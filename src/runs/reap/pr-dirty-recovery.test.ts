import { describe, expect, test } from "bun:test";
import { recoverDirtyPr } from "./pr-dirty-recovery.ts";
import type { ReapExec, ReapFs } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* Test helpers                                                             */
/* ----------------------------------------------------------------------- */

const PROJECT_PATH = "/data/projects/owner/repo";
const WORKTREE_PATH = "/tmp/warren-dirty-recovery-test";
const RUN_BRANCH = "warren/run-abc123";
const DEFAULT_BRANCH = "main";

function fakeMkTmpDir(): () => Promise<string> {
	return async () => WORKTREE_PATH;
}

type CmdResponse = { ok: true; stdout?: string } | { ok: false; msg: string };

function makeExec(responses: CmdResponse[]): {
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
			return { stdout: resp.ok ? (resp.stdout ?? "") : "", stderr: "" };
		},
	};
	return { exec, calls };
}

function makeFs(files: Record<string, string> = {}): ReapFs & {
	written: Record<string, string>;
} {
	const written: Record<string, string> = {};
	return {
		mkdirp: async () => {},
		readFile: async (path) => files[path] ?? null,
		writeFile: async (path, content) => {
			written[path] = content;
		},
		readdir: async (path) => {
			const prefix = path.endsWith("/") ? path : `${path}/`;
			return Object.keys(files)
				.filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
				.map((k) => k.slice(prefix.length));
		},
		written,
	};
}

/** Minimal success response sequence: fetch, worktree add, rebase, push, worktree remove. */
function happyPath(): CmdResponse[] {
	return [
		{ ok: true }, // fetch origin <run-branch> <default-branch>
		{ ok: true }, // worktree add --detach <path> origin/<run-branch>
		{ ok: true }, // rebase origin/<default-branch>
		{ ok: true }, // push --force-with-lease origin HEAD:<run-branch>
		{ ok: true }, // worktree remove (in finally)
	];
}

/* ----------------------------------------------------------------------- */
/* recoverDirtyPr                                                           */
/* ----------------------------------------------------------------------- */

describe("recoverDirtyPr", () => {
	test("happy path: fetch + worktree add + rebase + push → recovered", async () => {
		const { exec, calls } = makeExec(happyPath());
		const fs = makeFs();
		const result = await recoverDirtyPr({
			runBranch: RUN_BRANCH,
			projectPath: PROJECT_PATH,
			defaultBranch: DEFAULT_BRANCH,
			exec,
			fs,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toBe("recovered");
		// fetch must include both the run branch and the default branch
		expect(calls[0]).toMatchObject({
			cmd: "git",
			args: ["fetch", "origin", RUN_BRANCH, DEFAULT_BRANCH],
			cwd: PROJECT_PATH,
		});
		// worktree add at the run-branch tip
		expect(calls[1]).toMatchObject({
			cmd: "git",
			args: ["worktree", "add", "--detach", WORKTREE_PATH, `origin/${RUN_BRANCH}`],
			cwd: PROJECT_PATH,
		});
		// rebase onto origin/main
		expect(calls[2]).toMatchObject({
			cmd: "git",
			args: ["rebase", `origin/${DEFAULT_BRANCH}`],
			cwd: WORKTREE_PATH,
		});
		// force-push
		expect(calls[3]).toMatchObject({
			cmd: "git",
			args: ["push", "--force-with-lease", "origin", `HEAD:${RUN_BRANCH}`],
			cwd: WORKTREE_PATH,
		});
		// worktree remove runs in finally
		expect(calls[4]).toMatchObject({
			cmd: "git",
			args: expect.arrayContaining(["worktree", "remove"]),
		});
	});

	test("rebase conflict → code_conflict, rebase --abort called, no push", async () => {
		const { exec, calls } = makeExec([
			{ ok: true }, // fetch
			{ ok: true }, // worktree add
			{ ok: false, msg: "CONFLICT (content): Merge conflict in src/server.ts" },
			{ ok: true }, // rebase --abort
			{ ok: true }, // worktree remove (finally)
		]);
		const result = await recoverDirtyPr({
			runBranch: RUN_BRANCH,
			projectPath: PROJECT_PATH,
			defaultBranch: DEFAULT_BRANCH,
			exec,
			fs: makeFs(),
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toBe("code_conflict");
		// push must NOT have been called
		expect(calls.some((c) => c.args.includes("push"))).toBe(false);
		// abort called after failed rebase
		const abortCall = calls.find((c) => c.args.includes("--abort"));
		expect(abortCall).toBeDefined();
	});

	test("fetch failure → error", async () => {
		const { exec } = makeExec([
			{ ok: false, msg: "fatal: repository not found" },
			{ ok: true }, // worktree remove (finally — won't run since worktree was never created)
		]);
		const result = await recoverDirtyPr({
			runBranch: RUN_BRANCH,
			projectPath: PROJECT_PATH,
			defaultBranch: DEFAULT_BRANCH,
			exec,
			fs: makeFs(),
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toBe("error");
	});

	test("push failure → error", async () => {
		const { exec } = makeExec([
			{ ok: true }, // fetch
			{ ok: true }, // worktree add
			{ ok: true }, // rebase
			{ ok: false, msg: "error: failed to push" },
			{ ok: true }, // worktree remove
		]);
		const result = await recoverDirtyPr({
			runBranch: RUN_BRANCH,
			projectPath: PROJECT_PATH,
			defaultBranch: DEFAULT_BRANCH,
			exec,
			fs: makeFs(),
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toBe("error");
	});

	test("dedup: seeds files with duplicate rows are amended before push", async () => {
		const issuesPath = `${WORKTREE_PATH}/.seeds/issues.jsonl`;
		const dupRow = '{"id":"warren-a","title":"foo"}';
		const body = `${dupRow}\n${dupRow}\n`;
		const fs = makeFs({ [issuesPath]: body });

		// After dedup we need a git add + diff-cached + amend + push sequence.
		// Build a response that tracks how many commands run.
		const responses: CmdResponse[] = [
			{ ok: true }, // fetch
			{ ok: true }, // worktree add
			{ ok: true }, // rebase
			// dedup: git add
			{ ok: true },
			// dedup: diff --cached (throw = has delta)
			{ ok: false, msg: "exit 1" },
			// dedup: commit --amend
			{ ok: true },
			{ ok: true }, // push
			{ ok: true }, // worktree remove
		];
		const { exec, calls } = makeExec(responses);
		const result = await recoverDirtyPr({
			runBranch: RUN_BRANCH,
			projectPath: PROJECT_PATH,
			defaultBranch: DEFAULT_BRANCH,
			exec,
			fs,
			mkTmpDir: fakeMkTmpDir(),
		});
		expect(result).toBe("recovered");
		// Deduped body should have been written
		expect(fs.written[issuesPath]).toBe(`${dupRow}\n`);
		// git add for the seeds file must have been called in the worktree
		const addCall = calls.find(
			(c) => c.cmd === "git" && c.args[0] === "add" && c.args.includes(".seeds/issues.jsonl"),
		);
		expect(addCall).toBeDefined();
		expect(addCall?.cwd).toBe(WORKTREE_PATH);
		// commit --amend must have been called
		expect(calls.some((c) => c.args.includes("--amend"))).toBe(true);
	});
});
