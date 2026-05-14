import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db/client.ts";
import type { PortUsage } from "../preview/port-allocator.ts";
import type { SpawnFn } from "../projects/clone.ts";
import { type LoadedWarrenConfig, WarrenConfigUnavailableError } from "../warren-config/index.ts";
import {
	checkBwrap,
	checkCanopyClean,
	checkCanopyClone,
	checkDatabaseReachable,
	checkPreviewAuthStrength,
	checkPreviewMaxLive,
	checkPreviewPortAllocator,
	checkWarrenConfig,
	checkWarrenDb,
} from "./checks.ts";

const captureSpawnCalls = (
	results: Record<string, { stdout?: string; stderr?: string; exitCode: number }>,
): { spawn: SpawnFn; calls: { cmd: readonly string[]; cwd: string }[] } => {
	const calls: { cmd: readonly string[]; cwd: string }[] = [];
	const spawn: SpawnFn = async (cmd, opts) => {
		calls.push({ cmd, cwd: opts.cwd });
		const key = cmd[0] ?? "";
		const result = results[key] ?? results[Object.keys(results).find((k) => key.endsWith(k)) ?? ""];
		if (result === undefined) {
			throw new Error(`unexpected spawn: ${cmd.join(" ")}`);
		}
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode,
		};
	};
	return { spawn, calls };
};

describe("checkBwrap", () => {
	test("ok when bwrap --version exits 0", async () => {
		const { spawn, calls } = captureSpawnCalls({
			bwrap: { stdout: "bubblewrap 0.8.0\n", exitCode: 0 },
		});
		const result = await checkBwrap({ spawn });
		expect(result.ok).toBe(true);
		expect(result.message).toBe("bubblewrap 0.8.0");
		expect(calls[0]?.cmd).toEqual(["bwrap", "--version"]);
	});

	test("fails with the bubblewrap install hint when exit non-zero", async () => {
		const { spawn } = captureSpawnCalls({
			bwrap: { stderr: "command not found", exitCode: 127 },
		});
		const result = await checkBwrap({ spawn });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("127");
		expect(result.hint).toContain("bubblewrap");
	});

	test("fails with hint when spawn throws (binary missing)", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("ENOENT bwrap");
		};
		const result = await checkBwrap({ spawn });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("ENOENT");
		expect(result.hint).toContain("bubblewrap");
	});

	test("respects bwrapBinary override", async () => {
		const { spawn, calls } = captureSpawnCalls({
			"/usr/local/bin/bwrap": { stdout: "bubblewrap 0.8.0", exitCode: 0 },
		});
		await checkBwrap({ spawn, bwrapBinary: "/usr/local/bin/bwrap" });
		expect(calls[0]?.cmd).toEqual(["/usr/local/bin/bwrap", "--version"]);
	});
});

describe("checkCanopyClone", () => {
	test("ok with informational message when CANOPY_REPO_URL unset (warren-d3e9)", () => {
		const result = checkCanopyClone({ env: {}, exists: () => true });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no canopy library configured");
	});

	test("fails when the local dir does not exist", () => {
		const result = checkCanopyClone({
			env: { CANOPY_REPO_URL: "https://x/y.git", WARREN_CANOPY_DIR: "/missing" },
			exists: () => false,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("/missing");
		expect(result.hint).toContain("/agents/refresh");
	});

	test("ok when local dir exists", () => {
		const result = checkCanopyClone({
			env: { CANOPY_REPO_URL: "https://x/y.git", WARREN_CANOPY_DIR: "/cn" },
			exists: () => true,
		});
		expect(result.ok).toBe(true);
		expect(result.message).toBe("/cn");
	});
});

describe("checkCanopyClean", () => {
	const baseEnv = { CANOPY_REPO_URL: "https://x/y.git", WARREN_CANOPY_DIR: "/cn" };

	test("ok with informational message when CANOPY_REPO_URL unset (warren-d3e9)", async () => {
		const { spawn, calls } = captureSpawnCalls({});
		const result = await checkCanopyClean({ env: {}, spawn, exists: () => true });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no canopy library configured");
		expect(calls.length).toBe(0);
	});

	test("fails when the local dir does not exist", async () => {
		const { spawn, calls } = captureSpawnCalls({});
		const result = await checkCanopyClean({ env: baseEnv, spawn, exists: () => false });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("/cn");
		// Should not shell out when the dir is missing.
		expect(calls.length).toBe(0);
	});

	test("ok when git status --porcelain is empty", async () => {
		const { spawn, calls } = captureSpawnCalls({
			git: { stdout: "", exitCode: 0 },
		});
		const result = await checkCanopyClean({ env: baseEnv, spawn, exists: () => true });
		expect(result.ok).toBe(true);
		expect(calls[0]?.cmd).toEqual(["git", "status", "--porcelain"]);
		expect(calls[0]?.cwd).toBe("/cn");
	});

	test("fails with mutation count when porcelain reports dirt", async () => {
		const { spawn } = captureSpawnCalls({
			git: { stdout: " M a.md\n?? b\n", exitCode: 0 },
		});
		const result = await checkCanopyClean({ env: baseEnv, spawn, exists: () => true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("2 local mutation");
		expect(result.hint).toContain("/agents/refresh");
	});

	test("fails when git exits non-zero", async () => {
		const { spawn } = captureSpawnCalls({
			git: { stderr: "fatal: not a git repository", exitCode: 128 },
		});
		const result = await checkCanopyClean({ env: baseEnv, spawn, exists: () => true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("128");
	});

	test("fails when spawn itself throws", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("ENOENT git");
		};
		const result = await checkCanopyClean({ env: baseEnv, spawn, exists: () => true });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("ENOENT");
	});

	test("uses configured gitBinary", async () => {
		const { spawn, calls } = captureSpawnCalls({
			"/opt/git": { stdout: "", exitCode: 0 },
		});
		await checkCanopyClean({
			env: { ...baseEnv, WARREN_GIT_BINARY: "/opt/git" },
			spawn,
			exists: () => true,
		});
		expect(calls[0]?.cmd[0]).toBe("/opt/git");
	});
});

describe("checkWarrenConfig", () => {
	const empty: LoadedWarrenConfig = { triggers: null, defaults: null, errors: [] };
	const valid: LoadedWarrenConfig = {
		triggers: [],
		defaults: { defaultBranch: "main" },
		errors: [],
	};

	test("ok with informational message when no projects registered", async () => {
		const result = await checkWarrenConfig({ projects: [] });
		expect(result.name).toBe("warren_config");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no projects registered");
	});

	test("ok when every project's .warren/ is absent or valid (covers states 1+2)", async () => {
		const calls: string[] = [];
		const result = await checkWarrenConfig({
			projects: [
				{ id: "prj_absent", localPath: "/clones/a" },
				{ id: "prj_valid", localPath: "/clones/b" },
			],
			load: async (path) => {
				calls.push(path);
				return path === "/clones/a" ? empty : valid;
			},
		});
		expect(calls).toEqual(["/clones/a", "/clones/b"]);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("2 project(s) checked");
	});

	test("fails with file paths when any project's .warren/ is malformed (state 3)", async () => {
		const malformed: LoadedWarrenConfig = {
			triggers: null,
			defaults: { defaultBranch: "main" },
			errors: [
				{
					file: ".warren/triggers.yaml",
					code: "warren_config_parse_error",
					message: "YAML parse error: bad indent",
				},
			],
		};
		const result = await checkWarrenConfig({
			projects: [
				{ id: "prj_ok", localPath: "/clones/a" },
				{ id: "prj_bad", localPath: "/clones/b" },
			],
			load: async (path) => (path === "/clones/a" ? valid : malformed),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("prj_bad .warren/triggers.yaml");
		expect(result.message).toContain("YAML parse error");
		expect(result.hint).toContain("/refresh");
	});

	test("fails when a project clone has vanished (WarrenConfigUnavailableError)", async () => {
		const result = await checkWarrenConfig({
			projects: [{ id: "prj_gone", localPath: "/clones/missing" }],
			load: async () => {
				throw new WarrenConfigUnavailableError("project clone missing on disk: /clones/missing");
			},
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("prj_gone");
		expect(result.message).toContain("clone missing");
	});

	test("aggregates errors across many projects", async () => {
		const malformed: LoadedWarrenConfig = {
			triggers: null,
			defaults: null,
			errors: [
				{
					file: ".warren/defaults.json",
					code: "warren_config_schema_error",
					message: "branch: required",
				},
			],
		};
		const result = await checkWarrenConfig({
			projects: [
				{ id: "p1", localPath: "/c/p1" },
				{ id: "p2", localPath: "/c/p2" },
				{ id: "p3", localPath: "/c/p3" },
			],
			load: async (path) => (path === "/c/p2" ? malformed : valid),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("1 .warren/ failure(s) across 3 project(s)");
		expect(result.message).toContain("p2 .warren/defaults.json");
	});

	test("reads through the cache when supplied (shares parses with HTTP surface)", async () => {
		const seen: { id: string; path: string }[] = [];
		const cache = {
			get: async (id: string, path: string): Promise<LoadedWarrenConfig> => {
				seen.push({ id, path });
				return valid;
			},
			invalidate: () => undefined,
			clear: () => undefined,
			size: () => 0,
		};
		const result = await checkWarrenConfig({
			projects: [{ id: "prj_a", localPath: "/c/a" }],
			cache,
			load: async () => empty,
		});
		expect(seen).toEqual([{ id: "prj_a", path: "/c/a" }]);
		expect(result.ok).toBe(true);
	});
});

describe("checkWarrenDb", () => {
	test("ok with informational message when neither env var is set", () => {
		const result = checkWarrenDb({ env: {} });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("will default to sqlite");
	});

	test("ok and reports sqlite path when WARREN_DB_URL is sqlite://", () => {
		const result = checkWarrenDb({ env: { WARREN_DB_URL: "sqlite:///data/warren.db" } });
		expect(result.ok).toBe(true);
		expect(result.message).toBe("sqlite /data/warren.db");
	});

	test("ok and reports postgres when WARREN_DB_URL is postgres://", () => {
		const result = checkWarrenDb({ env: { WARREN_DB_URL: "postgres://u:p@h/db" } });
		expect(result.ok).toBe(true);
		expect(result.message).toBe("postgres");
	});

	test("synthesizes a sqlite url from legacy WARREN_DB_PATH", () => {
		const result = checkWarrenDb({ env: { WARREN_DB_PATH: "/srv/warren.db" } });
		expect(result.ok).toBe(true);
		expect(result.message).toBe("sqlite /srv/warren.db");
	});

	test("ok when WARREN_DB_URL and WARREN_DB_PATH agree (sqlite synthesis matches URL)", () => {
		const result = checkWarrenDb({
			env: {
				WARREN_DB_URL: "sqlite:///srv/warren.db",
				WARREN_DB_PATH: "/srv/warren.db",
			},
		});
		expect(result.ok).toBe(true);
	});

	test("fails when WARREN_DB_URL (postgres) and WARREN_DB_PATH (sqlite) disagree", () => {
		const result = checkWarrenDb({
			env: {
				WARREN_DB_URL: "postgres://h/db",
				WARREN_DB_PATH: "/srv/legacy.sqlite",
			},
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("disagree");
		expect(result.hint).toContain("WARREN_DB_URL wins");
	});

	test("fails when WARREN_DB_URL is malformed", () => {
		const result = checkWarrenDb({ env: { WARREN_DB_URL: "sqlite://" } });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("sqlite URL has no path");
	});
});

describe("checkDatabaseReachable", () => {
	test("degrades to informational ok when no db handle wired", async () => {
		const result = await checkDatabaseReachable({});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no db handle wired");
	});

	test("pings a live sqlite handle and reports dialect=sqlite", async () => {
		const db = await openDatabase({ url: ":memory:" });
		try {
			const result = await checkDatabaseReachable({ db });
			expect(result.ok).toBe(true);
			expect(result.message).toBe("dialect=sqlite");
		} finally {
			await db.close();
		}
	});

	test("returns ok=false with the underlying error when ping throws", async () => {
		const db = await openDatabase({ url: ":memory:" });
		await db.close();
		const result = await checkDatabaseReachable({ db });
		expect(result.ok).toBe(false);
		expect(result.hint).toContain("sqlite");
	});
});

describe("checkPreviewPortAllocator", () => {
	const usageProbe = (usage: PortUsage) => ({
		usage: async () => usage,
	});

	test("ok when under the warn threshold", async () => {
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 5, total: 10, range: { start: 30000, end: 30009 } }),
		});
		expect(result.name).toBe("preview_port_allocator");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("5/10");
		expect(result.message).toContain("30000-30009");
	});

	test("fails at exactly the warn threshold (≥80%)", async () => {
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 8, total: 10, range: { start: 30000, end: 30009 } }),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("8/10");
		expect(result.message).toContain("80%");
		expect(result.hint).toContain("WARREN_PREVIEW_PORT_RANGE");
	});

	test("fails when saturation is above threshold", async () => {
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 1001, total: 1001, range: { start: 30000, end: 31000 } }),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("1001/1001");
	});

	test("respects an override warnRatio", async () => {
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 5, total: 10, range: { start: 30000, end: 30009 } }),
			warnRatio: 0.5,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("50%");
	});

	test("ok message survives a zero in-use snapshot", async () => {
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 0, total: 1001, range: { start: 30000, end: 31000 } }),
		});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("0/1001");
	});

	test("treats a zero-total range as fully saturated (defensive)", async () => {
		// total=0 should never occur in production (constructor rejects an
		// inverted range), but the check shouldn't divide by zero — clamp
		// to ratio=1 so the operator gets a clear failure instead of NaN.
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 0, total: 0, range: { start: 30000, end: 30000 } }),
		});
		expect(result.ok).toBe(false);
	});

	test("fails with the probe error message when usage() throws", async () => {
		const result = await checkPreviewPortAllocator({
			probe: {
				usage: async () => {
					throw new Error("db handle closed");
				},
			},
		});
		expect(result.ok).toBe(false);
		expect(result.message).toBe("db handle closed");
		expect(result.hint).toContain("migration 0009");
	});
});

describe("checkPreviewMaxLive", () => {
	test("ok under the warn threshold", async () => {
		const result = await checkPreviewMaxLive({
			probe: { count: async () => 10 },
			maxLive: 20,
		});
		expect(result.name).toBe("preview_max_live");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("10/20");
	});

	test("fails at exactly 80% saturation", async () => {
		const result = await checkPreviewMaxLive({
			probe: { count: async () => 16 },
			maxLive: 20,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("16/20");
		expect(result.message).toContain("80%");
		expect(result.hint).toContain("WARREN_PREVIEW_MAX_LIVE");
	});

	test("respects an override warnRatio", async () => {
		const result = await checkPreviewMaxLive({
			probe: { count: async () => 5 },
			maxLive: 10,
			warnRatio: 0.5,
		});
		expect(result.ok).toBe(false);
	});

	test("clamps a zero-cap to fully saturated", async () => {
		const result = await checkPreviewMaxLive({
			probe: { count: async () => 0 },
			maxLive: 0,
		});
		expect(result.ok).toBe(false);
	});

	test("fails with the probe error message when count() throws", async () => {
		const result = await checkPreviewMaxLive({
			probe: {
				count: async () => {
					throw new Error("db handle closed");
				},
			},
			maxLive: 20,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toBe("db handle closed");
		expect(result.hint).toContain("migration 0009");
	});
});

describe("checkPreviewAuthStrength", () => {
	const STRONG_TOKEN = "1f3a2b9c0d4e5f6789abcdef0123456789abcdef0123456789abcdef01234567";

	test("ok and informational when WARREN_PREVIEW_HOST is unset", () => {
		const result = checkPreviewAuthStrength({ env: {} });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("WARREN_PREVIEW_HOST unset");
	});

	test("ok when host is set + token is strong", () => {
		const result = checkPreviewAuthStrength({
			env: { WARREN_PREVIEW_HOST: "preview.example.com", WARREN_API_TOKEN: STRONG_TOKEN },
		});
		expect(result.ok).toBe(true);
	});

	test("fails when host is set + token is empty", () => {
		const result = checkPreviewAuthStrength({
			env: { WARREN_PREVIEW_HOST: "preview.example.com", WARREN_API_TOKEN: "" },
		});
		expect(result.ok).toBe(false);
		expect(result.hint).toContain("openssl rand -hex 32");
	});

	test("fails when token matches a documented placeholder", () => {
		for (const placeholder of ["changeme", "Placeholder", "warren-token", "your-token-here"]) {
			const result = checkPreviewAuthStrength({
				env: { WARREN_PREVIEW_HOST: "preview.example.com", WARREN_API_TOKEN: placeholder },
			});
			expect(result.ok).toBe(false);
			expect(result.message).toContain("placeholder");
		}
	});

	test("fails when token is shorter than the minimum strength", () => {
		const result = checkPreviewAuthStrength({
			env: { WARREN_PREVIEW_HOST: "preview.example.com", WARREN_API_TOKEN: "shorty" },
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("preview surface needs");
	});

	test("blank WARREN_PREVIEW_HOST is treated as unset", () => {
		const result = checkPreviewAuthStrength({
			env: { WARREN_PREVIEW_HOST: "   ", WARREN_API_TOKEN: "shorty" },
		});
		expect(result.ok).toBe(true);
	});
});
