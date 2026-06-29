/**
 * Belt-and-suspenders recovery for run-branch PRs that GitHub marks DIRTY
 * exclusively in bookkeeping files (.seeds/*.jsonl, .plot/*.events.jsonl)
 * (warren-796b / pl-b5f1 step 6).
 *
 * When the coordinator polls a child PR and receives `{ kind: "dirty" }`,
 * it calls the `CoordinatorRecoverDirtyPrFn` seam. The seam creates an
 * isolated worktree at the run-branch tip, rebases it on `origin/<default>`,
 * and force-pushes back. `merge=union` in `.gitattributes` auto-resolves
 * JSONL conflicts; a remaining conflict signals real code-file conflicts
 * (`"code_conflict"`). On success the PR recovers to a clean+mergeable state
 * and the coordinator keeps waiting for the GitHub merge.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repos } from "../db/repos/index.ts";
import { composeRunBranch, resolveRunBranchPrefix } from "../runs/branch.ts";
import { dedupJsonl } from "../runs/reap/dedup-jsonl.ts";
import type { ReapExec, ReapFs } from "../runs/reap/types.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";

/* ----------------------------------------------------------------------- */
/* Public types                                                             */
/* ----------------------------------------------------------------------- */

/**
 * Outcome of a dirty-PR recovery attempt (warren-796b).
 *
 * - `"recovered"`     — rebase + force-push succeeded; PR should become
 *                       MERGEABLE on the next coordinator poll.
 * - `"code_conflict"` — rebase failed due to real code-file conflicts;
 *                       the coordinator should fail the plan terminally.
 * - `"noop"`          — transient error (network, worktree, push lease);
 *                       coordinator treats PR as still-open and retries.
 */
export type RecoverDirtyPrOutcome = "recovered" | "code_conflict" | "noop";

/**
 * Seam injected into the PlanRun coordinator (warren-796b). Called when
 * `checkPrMerged` returns `{ kind: "dirty" }` for an in-flight child PR.
 */
export type CoordinatorRecoverDirtyPrFn = (
	runId: string,
	prUrl: string,
) => Promise<RecoverDirtyPrOutcome>;

/* ----------------------------------------------------------------------- */
/* Factory                                                                  */
/* ----------------------------------------------------------------------- */

export interface CreateRecoverDirtyPrFnInput {
	readonly repos: Pick<Repos, "runs" | "projects">;
	readonly warrenConfigs: WarrenConfigCache;
	readonly runBranchPrefixDefault: string | undefined;
	readonly exec: ReapExec;
	readonly fs: ReapFs;
	/** Temp-dir factory (tests). */
	readonly mkTmpDir?: () => Promise<string>;
}

/**
 * Wire up the `CoordinatorRecoverDirtyPrFn` seam. The returned closure looks
 * up the run's project clone path and default branch, derives the run branch
 * name from the run id, then calls {@link recoverRunBranch}.
 */
export function createRecoverDirtyPrFn(
	input: CreateRecoverDirtyPrFnInput,
): CoordinatorRecoverDirtyPrFn {
	const { repos, warrenConfigs, runBranchPrefixDefault, exec, fs, mkTmpDir } = input;
	return async (runId: string): Promise<RecoverDirtyPrOutcome> => {
		try {
			const run = await repos.runs.get(runId);
			if (run === null || run.projectId === null) return "noop";
			const project = await repos.projects.get(run.projectId);
			if (project === null) return "noop";
			const warrenConfig = await warrenConfigs.get(run.projectId, project.localPath);
			const prefix = resolveRunBranchPrefix({
				projectDefault: warrenConfig.defaults?.runBranchPrefix,
				envDefault: runBranchPrefixDefault,
			});
			const runBranch = composeRunBranch(prefix, runId);
			return await recoverRunBranch({
				projectPath: project.localPath,
				runBranch,
				defaultBranch: project.defaultBranch,
				exec,
				fs,
				mkTmpDir,
			});
		} catch {
			return "noop";
		}
	};
}

/* ----------------------------------------------------------------------- */
/* Core recovery (exported for unit tests)                                 */
/* ----------------------------------------------------------------------- */

export interface RecoverRunBranchInput {
	readonly projectPath: string;
	readonly runBranch: string;
	readonly defaultBranch: string;
	readonly exec: ReapExec;
	readonly fs: ReapFs;
	/** Temp-dir factory (tests). */
	readonly mkTmpDir?: () => Promise<string>;
}

/**
 * Isolated-worktree rebase+force-push for a conflict-dirty run branch.
 *
 * 1. `git fetch origin <runBranch> <defaultBranch>` — update remote refs.
 * 2. `git worktree add --detach <tmp> origin/<runBranch>` — isolated copy.
 * 3. `git rebase origin/<defaultBranch>` — merge=union auto-resolves JSONL
 *    conflicts; any remaining conflict means real code files → `code_conflict`.
 * 4. Dedup JSONL bookkeeping files + `git commit --amend` if anything changed.
 * 5. `git push --force-with-lease origin HEAD:<runBranch>` — update the PR.
 * 6. Clean up worktree.
 */
export async function recoverRunBranch(
	input: RecoverRunBranchInput,
): Promise<RecoverDirtyPrOutcome> {
	const { projectPath, runBranch, defaultBranch, exec, fs } = input;
	const mkTmpDirImpl = input.mkTmpDir ?? defaultMkTmpDir;

	// Fetch both branches so remote-tracking refs are fresh.
	try {
		await exec.run("git", ["fetch", "origin", runBranch, defaultBranch], {
			cwd: projectPath,
			timeoutMs: 60_000,
		});
	} catch {
		return "noop";
	}

	let worktreePath: string | null = null;
	try {
		worktreePath = await mkTmpDirImpl();

		try {
			await exec.run("git", ["worktree", "add", "--detach", worktreePath, `origin/${runBranch}`], {
				cwd: projectPath,
				timeoutMs: 30_000,
			});
		} catch {
			return "noop";
		}

		// Rebase on default branch. merge=union in .gitattributes auto-resolves
		// .seeds/*.jsonl and .plot/*.events.jsonl conflicts. Any remaining conflict
		// is in code files → fail terminally.
		try {
			await exec.run("git", ["rebase", `origin/${defaultBranch}`], {
				cwd: worktreePath,
				timeoutMs: 60_000,
			});
		} catch {
			await exec
				.run("git", ["rebase", "--abort"], { cwd: worktreePath, timeoutMs: 10_000 })
				.catch(() => {});
			return "code_conflict";
		}

		// Dedup any JSONL files that merge=union may have duplicated.
		await dedupBookkeepingFiles(worktreePath, exec, fs);

		// Force-push the rebased branch back. --force-with-lease guards against
		// a concurrent push to the same branch between our fetch and our push.
		try {
			await exec.run("git", ["push", "--force-with-lease", "origin", `HEAD:${runBranch}`], {
				cwd: worktreePath,
				timeoutMs: 60_000,
			});
		} catch {
			return "noop";
		}

		return "recovered";
	} finally {
		if (worktreePath !== null) {
			await exec
				.run("git", ["worktree", "remove", "--force", worktreePath], {
					cwd: projectPath,
					timeoutMs: 10_000,
				})
				.catch(() => {});
			await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
		}
	}
}

/* ----------------------------------------------------------------------- */
/* Helpers                                                                  */
/* ----------------------------------------------------------------------- */

const SEEDS_FILES = ["issues.jsonl", "plans.jsonl"] as const;

async function dedupOneFile(
	absPath: string,
	relPath: string,
	fs: ReapFs,
	changed: string[],
): Promise<void> {
	const body = await fs.readFile(absPath);
	if (body === null) return;
	const deduped = dedupJsonl(body);
	if (deduped === body) return;
	await fs.writeFile(absPath, deduped);
	changed.push(relPath);
}

async function amendChangedFiles(
	worktreePath: string,
	changed: string[],
	exec: ReapExec,
): Promise<void> {
	await exec.run("git", ["add", "--", ...changed], { cwd: worktreePath, timeoutMs: 10_000 });
	let hasDedupdelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ...changed], {
			cwd: worktreePath,
			timeoutMs: 10_000,
		});
		hasDedupdelta = false;
	} catch {
		hasDedupdelta = true;
	}
	if (!hasDedupdelta) return;
	// Amend the top commit in-place. Preserves the existing commit's author
	// (no identity override — these are agent commits, not warren bookkeeping).
	await exec.run("git", ["commit", "--amend", "--no-verify", "--no-edit"], {
		cwd: worktreePath,
		timeoutMs: 10_000,
	});
}

/**
 * Dedup JSONL bookkeeping files in the worktree after a merge=union rebase.
 * Stages changed files and amends the top commit so the force-push carries
 * the deduped content. No-ops when nothing changed.
 */
async function dedupBookkeepingFiles(
	worktreePath: string,
	exec: ReapExec,
	fs: ReapFs,
): Promise<void> {
	const changed: string[] = [];

	for (const name of SEEDS_FILES) {
		await dedupOneFile(join(worktreePath, ".seeds", name), join(".seeds", name), fs, changed);
	}

	let plotEntries: readonly string[] = [];
	try {
		plotEntries = await fs.readdir(join(worktreePath, ".plot"));
	} catch {
		plotEntries = [];
	}
	for (const name of plotEntries) {
		if (!name.startsWith("plot-") || !name.endsWith(".events.jsonl")) continue;
		await dedupOneFile(join(worktreePath, ".plot", name), join(".plot", name), fs, changed);
	}

	if (changed.length === 0) return;
	await amendChangedFiles(worktreePath, changed, exec);
}

async function defaultMkTmpDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "warren-dirty-recover-"));
}
