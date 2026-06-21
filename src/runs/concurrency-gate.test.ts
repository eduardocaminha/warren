/**
 * Tests for the concurrency gate (warren-82a1).
 *
 * Core acceptance: 'N+1 runs → the excess waits'
 *   When WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS = N and N claude-code runs are
 *   in-flight, the N+1 dispatch creates a run row in queued state with no
 *   burrow provisioned, and no burrow HTTP calls are made for that run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import {
	countActiveClaudeRuns,
	isGateClosed,
	isGatedAgent,
	loadMaxConcurrentClaudeRuns,
	runConcurrencyGateTick,
} from "./concurrency-gate.ts";
import { spawnRun } from "./spawn/index.ts";
import { makeAgentJson, makeBurrowClient, makePool, setupRepos } from "./spawn/test-helpers.ts";

describe("loadMaxConcurrentClaudeRuns", () => {
	test("returns 2 when env is unset", () => {
		expect(loadMaxConcurrentClaudeRuns({})).toBe(2);
	});

	test("returns the parsed integer from env", () => {
		expect(loadMaxConcurrentClaudeRuns({ WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS: "4" })).toBe(4);
	});

	test("returns 2 for non-integer value", () => {
		expect(loadMaxConcurrentClaudeRuns({ WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS: "abc" })).toBe(2);
	});

	test("returns 2 for zero (non-positive)", () => {
		expect(loadMaxConcurrentClaudeRuns({ WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS: "0" })).toBe(2);
	});

	test("returns 2 for negative value", () => {
		expect(loadMaxConcurrentClaudeRuns({ WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS: "-1" })).toBe(2);
	});

	test("returns 1 as a valid minimum", () => {
		expect(loadMaxConcurrentClaudeRuns({ WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS: "1" })).toBe(1);
	});
});

describe("isGatedAgent", () => {
	test("returns true for claude-code", () => {
		expect(isGatedAgent("claude-code")).toBe(true);
	});

	test("returns false for other agents", () => {
		expect(isGatedAgent("sapling")).toBe(false);
		expect(isGatedAgent("refactor-bot")).toBe(false);
		expect(isGatedAgent("pi")).toBe(false);
	});
});

describe("countActiveClaudeRuns + isGateClosed", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: makeAgentJson({ name: "claude-code" }),
		});
		await repos.projects.create({
			id: "prj_xxxxxxxxxxxx",
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	async function addClaudeRun(state: "queued" | "running" | "succeeded" = "queued") {
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "do work",
			renderedAgentJson: makeAgentJson({ name: "claude-code" }),
			trigger: "manual",
		});
		if (state === "running") await repos.runs.markRunning(run.id);
		if (state === "succeeded") {
			await repos.runs.markRunning(run.id);
			await repos.runs.finalize(run.id, "succeeded");
		}
		return run;
	}

	test("countActiveClaudeRuns returns 0 when no runs exist", async () => {
		expect(await countActiveClaudeRuns(repos)).toBe(0);
	});

	test("countActiveClaudeRuns counts queued runs", async () => {
		await addClaudeRun("queued");
		expect(await countActiveClaudeRuns(repos)).toBe(1);
	});

	test("countActiveClaudeRuns counts running runs", async () => {
		await addClaudeRun("running");
		expect(await countActiveClaudeRuns(repos)).toBe(1);
	});

	test("countActiveClaudeRuns ignores terminal runs", async () => {
		await addClaudeRun("succeeded");
		expect(await countActiveClaudeRuns(repos)).toBe(0);
	});

	test("isGateClosed returns false when below limit", async () => {
		await addClaudeRun("running");
		expect(await isGateClosed(repos, 2)).toBe(false);
	});

	test("isGateClosed returns true when at limit", async () => {
		await addClaudeRun("running");
		await addClaudeRun("queued");
		expect(await isGateClosed(repos, 2)).toBe(true);
	});

	test("isGateClosed returns true when over limit", async () => {
		await addClaudeRun("running");
		await addClaudeRun("running");
		await addClaudeRun("queued");
		expect(await isGateClosed(repos, 2)).toBe(true);
	});
});

describe("N+1 runs → excess waits (warren-82a1 mandatory acceptance)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
		// Register claude-code agent (setupRepos only seeds refactor-bot)
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: makeAgentJson({ name: "claude-code" }),
		});
	});

	afterEach(async () => {
		await db.close();
	});

	const concurrencyEnv = { WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS: "2" };

	test("dispatches N claude-code runs normally when below the limit", async () => {
		const { client, calls } = makeBurrowClient();
		const pool = await makePool(repos, client);

		const r1 = await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run 1",
			concurrencyEnv,
		});
		const r2 = await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run 2",
			concurrencyEnv,
		});

		expect(r1.pending).toBe(false);
		expect(r2.pending).toBe(false);
		// Two runs × 2 HTTP calls each (POST /burrows + POST /burrows/:id/runs)
		expect(calls).toHaveLength(4);
	});

	test("N+1 run is held (pending=true, no burrow) when at limit", async () => {
		const { client, calls } = makeBurrowClient();
		const pool = await makePool(repos, client);

		// Dispatch N=2 runs to fill the slot
		await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run 1",
			concurrencyEnv,
		});
		await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run 2",
			concurrencyEnv,
		});

		const beforeCalls = calls.length;
		// N+1 dispatch — should be held at the gate
		const r3 = await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run 3",
			concurrencyEnv,
		});

		expect(r3.pending).toBe(true);
		// No burrow calls for the held run
		expect(calls.length).toBe(beforeCalls);

		// The run row exists in queued state with no burrow
		const row = await repos.runs.require(r3.run.id);
		expect(row.state).toBe("queued");
		expect(row.burrowId).toBeNull();
		expect(row.burrowRunId).toBeNull();
	});

	test("excess run is included in the active count (holds its slot)", async () => {
		const { client } = makeBurrowClient();
		const pool = await makePool(repos, client);

		await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "1",
			concurrencyEnv,
		});
		await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "2",
			concurrencyEnv,
		});
		const r3 = await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "3",
			concurrencyEnv,
		});

		expect(r3.pending).toBe(true);
		// The pending run still counts toward the cap (it's queued)
		expect(await countActiveClaudeRuns(repos)).toBe(3);
		// Gate is closed with limit=2
		expect(await isGateClosed(repos, 2)).toBe(true);
	});

	test("non-claude-code agents are not gated", async () => {
		const { client, calls } = makeBurrowClient();
		const pool = await makePool(repos, client);

		// Fill the claude-code cap
		await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "1",
			concurrencyEnv,
		});
		await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "2",
			concurrencyEnv,
		});

		const callsBefore = calls.length;
		// refactor-bot is not gated — should dispatch immediately
		const r = await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "refactor",
			concurrencyEnv,
		});

		expect(r.pending).toBe(false);
		// Should have made 2 more burrow calls (provision + dispatch)
		expect(calls.length).toBe(callsBefore + 2);
	});
});

describe("runConcurrencyGateTick", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: makeAgentJson({ name: "claude-code" }),
		});
	});

	afterEach(async () => {
		await db.close();
	});

	const concurrencyEnv = { WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS: "1" };

	test("dispatches a pending run when a slot opens", async () => {
		const { client, calls } = makeBurrowClient();
		const pool = await makePool(repos, client);
		const bridgeStarted: { runId: string; burrowRunId: string }[] = [];

		// Fill the limit (max=1)
		const r1 = await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run 1",
			concurrencyEnv,
		});
		expect(r1.pending).toBe(false);

		// r2 is held
		const r2 = await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run 2",
			concurrencyEnv,
		});
		expect(r2.pending).toBe(true);

		// Simulate r1 completing — finalize it so it's no longer in-flight
		if (!r1.pending) {
			await repos.runs.markRunning(r1.run.id);
			await repos.runs.finalize(r1.run.id, "succeeded");
		}

		const callsBefore = calls.length;
		const result = await runConcurrencyGateTick(
			{
				repos,
				burrowClientPool: pool,
				bridges: {
					start(runId, burrowRunId) {
						bridgeStarted.push({ runId, burrowRunId });
					},
					async stopAll() {},
					size: () => 0,
				},
			},
			{ maxConcurrent: 1 },
		);

		expect(result.dispatched).toHaveLength(1);
		expect(result.dispatched[0]).toBe(r2.run.id);
		expect(result.errors).toHaveLength(0);
		// The tick should have provisioned + dispatched r2 (2 burrow calls)
		expect(calls.length).toBe(callsBefore + 2);
		// Bridge was started for r2
		expect(bridgeStarted).toHaveLength(1);
		expect(bridgeStarted[0]?.runId).toBe(r2.run.id);

		// r2 now has a burrow (ID is unique per-dispatch; exact value not meaningful here)
		const updatedR2 = await repos.runs.require(r2.run.id);
		expect(updatedR2.burrowId).not.toBeNull();
		expect(updatedR2.burrowRunId).toBe("run_zzzzzzzzzzzz");
	});

	test("skips tick when still at limit", async () => {
		const { client, calls } = makeBurrowClient();
		const pool = await makePool(repos, client);

		// Fill the limit
		await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run 1",
			concurrencyEnv,
		});
		const r2 = await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "claude-code",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run 2",
			concurrencyEnv,
		});
		expect(r2.pending).toBe(true);

		// r1 is still running — no slot open
		const callsBefore = calls.length;
		const result = await runConcurrencyGateTick(
			{
				repos,
				burrowClientPool: pool,
				bridges: { start() {}, async stopAll() {}, size: () => 0 },
			},
			{ maxConcurrent: 1 },
		);

		expect(result.dispatched).toHaveLength(0);
		expect(calls.length).toBe(callsBefore); // no new burrow calls
	});
});
