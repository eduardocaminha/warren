import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { NoEligibleWorkerError, StickyWorkerUnreachableError } from "../runs/placement.ts";
import { BurrowClient } from "./client.ts";
import { DEFAULT_BURROW_SOCKET } from "./config.ts";
import { BurrowClientPool, LOCAL_WORKER_NAME, WorkerClientUnregisteredError } from "./pool.ts";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stub(impl: (input: URL | RequestInfo) => Promise<Response>): typeof fetch {
	return impl as unknown as typeof fetch;
}

function makeClient(): BurrowClient {
	return new BurrowClient({ config: { transport: { kind: "unix", path: "/tmp/x.sock" } } });
}

describe("BurrowClientPool", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => {
		db.close();
	});

	test("register / get / has / size / names round-trip a client by worker name", () => {
		const pool = new BurrowClientPool({ repos });
		const c = makeClient();
		pool.register("alpha", c);

		expect(pool.size).toBe(1);
		expect(pool.has("alpha")).toBe(true);
		expect(pool.has("beta")).toBe(false);
		expect(pool.get("alpha")).toBe(c);
		expect(pool.names()).toEqual(["alpha"]);
		expect(pool.entries()).toEqual([{ workerName: "alpha", client: c }]);
	});

	test("register throws on duplicate worker names", () => {
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", makeClient());
		expect(() => pool.register("alpha", makeClient())).toThrow(ValidationError);
	});

	test("get throws WorkerClientUnregisteredError when the worker is not registered", () => {
		const pool = new BurrowClientPool({ repos });
		expect(() => pool.get("ghost")).toThrow(WorkerClientUnregisteredError);
	});

	test("names returns workers sorted alphabetically", () => {
		const pool = new BurrowClientPool({ repos });
		pool.register("zulu", makeClient());
		pool.register("alpha", makeClient());
		pool.register("mike", makeClient());
		expect(pool.names()).toEqual(["alpha", "mike", "zulu"]);
	});

	test("deregister removes the client and closes it", async () => {
		const pool = new BurrowClientPool({ repos });
		const c = makeClient();
		pool.register("alpha", c);
		await pool.deregister("alpha");
		expect(pool.has("alpha")).toBe(false);
		expect(pool.size).toBe(0);
	});

	test("deregister is a no-op for unknown workers", async () => {
		const pool = new BurrowClientPool({ repos });
		await expect(pool.deregister("ghost")).resolves.toBeUndefined();
	});
});

describe("BurrowClientPool.fromEnv", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => {
		db.close();
	});

	test("synthesizes a 'local' worker row with the default unix socket URL", () => {
		const pool = BurrowClientPool.fromEnv({ env: {}, repos });
		expect(pool.size).toBe(1);
		expect(pool.names()).toEqual([LOCAL_WORKER_NAME]);

		const row = repos.workers.require(LOCAL_WORKER_NAME);
		expect(row.url).toBe(`unix://${DEFAULT_BURROW_SOCKET}`);
		expect(row.state).toBe("healthy");
	});

	test("renders a TCP transport as an http://host:port URL on the worker row", () => {
		const pool = BurrowClientPool.fromEnv({
			env: { WARREN_BURROW_HOST: "burrow.local", WARREN_BURROW_PORT: "9410" },
			repos,
		});
		expect(pool.size).toBe(1);

		const row = repos.workers.require(LOCAL_WORKER_NAME);
		expect(row.url).toBe("http://burrow.local:9410");
	});

	test("stamps `addedAt` from the provided `now` clock", () => {
		const frozen = new Date("2026-01-02T03:04:05.000Z");
		BurrowClientPool.fromEnv({ env: {}, repos, now: () => frozen });
		const row = repos.workers.require(LOCAL_WORKER_NAME);
		expect(row.addedAt).toBe(frozen.toISOString());
	});

	test("preserves an existing worker's state across re-boots (probe-derived state wins)", () => {
		repos.workers.upsert({ name: LOCAL_WORKER_NAME, url: "unix:///old.sock", state: "draining" });
		BurrowClientPool.fromEnv({ env: {}, repos });
		const row = repos.workers.require(LOCAL_WORKER_NAME);
		expect(row.state).toBe("draining");
		expect(row.url).toBe(`unix://${DEFAULT_BURROW_SOCKET}`);
	});

	test("forwards a fetch override into the underlying BurrowClient", async () => {
		let calls = 0;
		const stubFetch = stub(async () => {
			calls += 1;
			return jsonResponse(200, { ok: true });
		});
		const pool = BurrowClientPool.fromEnv({ env: {}, repos, fetch: stubFetch });
		await pool.get(LOCAL_WORKER_NAME).probe();
		expect(calls).toBe(1);
	});
});

describe("BurrowClientPool.fromConfig", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => {
		db.close();
	});

	test("registers one client per configured worker, upserting rows", () => {
		const pool = BurrowClientPool.fromConfig({
			repos,
			token: "shared-secret",
			workers: [
				{
					name: "alpha",
					url: "http://alpha.local:9410",
					transport: { kind: "tcp", hostname: "alpha.local", port: 9410 },
				},
				{
					name: "beta",
					url: "unix:///var/run/burrow-beta.sock",
					transport: { kind: "unix", path: "/var/run/burrow-beta.sock" },
				},
			],
		});
		expect(pool.size).toBe(2);
		expect(pool.names()).toEqual(["alpha", "beta"]);

		const alpha = repos.workers.require("alpha");
		expect(alpha.url).toBe("http://alpha.local:9410");
		expect(alpha.state).toBe("healthy");

		const beta = repos.workers.require("beta");
		expect(beta.url).toBe("unix:///var/run/burrow-beta.sock");
	});

	test("does NOT synthesize the 'local' worker (operator config defines the pool)", () => {
		const pool = BurrowClientPool.fromConfig({
			repos,
			token: "shared-secret",
			workers: [
				{
					name: "alpha",
					url: "http://alpha.local:9410",
					transport: { kind: "tcp", hostname: "alpha.local", port: 9410 },
				},
			],
		});
		expect(pool.has(LOCAL_WORKER_NAME)).toBe(false);
		expect(repos.workers.get(LOCAL_WORKER_NAME)).toBeNull();
	});

	test("threads the shared token into every registered BurrowClient", () => {
		const pool = BurrowClientPool.fromConfig({
			repos,
			token: "shared-secret",
			workers: [
				{
					name: "alpha",
					url: "http://alpha.local:9410",
					transport: { kind: "tcp", hostname: "alpha.local", port: 9410 },
				},
				{
					name: "beta",
					url: "unix:///b.sock",
					transport: { kind: "unix", path: "/b.sock" },
				},
			],
		});
		expect(pool.get("alpha").config.token).toBe("shared-secret");
		expect(pool.get("beta").config.token).toBe("shared-secret");
	});

	test("stamps `addedAt` from the provided `now` clock for new rows", () => {
		const frozen = new Date("2026-02-03T04:05:06.000Z");
		BurrowClientPool.fromConfig({
			repos,
			token: "shared-secret",
			now: () => frozen,
			workers: [
				{
					name: "alpha",
					url: "http://alpha.local:9410",
					transport: { kind: "tcp", hostname: "alpha.local", port: 9410 },
				},
			],
		});
		const row = repos.workers.require("alpha");
		expect(row.addedAt).toBe(frozen.toISOString());
	});

	test("preserves an existing worker's state across re-boots (probe-derived wins)", () => {
		repos.workers.upsert({ name: "alpha", url: "http://old:1", state: "draining" });
		BurrowClientPool.fromConfig({
			repos,
			token: "shared-secret",
			workers: [
				{
					name: "alpha",
					url: "http://alpha.local:9410",
					transport: { kind: "tcp", hostname: "alpha.local", port: 9410 },
				},
			],
		});
		const row = repos.workers.require("alpha");
		expect(row.state).toBe("draining");
		expect(row.url).toBe("http://alpha.local:9410");
	});

	test("throws ValidationError on an empty workers array", () => {
		expect(() =>
			BurrowClientPool.fromConfig({ repos, token: "shared-secret", workers: [] }),
		).toThrow(ValidationError);
	});

	test("forwards a fetch override into every constructed BurrowClient", async () => {
		let calls = 0;
		const stubFetch = stub(async () => {
			calls += 1;
			return jsonResponse(200, { ok: true });
		});
		const pool = BurrowClientPool.fromConfig({
			repos,
			token: "shared-secret",
			fetch: stubFetch,
			workers: [
				{
					name: "alpha",
					url: "http://a:1",
					transport: { kind: "tcp", hostname: "a", port: 1 },
				},
				{
					name: "beta",
					url: "http://b:2",
					transport: { kind: "tcp", hostname: "b", port: 2 },
				},
			],
		});
		await pool.get("alpha").probe();
		await pool.get("beta").probe();
		expect(calls).toBe(2);
	});
});

describe("BurrowClientPool.placeFor / clientFor", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		repos.agents.upsert({ name: "claude-code", renderedJson: { sections: {} } });
		const p = repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = p.id;
	});

	afterEach(() => {
		db.close();
	});

	test("placeFor delegates to placement and returns the matching client", () => {
		repos.workers.upsert({ name: "alpha", url: "http://alpha:1" });
		const alpha = makeClient();
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", alpha);
		const result = pool.placeFor({ projectId });
		expect(result.workerName).toBe("alpha");
		expect(result.client).toBe(alpha);
	});

	test("placeFor propagates NoEligibleWorkerError when nothing is healthy", () => {
		const pool = new BurrowClientPool({ repos });
		expect(() => pool.placeFor({ projectId })).toThrow(NoEligibleWorkerError);
	});

	test("placeFor surfaces WorkerClientUnregisteredError if placement returns an unregistered name", () => {
		// Worker row exists but the pool was never told about it — drift scenario.
		repos.workers.upsert({ name: "alpha", url: "http://alpha:1" });
		const pool = new BurrowClientPool({ repos });
		expect(() => pool.placeFor({ projectId })).toThrow(WorkerClientUnregisteredError);
	});

	test("clientFor returns the worker pinned to an existing burrow", () => {
		repos.workers.upsert({ name: "alpha", url: "http://alpha:1" });
		repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "alpha" });
		const alpha = makeClient();
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", alpha);

		const result = pool.clientFor({ burrowId: "bur_aaaaaaaaaaaa" });
		expect(result.workerName).toBe("alpha");
		expect(result.client).toBe(alpha);
	});

	test("clientFor propagates StickyWorkerUnreachableError when the pinned worker is unreachable", () => {
		repos.workers.upsert({ name: "alpha", url: "http://alpha:1", state: "unreachable" });
		repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "alpha" });
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", makeClient());
		expect(() => pool.clientFor({ burrowId: "bur_aaaaaaaaaaaa" })).toThrow(
			StickyWorkerUnreachableError,
		);
	});
});

describe("BurrowClientPool.probe", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => {
		db.close();
	});

	test("returns ok=true for every reachable worker", async () => {
		const pool = new BurrowClientPool({ repos });
		const stubFetch = stub(async () => jsonResponse(200, { ok: true }));
		pool.register(
			"alpha",
			new BurrowClient({
				config: { transport: { kind: "unix", path: "/tmp/a.sock" } },
				fetch: stubFetch,
			}),
		);
		pool.register(
			"beta",
			new BurrowClient({
				config: { transport: { kind: "unix", path: "/tmp/b.sock" } },
				fetch: stubFetch,
			}),
		);
		const results = await pool.probe();
		expect(results.map((r) => ({ name: r.workerName, ok: r.ok }))).toEqual([
			{ name: "alpha", ok: true },
			{ name: "beta", ok: true },
		]);
	});

	test("records per-worker failures without throwing", async () => {
		const pool = new BurrowClientPool({ repos });
		const okFetch = stub(async () => jsonResponse(200, { ok: true }));
		const failFetch = stub(async () => {
			const err = new TypeError("fetch failed");
			(err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
			throw err;
		});
		pool.register(
			"alpha",
			new BurrowClient({
				config: { transport: { kind: "unix", path: "/tmp/a.sock" } },
				fetch: okFetch,
			}),
		);
		pool.register(
			"beta",
			new BurrowClient({
				config: { transport: { kind: "tcp", hostname: "b", port: 1 } },
				fetch: failFetch,
			}),
		);
		const results = await pool.probe();
		expect(results.find((r) => r.workerName === "alpha")?.ok).toBe(true);
		const beta = results.find((r) => r.workerName === "beta");
		expect(beta?.ok).toBe(false);
		expect(beta?.error).toBeInstanceOf(Error);
	});

	test("returns an empty array for an empty pool", async () => {
		const pool = new BurrowClientPool({ repos });
		await expect(pool.probe()).resolves.toEqual([]);
	});
});

describe("BurrowClientPool.close", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => {
		db.close();
	});

	test("clears the client map", async () => {
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", makeClient());
		pool.register("beta", makeClient());
		await pool.close();
		expect(pool.size).toBe(0);
		expect(pool.names()).toEqual([]);
	});

	test("survives a misbehaving client's close failure (allSettled)", async () => {
		const pool = new BurrowClientPool({ repos });
		const bad = makeClient();
		// Override close to throw — pool.close must still resolve.
		(bad as unknown as { close: () => Promise<void> }).close = async () => {
			throw new Error("close kaboom");
		};
		pool.register("alpha", bad);
		await expect(pool.close()).resolves.toBeUndefined();
		expect(pool.size).toBe(0);
	});
});
