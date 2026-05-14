/**
 * Cross-process two-burrow integration test (R-12 / pl-9ba1 + pl-cb3e).
 *
 * Stub-fetch siblings (`src/server/integration.multi-worker.test.ts`) cover
 * the placement / fan-out / drain logic against an in-process fake. This
 * file is the complement: spawn TWO real `burrow serve` subprocesses (via
 * the acceptance harness's `burrow-with-stub` wrapper), build a real
 * `BurrowClientPool.fromConfig` over them, and prove the wire pieces
 * R-12 leans on actually compose against a real burrow HTTP surface:
 *
 *   - bearer auth round-trips end-to-end (set BURROW_API_TOKEN on each
 *     burrow subprocess, supply the same token via BurrowClientPool;
 *     without --no-auth, missing/wrong tokens must 401).
 *   - `pool.probe()` aggregates per-worker `/healthz` results over real
 *     unix sockets.
 *   - `fanOutAcrossWorkers` unions `burrows.list` from two real burrows
 *     and surfaces a `worker_unreachable` log line when one is killed.
 *   - `client.setDrain(true)` / `setDrain(false)` round-trips against the
 *     real `POST /admin/drain` route on each burrow (pl-cb3e step 4).
 *   - `pool.clientFor` against a sticky burrow on a killed worker raises
 *     `StickyWorkerUnreachableError` (placement risk #5 — fail loudly,
 *     never silently re-place).
 *
 * What's intentionally NOT covered here:
 *   - Driving a full `burrows.up` + run dispatch through warren's HTTP
 *     server. That needs a canopy fixture + project + workspace
 *     materializer, which is the territory of acceptance scenario 18
 *     (warren-82ea). Trying to do it under `bun test` would duplicate the
 *     in-proc harness.
 *   - Multi-host topology (TLS, network partitions). Loopback unix
 *     sockets prove the wire contract; cross-host needs compose-mode.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpClientError, type Transport } from "@os-eco/burrow-cli";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { StickyWorkerUnreachableError } from "../runs/placement.ts";
import { BurrowClient } from "./client.ts";
import { BurrowUnreachableError } from "./errors.ts";
import { fanOutAcrossWorkers } from "./fanout.ts";
import { BurrowClientPool } from "./pool.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(HERE, "..", "..", "scripts", "acceptance", "lib", "burrow-with-stub.ts");
const TOKEN = "cross-process-shared-token";
const SOCKET_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;

interface BurrowProc {
	readonly proc: Bun.Subprocess;
	readonly socketPath: string;
	kill(signal?: NodeJS.Signals): Promise<void>;
	killed: boolean;
}

async function spawnBurrow(rootDir: string, name: string): Promise<BurrowProc> {
	const sockDir = join(rootDir, `sock-${name}`);
	const dataDir = join(rootDir, `data-${name}`);
	mkdirSync(sockDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	const socketPath = join(sockDir, "burrow.sock");

	// No --no-auth: forces bearer-token resolution from BURROW_API_TOKEN env
	// inside `runServeCommand`, which is the production-shaped auth posture
	// the [workers] config requires (pl-9ba1 acceptance #8).
	const proc = Bun.spawn({
		cmd: ["bun", "run", WRAPPER, "--socket", socketPath],
		env: {
			...(process.env as Record<string, string>),
			BURROW_API_TOKEN: TOKEN,
			BURROW_DATA_DIR: dataDir,
			LOG_LEVEL: "fatal",
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: process.env.WARREN_XPROC_STDERR === "1" ? "inherit" : "ignore",
	});

	await waitForSocket(socketPath, SOCKET_WAIT_MS);

	const handle: BurrowProc = {
		proc,
		socketPath,
		killed: false,
		kill: async (signal: NodeJS.Signals = "SIGTERM") => {
			if (handle.killed) return;
			handle.killed = true;
			try {
				proc.kill(signal);
			} catch {
				// already gone
			}
			const raced = await Promise.race([
				proc.exited,
				new Promise<"timeout">((r) => setTimeout(() => r("timeout"), KILL_WAIT_MS)),
			]);
			if (raced === "timeout") {
				try {
					proc.kill("SIGKILL");
				} catch {
					// already gone
				}
				await proc.exited.catch(() => 0);
			}
		},
	};
	return handle;
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (existsSync(path)) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`burrow socket did not appear at ${path} within ${timeoutMs}ms`);
}

function unixWorker(
	name: string,
	socketPath: string,
): {
	readonly name: string;
	readonly url: string;
	readonly transport: Transport;
} {
	return {
		name,
		url: `unix://${socketPath}`,
		transport: { kind: "unix", path: socketPath },
	};
}

describe("BurrowClientPool — two healthy real burrows", () => {
	let rootDir: string;
	let db: WarrenDb;
	let repos: Repos;
	let alpha: BurrowProc;
	let beta: BurrowProc;
	let pool: BurrowClientPool;

	beforeAll(async () => {
		rootDir = mkdtempSync(join(tmpdir(), "warren-xproc-healthy-"));
		[alpha, beta] = await Promise.all([
			spawnBurrow(rootDir, "alpha"),
			spawnBurrow(rootDir, "beta"),
		]);

		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);

		pool = BurrowClientPool.fromConfig({
			repos,
			token: TOKEN,
			workers: [unixWorker("alpha", alpha.socketPath), unixWorker("beta", beta.socketPath)],
		});
	});

	afterAll(async () => {
		await pool?.close();
		await Promise.all([alpha?.kill(), beta?.kill()]);
		db?.close();
		rmSync(rootDir, { recursive: true, force: true });
	});

	test("pool.probe() reports both workers healthy", async () => {
		const results = await pool.probe();
		expect(results).toHaveLength(2);
		const byName = new Map(results.map((r) => [r.workerName, r]));
		expect(byName.get("alpha")?.ok).toBe(true);
		expect(byName.get("beta")?.ok).toBe(true);
	});

	test("authenticated burrows.list works on both workers via shared bearer", async () => {
		// `burrows.list` is auth-protected; `/healthz` is not. Hitting it
		// proves the token round-trips end-to-end (BurrowClientPool → http
		// over unix socket → resolveAuth → handler).
		const aList = await pool.get("alpha").http.burrows.list();
		const bList = await pool.get("beta").http.burrows.list();
		expect(aList).toEqual([]);
		expect(bList).toEqual([]);
	});

	test("missing bearer is rejected with 401 unauthorized", async () => {
		// Burrow's auth middleware emits `{error:{code:'unauthorized'}}` on
		// 401; HttpClient's `rehydrateError` maps that to `HttpClientError`
		// (the `credential_error` code is reserved for upstream credential
		// failures, not the no-token-supplied case).
		const anon = new BurrowClient({
			config: { transport: { kind: "unix", path: alpha.socketPath } },
		});
		try {
			let caught: unknown;
			try {
				await anon.http.burrows.list();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(HttpClientError);
			expect((caught as HttpClientError).status).toBe(401);
			expect((caught as HttpClientError).code).toBe("unauthorized");
		} finally {
			await anon.close();
		}
	});

	test("fanOutAcrossWorkers unions burrows.list from both real workers", async () => {
		const logged: { obj: object; msg: string | undefined }[] = [];
		const result = await fanOutAcrossWorkers(pool, (c) => c.http.burrows.list(), {
			op: "burrows.list",
			logger: { warn: (obj, msg) => logged.push({ obj, msg }) },
		});
		expect(result.errors).toEqual([]);
		expect(logged).toEqual([]);
		expect(result.results.map((r) => r.workerName).sort()).toEqual(["alpha", "beta"]);
		expect(result.results.every((r) => r.value.length === 0)).toBe(true);
	});

	test("client.setDrain(true)/setDrain(false) round-trips against POST /admin/drain", async () => {
		const client = pool.get("alpha");
		const drained = await client.setDrain(true);
		expect(drained).toEqual({ drain: true });
		const restored = await client.setDrain(false);
		expect(restored).toEqual({ drain: false });
	});
});

describe("BurrowClientPool — one killed real burrow", () => {
	let rootDir: string;
	let db: WarrenDb;
	let repos: Repos;
	let alpha: BurrowProc;
	let beta: BurrowProc;
	let pool: BurrowClientPool;

	beforeAll(async () => {
		rootDir = mkdtempSync(join(tmpdir(), "warren-xproc-killed-"));
		[alpha, beta] = await Promise.all([
			spawnBurrow(rootDir, "alpha"),
			spawnBurrow(rootDir, "beta"),
		]);

		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);

		pool = BurrowClientPool.fromConfig({
			repos,
			token: TOKEN,
			workers: [unixWorker("alpha", alpha.socketPath), unixWorker("beta", beta.socketPath)],
		});

		// Sticky-by-burrow scenario: pre-seed a burrows row pinned to alpha
		// so `pool.clientFor({burrowId})` resolves to alpha. After alpha
		// dies and warren marks it unreachable (below), the sticky lookup
		// must fail loudly with StickyWorkerUnreachableError rather than
		// silently re-place onto beta (placement risk #5).
		repos.burrows.create({ id: "bur_pinned_to_alpha", workerId: "alpha" });
	});

	afterAll(async () => {
		await pool?.close();
		await Promise.all([alpha?.kill(), beta?.kill()]);
		db?.close();
		rmSync(rootDir, { recursive: true, force: true });
	});

	test("killing alpha surfaces as a structured worker_unreachable in fan-out", async () => {
		// Sanity check both up before killing.
		const before = await pool.probe();
		expect(before.find((r) => r.workerName === "alpha")?.ok).toBe(true);

		await alpha.kill();

		const logged: { obj: object; msg: string | undefined }[] = [];
		const result = await fanOutAcrossWorkers(pool, (c) => c.http.burrows.list(), {
			op: "burrows.list",
			logger: { warn: (obj, msg) => logged.push({ obj, msg }) },
		});
		const successful = result.results.map((r) => r.workerName);
		const failed = result.errors.map((e) => e.workerName);
		expect(successful).toEqual(["beta"]);
		expect(failed).toEqual(["alpha"]);
		expect(result.errors[0]?.error).toBeInstanceOf(Error);
		expect(logged.map((l) => l.msg)).toEqual(["worker_unreachable"]);
		expect((logged[0]?.obj as { workerName: string }).workerName).toBe("alpha");
	});

	test("pool.probe() reports alpha unhealthy after kill", async () => {
		const results = await pool.probe();
		const byName = new Map(results.map((r) => [r.workerName, r]));
		expect(byName.get("alpha")?.ok).toBe(false);
		expect(byName.get("alpha")?.error).toBeInstanceOf(BurrowUnreachableError);
		expect(byName.get("beta")?.ok).toBe(true);
	});

	test("sticky pool.clientFor against killed worker fails loudly", async () => {
		// Flip warren's view of alpha to `unreachable` so `placeForBurrow`
		// raises rather than handing back a dead client. This is what the
		// probe loop (src/server/probe.ts) would do in production after
		// observing the kill.
		repos.workers.setState("alpha", "unreachable");
		expect(() => pool.clientFor({ burrowId: "bur_pinned_to_alpha" })).toThrow(
			StickyWorkerUnreachableError,
		);
	});
});
