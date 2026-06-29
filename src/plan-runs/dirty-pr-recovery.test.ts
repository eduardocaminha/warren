/**
 * Unit tests for `recoverRunBranch` (warren-796b / pl-b5f1 step 6).
 *
 * Tests exercise the git-operation sequence by stubbing `exec` and `fs`
 * rather than running real git commands.
 */

import { describe, expect, test } from "bun:test";
import type { ReapExec, ReapFs } from "../runs/reap/types.ts";
import { recoverRunBranch } from "./dirty-pr-recovery.ts";

/* ----------------------------------------------------------------------- */
/* Stubs                                                                    */
/* ----------------------------------------------------------------------- */

interface ExecCall {
	cmd: string;
	args: readonly string[];
	cwd: string;
}

/**
 * Build a fake `ReapExec` that records all calls.
 *
 * `failOnCmd` maps a command-args substring to an error message. The first
 * matching call rejects; subsequent calls are unaffected (clear from the map
 * if you want single-fire behaviour).
 */
function makeExec(failOnCmd: Record<string, string> = {}): {
	exec: ReapExec;
	calls: ExecCall[];
} {
	const calls: ExecCall[] = [];
	const exec: ReapExec = {
		run: async (cmd, args, opts) => {
			calls.push({ cmd, args, cwd: opts.cwd });
			const key = Object.keys(failOnCmd).find((k) => `${cmd} ${args.join(" ")}`.includes(k));
			if (key !== undefined) {
				throw new Error(failOnCmd[key] ?? "stub error");
			}
			return { stdout: "", stderr: "" };
		},
	};
	return { exec, calls };
}

function makeFs(files: Record<string, string> = {}): {
	fs: ReapFs;
	written: Record<string, string>;
} {
	const written: Record<string, string> = {};
	const fs: ReapFs = {
		mkdirp: async () => {},
		readFile: async (path) => files[path] ?? null,
		writeFile: async (path, contents) => {
			written[path] = contents;
		},
		readdir: async (path) => {
			return Object.keys(files)
				.filter((f) => f.startsWith(`${path}/`))
				.map((f) => f.slice(path.length + 1).split("/")[0] ?? "")
				.filter((n, i, a) => a.indexOf(n) === i);
		},
	};
	return { fs, written };
}

const BASE = {
	projectPath: "/clone",
	runBranch: "burrow/run-abc",
	defaultBranch: "main",
	mkTmpDir: async () => "/tmp/test-worktree",
} as const;

/* ----------------------------------------------------------------------- */
/* Tests                                                                    */
/* ----------------------------------------------------------------------- */

describe("recoverRunBranch", () => {
	test("happy path: fetch + worktree + rebase + push → recovered", async () => {
		const { exec, calls } = makeExec();
		const { fs } = makeFs();

		const outcome = await recoverRunBranch({ ...BASE, exec, fs });

		expect(outcome).toBe("recovered");

		const cmds = calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
		expect(cmds[0]).toContain("git fetch origin burrow/run-abc main");
		expect(cmds[1]).toContain("git worktree add --detach /tmp/test-worktree origin/burrow/run-abc");
		expect(cmds[2]).toContain("git rebase origin/main");
		// No dedup (no JSONL files) — no add/amend
		expect(cmds[3]).toContain("git push --force-with-lease origin HEAD:burrow/run-abc");
		// Worktree cleanup
		expect(cmds[4]).toContain("git worktree remove --force /tmp/test-worktree");
	});

	test("fetch failure → noop", async () => {
		const { exec } = makeExec({ "git fetch": "network error" });
		const { fs } = makeFs();

		const outcome = await recoverRunBranch({ ...BASE, exec, fs });
		expect(outcome).toBe("noop");
	});

	test("worktree add failure → noop", async () => {
		const { exec } = makeExec({ "git worktree add": "already exists" });
		const { fs } = makeFs();

		const outcome = await recoverRunBranch({ ...BASE, exec, fs });
		expect(outcome).toBe("noop");
	});

	test("rebase conflict → abort → code_conflict", async () => {
		const { exec, calls } = makeExec({ "git rebase origin/main": "CONFLICT in src/foo.ts" });
		const { fs } = makeFs();

		const outcome = await recoverRunBranch({ ...BASE, exec, fs });
		expect(outcome).toBe("code_conflict");

		const abortCall = calls.find((c) => c.args.includes("--abort"));
		expect(abortCall).toBeDefined();
	});

	test("push failure (lease violated) → noop", async () => {
		const { exec } = makeExec({ "git push --force-with-lease": "stale info" });
		const { fs } = makeFs();

		const outcome = await recoverRunBranch({ ...BASE, exec, fs });
		expect(outcome).toBe("noop");
	});

	test("dedup: duplicate JSONL rows are deduped and commit is amended", async () => {
		const dup = '{"id":"i-1","v":1}\n{"id":"i-1","v":2}\n';
		const { exec, calls } = makeExec({
			// git diff --cached --quiet exits non-zero when there are staged changes
			"git diff --cached --quiet": "staged",
		});
		const { fs, written } = makeFs({
			"/tmp/test-worktree/.seeds/issues.jsonl": dup,
		});

		const outcome = await recoverRunBranch({ ...BASE, exec, fs });
		expect(outcome).toBe("recovered");

		// Deduped file has only the last occurrence of id "i-1".
		expect(written["/tmp/test-worktree/.seeds/issues.jsonl"]).toBe('{"id":"i-1","v":2}\n');

		// git add and git commit --amend were called.
		const addCall = calls.find((c) => c.cmd === "git" && c.args[0] === "add");
		expect(addCall).toBeDefined();
		const amendCall = calls.find((c) => c.cmd === "git" && c.args.includes("--amend"));
		expect(amendCall).toBeDefined();
	});

	test("worktree cleanup runs even when push fails", async () => {
		const { exec, calls } = makeExec({ "git push --force-with-lease": "rejected" });
		const { fs } = makeFs();

		await recoverRunBranch({ ...BASE, exec, fs });

		const removeCall = calls.find(
			(c) => c.cmd === "git" && c.args.includes("worktree") && c.args.includes("remove"),
		);
		expect(removeCall).toBeDefined();
	});
});
