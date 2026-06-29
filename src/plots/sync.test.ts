import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPlotSyncer } from "./sync.ts";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stubFetch(responses: ReadonlyArray<Response>): {
	fetch: typeof fetch;
	calls: { url: string; method: string }[];
} {
	const calls: { url: string; method: string }[] = [];
	let i = 0;
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
		const next = responses[i++];
		if (next === undefined) throw new Error("stubFetch: out of canned responses");
		return next;
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

describe("defaultPlotSyncer.sync", () => {
	test("returns no_op when no plot files are dirty", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "warren-sync-noop-"));
		const plotDir = join(tempDir, ".plot");
		mkdirSync(plotDir, { recursive: true });

		const spawnCalls: string[][] = [];
		const spawn = async (cmd: readonly string[]) => {
			spawnCalls.push(cmd as string[]);
			if (cmd.includes("status")) {
				return { stdout: "", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};

		try {
			const result = await defaultPlotSyncer.sync({
				projectPath: tempDir,
				gitUrl: "https://github.com/owner/repo.git",
				defaultBranch: "main",
				token: "ghp_test",
				handle: "alice",
				spawn,
				gitBinary: "git",
			});

			expect(result.kind).toBe("no_op");
			expect(spawnCalls).toHaveLength(1);
			expect(spawnCalls[0]).toEqual(["git", "status", "--porcelain", "--", ".plot/"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("immediate mode: pushes directly to main without opening a PR (warren-1312)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "warren-sync-immediate-"));
		const plotDir = join(tempDir, ".plot");
		mkdirSync(plotDir, { recursive: true });
		writeFileSync(join(plotDir, "plot-1.json"), '{"id":"plot-1"}');
		writeFileSync(join(plotDir, "plot-1.events.jsonl"), '{"event":"created"}\n');

		const spawnCalls: string[][] = [];
		const spawn = async (cmd: readonly string[]) => {
			spawnCalls.push(cmd as string[]);
			if (cmd.includes("status")) {
				return { stdout: " M .plot/plot-1.json\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};

		// No fetch stubs — immediate mode must not call the GitHub API.
		const { fetch: noCallFetch, calls: fetchCalls } = stubFetch([]);

		try {
			const result = await defaultPlotSyncer.sync({
				projectPath: tempDir,
				gitUrl: "https://github.com/owner/repo",
				defaultBranch: "main",
				token: "ghp_test",
				handle: "alice",
				plotSyncConfig: {
					mergeStrategy: "immediate",
					targetBranch: "main",
				},
				spawn,
				fetch: noCallFetch,
				gitBinary: "git",
			});

			expect(result.kind).toBe("direct_push");
			if (result.kind === "direct_push") {
				expect(result.targetBranch).toBe("main");
				expect(result.attempts).toBeGreaterThanOrEqual(1);
			}

			// No PR-related API calls.
			expect(fetchCalls).toHaveLength(0);

			// Direct-push git flow: status, fetch (prune), worktree add (detached),
			// add, commit, fetch (retry loop), rebase, push HEAD:<target>, worktree remove.
			const hasCommand = (subcmd: string) => spawnCalls.some((c) => c.includes(subcmd));
			expect(hasCommand("status")).toBe(true);
			expect(hasCommand("fetch")).toBe(true);
			expect(hasCommand("worktree")).toBe(true);
			expect(hasCommand("add")).toBe(true);
			expect(hasCommand("commit")).toBe(true);
			// Push must target HEAD:main (not a PR branch).
			expect(spawnCalls.some((c) => c.includes("push") && c.includes("HEAD:main"))).toBe(true);
			// No PR branch (warren/plot-sync-*) pushed.
			expect(
				spawnCalls.some(
					(c) => c.includes("push") && c.some((arg) => arg.startsWith("warren/plot-sync-")),
				),
			).toBe(false);
			// Worktree is detached (--detach), not a named branch.
			expect(
				spawnCalls.some(
					(c) => c.includes("worktree") && c.includes("add") && c.includes("--detach"),
				),
			).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("auto mode: pushes directly to main without opening a PR (warren-1312)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "warren-sync-auto-"));
		const plotDir = join(tempDir, ".plot");
		mkdirSync(plotDir, { recursive: true });
		writeFileSync(join(plotDir, "plot-2.events.jsonl"), '{"event":"updated"}\n');

		const spawnCalls: string[][] = [];
		const spawn = async (cmd: readonly string[]) => {
			spawnCalls.push(cmd as string[]);
			if (cmd.includes("status")) {
				return { stdout: " M .plot/plot-2.events.jsonl\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};

		const { fetch: noCallFetch, calls: fetchCalls } = stubFetch([]);

		try {
			const result = await defaultPlotSyncer.sync({
				projectPath: tempDir,
				gitUrl: "https://github.com/owner/repo",
				defaultBranch: "main",
				token: "ghp_test",
				handle: "alice",
				plotSyncConfig: { mergeStrategy: "auto" },
				spawn,
				fetch: noCallFetch,
				gitBinary: "git",
			});

			expect(result.kind).toBe("direct_push");
			if (result.kind === "direct_push") {
				expect(result.targetBranch).toBe("main");
			}
			expect(fetchCalls).toHaveLength(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("respects manual mergeStrategy and opens a PR (unchanged path)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "warren-sync-manual-"));
		const plotDir = join(tempDir, ".plot");
		mkdirSync(plotDir, { recursive: true });
		writeFileSync(join(plotDir, "plot-1.json"), '{"id":"plot-1"}');

		const spawnCalls: string[][] = [];
		const spawn = async (cmd: readonly string[]) => {
			spawnCalls.push(cmd as string[]);
			if (cmd.includes("status")) {
				return { stdout: " M .plot/plot-1.json\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};

		const { fetch, calls: fetchCalls } = stubFetch([
			jsonResponse(201, { html_url: "https://github.com/owner/repo/pull/100" }),
		]);

		try {
			const result = await defaultPlotSyncer.sync({
				projectPath: tempDir,
				gitUrl: "https://github.com/owner/repo",
				defaultBranch: "main",
				token: "ghp_test",
				handle: "bob",
				plotSyncConfig: {
					mergeStrategy: "manual",
				},
				spawn,
				fetch,
				gitBinary: "git",
			});

			expect(result.kind).toBe("synced");
			if (result.kind === "synced") {
				expect(result.prUrl).toBe("https://github.com/owner/repo/pull/100");
				expect(result.prNumber).toBe(100);
				expect(result.merged).toBe(false);
			}

			expect(fetchCalls).toHaveLength(1);
			expect(fetchCalls[0]?.url).toBe("https://api.github.com/repos/owner/repo/pulls");
			// PR branch (warren/plot-sync-*) is pushed.
			expect(
				spawnCalls.some(
					(c) => c.includes("push") && c.some((arg) => arg.startsWith("warren/plot-sync-")),
				),
			).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
