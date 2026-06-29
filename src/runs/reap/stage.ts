import { join } from "node:path";
import { warrenCommitIdentityArgs } from "../../bot-identity.ts";
import type { EventRow } from "../../db/schema.ts";
import { dedupJsonl } from "./dedup-jsonl.ts";
import { rebasePushToMain } from "./rebase-push.ts";
import type { ReapExec, ReapFs } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* Plot commit-through-reap (warren-343a, shape (a))                         */
/* ----------------------------------------------------------------------- */

/**
 * Filenames matching this prefix are gitignored derived state per
 * ../plot/README.md — the SQLite index Plot rebuilds on demand. Skipping
 * these on copy mirrors the snapshot/restore wrapper in
 * src/projects/refresh.ts (mx-239786) and keeps the warren-authored
 * commit free of churn.
 */
const PLOT_INDEX_SKIP_PREFIX = ".index.db";

interface StagePlotForCommitInput {
	readonly workspacePath: string;
	readonly projectPath: string;
	readonly fs: ReapFs;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

/**
 * Replicate every committable `.plot/` file from the project clone into
 * the burrow workspace, then stage `.plot/` and author a
 * `chore(warren): plot state` commit when there's a real delta the agent
 * never committed. Returns true when a warren-identity commit landed.
 *
 * The project clone is the union point: by this step `mergePlot` has
 * already merged the workspace's agent-side `.plot/` writes into the
 * project clone, and the project clone also carries any host-side
 * appender writes (`defaultPlotAppender`, `defaultPlanRunPlotAppender`,
 * `autoTransitionPlotToDone`) that warren wrote at dispatch / plan-run
 * coordination time. Copying that union back into the workspace gives
 * `git push` a single canonical view to ship to origin.
 *
 * `.plot/.index.db*` files are skipped — derived SQLite state Plot
 * rebuilds via `plot rebuild-index` (mx-239786). Anything that isn't
 * `plot-*.json` or `plot-*.events.jsonl` is also skipped: the SPEC §11.O
 * file layout for `.plot/` is flat and these two extensions cover the
 * full carrier surface; filtering keeps stray dotfiles out of the warren
 * commit.
 *
 * The `git add` / staged-delta / `--only` commit pathspecs are limited
 * to the actually-copied carrier files (warren-c55e, symmetric with
 * stageSeedsForCommit / #420) so a pre-staged unrelated file — even one
 * under `.plot/` — can neither spoof a staged delta nor be swept into
 * the warren bookkeeping commit. The add still honors a project-level
 * `.gitignore` of `.plot/`: a project that gitignored the directory has
 * opted out of committing Plot state, the copied carriers stage nothing,
 * and the staged-changes check below sees no entries.
 */
export async function stagePlotForCommit(input: StagePlotForCommitInput): Promise<boolean> {
	const { workspacePath, projectPath, fs, exec, emit } = input;
	const projectPlotDir = join(projectPath, ".plot");
	const workspacePlotDir = join(workspacePath, ".plot");

	const entries = await fs.readdir(projectPlotDir);
	const copiedPathspecs: string[] = [];
	for (const name of entries) {
		if (name.startsWith(PLOT_INDEX_SKIP_PREFIX)) continue;
		if (!name.startsWith("plot-")) continue;
		if (!name.endsWith(".json") && !name.endsWith(".events.jsonl")) continue;
		const contents = await fs.readFile(join(projectPlotDir, name));
		if (contents === null) continue;
		if (copiedPathspecs.length === 0) await fs.mkdirp(workspacePlotDir);
		await fs.writeFile(join(workspacePlotDir, name), contents);
		copiedPathspecs.push(join(".plot", name));
	}
	const copied = copiedPathspecs.length;
	if (copied === 0) return false;

	await exec.run("git", ["add", "--", ...copiedPathspecs], {
		cwd: workspacePath,
		timeoutMs: 10_000,
	});

	// warren-be12 (#420) / warren-c55e: narrow the staged-delta guard to the
	// actually-copied `.plot/` carriers (symmetry with the `--only`
	// pathspecs below, and with stageSeedsForCommit) so an unrelated
	// pre-staged file under `.plot/` can't spoof a delta. `git diff
	// --cached --quiet` exits non-zero when there's a staged change — the
	// natural primitive for "did the add pick up a delta the agent hadn't
	// already committed".
	let hasStagedDelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ...copiedPathspecs], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		});
		hasStagedDelta = false;
	} catch {
		hasStagedDelta = true;
	}
	if (!hasStagedDelta) return false;

	await exec.run(
		"git",
		[
			...warrenCommitIdentityArgs(),
			"commit",
			// warren-27d3: internal bookkeeping commits must never be gated by
			// the project's git hooks (e.g. a pre-commit hook running the full
			// check:all gauntlet). --no-verify skips pre-commit / commit-msg.
			"--no-verify",
			// warren-be12 (#420) / warren-c55e: path-limit the commit to the
			// actually-copied `.plot/` carriers via `--only` so any unrelated
			// files an earlier step pre-staged in the workspace index — even
			// ones under `.plot/` — are not swept into the warren bookkeeping
			// commit.
			"--only",
			"-m",
			"chore(warren): plot state",
			"--",
			...copiedPathspecs,
		],
		{ cwd: workspacePath, timeoutMs: 10_000 },
	);
	await emit("reap.plot_committed", {
		message: "chore(warren): plot state",
		filesStaged: copied,
	});
	return true;
}

/* ----------------------------------------------------------------------- */
/* Seeds commit-through-reap (warren-7ecc)                                   */
/* ----------------------------------------------------------------------- */

/**
 * Seeds-tracker files committed by warren on the agent's behalf. The
 * SPEC for `.seeds/` (../seeds/SPEC.md) pins a flat layout of two
 * jsonl carriers — `issues.jsonl` (the issue queue) and `plans.jsonl`
 * (sd plan submit output, the planner's primary write). `config.yaml`
 * and `templates.jsonl` are committed by the human at `sd init` time
 * and don't get rewritten by agent activity, so excluding them keeps
 * the warren-authored commit narrow.
 */
const SEEDS_COMMITTABLE_FILES: readonly string[] = ["issues.jsonl", "plans.jsonl"];

interface StageSeedsForCommitInput {
	readonly workspacePath: string;
	readonly projectPath: string;
	/** Branch to push the bookkeeping commit to directly (e.g. "main"). */
	readonly targetBranch: string;
	readonly fs: ReapFs;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

/**
 * Stage and commit `.seeds/issues.jsonl` + `.seeds/plans.jsonl` in the
 * project clone (not the burrow workspace), then push that commit directly
 * to `targetBranch` via `rebasePushToMain`. Returns true when a
 * warren-identity commit was committed and pushed.
 *
 * **Why direct-push instead of run branch?** Concurrent reap PRs race on
 * GitHub's merge queue: GitHub ignores the `merge=union` gitattribute, so
 * the JSONL carriers produce real conflicts, PRs land in DIRTY/conflicted
 * state, and auto-merge is blocked (warren-1a00, plan pl-b5f1 step 4).
 * Routing the bookkeeping commit around the PR queue via a local
 * fetch→rebase→push (where `merge=union` fires correctly) eliminates the
 * race.
 *
 * The project clone is the canonical union point: by this step `mirrorSeeds`
 * has already merged closed-status and newly-created rows from the workspace
 * into the project's `issues.jsonl`, and `mirrorPlans` has appended any new
 * plans. Committing that merged view directly in the project clone and pushing
 * gives origin a single authoritative write without touching the run branch.
 *
 * A `postRebase` hook runs inside the isolated push worktree after every
 * `git rebase origin/<target>` to dedup the JSONL carriers (last-write-wins
 * by `id`). The `merge=union` rebase can append duplicate id rows when two
 * concurrent direct-pushes race; dedup collapses them before the final push
 * lands on origin (plan pl-b5f1 acceptance criterion 1).
 *
 * **Workspace cleanup:** the agent may have staged or modified `.seeds/`
 * files without committing them (e.g. via `sd close` or `sd plan submit`).
 * After routing seeds to main, those changes must be removed from the
 * workspace so the run branch stays clean and `isWorkspaceDirty` does not
 * falsely trigger `droppedCommit` for a seeds-only run.
 *
 * `git add .seeds/` honors a project-level `.gitignore` of `.seeds/` — a
 * project that gitignored the directory has opted out of committing seeds
 * state, and the staged-changes check below sees no entries.
 */
export async function stageSeedsForCommit(input: StageSeedsForCommitInput): Promise<boolean> {
	const { workspacePath, projectPath, targetBranch, fs, exec, emit } = input;
	const projectSeedsDir = join(projectPath, ".seeds");
	const seedsPathspecs = SEEDS_COMMITTABLE_FILES.map((name) => join(".seeds", name));

	// Guard: skip entirely when no committable seeds files exist in the project clone.
	let foundCount = 0;
	for (const name of SEEDS_COMMITTABLE_FILES) {
		const contents = await fs.readFile(join(projectSeedsDir, name));
		if (contents !== null) foundCount++;
	}
	if (foundCount === 0) return false;

	// Remove agent-side seeds changes from the workspace so uncommitted seeds
	// state does not appear on the run branch or cause a false droppedCommit.
	// The canonical merged seeds view lives in the project clone and goes to
	// main via direct push below.
	await exec
		.run("git", ["restore", "--staged", "--", ".seeds/"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		})
		.catch(() => {});
	await exec
		.run("git", ["restore", "--", ".seeds/"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		})
		.catch(() => {});
	await exec
		.run("git", ["clean", "-f", "--", ".seeds/"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		})
		.catch(() => {});

	// Stage seeds files in the project clone.
	await exec.run("git", ["add", "--", ".seeds/"], {
		cwd: projectPath,
		timeoutMs: 10_000,
	});

	// warren-be12 (#420): narrow the staged-delta guard to the two committable
	// carriers so an unrelated pre-staged file under `.seeds/` can't spoof a
	// delta.
	let hasStagedDelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ...seedsPathspecs], {
			cwd: projectPath,
			timeoutMs: 10_000,
		});
		hasStagedDelta = false;
	} catch {
		hasStagedDelta = true;
	}

	if (!hasStagedDelta) {
		await exec
			.run("git", ["restore", "--staged", "--", ".seeds/"], {
				cwd: projectPath,
				timeoutMs: 10_000,
			})
			.catch(() => {});
		return false;
	}

	// Commit in the project clone (not the workspace/run branch).
	await exec.run(
		"git",
		[
			...warrenCommitIdentityArgs(),
			"commit",
			// warren-27d3: skip project git hooks for warren's bookkeeping commit.
			"--no-verify",
			// warren-be12 (#420): path-limit the commit to the two seeds
			// carriers via `--only` so pre-staged unrelated files are not
			// swept into the warren bookkeeping commit.
			"--only",
			"-m",
			"chore(warren): seeds state",
			"--",
			...seedsPathspecs,
		],
		{ cwd: projectPath, timeoutMs: 10_000 },
	);

	// Dedup seeds files in the isolated push worktree after each rebase so
	// merge=union duplicates (concurrent direct-pushes) are collapsed before
	// the commit lands on origin.
	const postRebase = async (worktreePath: string) => {
		let amended = false;
		for (const name of SEEDS_COMMITTABLE_FILES) {
			const body = await fs.readFile(join(worktreePath, ".seeds", name));
			if (body === null) continue;
			const deduped = dedupJsonl(body);
			if (deduped === body) continue;
			await fs.writeFile(join(worktreePath, ".seeds", name), deduped);
			amended = true;
		}
		if (!amended) return;
		await exec.run("git", ["add", "--", ...seedsPathspecs], {
			cwd: worktreePath,
			timeoutMs: 10_000,
		});
		let hasDedupdelta: boolean;
		try {
			await exec.run("git", ["diff", "--cached", "--quiet", "--", ...seedsPathspecs], {
				cwd: worktreePath,
				timeoutMs: 10_000,
			});
			hasDedupdelta = false;
		} catch {
			hasDedupdelta = true;
		}
		if (!hasDedupdelta) return;
		await exec.run(
			"git",
			[...warrenCommitIdentityArgs(), "commit", "--amend", "--no-verify", "--no-edit"],
			{ cwd: worktreePath, timeoutMs: 10_000 },
		);
	};

	// Push the bookkeeping commit directly to main (bypassing the run branch).
	const pushResult = await rebasePushToMain({
		projectPath,
		targetBranch,
		exec,
		postRebase,
	});

	if (!pushResult.ok) {
		const detail = "message" in pushResult ? `: ${pushResult.message}` : "";
		throw new Error(`seeds direct push failed: ${pushResult.reason}${detail}`);
	}

	await emit("reap.seeds_committed", {
		message: "chore(warren): seeds state",
		filesStaged: foundCount,
		directPush: true,
		attempts: pushResult.attempts,
	});
	return true;
}
