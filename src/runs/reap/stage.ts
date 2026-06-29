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

/**
 * After a `merge=union` rebase in the isolated push worktree, dedup any
 * `.plot/*.events.jsonl` files that accumulated duplicate `id` rows and amend
 * the top commit in-place. Extracted from `stagePlotForCommit`'s `postRebase`
 * callback to keep that function's cognitive complexity within budget.
 */
async function dedupPlotEventFiles(
	worktreePath: string,
	fs: ReapFs,
	exec: ReapExec,
): Promise<void> {
	let entries: readonly string[] = [];
	try {
		entries = await fs.readdir(join(worktreePath, ".plot"));
	} catch {
		return;
	}
	const eventFiles = entries.filter(
		(name) => name.startsWith("plot-") && name.endsWith(".events.jsonl"),
	);
	const amendedPathspecs: string[] = [];
	for (const name of eventFiles) {
		const filePath = join(worktreePath, ".plot", name);
		const body = await fs.readFile(filePath);
		if (body === null) continue;
		const deduped = dedupJsonl(body);
		if (deduped === body) continue;
		await fs.writeFile(filePath, deduped);
		amendedPathspecs.push(join(".plot", name));
	}
	if (amendedPathspecs.length === 0) return;
	await exec.run("git", ["add", "--", ...amendedPathspecs], {
		cwd: worktreePath,
		timeoutMs: 10_000,
	});
	let hasDedupdelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ...amendedPathspecs], {
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
}

interface StagePlotForCommitInput {
	readonly workspacePath: string;
	readonly projectPath: string;
	/** Branch to push the bookkeeping commit to directly (e.g. "main"). */
	readonly targetBranch: string;
	readonly fs: ReapFs;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

/**
 * Stage and commit committable `.plot/` files in the project clone (not the
 * burrow workspace), then push that commit directly to `targetBranch` via
 * `rebasePushToMain`. Returns true when a warren-identity commit was committed
 * and pushed.
 *
 * **Why direct-push instead of run branch?** The same race that hit seeds
 * (warren-1a00, plan pl-b5f1) applies to plot: GitHub ignores `merge=union`
 * on PR merges, so concurrent reap PRs with `.plot/*.events.jsonl` changes
 * produce real conflicts. Routing the bookkeeping commit around the PR queue
 * via fetch→rebase→push (where `merge=union` fires correctly) eliminates the
 * race (warren-1312, pl-b5f1 step 5).
 *
 * The project clone is the canonical union point: by this step `mergePlot` has
 * already merged the workspace's agent-side `.plot/` writes into the project
 * clone, and the project clone also carries any host-side appender writes
 * (`defaultPlotAppender`, `defaultPlanRunPlotAppender`,
 * `autoTransitionPlotToDone`). Committing that merged view directly in the
 * project clone and pushing gives origin a single authoritative write without
 * touching the run branch.
 *
 * A `postRebase` hook deduplicates `.plot/*.events.jsonl` files in the isolated
 * push worktree after each rebase (last-write-wins by `id`) so `merge=union`
 * duplicate rows from concurrent direct-pushes are collapsed before the commit
 * lands on origin.
 *
 * **Workspace cleanup:** the agent may have staged or modified `.plot/` files
 * without committing them. After routing plot to main, those changes are removed
 * from the workspace so the run branch stays clean and `isWorkspaceDirty` does
 * not falsely trigger `droppedCommit` for a plot-only run.
 *
 * `.plot/.index.db*` files and entries that don't match `plot-*.json` or
 * `plot-*.events.jsonl` are excluded — same filter as the old workspace-copy
 * path (warren-c55e).
 */
export async function stagePlotForCommit(input: StagePlotForCommitInput): Promise<boolean> {
	const { workspacePath, projectPath, targetBranch, fs, exec, emit } = input;
	const projectPlotDir = join(projectPath, ".plot");

	// Discover committable plot files in the project clone.
	const entries = await fs.readdir(projectPlotDir);
	const committableFiles: string[] = [];
	for (const name of entries) {
		if (name.startsWith(PLOT_INDEX_SKIP_PREFIX)) continue;
		if (!name.startsWith("plot-")) continue;
		if (!name.endsWith(".json") && !name.endsWith(".events.jsonl")) continue;
		committableFiles.push(name);
	}
	if (committableFiles.length === 0) return false;

	const committablePathspecs = committableFiles.map((name) => join(".plot", name));

	// Remove agent-side plot changes from the workspace so uncommitted plot
	// state does not appear on the run branch or cause a false droppedCommit.
	// The canonical merged plot view lives in the project clone and goes to
	// main via direct push below. Errors are swallowed (best-effort cleanup).
	await exec
		.run("git", ["restore", "--staged", "--", ".plot/"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		})
		.catch(() => {});
	await exec
		.run("git", ["restore", "--", ".plot/"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		})
		.catch(() => {});
	await exec
		.run("git", ["clean", "-f", "--", ".plot/"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		})
		.catch(() => {});

	// Stage plot files in the project clone.
	await exec.run("git", ["add", "--", ...committablePathspecs], {
		cwd: projectPath,
		timeoutMs: 10_000,
	});

	// warren-be12 (#420) / warren-c55e: narrow the staged-delta guard to the
	// committable carriers so an unrelated pre-staged file under `.plot/` can't
	// spoof a delta.
	let hasStagedDelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ...committablePathspecs], {
			cwd: projectPath,
			timeoutMs: 10_000,
		});
		hasStagedDelta = false;
	} catch {
		hasStagedDelta = true;
	}

	if (!hasStagedDelta) {
		await exec
			.run("git", ["restore", "--staged", "--", ".plot/"], {
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
			// warren-be12 (#420) / warren-c55e: path-limit the commit to the
			// committable carriers via `--only` so pre-staged unrelated files are
			// not swept into the warren bookkeeping commit.
			"--only",
			"-m",
			"chore(warren): plot state",
			"--",
			...committablePathspecs,
		],
		{ cwd: projectPath, timeoutMs: 10_000 },
	);

	// Push the bookkeeping commit directly to main (bypassing the run branch).
	// postRebase deduplicates .events.jsonl files in the worktree so merge=union
	// duplicates from concurrent direct-pushes are collapsed before the push lands.
	const pushResult = await rebasePushToMain({
		projectPath,
		targetBranch,
		exec,
		postRebase: (wt) => dedupPlotEventFiles(wt, fs, exec),
	});

	if (!pushResult.ok) {
		const detail = "message" in pushResult ? `: ${pushResult.message}` : "";
		throw new Error(`plot direct push failed: ${pushResult.reason}${detail}`);
	}

	await emit("reap.plot_committed", {
		message: "chore(warren): plot state",
		filesStaged: committableFiles.length,
		directPush: true,
		attempts: pushResult.attempts,
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
