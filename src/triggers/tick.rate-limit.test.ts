import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import { runTick } from "./tick.ts";

// -------------------------------------------------------------------------
// Rate-limited retry pass (warren-3f64)
// -------------------------------------------------------------------------

const NOW = new Date("2026-05-11T00:05:00.000Z");

function emptyConfig(): LoadedWarrenConfig {
	return {
		triggers: null,
		defaults: null,
		defaultsSource: null,
		prTemplate: null,
		errors: [],
		warnings: [],
	};
}

interface SilentLogger {
	logs: { level: "info" | "warn" | "error"; obj: Record<string, unknown>; msg?: string }[];
	info: (obj: Record<string, unknown>, msg?: string) => void;
	warn: (obj: Record<string, unknown>, msg?: string) => void;
	error: (obj: Record<string, unknown>, msg?: string) => void;
}

function makeLogger(): SilentLogger {
	const logs: SilentLogger["logs"] = [];
	return {
		logs,
		info: (obj, msg) => logs.push({ level: "info", obj, msg }),
		warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
		error: (obj, msg) => logs.push({ level: "error", obj, msg }),
	};
}

describe("runTick — rate-limited retry pass", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		db.drizzle
			.insert(agents)
			.values({
				name: "claude-code",
				renderedJson: { sections: {} },
				registeredAt: "2026-05-10T00:00:00.000Z",
				lastRefreshed: "2026-05-10T00:00:00.000Z",
			})
			.run();
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	test("past-due rate-limited run: spawns a replicate and clears resume_at (warren-3f64)", async () => {
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "do the thing",
			renderedAgentJson: { sections: {} },
			trigger: "cron",
		});
		await repos.runs.markRunning(run.id, NOW);
		await repos.runs.finalize(run.id, "failed", NOW, "rate_limited");
		await repos.runs.attachResumeAt(run.id, new Date("2026-05-10T23:00:00.000Z")); // past

		const spawnCalls: { parentRunId: string; resumeAttempts: number }[] = [];
		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "unused" }),
			retryRateLimited: async (input) => {
				spawnCalls.push({ parentRunId: input.parentRunId, resumeAttempts: input.resumeAttempts });
				return { runId: "run_retry001" };
			},
		});

		expect(spawnCalls).toEqual([{ parentRunId: run.id, resumeAttempts: 1 }]);
		// resume_at cleared — double-dispatch prevented on next tick
		const updated = await repos.runs.require(run.id);
		expect(updated.resumeAt).toBeNull();
	});

	test("rate-limited run not yet due: not retried (warren-3f64)", async () => {
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "not yet",
			renderedAgentJson: { sections: {} },
			trigger: "cron",
		});
		await repos.runs.markRunning(run.id, NOW);
		await repos.runs.finalize(run.id, "failed", NOW, "rate_limited");
		await repos.runs.attachResumeAt(run.id, new Date("2026-05-12T00:00:00.000Z")); // FUTURE

		const spawnCalls: string[] = [];
		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "unused" }),
			retryRateLimited: async (input) => {
				spawnCalls.push(input.parentRunId);
				return { runId: "run_unused" };
			},
		});

		expect(spawnCalls).toHaveLength(0);
		const row = await repos.runs.require(run.id);
		expect(row.resumeAt).not.toBeNull();
	});

	test("rate-limited retry: plan-run child is redirected to the new run (warren-3f64)", async () => {
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "plan child",
			renderedAgentJson: { sections: {} },
			trigger: "cron",
		});
		await repos.runs.markRunning(run.id, NOW);
		await repos.runs.finalize(run.id, "failed", NOW, "rate_limited");
		await repos.runs.attachResumeAt(run.id, new Date("2026-05-10T23:00:00.000Z"));

		const { planRun } = await repos.planRuns.create({
			projectId,
			planId: "pl-test-3f64",
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-child-3f64" }],
		});
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: 1,
			patch: { runId: run.id },
		});

		let retryRunId = "";
		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "unused" }),
			retryRateLimited: async (input) => {
				const retryRun = await repos.runs.create({
					agentName: input.agentName,
					projectId: input.projectId,
					prompt: input.prompt ?? "",
					renderedAgentJson: { sections: {} },
					trigger: input.trigger ?? "cron",
				});
				retryRunId = retryRun.id;
				return { runId: retryRun.id };
			},
		});

		expect(retryRunId).not.toBe("");
		const children = await repos.planRuns.listChildren(planRun.id);
		expect(children[0]?.runId).toBe(retryRunId);
	});

	test("rate-limited retry: spawn failure leaves resume_at intact for next tick (warren-3f64)", async () => {
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "will fail spawn",
			renderedAgentJson: { sections: {} },
			trigger: "cron",
		});
		await repos.runs.markRunning(run.id, NOW);
		await repos.runs.finalize(run.id, "failed", NOW, "rate_limited");
		const resumeAt = new Date("2026-05-10T23:00:00.000Z");
		await repos.runs.attachResumeAt(run.id, resumeAt);

		const logger = makeLogger();
		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "unused" }),
			retryRateLimited: async () => {
				throw new Error("burrow unreachable");
			},
			logger,
		});

		const row = await repos.runs.require(run.id);
		expect(row.resumeAt).toBe(resumeAt.toISOString());
		expect(logger.logs.some((l) => l.msg === "scheduler.rate_limited_retry_spawn_failed")).toBe(
			true,
		);
	});

	test("no retryRateLimited dep: rate-limited runs silently skipped (warren-3f64)", async () => {
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "no retry dep",
			renderedAgentJson: { sections: {} },
			trigger: "cron",
		});
		await repos.runs.markRunning(run.id, NOW);
		await repos.runs.finalize(run.id, "failed", NOW, "rate_limited");
		await repos.runs.attachResumeAt(run.id, new Date("2026-05-10T23:00:00.000Z"));

		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "unused" }),
			// retryRateLimited intentionally omitted
		});

		const row = await repos.runs.require(run.id);
		expect(row.resumeAt).not.toBeNull();
	});
});
