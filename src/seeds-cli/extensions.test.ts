import { describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnResult } from "../projects/clone.ts";
import { SeedsCliError } from "./errors.ts";
import {
	clearScheduledFor,
	closeSeed,
	listScheduledSeeds,
	updateExtensions,
} from "./extensions.ts";

function ok(stdout: string): SpawnResult {
	return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): SpawnResult {
	return { stdout: "", stderr, exitCode };
}

describe("listScheduledSeeds", () => {
	test("shells out with the configured sd binary and project cwd", async () => {
		const calls: { cmd: readonly string[]; cwd: string }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd });
			return ok(JSON.stringify({ issues: [] }));
		};
		await listScheduledSeeds({ spawn, sdBinary: "/opt/sd" }, "/data/projects/x/y");
		expect(calls).toEqual([
			{ cmd: ["/opt/sd", "list", "--format", "json"], cwd: "/data/projects/x/y" },
		]);
	});

	test("parses scheduled seeds from a real sd envelope", async () => {
		const envelope = JSON.stringify({
			success: true,
			issues: [
				{
					id: "warren-a",
					status: "open",
					title: "do thing",
					extensions: { scheduledFor: "2026-05-11T00:00:00.000Z" },
				},
				{ id: "warren-b", status: "open" },
			],
		});
		const spawn: SpawnFn = async () => ok(envelope);
		const result = await listScheduledSeeds({ spawn, sdBinary: "sd" }, "/p");
		expect(result.scheduled.map((s) => s.id)).toEqual(["warren-a"]);
	});

	test("throws SeedsCliError on a non-zero exit", async () => {
		const spawn: SpawnFn = async () => fail("seeds: no .seeds/ directory");
		await expect(listScheduledSeeds({ spawn, sdBinary: "sd" }, "/p")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});

	test("throws SeedsCliError on non-JSON stdout", async () => {
		const spawn: SpawnFn = async () => ok("seeds: argh");
		await expect(listScheduledSeeds({ spawn, sdBinary: "sd" }, "/p")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});

	test("throws SeedsCliError when the envelope shape doesn't match", async () => {
		const spawn: SpawnFn = async () => ok(JSON.stringify({ success: true }));
		await expect(listScheduledSeeds({ spawn, sdBinary: "sd" }, "/p")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});
});

describe("closeSeed", () => {
	test("shells out to sd close with the seed id", async () => {
		const calls: { cmd: readonly string[]; cwd: string }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd });
			return ok("");
		};
		await closeSeed({ spawn, sdBinary: "/opt/sd" }, "/data/projects/x/y", "warren-abc");
		expect(calls).toEqual([{ cmd: ["/opt/sd", "close", "warren-abc"], cwd: "/data/projects/x/y" }]);
	});

	test("throws SeedsCliError with a recoveryHint on a non-zero exit", async () => {
		const spawn: SpawnFn = async () => fail("seeds: no such issue");
		let caught: unknown;
		try {
			await closeSeed({ spawn, sdBinary: "sd" }, "/p", "warren-abc");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(SeedsCliError);
		expect((caught as SeedsCliError).recoveryHint).toBe(
			"run `sd show warren-abc` in /p to diagnose",
		);
	});
});

describe("clearScheduledFor", () => {
	test("merges {scheduledFor: null, lastScheduledRun: runId} via sd update", async () => {
		const calls: { cmd: readonly string[] }[] = [];
		const spawn: SpawnFn = async (cmd) => {
			calls.push({ cmd });
			return ok("{}");
		};
		await clearScheduledFor(
			{ spawn, sdBinary: "sd" },
			"/data/projects/x/y",
			"warren-abc",
			"run_xyz",
		);
		expect(calls).toHaveLength(1);
		const cmd = calls[0]?.cmd ?? [];
		expect(cmd[0]).toBe("sd");
		expect(cmd[1]).toBe("update");
		expect(cmd[2]).toBe("warren-abc");
		expect(cmd[3]).toBe("--extensions");
		expect(JSON.parse(cmd[4] ?? "{}")).toEqual({
			scheduledFor: null,
			lastScheduledRun: "run_xyz",
		});
	});

	test("throws SeedsCliError on a non-zero exit", async () => {
		const spawn: SpawnFn = async () => fail("nope");
		await expect(
			clearScheduledFor({ spawn, sdBinary: "sd" }, "/p", "warren-abc", "run_xyz"),
		).rejects.toBeInstanceOf(SeedsCliError);
	});
});

describe("updateExtensions", () => {
	test("shells out to sd update with the validated payload", async () => {
		const calls: { cmd: readonly string[]; cwd: string }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd });
			return ok("{}");
		};
		await updateExtensions({ spawn, sdBinary: "/opt/sd" }, "/data/projects/x/y", "warren-abc", {
			role: "claude-code",
			trigger: "manual",
			lastRunId: "run_xyz",
			lastRunAt: "2026-05-15T15:30:00.000Z",
		});
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one spawn call");
		expect(call.cwd).toBe("/data/projects/x/y");
		expect(call.cmd[0]).toBe("/opt/sd");
		expect(call.cmd[1]).toBe("update");
		expect(call.cmd[2]).toBe("warren-abc");
		expect(call.cmd[3]).toBe("--extensions");
		expect(JSON.parse(call.cmd[4] ?? "{}")).toEqual({
			role: "claude-code",
			trigger: "manual",
			lastRunId: "run_xyz",
			lastRunAt: "2026-05-15T15:30:00.000Z",
		});
	});

	test("supports the cron clear + lastRun merge in a single write", async () => {
		const calls: { cmd: readonly string[] }[] = [];
		const spawn: SpawnFn = async (cmd) => {
			calls.push({ cmd });
			return ok("{}");
		};
		await updateExtensions({ spawn, sdBinary: "sd" }, "/p", "warren-abc", {
			role: "claude-code",
			trigger: "cron",
			lastRunId: "run_xyz",
			lastRunAt: "2026-05-15T15:30:00.000Z",
			scheduledFor: null,
			lastScheduledRun: "run_xyz",
		});
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]?.cmd[4] ?? "{}")).toEqual({
			role: "claude-code",
			trigger: "cron",
			lastRunId: "run_xyz",
			lastRunAt: "2026-05-15T15:30:00.000Z",
			scheduledFor: null,
			lastScheduledRun: "run_xyz",
		});
	});

	test("rejects an invalid trigger string without shelling out", async () => {
		const calls: { cmd: readonly string[] }[] = [];
		const spawn: SpawnFn = async (cmd) => {
			calls.push({ cmd });
			return ok("{}");
		};
		await expect(
			updateExtensions({ spawn, sdBinary: "sd" }, "/p", "warren-abc", {
				trigger: "manual-trigger",
			} as unknown as Parameters<typeof updateExtensions>[3]),
		).rejects.toBeInstanceOf(SeedsCliError);
		expect(calls).toEqual([]);
	});

	test("rejects unknown keys (strict schema) without shelling out", async () => {
		const calls: { cmd: readonly string[] }[] = [];
		const spawn: SpawnFn = async (cmd) => {
			calls.push({ cmd });
			return ok("{}");
		};
		await expect(
			updateExtensions({ spawn, sdBinary: "sd" }, "/p", "warren-abc", {
				notAWarrenKey: "value",
			} as unknown as Parameters<typeof updateExtensions>[3]),
		).rejects.toBeInstanceOf(SeedsCliError);
		expect(calls).toEqual([]);
	});

	test("throws SeedsCliError with a recoveryHint on a non-zero exit", async () => {
		const spawn: SpawnFn = async () => fail("seeds: no such issue warren-abc");
		let caught: unknown;
		try {
			await updateExtensions({ spawn, sdBinary: "sd" }, "/p", "warren-abc", {
				role: "claude-code",
				trigger: "manual",
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(SeedsCliError);
		expect((caught as SeedsCliError).recoveryHint).toBe(
			"run `sd show warren-abc` in /p to diagnose",
		);
	});

	test("clearScheduledFor still merges {scheduledFor:null, lastScheduledRun} via updateExtensions", async () => {
		const calls: { cmd: readonly string[] }[] = [];
		const spawn: SpawnFn = async (cmd) => {
			calls.push({ cmd });
			return ok("{}");
		};
		await clearScheduledFor({ spawn, sdBinary: "sd" }, "/p", "warren-abc", "run_xyz");
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]?.cmd[4] ?? "{}")).toEqual({
			scheduledFor: null,
			lastScheduledRun: "run_xyz",
		});
	});
});
