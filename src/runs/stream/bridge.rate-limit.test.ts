/**
 * Bridge rate_limit_event telemetry classification tests (warren-5249).
 *
 * The bridge detects `kind=telemetry / stream=system / payload.type=rate_limit_event`
 * envelopes as they stream through, tracks the last `resets_at`, and surfaces it
 * in the BridgeRunStreamResult as `rateLimitResetsAt`. The reconnect registry uses
 * this to pass `failureReason:"rate_limited"` to reapRun when the run also ends failed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { evt, makePool, seedBridgeRun, source } from "./test-helpers.ts";

describe("bridgeRunStream — rate_limit_event telemetry (warren-5249)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let burrowRunId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const ids = await seedBridgeRun(repos);
		runId = ids.runId;
		burrowRunId = ids.burrowRunId;
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	function rateLimitEvent(seq: number, resetsAt: string | null): ReturnType<typeof evt> {
		return evt(burrowRunId, seq, {
			kind: "telemetry",
			stream: "system",
			payload: {
				type: "rate_limit_event",
				rate_limit_info: resetsAt !== null ? { resets_at: resetsAt } : {},
			},
		});
	}

	test("rate_limit_event with resets_at sets rateLimitResetsAt in bridge result", async () => {
		const resetsAt = "2026-06-21T03:00:00.000Z";
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([rateLimitEvent(1, resetsAt)]),
		});
		expect(result.rateLimitResetsAt).toBe(resetsAt);
	});

	test("rate_limit_event without resets_at sets rateLimitResetsAt to null", async () => {
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([rateLimitEvent(1, null)]),
		});
		expect(result.rateLimitResetsAt).toBeNull();
	});

	test("no rate_limit_event → rateLimitResetsAt is undefined", async () => {
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([evt(burrowRunId, 1)]),
		});
		expect(result.rateLimitResetsAt).toBeUndefined();
	});

	test("last rate_limit_event wins when multiple appear", async () => {
		const first = "2026-06-21T01:00:00.000Z";
		const last = "2026-06-21T03:00:00.000Z";
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([rateLimitEvent(1, first), evt(burrowRunId, 2), rateLimitEvent(3, last)]),
		});
		expect(result.rateLimitResetsAt).toBe(last);
	});

	test("telemetry event on non-system stream is ignored", async () => {
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				evt(burrowRunId, 1, {
					kind: "telemetry",
					stream: "stdout",
					payload: {
						type: "rate_limit_event",
						rate_limit_info: { resets_at: "2026-06-21T00:00:00.000Z" },
					},
				}),
			]),
		});
		expect(result.rateLimitResetsAt).toBeUndefined();
	});

	test("non-rate_limit_event telemetry does not set rateLimitResetsAt", async () => {
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				evt(burrowRunId, 1, {
					kind: "telemetry",
					stream: "system",
					payload: { type: "some_other_event", data: {} },
				}),
			]),
		});
		expect(result.rateLimitResetsAt).toBeUndefined();
	});

	test("rate_limit_info with non-string resets_at sets rateLimitResetsAt to null", async () => {
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				evt(burrowRunId, 1, {
					kind: "telemetry",
					stream: "system",
					payload: { type: "rate_limit_event", rate_limit_info: { resets_at: 12345 } },
				}),
			]),
		});
		expect(result.rateLimitResetsAt).toBeNull();
	});
});
