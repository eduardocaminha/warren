/**
 * Unit test for the PlanRun spawn wrapper (warren-b290 / pl-7937 step 5).
 * Asserts `createPlanRunSpawn` forwards `planRun.plotId` into `spawnRun`'s
 * input bag so per-child PLOT_ID/PLOT_ACTOR injection and
 * `run_dispatched` Plot emission light up via the unchanged Phase 1 path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { SpawnRunInput, SpawnRunResult } from "../runs/index.ts";
import type { BridgeRegistry } from "../server/types.ts";
import { createWarrenConfigCache } from "../warren-config/index.ts";
import { createPlanRunSpawn } from "./dispatch.ts";

const NOW = new Date("2026-05-18T00:00:00.000Z");

function stubFetch(): typeof fetch {
	return (async () =>
		new Response(JSON.stringify({ error: { code: "x", message: "stub" } }), {
			status: 404,
		})) as unknown as typeof fetch;
}

function makeBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stubFetch(),
	});
}

async function makePool(repos: Repos): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register("local", makeBurrowClient());
	return pool;
}

function makeBridges(): BridgeRegistry {
	return {
		start() {},
		async stopAll() {},
		size: () => 0,
	};
}

describe("createPlanRunSpawn", () => {
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
				registeredAt: NOW.toISOString(),
				lastRefreshed: NOW.toISOString(),
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

	test("forwards planRun.plotId into spawnRun's input bag when set", async () => {
		const { planRun } = await repos.planRuns.create({
			planId: "pl-plot",
			projectId,
			agentName: "claude-code",
			plotId: "plot_xyz",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const child = (await repos.planRuns.listChildren(planRun.id))[0];
		if (child === undefined) throw new Error("child seq=1 missing");

		const captured: SpawnRunInput[] = [];
		const spawnRunFn = async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			captured.push(input);
			const run = await repos.runs.create({
				agentName: input.agentName,
				projectId: input.projectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: input.trigger ?? "manual",
				...(input.plotId !== undefined ? { plotId: input.plotId } : {}),
				now: NOW,
			});
			return {
				pending: false,
				run,
				burrow: { id: "bur_a", workspacePath: "/ws" } as Burrow,
				burrowRun: { id: "rb_a" } as BurrowRun,
				agent: { name: input.agentName, sections: {} } as never,
			};
		};

		const spawn = createPlanRunSpawn({
			repos,
			burrowClientPool: await makePool(repos),
			bridges: makeBridges(),
			warrenConfigs: createWarrenConfigCache({
				load: async () => ({
					triggers: null,
					defaults: null,
					prTemplate: null,
					errors: [],
					warnings: [],
				}),
			}),
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			seedsCli: {
				sdBinary: "sd",
				spawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			},
			spawnRunFn,
			now: () => NOW,
		});

		await spawn({ planRun, child, prompt: "work on sd warren-a" });

		expect(captured).toHaveLength(1);
		expect(captured[0]?.plotId).toBe("plot_xyz");
		expect(captured[0]?.trigger).toBe("plan-run");
		expect(captured[0]?.dispatcherHandle).toBe(planRun.dispatcherHandle);
	});

	test("omits plotId from spawnRun input when the PlanRun has no plot binding", async () => {
		const { planRun } = await repos.planRuns.create({
			planId: "pl-noplot",
			projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const child = (await repos.planRuns.listChildren(planRun.id))[0];
		if (child === undefined) throw new Error("child seq=1 missing");

		const captured: SpawnRunInput[] = [];
		const spawnRunFn = async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			captured.push(input);
			const run = await repos.runs.create({
				agentName: input.agentName,
				projectId: input.projectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: input.trigger ?? "manual",
				now: NOW,
			});
			return {
				pending: false,
				run,
				burrow: { id: "bur_b", workspacePath: "/ws" } as Burrow,
				burrowRun: { id: "rb_b" } as BurrowRun,
				agent: { name: input.agentName, sections: {} } as never,
			};
		};

		const spawn = createPlanRunSpawn({
			repos,
			burrowClientPool: await makePool(repos),
			bridges: makeBridges(),
			warrenConfigs: createWarrenConfigCache({
				load: async () => ({
					triggers: null,
					defaults: null,
					prTemplate: null,
					errors: [],
					warnings: [],
				}),
			}),
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			seedsCli: {
				sdBinary: "sd",
				spawn: (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn,
			},
			spawnRunFn,
			now: () => NOW,
		});

		await spawn({ planRun, child, prompt: "work on sd warren-a" });

		expect(captured).toHaveLength(1);
		expect(captured[0]?.plotId).toBeUndefined();
	});
});
