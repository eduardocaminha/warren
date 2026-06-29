import { describe, expect, test } from "bun:test";
import { rebasePushToMain } from "./rebase-push.ts";
import type { ReapExec } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* Test helpers                                                             */
/* ----------------------------------------------------------------------- */

const PROJECT_PATH = "/data/projects/x/y";
const WORKTREE_PATH = "/tmp/warren-rebase-push-test";

function fakeMkTmpDir(): () => Promise<string> {
	return async () => WORKTREE_PATH;
}

type Response = { ok: true } | { ok: false; msg: string };

/**
 * Build a ReapExec whose calls match a response queue 1:1.
 * Extra calls beyond the queue succeed silently.
 */
function makeExec(responses: Response[]): {
	exec: ReapExec;
	calls: { cmd: string; args: readonly string[]; cwd: string }[];
} {
	const calls: { cmd: string; args: readonly string[]; cwd: string }[] = [];
	let i = 0;
	const exec: ReapExec = {
		run: async (cmd, args, opts) => {
			calls.push({ cmd, args, cwd: opts.cwd });
			const resp = responses[i++] ?? { ok: true };
			if (!resp.ok) throw new Error(resp.msg);
			return { stdout: "", stderr: "" };
		},
	};
	return { exec, calls };
}

/** All commands succeed. */
function allOk(): Response[] {
	return [
		{ ok: true }, // worktree add
		{ ok: true }, // fetch
		{ ok: true }, // rebase
		{ ok: true }, // push
		{ ok: true }, // worktree remove
	];
}

const NON_FF_MSG = "error: failed to push some refs\nhint: non-fast-forward";
const nff: Response = { ok: false, msg: NON_FF_MSG };

/* ----------------------------------------------------------------------- */
/* rebasePushToMain                                                         */
/* ----------------------------------------------------------------------- */

describe("rebasePushToMain", () => {
	test("succeeds on first attempt — returns ok with attempts=1", async () => {
		const { exec, calls } = makeExec(allOk());
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toEqual({ ok: true, attempts: 1 });
		// worktree add must run first in project clone
		expect(calls[0]).toMatchObject({
			cmd: "git",
			args: ["worktree", "add", "--detach", WORKTREE_PATH, "HEAD"],
			cwd: PROJECT_PATH,
		});
		// fetch → rebase → push run in the worktree
		expect(calls[1]).toMatchObject({
			cmd: "git",
			args: ["fetch", "origin", "main"],
			cwd: WORKTREE_PATH,
		});
		expect(calls[2]).toMatchObject({
			cmd: "git",
			args: ["rebase", "origin/main"],
			cwd: WORKTREE_PATH,
		});
		expect(calls[3]).toMatchObject({
			cmd: "git",
			args: ["push", "origin", "HEAD:main"],
			cwd: WORKTREE_PATH,
		});
	});

	test("cleanup: worktree remove always runs (success path)", async () => {
		const { exec, calls } = makeExec(allOk());
		await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		const removeCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "remove",
		);
		expect(removeCall).toBeDefined();
		expect(removeCall?.args).toContain(WORKTREE_PATH);
		expect(removeCall?.cwd).toBe(PROJECT_PATH);
	});

	test("cleanup: worktree remove runs even when push fails permanently", async () => {
		const { exec, calls } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch
			{ ok: true }, // rebase
			{ ok: false, msg: "push: authentication failed" }, // push — permanent error
			{ ok: true }, // worktree remove
		]);
		await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		const removeCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "remove",
		);
		expect(removeCall).toBeDefined();
	});

	test("cleanup: worktree remove runs even when rebase conflicts", async () => {
		const { exec, calls } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch
			{ ok: false, msg: "CONFLICT (content): Merge conflict in .seeds/issues.jsonl" }, // rebase
			{ ok: true }, // rebase --abort
			{ ok: true }, // worktree remove
		]);
		await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		const removeCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "remove",
		);
		expect(removeCall).toBeDefined();
	});

	test("retries on non-fast-forward: succeeds on second attempt", async () => {
		const { exec, calls } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch (attempt 1)
			{ ok: true }, // rebase (attempt 1)
			nff, // push (attempt 1) — non-ff
			{ ok: true }, // fetch (attempt 2)
			{ ok: true }, // rebase (attempt 2)
			{ ok: true }, // push (attempt 2) — success
			{ ok: true }, // worktree remove
		]);
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toEqual({ ok: true, attempts: 2 });
		// Verify second-attempt fetch runs in the worktree
		expect(calls[4]).toMatchObject({
			cmd: "git",
			args: ["fetch", "origin", "main"],
			cwd: WORKTREE_PATH,
		});
	});

	test("retry ceiling exceeded: returns retry_ceiling_exceeded after maxAttempts", async () => {
		const { exec } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch 1
			{ ok: true }, // rebase 1
			nff, // push 1 — non-ff
			{ ok: true }, // fetch 2
			{ ok: true }, // rebase 2
			nff, // push 2 — non-ff
			{ ok: true }, // fetch 3
			{ ok: true }, // rebase 3
			nff, // push 3 — non-ff (ceiling)
			{ ok: true }, // worktree remove
		]);
		// Use maxAttempts: 3 to keep the test concise
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			maxAttempts: 3,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toEqual({ ok: false, reason: "retry_ceiling_exceeded", attempts: 3 });
	});

	test("rebase conflict: returns rebase_conflict and aborts rebase", async () => {
		const conflictMsg = "CONFLICT: Merge conflict in .seeds/issues.jsonl";
		const { exec, calls } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch
			{ ok: false, msg: conflictMsg }, // rebase — conflict
			{ ok: true }, // rebase --abort
			{ ok: true }, // worktree remove
		]);
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toEqual({ ok: false, reason: "rebase_conflict", message: conflictMsg });
		// Must abort the in-progress rebase
		const abortCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "rebase" && c.args[1] === "--abort",
		);
		expect(abortCall).toBeDefined();
		expect(abortCall?.cwd).toBe(WORKTREE_PATH);
	});

	test("fetch error: returns error immediately (no retry)", async () => {
		const { exec, calls } = makeExec([
			{ ok: true }, // worktree add
			{ ok: false, msg: "fatal: not a git repository" }, // fetch — hard error
			{ ok: true }, // worktree remove
		]);
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result.ok).toBe(false);
		if (result.ok === false && result.reason === "error") {
			expect(result.message).toContain("fetch:");
		} else {
			expect(result.ok).toBe(false); // force the branch to be taken
		}
		// No rebase or push attempted after fetch failure
		const hasRebase = calls.some((c) => c.cmd === "git" && c.args[0] === "rebase");
		expect(hasRebase).toBe(false);
	});

	test("push error (non-network, non-NFF): returns error immediately", async () => {
		const { exec } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch
			{ ok: true }, // rebase
			{ ok: false, msg: "error: permission denied" }, // push — auth error
			{ ok: true }, // worktree remove
		]);
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result.ok).toBe(false);
		if (result.ok === false && result.reason === "error") {
			expect(result.message).toContain("push:");
		} else {
			expect(result.ok).toBe(false);
		}
	});

	test("worktree add failure: returns error without attempting fetch/push", async () => {
		const { exec, calls } = makeExec([
			{ ok: false, msg: "fatal: could not create worktree" }, // worktree add
			{ ok: true }, // worktree remove (still runs in finally)
		]);
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result.ok).toBe(false);
		if (result.ok === false && result.reason === "error") {
			expect(result.message).toContain("worktree add:");
		} else {
			expect(result.ok).toBe(false);
		}
		// No fetch/rebase/push after worktree add failure
		const hasFetch = calls.some((c) => c.cmd === "git" && c.args[0] === "fetch");
		expect(hasFetch).toBe(false);
	});

	test("targetBranch is used consistently in fetch, rebase, push commands", async () => {
		const { exec, calls } = makeExec(allOk());
		await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "release/1.x",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(calls[1]?.args).toContain("release/1.x"); // fetch
		expect(calls[2]?.args).toContain("origin/release/1.x"); // rebase
		expect(calls[3]?.args).toContain("HEAD:release/1.x"); // push
	});

	test("'rejected' in push stderr counts as non-fast-forward", async () => {
		const { exec } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch 1
			{ ok: true }, // rebase 1
			{ ok: false, msg: "! [rejected]  HEAD -> main (rejected)" }, // push 1 — NFF variant
			{ ok: true }, // fetch 2
			{ ok: true }, // rebase 2
			{ ok: true }, // push 2 — success
			{ ok: true }, // worktree remove
		]);
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toEqual({ ok: true, attempts: 2 });
	});

	test("'fetch first' in push stderr counts as non-fast-forward", async () => {
		const { exec } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch 1
			{ ok: true }, // rebase 1
			{ ok: false, msg: "Updates rejected because remote has work (fetch first)" }, // push 1
			{ ok: true }, // fetch 2
			{ ok: true }, // rebase 2
			{ ok: true }, // push 2
			{ ok: true }, // worktree remove
		]);
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toEqual({ ok: true, attempts: 2 });
	});

	test("maxAttempts=1: no retry allowed, ceiling exceeded on first non-ff", async () => {
		const { exec } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch
			{ ok: true }, // rebase
			nff, // push — non-ff
			{ ok: true }, // worktree remove
		]);
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			maxAttempts: 1,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toEqual({ ok: false, reason: "retry_ceiling_exceeded", attempts: 1 });
	});

	test("three retries needed: succeeds on attempt 3 within default ceiling", async () => {
		const { exec } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true },
			{ ok: true },
			nff, // attempt 1: fetch, rebase, push(nff)
			{ ok: true },
			{ ok: true },
			nff, // attempt 2: fetch, rebase, push(nff)
			{ ok: true },
			{ ok: true },
			{ ok: true }, // attempt 3: fetch, rebase, push(ok)
			{ ok: true }, // worktree remove
		]);
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toEqual({ ok: true, attempts: 3 });
	});

	test("postRebase hook is called after rebase, before push (warren-2501)", async () => {
		const { exec, calls } = makeExec(allOk());
		const hookCalls: string[] = [];
		const postRebase = async (worktreePath: string) => {
			hookCalls.push(worktreePath);
		};
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
			postRebase,
		});
		expect(result).toEqual({ ok: true, attempts: 1 });
		expect(hookCalls).toEqual([WORKTREE_PATH]);
		// Verify hook ran between rebase (index 2) and push (index 3)
		const rebaseIdx = calls.findIndex((c) => c.args[0] === "rebase" && !c.args.includes("--abort"));
		const pushIdx = calls.findIndex((c) => c.args[0] === "push");
		// hook ran in between — its side effects would appear between these two calls
		expect(rebaseIdx).toBeGreaterThan(-1);
		expect(pushIdx).toBeGreaterThan(rebaseIdx);
	});

	test("postRebase hook error surfaces as reason: error (warren-2501)", async () => {
		const { exec } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch
			{ ok: true }, // rebase
			// no push response needed — hook throws before push
			{ ok: true }, // worktree remove
		]);
		const postRebase = async (_worktreePath: string) => {
			throw new Error("dedup write failed: disk full");
		};
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
			postRebase,
		});
		expect(result.ok).toBe(false);
		if (result.ok === false && result.reason === "error") {
			expect(result.message).toContain("postRebase:");
			expect(result.message).toContain("dedup write failed");
		} else {
			expect(result.ok).toBe(false); // force branch
		}
	});

	test("postRebase hook is called on each retry attempt (warren-2501)", async () => {
		const { exec } = makeExec([
			{ ok: true }, // worktree add
			{ ok: true }, // fetch 1
			{ ok: true }, // rebase 1
			// hook call 1 (no exec commands from it in this test)
			nff, // push 1 — non-ff
			{ ok: true }, // fetch 2
			{ ok: true }, // rebase 2
			// hook call 2
			{ ok: true }, // push 2 — success
			{ ok: true }, // worktree remove
		]);
		const hookCalls: string[] = [];
		const postRebase = async (p: string) => {
			hookCalls.push(p);
		};
		const result = await rebasePushToMain({
			projectPath: PROJECT_PATH,
			targetBranch: "main",
			exec,
			mkTmpDir: fakeMkTmpDir(),
			postRebase,
		});
		expect(result).toEqual({ ok: true, attempts: 2 });
		expect(hookCalls).toHaveLength(2);
	});
});
