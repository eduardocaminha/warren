import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatError } from "../../core/errors.ts";
import type { ReapExec } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* Types                                                                    */
/* ----------------------------------------------------------------------- */

export type RebasePushToMainResult =
	| { readonly ok: true; readonly attempts: number }
	| { readonly ok: false; readonly reason: "retry_ceiling_exceeded"; readonly attempts: number }
	| { readonly ok: false; readonly reason: "rebase_conflict"; readonly message: string }
	| { readonly ok: false; readonly reason: "error"; readonly message: string };

export interface RebasePushToMainInput {
	/** Project clone root — commits to push live here at HEAD. */
	readonly projectPath: string;
	/** Remote branch to rebase onto and push to (e.g. "main"). */
	readonly targetBranch: string;
	readonly exec: ReapExec;
	/**
	 * Maximum total push attempts before the retry ceiling is declared
	 * exceeded (default: 5). Non-fast-forward rejections trigger retries;
	 * every other push error surfaces immediately.
	 */
	readonly maxAttempts?: number;
	/**
	 * Injectable temp-dir factory (tests). Defaults to `mkdtemp` in
	 * `os.tmpdir()`. The returned path is used as the isolated worktree
	 * root; it must not exist on disk when the real implementation runs
	 * (worktree add creates it), but tests can return any string without
	 * creating a real directory.
	 */
	readonly mkTmpDir?: () => Promise<string>;
	/**
	 * Optional hook called after each successful `git rebase` but before
	 * `git push`. Use for post-rebase processing such as JSONL dedup after
	 * a `merge=union` rebase. The hook receives the isolated worktree path
	 * and may run git commands (via exec) or write files. If the hook
	 * throws, the attempt is marked `reason: "error"` immediately.
	 */
	readonly postRebase?: (worktreePath: string) => Promise<void>;
}

/* ----------------------------------------------------------------------- */
/* Internal types                                                           */
/* ----------------------------------------------------------------------- */

type AttemptResult =
	| { readonly done: true; readonly ok: true }
	| {
			readonly done: true;
			readonly ok: false;
			readonly reason: "rebase_conflict" | "error";
			readonly message: string;
	  }
	| { readonly done: false } // non-fast-forward — caller should retry
	| { readonly done: true; readonly ok: false; readonly reason: "retry_ceiling_exceeded" };

/* ----------------------------------------------------------------------- */
/* Constants                                                                */
/* ----------------------------------------------------------------------- */

const MAX_ATTEMPTS = 5;

/* ----------------------------------------------------------------------- */
/* Public API                                                               */
/* ----------------------------------------------------------------------- */

/**
 * Push the current HEAD of `projectPath` to `origin/<targetBranch>` via
 * an isolated git worktree.
 *
 * Flow per attempt: `git fetch origin <target>` → `git rebase
 * origin/<target>` → `git push origin HEAD:<target>`. On non-fast-forward
 * rejection the loop retries (fetch→rebase→push) up to `maxAttempts`
 * total before returning `retry_ceiling_exceeded`. Merge conflicts during
 * rebase return `rebase_conflict` immediately (no retry — only NFF
 * rejections benefit from retrying).
 *
 * The worktree is created as a detached-HEAD copy of `projectPath`'s
 * current HEAD so each concurrent reap context gets its own isolated
 * index. The main worktree's index and working tree are never touched.
 *
 * The caller is responsible for ensuring the commits at HEAD are the ones
 * to push (i.e. the bookkeeping commit is already staged + committed in
 * the project clone before calling this function).
 */
export async function rebasePushToMain(
	input: RebasePushToMainInput,
): Promise<RebasePushToMainResult> {
	const { projectPath, targetBranch, exec } = input;
	const maxAttempts = input.maxAttempts ?? MAX_ATTEMPTS;
	const mkTmpDir = input.mkTmpDir ?? defaultMkTmpDir;

	let worktreePath: string | null = null;

	try {
		worktreePath = await mkTmpDir();

		try {
			await exec.run("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
				cwd: projectPath,
				timeoutMs: 30_000,
			});
		} catch (err) {
			return { ok: false, reason: "error", message: `worktree add: ${errMsg(err)}` };
		}

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const r = await runAttempt(
				exec,
				worktreePath,
				targetBranch,
				attempt === maxAttempts,
				input.postRebase,
			);
			if (r.done) {
				if (r.ok) return { ok: true, attempts: attempt };
				if (r.reason === "retry_ceiling_exceeded") {
					return { ok: false, reason: "retry_ceiling_exceeded", attempts: attempt };
				}
				return { ok: false, reason: r.reason, message: r.message };
			}
		}

		return { ok: false, reason: "retry_ceiling_exceeded", attempts: 0 };
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

async function runAttempt(
	exec: ReapExec,
	worktreePath: string,
	targetBranch: string,
	isLastAttempt: boolean,
	postRebase?: (worktreePath: string) => Promise<void>,
): Promise<AttemptResult> {
	try {
		await exec.run("git", ["fetch", "origin", targetBranch], {
			cwd: worktreePath,
			timeoutMs: 60_000,
		});
	} catch (err) {
		return { done: true, ok: false, reason: "error", message: `fetch: ${errMsg(err)}` };
	}

	try {
		await exec.run("git", ["rebase", `origin/${targetBranch}`], {
			cwd: worktreePath,
			timeoutMs: 30_000,
		});
	} catch (err) {
		await exec
			.run("git", ["rebase", "--abort"], { cwd: worktreePath, timeoutMs: 10_000 })
			.catch(() => {});
		return { done: true, ok: false, reason: "rebase_conflict", message: errMsg(err) };
	}

	if (postRebase !== undefined) {
		try {
			await postRebase(worktreePath);
		} catch (err) {
			return { done: true, ok: false, reason: "error", message: `postRebase: ${errMsg(err)}` };
		}
	}

	try {
		await exec.run("git", ["push", "origin", `HEAD:${targetBranch}`], {
			cwd: worktreePath,
			timeoutMs: 60_000,
		});
		return { done: true, ok: true };
	} catch (err) {
		const msg = errMsg(err);
		if (!isNonFastForward(msg)) {
			return { done: true, ok: false, reason: "error", message: `push: ${msg}` };
		}
		if (isLastAttempt) {
			return { done: true, ok: false, reason: "retry_ceiling_exceeded" };
		}
		return { done: false };
	}
}

function isNonFastForward(msg: string): boolean {
	return /non-fast-forward|rejected|fetch first/i.test(msg);
}

function errMsg(err: unknown): string {
	return formatError(err);
}

async function defaultMkTmpDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "warren-rebase-push-"));
}
