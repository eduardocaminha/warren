import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunEvent } from "@os-eco/burrow-cli";
import { BurrowClient } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "./events.ts";
import { bridgeRunStream, recoverActiveRunStreams } from "./stream.ts";

function makeBurrowClient(): BurrowClient {
	const fetchImpl = (async () =>
		new Response("{}", {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: fetchImpl,
	});
}

function evt(burrowRunId: string, seq: number, overrides: Partial<RunEvent> = {}): RunEvent {
	return {
		id: 0,
		burrowId: "bur_x",
		runId: burrowRunId,
		seq,
		kind: "text",
		stream: "stdout",
		payload: { seq },
		ts: new Date(2026, 4, 8, 12, 0, seq),
		...overrides,
	};
}

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
	for (const i of items) yield i;
}

function source(events: RunEvent[]): (signal: AbortSignal) => AsyncIterable<RunEvent> {
	return () => asyncIter(events);
}

describe("bridgeRunStream", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let burrowRunId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
		const project = repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		runId = run.id;
		burrowRunId = "run_zzzzzzzzzzzz";
		broker = new RunEventBroker();
	});

	afterEach(() => {
		db.close();
	});

	test("writes every event to the events table and returns a count", async () => {
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([evt(burrowRunId, 1), evt(burrowRunId, 2), evt(burrowRunId, 3)]),
		});
		expect(result.written).toBe(3);
		expect(result.skipped).toBe(0);
		expect(result.errored).toBe(false);
		const rows = repos.events.listByRun(runId).map((e) => e.burrowEventSeq);
		expect(rows).toEqual([1, 2, 3]);
	});

	test("publishes each event to the broker after persisting", async () => {
		const sub = broker.subscribe(runId);
		const consumed: number[] = [];
		const consumer = (async () => {
			for await (const row of sub) {
				consumed.push(row.burrowEventSeq);
				if (consumed.length >= 2) break;
			}
		})();

		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([evt(burrowRunId, 1), evt(burrowRunId, 2)]),
		});
		await consumer;

		expect(consumed).toEqual([1, 2]);
		// Bridge calls broker.close on exit, so subscriberCount returns to 0.
		expect(broker.subscriberCount(runId)).toBe(0);
	});

	test("resume: skips events with seq <= MAX(burrow_event_seq)", async () => {
		// Pre-populate as if a previous warren had persisted seqs 1,2.
		repos.events.append({
			runId,
			burrowEventSeq: 1,
			ts: "2026-05-08T12:00:01.000Z",
			kind: "text",
			stream: "stdout",
			payload: { seq: 1 },
		});
		repos.events.append({
			runId,
			burrowEventSeq: 2,
			ts: "2026-05-08T12:00:02.000Z",
			kind: "text",
			stream: "stdout",
			payload: { seq: 2 },
		});

		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([
				evt(burrowRunId, 1),
				evt(burrowRunId, 2),
				evt(burrowRunId, 3),
				evt(burrowRunId, 4),
			]),
		});
		expect(result.skipped).toBe(2);
		expect(result.written).toBe(2);
		const rows = repos.events.listByRun(runId).map((e) => e.burrowEventSeq);
		expect(rows).toEqual([1, 2, 3, 4]);
	});

	test("normalizes unknown stream tags to null", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([evt(burrowRunId, 1, { stream: "weird" as unknown as RunEvent["stream"] })]),
		});
		const row = repos.events.listByRun(runId)[0];
		expect(row?.stream).toBeNull();
	});

	test("source error: logs, sets errored=true, and does not throw", async () => {
		const errs: object[] = [];
		const source = (): AsyncIterable<RunEvent> => ({
			async *[Symbol.asyncIterator]() {
				yield evt(burrowRunId, 1);
				throw new Error("burrow disconnected");
			},
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: () => source(),
			logger: {
				error(obj) {
					errs.push(obj);
				},
			},
		});
		expect(result.written).toBe(1);
		expect(result.errored).toBe(true);
		expect(errs.length).toBe(1);
	});

	test("AbortSignal stops consumption mid-stream", async () => {
		const ctrl = new AbortController();
		// An infinite source — guarded by signal abort.
		const source = (signal: AbortSignal): AsyncIterable<RunEvent> => ({
			async *[Symbol.asyncIterator]() {
				let i = 1;
				while (!signal.aborted) {
					yield evt(burrowRunId, i++);
					await new Promise((r) => setTimeout(r, 1));
				}
			},
		});

		const promise = bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			signal: ctrl.signal,
			source: (s) => source(s),
		});

		await new Promise((r) => setTimeout(r, 20));
		ctrl.abort();
		const result = await promise;
		expect(result.written).toBeGreaterThan(0);
		// No assertion on errored — abort is allowed to surface as either
		// a clean stop or an AbortError; both are acceptable here.
	});

	test("first event transitions run queued → running and sets startedAt", async () => {
		const before = repos.runs.require(runId);
		expect(before.state).toBe("queued");
		expect(before.startedAt).toBeNull();

		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([evt(burrowRunId, 1)]),
		});

		const after = repos.runs.require(runId);
		expect(after.state).toBe("running");
		expect(after.startedAt).not.toBeNull();
	});

	test("does not transition state when source yields no events", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([]),
		});
		const after = repos.runs.require(runId);
		expect(after.state).toBe("queued");
		expect(after.startedAt).toBeNull();
	});

	test("claim is a no-op when run is already running (resume after restart)", async () => {
		const startedAt = new Date(2026, 0, 1).toISOString();
		repos.runs.markRunning(runId, new Date(startedAt));
		const before = repos.runs.require(runId);

		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([evt(burrowRunId, 1)]),
		});

		const after = repos.runs.require(runId);
		expect(after.state).toBe("running");
		// startedAt was not overwritten by a second claim attempt.
		expect(after.startedAt).toBe(before.startedAt);
	});

	test("warren-a69a: claude-code result event sets terminalDetected and breaks the loop", async () => {
		const claudeResult = evt(burrowRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "result", subtype: "result", is_error: false, terminal_reason: "completed" },
		});
		const trailing = evt(burrowRunId, 2, { kind: "text", payload: { text: "post-terminal" } });
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([claudeResult, trailing]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		// The trailing event after terminal must NOT be persisted — bridge breaks.
		const seqs = repos.events.listByRun(runId).map((e) => e.burrowEventSeq);
		expect(seqs).toEqual([1]);
	});

	test("warren-a69a: claude-code result with is_error=true maps to failed", async () => {
		const claudeFail = evt(burrowRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "result", subtype: "result", is_error: true, terminal_reason: "completed" },
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([claudeFail]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "failed" });
	});

	test("warren-a69a: non-terminal state_change events do not set terminalDetected", async () => {
		const init = evt(burrowRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "system", subtype: "init" },
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([init]),
		});
		expect(result.terminalDetected).toBeUndefined();
	});

	test("bridge end calls broker.close so live subscribers return", async () => {
		const sub = broker.subscribe(runId);
		const out: number[] = [];
		const consumer = (async () => {
			for await (const row of sub) out.push(row.burrowEventSeq);
		})();
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			source: source([evt(burrowRunId, 1)]),
		});
		await consumer;
		expect(out).toEqual([1]);
	});
});

describe("recoverActiveRunStreams", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
		const project = repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		// Seed three runs:
		//   run_a: queued + burrowRunId  → bridge
		//   run_b: running + burrowRunId → bridge
		//   run_c: running, no burrowRunId → skip
		//   run_d: succeeded             → ignore
		repos.runs.create({
			id: "run_aaaaaaaaaaaa",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_a",
			burrowRunId: "rb_a",
		});
		const b = repos.runs.create({
			id: "run_bbbbbbbbbbbb",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_b",
			burrowRunId: "rb_b",
		});
		repos.runs.markRunning(b.id);
		repos.runs.create({
			id: "run_cccccccccccc",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		repos.runs.markRunning("run_cccccccccccc");
		const d = repos.runs.create({
			id: "run_dddddddddddd",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_d",
			burrowRunId: "rb_d",
		});
		repos.runs.markRunning(d.id);
		repos.runs.finalize(d.id, "succeeded");
		broker = new RunEventBroker();
	});

	afterEach(() => {
		db.close();
	});

	test("starts a bridge for each active run with a burrow_run_id", async () => {
		const calls: { runId: string; burrowRunId: string }[] = [];
		const result = recoverActiveRunStreams({
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			bridge: async (input) => {
				calls.push({ runId: input.runId, burrowRunId: input.burrowRunId });
				return { written: 0, skipped: 0, errored: false };
			},
		});
		expect(result.bridges).toHaveLength(2);
		expect(result.skipped).toEqual([{ runId: "run_cccccccccccc", reason: "no_burrow_run_id" }]);
		// Wait for the bridges to settle (they're started synchronously).
		await Promise.all(result.bridges.map((b) => b.done));
		const ids = calls.map((c) => c.runId).sort();
		expect(ids).toEqual(["run_aaaaaaaaaaaa", "run_bbbbbbbbbbbb"]);
	});

	test("returned AbortControllers can stop in-flight bridges", async () => {
		const result = recoverActiveRunStreams({
			repos,
			broker,
			burrowClient: makeBurrowClient(),
			bridge: async (input) => {
				await new Promise<void>((resolve) => {
					if (input.signal === undefined) {
						resolve();
						return;
					}
					if (input.signal.aborted) {
						resolve();
						return;
					}
					input.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return { written: 0, skipped: 0, errored: false };
			},
		});
		for (const b of result.bridges) b.abort.abort();
		await Promise.all(result.bridges.map((b) => b.done));
		// Sanity: nothing terminated by itself before we aborted.
		expect(result.bridges).toHaveLength(2);
	});
});
