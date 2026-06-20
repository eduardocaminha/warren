import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { RateLimitConfig } from "./config.ts";
import type { CoordinatorShowSeedFn, CoordinatorSpawnFn } from "./coordinator.ts";
import type { PrMergeChecker } from "./pr-merge.ts";
import { bootPlanRunCoordinator, runPlanRunTick } from "./tick.ts";

const NOW = new Date("2026-05-17T00:00:00.000Z");

const noopPoll: PrMergeChecker = async () => ({ kind: "open" });
const openSeed: CoordinatorShowSeedFn = async (_p, id) => ({ id, status: "open" });

interface Harness {
	db: WarrenDb;
	repos: Repos;
	projectId: string;
}

async function setup(): Promise<Harness> {
	const db = await openDatabase({ path: ":memory:" });
	db.drizzle
		.insert(agents)
		.values({
			name: "claude-code",
			renderedJson: { sections: {} },
			registeredAt: "2026-05-10T00:00:00.000Z",
			lastRefreshed: "2026-05-10T00:00:00.000Z",
		})
		.run();
	const repos = createRepos(db);
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	return { db, repos, projectId: project.id };
}

describe("runPlanRunTick", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("returns empty advances + errors when no plan_runs are active", async () => {
		const result = await runPlanRunTick({
			repos: h.repos,
			showSeed: openSeed,
			checkPrMerged: noopPoll,
			spawn: async () => ({ runId: "unused" }),
			now: () => NOW,
		});
		expect(result.advances).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("per-PlanRun isolation: one throwing advance doesn't stop the others", async () => {
		const a = await h.repos.planRuns.create({
			planId: "pl-a",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const b = await h.repos.planRuns.create({
			planId: "pl-b",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-b" }],
			now: NOW,
		});

		const dispatched: string[] = [];
		const spawn: CoordinatorSpawnFn = async ({ planRun, child, prompt }) => {
			if (planRun.id === a.planRun.id) {
				throw new Error("boom");
			}
			const run = await h.repos.runs.create({
				agentName: "claude-code",
				projectId: h.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
			});
			dispatched.push(run.id);
			return { runId: run.id };
		};

		const result = await runPlanRunTick({
			repos: h.repos,
			showSeed: openSeed,
			checkPrMerged: noopPoll,
			spawn,
			now: () => NOW,
		});

		// Both PlanRuns must have been visited despite the boom on `a`.
		expect(result.advances).toHaveLength(2);
		const reloadedA = await h.repos.planRuns.require(a.planRun.id);
		const reloadedB = await h.repos.planRuns.require(b.planRun.id);
		// Plan A's child failed to dispatch → coordinator marked the plan failed
		// (the throw inside spawn is converted into an AdvanceResult, not a tick-
		// level error). Plan B dispatched cleanly.
		expect(reloadedA.state).toBe("failed");
		expect(reloadedA.failureReason).toContain("dispatch_failed");
		expect(reloadedB.state).toBe("running");
		expect(dispatched).toHaveLength(1);
		expect(result.errors).toEqual([]);
	});

	test("catches internal coordinator errors per-PlanRun via the tick try/catch", async () => {
		const a = await h.repos.planRuns.create({
			planId: "pl-a",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const b = await h.repos.planRuns.create({
			planId: "pl-b",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-b" }],
			now: NOW,
		});

		let spawned = 0;
		const spawn: CoordinatorSpawnFn = async ({ child, prompt }) => {
			spawned += 1;
			const run = await h.repos.runs.create({
				agentName: "claude-code",
				projectId: h.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
			});
			return { runId: run.id };
		};

		// Force a coordinator throw on plan A by making listChildren raise via
		// a poisoned showSeed for warren-a.
		const showSeed: CoordinatorShowSeedFn = async (_p, id) => {
			if (id === "warren-a") throw new Error("showSeed exploded");
			return { id, status: "open" };
		};

		const result = await runPlanRunTick({
			repos: h.repos,
			showSeed,
			checkPrMerged: noopPoll,
			spawn,
			now: () => NOW,
		});

		// showSeed throw is caught inside the coordinator → returns noop, not an
		// advance error. Plan B still advances.
		expect(result.errors).toEqual([]);
		expect(result.advances).toHaveLength(2);
		const aAdvance = result.advances.find((adv) => adv.planRunId === a.planRun.id);
		expect(aAdvance?.result.kind).toBe("noop");
		const bAdvance = result.advances.find((adv) => adv.planRunId === b.planRun.id);
		expect(bAdvance?.result.kind).toBe("dispatched");
		expect(spawned).toBe(1);
	});

	test("default emit appends plan_run.* system events to the dispatched child run", async () => {
		await h.repos.planRuns.create({
			planId: "pl-a",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const spawn: CoordinatorSpawnFn = async ({ child, prompt }) => {
			const run = await h.repos.runs.create({
				agentName: "claude-code",
				projectId: h.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
			});
			return { runId: run.id };
		};

		await runPlanRunTick({
			repos: h.repos,
			showSeed: openSeed,
			checkPrMerged: noopPoll,
			spawn,
			now: () => NOW,
		});

		const runs = await h.repos.runs.listAll();
		expect(runs).toHaveLength(1);
		const childRun = runs[0];
		if (!childRun) throw new Error("expected one run");
		const events = await h.repos.events.listByRun(childRun.id);
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("plan_run.dispatched");
		expect(events.every((e) => e.stream === "system")).toBe(true);
	});
});

describe("bootPlanRunCoordinator", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("disabled flag returns a stop-only handle without scheduling", async () => {
		let scheduled = 0;
		const handle = bootPlanRunCoordinator({
			repos: h.repos,
			showSeed: openSeed,
			checkPrMerged: noopPoll,
			spawn: async () => ({ runId: "unused" }),
			tickMs: 100,
			disabled: true,
			setInterval: () => {
				scheduled += 1;
				return {};
			},
			clearInterval: () => {},
		});
		expect(scheduled).toBe(0);
		await handle.stop();
	});

	test("runOnce fires a single tick and increments tickCount", async () => {
		const handle = bootPlanRunCoordinator({
			repos: h.repos,
			showSeed: openSeed,
			checkPrMerged: noopPoll,
			spawn: async () => ({ runId: "unused" }),
			tickMs: 100,
			disabled: true,
			setInterval: () => ({}),
			clearInterval: () => {},
			now: () => NOW,
		});
		try {
			const result = await handle.runOnce();
			expect(result).not.toBeNull();
			expect(handle.tickCount()).toBe(1);
		} finally {
			await handle.stop();
		}
	});

	test("single-flight: a tick fired while another is in flight is skipped", async () => {
		let release: () => void = () => {};
		const block = new Promise<void>((resolve) => {
			release = resolve;
		});
		await h.repos.planRuns.create({
			planId: "pl-a",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const slowSpawn: CoordinatorSpawnFn = async ({ child, prompt }) => {
			await block;
			const run = await h.repos.runs.create({
				agentName: "claude-code",
				projectId: h.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
			});
			return { runId: run.id };
		};
		const handle = bootPlanRunCoordinator({
			repos: h.repos,
			showSeed: openSeed,
			checkPrMerged: noopPoll,
			spawn: slowSpawn,
			tickMs: 100,
			disabled: true,
			setInterval: () => ({}),
			clearInterval: () => {},
			now: () => NOW,
		});
		try {
			const first = handle.runOnce();
			const second = await handle.runOnce();
			expect(second).toBeNull();
			release();
			await first;
			expect(handle.tickCount()).toBe(1);
		} finally {
			await handle.stop();
		}
	});
});

/* ------------------------------------------------------------------ */
/* paused_rate_limited plan-run resume via tick (warren-e521)          */
/* ------------------------------------------------------------------ */

describe("runPlanRunTick — paused_rate_limited resume (warren-e521)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	const aggressiveRateLimitConfig: RateLimitConfig = {
		bufferMs: 0,
		backoffBaseMs: 60_000,
		backoffCeilMs: 60 * 60 * 1000,
		maxRetries: 3,
	};

	test("paused plan before resume_at returns noop (not included in tick advances)", async () => {
		const futureResume = new Date(NOW.getTime() + 60_000).toISOString();
		const { planRun } = await h.repos.planRuns.create({
			planId: "pl-r",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-r1" }],
			now: NOW,
		});
		await h.repos.planRuns.transitionTo(planRun.id, "running", { startedAt: NOW.toISOString() });
		await h.repos.planRuns.transitionTo(planRun.id, "paused_rate_limited", {
			resumeAt: futureResume,
		});
		const reloaded = await h.repos.planRuns.require(planRun.id);

		const result = await runPlanRunTick({
			repos: h.repos,
			showSeed: openSeed,
			checkPrMerged: noopPoll,
			spawn: async () => ({ runId: "unused" }),
			rateLimitConfig: aggressiveRateLimitConfig,
			now: () => NOW,
		});

		expect(result.errors).toEqual([]);
		expect(result.advances).toHaveLength(1);
		const advance = result.advances[0];
		expect(advance?.result.kind).toBe("noop");
		if (advance?.result.kind === "noop") {
			expect(advance.result.reason).toBe("plan_paused_rate_limited");
		}
		// Still paused
		const recheck = await h.repos.planRuns.require(reloaded.id);
		expect(recheck.state).toBe("paused_rate_limited");
	});

	test("paused plan at resume_at is re-dispatched by the tick", async () => {
		const { planRun } = await h.repos.planRuns.create({
			planId: "pl-r2",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-r2" }],
			now: NOW,
		});
		await h.repos.planRuns.transitionTo(planRun.id, "running", { startedAt: NOW.toISOString() });
		// Set resumeAt = NOW so it's ready to resume
		await h.repos.planRuns.transitionTo(planRun.id, "paused_rate_limited", {
			resumeAt: NOW.toISOString(),
		});

		const dispatched: string[] = [];
		const spawn: CoordinatorSpawnFn = async ({ child, prompt }) => {
			const run = await h.repos.runs.create({
				agentName: "claude-code",
				projectId: h.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
			});
			dispatched.push(run.id);
			return { runId: run.id };
		};

		const result = await runPlanRunTick({
			repos: h.repos,
			showSeed: openSeed,
			checkPrMerged: noopPoll,
			spawn,
			rateLimitConfig: aggressiveRateLimitConfig,
			now: () => NOW,
		});

		expect(result.errors).toEqual([]);
		expect(result.advances).toHaveLength(1);
		const advance = result.advances[0];
		expect(advance?.result.kind).toBe("dispatched");
		expect(dispatched).toHaveLength(1);
		const reloaded = await h.repos.planRuns.require(planRun.id);
		expect(reloaded.state).toBe("running");
		expect(reloaded.resumeAt).toBeNull();
	});

	test("ceiling hit at resume_at fails the plan terminally", async () => {
		const { planRun } = await h.repos.planRuns.create({
			planId: "pl-r3",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-r3" }],
			now: NOW,
		});
		await h.repos.planRuns.transitionTo(planRun.id, "running", { startedAt: NOW.toISOString() });
		// Set retries = maxRetries (3) and resumeAt = NOW
		await h.repos.planRuns.transitionTo(planRun.id, "paused_rate_limited", {
			resumeAt: NOW.toISOString(),
			rateLimitRetriesDelta: aggressiveRateLimitConfig.maxRetries,
		});

		let spawnCalled = false;
		const result = await runPlanRunTick({
			repos: h.repos,
			showSeed: openSeed,
			checkPrMerged: noopPoll,
			spawn: async () => {
				spawnCalled = true;
				return { runId: "unused" };
			},
			rateLimitConfig: aggressiveRateLimitConfig,
			now: () => NOW,
		});

		expect(spawnCalled).toBe(false);
		expect(result.errors).toEqual([]);
		const advance = result.advances[0];
		expect(advance?.result.kind).toBe("plan_failed");
		const reloaded = await h.repos.planRuns.require(planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toContain("rate_limit_ceiling_exceeded");
	});
});
