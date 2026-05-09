import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowUnreachableError } from "../burrow-client/index.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { isId } from "../core/ids.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { AgentDefinition } from "../registry/schema.ts";
import { RunSpawnError } from "./errors.ts";
import type { SeedBurrowWorkspaceInput } from "./seed.ts";
import { spawnRun } from "./spawn.ts";

// `typeof fetch` requires a `preconnect` method we don't exercise in tests; cast
// each stub so callers can pass a plain async function.
function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface BurrowFetchPlan {
	burrow?: Partial<Burrow>;
	run?: Partial<BurrowRun>;
	burrowsUpStatus?: number;
	burrowsUpBody?: unknown;
	runsCreateStatus?: number;
	runsCreateBody?: unknown;
	destroyStatus?: number;
	destroyBody?: unknown;
}

interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
}

function makeBurrowClient(plan: BurrowFetchPlan = {}): {
	client: BurrowClient;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const fetchImpl = stub(async (input, init) => {
		const url = new URL(String(input), "http://localhost");
		const path = url.pathname;
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, body });
		if (method === "POST" && path === "/burrows") {
			const burrow: Burrow = {
				id: "bur_aaaaaaaaaaaa",
				parentId: null,
				kind: "task",
				name: null,
				projectRoot: "/data/projects/x/y",
				workspacePath: "/data/burrow/workspaces/bur_aaaaaaaaaaaa",
				branch: "warren/run/abc",
				provider: "local",
				providerStateJson: null,
				profileJson: {},
				state: "active",
				createdAt: new Date("2026-05-08T12:00:00Z"),
				updatedAt: new Date("2026-05-08T12:00:00Z"),
				destroyedAt: null,
				...plan.burrow,
			};
			return jsonResponse(
				plan.burrowsUpStatus ?? 201,
				plan.burrowsUpBody ?? serializeBurrow(burrow),
			);
		}
		if (method === "POST" && path.match(/^\/burrows\/[^/]+\/runs$/)) {
			const run: BurrowRun = {
				id: "run_zzzzzzzzzzzz",
				burrowId: "bur_aaaaaaaaaaaa",
				agentId: "refactor-bot",
				prompt: "fix the test",
				resumeOfRunId: null,
				state: "queued",
				exitCode: null,
				errorMessage: null,
				metadataJson: null,
				queuedAt: new Date("2026-05-08T12:00:01Z"),
				startedAt: null,
				completedAt: null,
				...plan.run,
			};
			return jsonResponse(plan.runsCreateStatus ?? 201, plan.runsCreateBody ?? serializeRun(run));
		}
		if (method === "DELETE" && path.match(/^\/burrows\/[^/]+$/)) {
			return jsonResponse(
				plan.destroyStatus ?? 200,
				plan.destroyBody ?? { burrowId: "bur_aaaaaaaaaaaa", archived: false },
			);
		}
		return jsonResponse(404, {
			error: { code: "not_found", message: `unmatched ${method} ${path}` },
		});
	});
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: fetchImpl,
	});
	return { client, calls };
}

function serializeBurrow(b: Burrow): unknown {
	return {
		...b,
		createdAt: b.createdAt.toISOString(),
		updatedAt: b.updatedAt.toISOString(),
		destroyedAt: b.destroyedAt?.toISOString() ?? null,
	};
}

function serializeRun(r: BurrowRun): unknown {
	return {
		...r,
		queuedAt: r.queuedAt.toISOString(),
		startedAt: r.startedAt?.toISOString() ?? null,
		completedAt: r.completedAt?.toISOString() ?? null,
	};
}

function makeAgentJson(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "refactor-bot",
		version: 1,
		sections: {
			system: "be a refactor agent",
			...(overrides.sections ?? {}),
		},
		resolvedFrom: [],
		frontmatter: {},
		...overrides,
	};
}

describe("spawnRun", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		repos.agents.upsert({ name: "refactor-bot", renderedJson: makeAgentJson() });
		repos.projects.create({
			id: "prj_xxxxxxxxxxxx",
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	afterEach(() => {
		db.close();
	});

	test("rejects an empty prompt before touching db or burrow", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "   ",
				seedWorkspace: async () => undefined,
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
		expect(repos.runs.listAll()).toHaveLength(0);
	});

	test("throws NotFoundError when the agent is not registered", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "no-such-agent",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
				seedWorkspace: async () => undefined,
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("throws NotFoundError when the project does not exist", async () => {
		const { client } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_doesnotexist",
				prompt: "fix it",
				seedWorkspace: async () => undefined,
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("end-to-end: creates the warren run, provisions a burrow, seeds, dispatches", async () => {
		const seedCalls: SeedBurrowWorkspaceInput[] = [];
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClient: client,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix the flaky test",
			seedWorkspace: async (input) => {
				seedCalls.push(input);
			},
		});

		// Warren run row
		expect(isId("run", result.run.id)).toBe(true);
		expect(result.run.state).toBe("queued");
		expect(result.run.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(result.run.burrowRunId).toBe("run_zzzzzzzzzzzz");
		const reread = repos.runs.require(result.run.id);
		expect(reread.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(reread.burrowRunId).toBe("run_zzzzzzzzzzzz");

		// Frozen rendered agent JSON survives the round-trip
		const stored = reread.renderedAgentJson as { name: string; sections: Record<string, string> };
		expect(stored.name).toBe("refactor-bot");
		expect(stored.sections.system).toBe("be a refactor agent");

		// Burrow provisioning + dispatch — agents: ["refactor-bot"] is forwarded
		// at up-time so burrow can mount the runtime's binary into the sandbox
		// even when the project clone has no burrow.toml (warren-8526).
		expect(calls).toEqual([
			{
				method: "POST",
				path: "/burrows",
				body: {
					projectRoot: "/data/projects/x/y",
					originUrl: "https://github.com/x/y.git",
					agents: ["refactor-bot"],
				},
			},
			{
				method: "POST",
				path: "/burrows/bur_aaaaaaaaaaaa/runs",
				body: {
					agentId: "refactor-bot",
					prompt: "fix the flaky test",
				},
			},
		]);

		// Seeding ran with the provisioned workspacePath
		expect(seedCalls).toHaveLength(1);
		expect(seedCalls[0]?.workspacePath).toBe("/data/burrow/workspaces/bur_aaaaaaaaaaaa");
	});

	test("forwards burrow_config network and metadata onto the burrow calls", async () => {
		repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({
				sections: {
					system: "s",
					burrow_config: `[sandbox]\nnetwork = "restricted"`,
				},
			}),
		});

		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClient: client,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			metadata: { runByOperator: "alice" },
			seedWorkspace: async () => undefined,
		});

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/burrows",
			body: {
				projectRoot: "/data/projects/x/y",
				originUrl: "https://github.com/x/y.git",
				network: "restricted",
				agents: ["refactor-bot"],
			},
		});
		expect(calls[1]).toMatchObject({
			method: "POST",
			path: "/burrows/bur_aaaaaaaaaaaa/runs",
			body: {
				agentId: "refactor-bot",
				prompt: "p",
				metadata: { runByOperator: "alice" },
			},
		});
	});

	test("rolls back: cancels the warren row and destroys the burrow when seeding fails", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
				seedWorkspace: async () => {
					throw new Error("disk full");
				},
			}),
		).rejects.toBeInstanceOf(RunSpawnError);

		// Warren row still exists in cancelled state
		const rows = repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");

		// Burrow was provisioned then destroyed (best-effort)
		const methods = calls.map((c) => `${c.method} ${c.path}`);
		expect(methods).toContain("POST /burrows");
		expect(methods).toContain("DELETE /burrows/bur_aaaaaaaaaaaa");
		// /runs dispatch was never reached
		expect(methods).not.toContain("POST /burrows/bur_aaaaaaaaaaaa/runs");
	});

	test("rolls back when burrow dispatch fails", async () => {
		const { client, calls } = makeBurrowClient({
			runsCreateStatus: 500,
			runsCreateBody: { error: { code: "internal_error", message: "boom" } },
		});
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
				seedWorkspace: async () => undefined,
			}),
		).rejects.toBeDefined();

		const rows = repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(rows[0]?.burrowRunId).toBeNull();
		const methods = calls.map((c) => `${c.method} ${c.path}`);
		expect(methods).toContain("DELETE /burrows/bur_aaaaaaaaaaaa");
	});

	test("propagates burrow transport failures and leaves no warren row attached to a burrow", async () => {
		const errFetch = stub(async () => {
			const e = new TypeError("fetch failed");
			(e as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
			throw e;
		});
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: errFetch,
		});
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
				seedWorkspace: async () => undefined,
			}),
		).rejects.toBeInstanceOf(BurrowUnreachableError);

		const rows = repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBeNull();
	});

	test("readCachedAgent: handles older cached envelopes (raw cn render output)", async () => {
		// Older registry refresh paths may have stored the raw envelope rather
		// than the parsed AgentDefinition. The spawn flow re-parses on read so
		// stale caches don't crash the flow.
		repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				success: true,
				command: "render",
				name: "refactor-bot",
				version: 2,
				sections: [{ name: "system", body: "s" }],
			},
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClient: client,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			seedWorkspace: async () => undefined,
		});
		const stored = result.run.renderedAgentJson as { sections: Record<string, string> };
		expect(stored.sections.system).toBe("s");
	});

	test("rejects a corrupted cached agent JSON with RunSpawnError", async () => {
		repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { name: "refactor-bot", version: 1, sections: { system: 42 } },
		});
		const { client } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClient: client,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
				seedWorkspace: async () => undefined,
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});
});
