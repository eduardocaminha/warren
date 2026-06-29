/**
 * Belt-and-suspenders recovery for run-branch PRs that GitHub reports as
 * DIRTY exclusively due to bookkeeping files (warren-796b, pl-b5f1 step 6).
 *
 * Context: after warren-2501 + warren-1312, seeds/plot bookkeeping commits go
 * directly to `main` rather than the run branch, so new PRs carry only code
 * changes and cannot conflict on bookkeeping files. This module handles the
 * residual case — a run whose PR was opened before the fix, or whose reap
 * pipeline hit an edge-case path — where `checkPullRequestMerged` returns
 * `{ kind: "dirty" }`.
 *
 * Recovery: fetch the run branch, rebase it against `origin/<defaultBranch>`
 * in an isolated worktree (the local rebase honours `merge=union` and
 * auto-resolves bookkeeping conflicts), dedup any JSONL bookkeeping files
 * that picked up duplicate rows from the union merge, then force-push the
 * rebased head back to the run branch. If the rebase fails (non-bookkeeping
 * conflict) the function returns `"code_conflict"` so the coordinator can
 * surface a meaningful error instead of spinning forever.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warrenCommitIdentityArgs } from "../../bot-identity.ts";
import type { Repos } from "../../db/repos/index.ts";
import { resolveRunBranchPrefix } from "../branch.ts";
import { dedupJsonl } from "./dedup-jsonl.ts";
import type { ReapExec, ReapFs } from "./types.ts";
import { defaultExec, defaultFs } from "./util.ts";

/* ----------------------------------------------------------------------- */
/* Types                                                                    */
/* ----------------------------------------------------------------------- */

/**
 * Outcome of a dirty-PR recovery attempt:
 *
 * - `"recovered"` — rebase + force-push succeeded; the coordinator should
 *   keep polling and the PR's `mergeable_state` should clear to `"clean"`.
 * - `"code_conflict"` — git rebase failed due to non-bookkeeping conflicts;
 *   the coordinator should surface this as a terminal plan failure.
 * - `"noop"` — run has no branch or project clone; nothing to do.
 * - `"error"` — unexpected failure (git error, worktree leak etc.); the
 *   coordinator should treat the PR as still-open and keep waiting (budget).
 */
export type RecoverDirtyPrResult = "recovered" | "code_conflict" | "noop" | "error";

export type RecoverDirtyPrFn = (runId: string) => Promise<RecoverDirtyPrResult>;

/* ----------------------------------------------------------------------- */
/* Bookkeeping file lists (mirrors stage.ts)                               */
/* ----------------------------------------------------------------------- */

/**
 * Seeds JSONL files that may contain duplicate rows after a `merge=union`
 * rebase. Mirrors `SEEDS_COMMITTABLE_FILES` in `stage.ts`.
 */
const SEEDS_DEDUP_FILES: readonly string[] = ["issues.jsonl", "plans.jsonl"];

/**
 * Pattern for plot event files that need deduplication after `merge=union`.
 * Files match `plot-*.events.jsonl` under `.plot/`.
 */
function isPlotEventFile(name: string): boolean {
	return name.startsWith("plot-") && name.endsWith(".events.jsonl");
}

/* ----------------------------------------------------------------------- */
/* Internal helpers                                                         */
/* ----------------------------------------------------------------------- */

async function defaultMkTmpDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "warren-dirty-recovery-"));
}

/**
 * Dedup bookkeeping JSONL files that `merge=union` may have duplicated, then
 * amend the top commit in the worktree if anything changed.
 */
async function dedupBookkeepingFiles(
	worktreePath: string,
	fs: ReapFs,
	exec: ReapExec,
): Promise<void> {
	const amended: string[] = [];

	// Seeds files
	for (const name of SEEDS_DEDUP_FILES) {
		const path = join(worktreePath, ".seeds", name);
		const body = await fs.readFile(path);
		if (body === null) continue;
		const deduped = dedupJsonl(body);
		if (deduped === body) continue;
		await fs.writeFile(path, deduped);
		amended.push(join(".seeds", name));
	}

	// Plot event files
	let plotEntries: readonly string[] = [];
	try {
		plotEntries = await fs.readdir(join(worktreePath, ".plot"));
	} catch {
		// .plot/ may not exist — not an error.
	}
	for (const name of plotEntries.filter(isPlotEventFile)) {
		const path = join(worktreePath, ".plot", name);
		const body = await fs.readFile(path);
		if (body === null) continue;
		const deduped = dedupJsonl(body);
		if (deduped === body) continue;
		await fs.writeFile(path, deduped);
		amended.push(join(".plot", name));
	}

	if (amended.length === 0) return;

	await exec.run("git", ["add", "--", ...amended], {
		cwd: worktreePath,
		timeoutMs: 10_000,
	});

	let hasDelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ...amended], {
			cwd: worktreePath,
			timeoutMs: 10_000,
		});
		hasDelta = false;
	} catch {
		hasDelta = true;
	}
	if (!hasDelta) return;

	await exec.run(
		"git",
		[...warrenCommitIdentityArgs(), "commit", "--amend", "--no-verify", "--no-edit"],
		{ cwd: worktreePath, timeoutMs: 10_000 },
	);
}

/* ----------------------------------------------------------------------- */
/* Core recovery logic                                                      */
/* ----------------------------------------------------------------------- */

export interface RecoverDirtyPrInput {
	/** Run-branch name (e.g. "warren/run-abc123"). */
	readonly runBranch: string;
	/** Absolute path to the project's local clone. */
	readonly projectPath: string;
	/** Branch to rebase onto (e.g. "main"). */
	readonly defaultBranch: string;
	readonly exec: ReapExec;
	readonly fs: ReapFs;
	/** Injectable temp-dir factory for tests. */
	readonly mkTmpDir?: () => Promise<string>;
}

/**
 * Rebase the run branch against `origin/<defaultBranch>` in an isolated
 * worktree, dedup any bookkeeping JSONL files, then force-push. Returns the
 * recovery outcome without throwing.
 */
export async function recoverDirtyPr(input: RecoverDirtyPrInput): Promise<RecoverDirtyPrResult> {
	const { runBranch, projectPath, defaultBranch, exec, fs } = input;
	const mkTmpDir = input.mkTmpDir ?? defaultMkTmpDir;

	let worktreePath: string | null = null;
	try {
		worktreePath = await mkTmpDir();

		// Create an isolated worktree at the tip of the run branch (fetch first).
		try {
			await exec.run("git", ["fetch", "origin", runBranch, defaultBranch], {
				cwd: projectPath,
				timeoutMs: 60_000,
			});
		} catch {
			// Fetch failure — branch may have been deleted or network issue.
			return "error";
		}

		try {
			await exec.run("git", ["worktree", "add", "--detach", worktreePath, `origin/${runBranch}`], {
				cwd: projectPath,
				timeoutMs: 30_000,
			});
		} catch {
			return "error";
		}

		// Rebase against origin/<defaultBranch>. merge=union auto-resolves
		// bookkeeping conflicts; non-bookkeeping conflicts cause rebase to fail.
		try {
			await exec.run("git", ["rebase", `origin/${defaultBranch}`], {
				cwd: worktreePath,
				timeoutMs: 60_000,
			});
		} catch {
			// Abort to leave the worktree in a clean state.
			await exec
				.run("git", ["rebase", "--abort"], { cwd: worktreePath, timeoutMs: 10_000 })
				.catch(() => {});
			return "code_conflict";
		}

		// Dedup any bookkeeping files that accumulated duplicates via merge=union.
		try {
			await dedupBookkeepingFiles(worktreePath, fs, exec);
		} catch {
			// Dedup is best-effort; a failure here doesn't prevent the push.
		}

		// Force-push the rebased head back to the run branch.
		try {
			await exec.run("git", ["push", "--force-with-lease", "origin", `HEAD:${runBranch}`], {
				cwd: worktreePath,
				timeoutMs: 60_000,
			});
		} catch {
			return "error";
		}

		return "recovered";
	} catch {
		return "error";
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
/* Production factory                                                       */
/* ----------------------------------------------------------------------- */

/**
 * Build a `RecoverDirtyPrFn` wired to the production repos. Uses
 * `branchPrefixDefault` (the `WARREN_RUN_BRANCH_PREFIX` env default) to
 * compose the run-branch name; falls back to the built-in prefix when
 * omitted. Returns `"noop"` when the run or project rows have been deleted.
 */
export function createRecoverDirtyPrFn(
	repos: Pick<Repos, "runs" | "projects">,
	branchPrefixDefault?: string,
	exec?: ReapExec,
	fs?: ReapFs,
): RecoverDirtyPrFn {
	const _exec = exec ?? defaultExec;
	const _fs = fs ?? defaultFs;
	const prefix = resolveRunBranchPrefix({ envDefault: branchPrefixDefault });
	return async (runId) => {
		try {
			const run = await repos.runs.get(runId);
			if (run === null || run.projectId === null) return "noop";
			const project = await repos.projects.get(run.projectId);
			if (project === null) return "noop";
			return recoverDirtyPr({
				runBranch: `${prefix}/${runId}`,
				projectPath: project.localPath,
				defaultBranch: project.defaultBranch,
				exec: _exec,
				fs: _fs,
			});
		} catch {
			return "error";
		}
	};
}
