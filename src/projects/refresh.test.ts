import { describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnResult } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { refreshProjectClone } from "./refresh.ts";

const CFG: ProjectsConfig = { root: "/data/projects", gitBinary: "git" };

interface Recorded {
	cmd: readonly string[];
	cwd: string;
}

function recorder(handler: (cmd: readonly string[]) => SpawnResult): {
	spawn: SpawnFn;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const spawn: SpawnFn = async (cmd, opts) => {
		calls.push({ cmd, cwd: opts.cwd });
		return handler(cmd);
	};
	return { spawn, calls };
}

function ok(stdout = ""): SpawnResult {
	return { stdout, stderr: "", exitCode: 0 };
}

describe("refreshProjectClone", () => {
	test("fetches, checks out ref, hard-resets to origin/<ref>, scrubs stale user identity, and returns HEAD sha", async () => {
		const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
		});

		expect(result).toEqual({ headSha: sha, ref: "main" });
		expect(calls.map((c) => c.cmd[1])).toEqual([
			"fetch",
			"checkout",
			"reset",
			"config",
			"config",
			"rev-parse",
		]);
		expect(calls[0]?.cmd).toEqual(["git", "fetch", "--prune", "origin"]);
		expect(calls[1]?.cmd).toEqual(["git", "checkout", "--force", "main"]);
		expect(calls[2]?.cmd).toEqual(["git", "reset", "--hard", "origin/main"]);
		expect(calls[3]?.cmd).toEqual(["git", "config", "--local", "--unset-all", "user.name"]);
		expect(calls[4]?.cmd).toEqual(["git", "config", "--local", "--unset-all", "user.email"]);
		expect(calls.every((c) => c.cwd === "/data/projects/x/y")).toBe(true);
	});

	test("tolerates the user identity scrub exiting non-zero when keys are absent (warren-9f70)", async () => {
		const sha = "abcabcabcabcabcabcabcabcabcabcabcabcabca";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "config" && cmd.includes("--unset-all")) {
				// Real git exits 5 ("no such key") when the key is absent —
				// the normal case for clean clones.
				return { stdout: "", stderr: "", exitCode: 5 };
			}
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
		});

		expect(result.headSha).toBe(sha);
		// rev-parse still runs after a failed unset: the scrub is
		// best-effort and must not abort the refresh.
		expect(calls.map((c) => c.cmd[1])).toContain("rev-parse");
	});

	test("falls back to plain reset --hard <ref> when origin/<ref> does not resolve", async () => {
		const sha = "1111111111111111111111111111111111111111";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "reset" && cmd[3] === "origin/v1.2.3") {
				return { stdout: "", stderr: "unknown revision", exitCode: 128 };
			}
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "v1.2.3",
			spawn,
			exists: () => true,
		});

		expect(result.headSha).toBe(sha);
		const resetCalls = calls.filter((c) => c.cmd[1] === "reset");
		expect(resetCalls.map((c) => c.cmd[3])).toEqual(["origin/v1.2.3", "v1.2.3"]);
	});

	test("throws ProjectUnavailableError when localPath does not exist", async () => {
		const { spawn } = recorder(() => ok());
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/missing",
				ref: "main",
				spawn,
				exists: () => false,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});

	test("throws ProjectUnavailableError when fetch fails", async () => {
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "fetch") {
				return { stdout: "", stderr: "fatal: could not read", exitCode: 128 };
			}
			return ok();
		});
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});

	test("wraps spawn-level failures (e.g. ENOENT for git binary) as ProjectUnavailableError", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("ENOENT: git not found");
		};
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});

	test("throws ProjectUnavailableError when rev-parse returns empty", async () => {
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok("\n");
			return ok();
		});
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});
});
