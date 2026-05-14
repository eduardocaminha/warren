import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { BurrowClient } from "./client.ts";
import { fanOutAcrossWorkers } from "./fanout.ts";
import { BurrowClientPool } from "./pool.ts";

function makeClient(): BurrowClient {
	return new BurrowClient({ config: { transport: { kind: "unix", path: "/tmp/x.sock" } } });
}

describe("fanOutAcrossWorkers", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => {
		db.close();
	});

	test("returns one fulfilled entry per worker in alphabetical name order", async () => {
		const pool = new BurrowClientPool({ repos });
		pool.register("charlie", makeClient());
		pool.register("alpha", makeClient());
		pool.register("bravo", makeClient());

		const fan = await fanOutAcrossWorkers(pool, async (_client, name) => `value-${name}`);
		expect(fan.results.map((r) => r.workerName)).toEqual(["alpha", "bravo", "charlie"]);
		expect(fan.results.map((r) => r.value)).toEqual([
			"value-alpha",
			"value-bravo",
			"value-charlie",
		]);
		expect(fan.errors).toEqual([]);
	});

	test("collects per-worker rejections into errors without throwing", async () => {
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", makeClient());
		pool.register("beta", makeClient());

		const fan = await fanOutAcrossWorkers(pool, async (_client, name) => {
			if (name === "beta") throw new Error("boom");
			return name;
		});

		expect(fan.results).toEqual([{ workerName: "alpha", value: "alpha" }]);
		expect(fan.errors).toHaveLength(1);
		expect(fan.errors[0]?.workerName).toBe("beta");
		expect(fan.errors[0]?.error.message).toBe("boom");
	});

	test("normalizes non-Error rejections to Error", async () => {
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", makeClient());

		const fan = await fanOutAcrossWorkers(
			pool,
			() => Promise.reject("weird-rejection") as Promise<string>,
		);
		expect(fan.results).toEqual([]);
		expect(fan.errors[0]?.error).toBeInstanceOf(Error);
		expect(fan.errors[0]?.error.message).toBe("weird-rejection");
	});

	test("emits a worker_unreachable warn line for each rejected worker", async () => {
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", makeClient());
		pool.register("beta", makeClient());

		const warnings: { obj: object; msg: string | undefined }[] = [];
		const logger = {
			warn(obj: object, msg?: string) {
				warnings.push({ obj, msg });
			},
		};

		await fanOutAcrossWorkers(
			pool,
			async (_client, name) => {
				if (name === "beta") throw new Error("down");
				return name;
			},
			{ logger, op: "test.op" },
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.msg).toBe("worker_unreachable");
		expect(warnings[0]?.obj).toEqual({ workerName: "beta", op: "test.op", err: "down" });
	});

	test("returns empty result arrays for an empty pool", async () => {
		const pool = new BurrowClientPool({ repos });
		const fan = await fanOutAcrossWorkers(pool, async () => "unused");
		expect(fan.results).toEqual([]);
		expect(fan.errors).toEqual([]);
	});

	test("runs per-worker calls in parallel (not serial)", async () => {
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", makeClient());
		pool.register("beta", makeClient());

		let inFlight = 0;
		let maxInFlight = 0;
		await fanOutAcrossWorkers(pool, async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 10));
			inFlight -= 1;
			return null;
		});
		expect(maxInFlight).toBe(2);
	});
});
