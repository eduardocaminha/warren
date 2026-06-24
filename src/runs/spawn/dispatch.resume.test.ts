/**
 * Tests for the resumeOfRunId wiring in spawnRun (warren-c7a7 / pl-e118 step 1).
 *
 * spawnRun accepts a `resumeOfRunId` (warren run ID) and resolves it to the
 * prior run's `burrowRunId` before forwarding to `POST /burrows/:id/runs` so
 * burrow's dispatcher activates `buildResumeCommand` instead of `buildSpawnCommand`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeBurrowClient, makePool, setupRepos } from "./test-helpers.ts";

describe("spawnRun: resumeOfRunId wiring (warren-c7a7 / pl-e118 step 1)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("forwards the prior run's burrowRunId as resumeOfRunId on the dispatch call", async () => {
		const priorRun = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "first turn",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
		});
		await repos.runs.attachBurrow(priorRun.id, {
			burrowId: "bur_priorburrowid",
			burrowRunId: "run_priorburrowrun",
		});

		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "second turn",
			resumeOfRunId: priorRun.id,
		});

		const dispatch = calls.find((c) => /\/runs$/.test(c.path));
		expect(dispatch).toBeDefined();
		expect((dispatch?.body as { resumeOfRunId?: string }).resumeOfRunId).toBe("run_priorburrowrun");
	});

	test("omits resumeOfRunId on dispatch when the prior run has no burrowRunId (fresh spawn fallback)", async () => {
		const priorRun = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "first turn",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
		});

		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "second turn",
			resumeOfRunId: priorRun.id,
		});

		const dispatch = calls.find((c) => /\/runs$/.test(c.path));
		expect(dispatch).toBeDefined();
		expect((dispatch?.body as { resumeOfRunId?: string }).resumeOfRunId).toBeUndefined();
	});

	test("omits resumeOfRunId on dispatch when the prior run does not exist (fresh spawn fallback)", async () => {
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "second turn",
			resumeOfRunId: "run_nonexistentxx",
		});

		const dispatch = calls.find((c) => /\/runs$/.test(c.path));
		expect(dispatch).toBeDefined();
		expect((dispatch?.body as { resumeOfRunId?: string }).resumeOfRunId).toBeUndefined();
	});

	test("omits resumeOfRunId from dispatch when not specified (normal spawn)", async () => {
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "standalone turn",
		});

		const dispatch = calls.find((c) => /\/runs$/.test(c.path));
		expect(dispatch).toBeDefined();
		expect((dispatch?.body as { resumeOfRunId?: string }).resumeOfRunId).toBeUndefined();
	});
});
