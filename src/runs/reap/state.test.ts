import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reapRun } from "./index.ts";
import { extractRateLimitFromEvents } from "./state.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	makePool,
	setup,
} from "./test-helpers.ts";

describe("reapRun failure-reason inference (warren-3c40 / warren-5165)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("classifies a queued-on-entry failure as never_started (warren-3c40)", async () => {
		// New run is created in `queued`; no bridge event ever fired, so it
		// stays `queued` — that's the "burrow accepted dispatch but never
		// started the run" shape.
		const repos = ctx.repos;
		const project = (await repos.projects.listAll())[0];
		expect(project).toBeDefined();
		const stuck = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: (project as { id: string }).id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_neverstarted",
		});

		const result = await reapRun({
			runId: stuck.id,
			outcome: "failed",
			repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("never_started");
		const row = await repos.runs.require(stuck.id);
		expect(row.state).toBe("failed");
		expect(row.failureReason).toBe("never_started");

		const events = await repos.events.listByRun(stuck.id);
		const completed = events.find((e) => e.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({ failureReason: "never_started" });
	});

	test("classifies running-on-entry with model output as crashed (warren-3c40)", async () => {
		// ctx.runId was already markRunning'd in setup(). Seed an assistant
		// text event so the discriminator sees a real model turn — that's
		// the "agent ran and crashed mid-conversation" shape, distinct from
		// the warren-5165 no-output shape.
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "I'll start by reading the file." },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("crashed");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("crashed");
	});

	test("classifies running-on-entry with no model output as no_model_response (warren-5165)", async () => {
		// Bridge claimed the run on a non-model-turn event (e.g. the
		// claude-code init system event), then the agent exited before
		// producing any assistant turn — the "Not logged in / credential"
		// shape from run_hkkm35bcckc4. Seed a state_change/system event
		// to simulate the init, but no text/thinking/tool_use stdout
		// events.
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "system", subtype: "init", apiKeySource: "/login managed key" },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("no_model_response");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("no_model_response");
	});

	test("thinking and tool_use events also count as model-turn output (warren-5165)", async () => {
		// burrow's jsonl-claude parser maps assistant content blocks into
		// kind=text, kind=thinking, or kind=tool_use. Any one of them is
		// proof the run reached at least one assistant turn → crashed,
		// not no_model_response.
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "tool_use",
			stream: "stdout",
			payload: { type: "tool_use", name: "Read", input: { path: "/x" } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("crashed");
	});

	test("succeeded runs carry no failureReason", async () => {
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(result.failureReason).toBeNull();
		expect((await ctx.repos.runs.require(ctx.runId)).failureReason).toBeNull();
	});

	test("explicit failureReason override wins over inference (warren-3c40)", async () => {
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			failureReason: "timed_out",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(result.failureReason).toBe("timed_out");
		expect((await ctx.repos.runs.require(ctx.runId)).failureReason).toBe("timed_out");
	});

	test("idempotent reap surfaces the previously-stored failureReason", async () => {
		// Seed a model-turn event so the first reap classifies as crashed
		// (warren-5165 discriminator: bare running-on-entry with no model
		// output would now classify as no_model_response).
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "ok" },
		});
		// First reap: classify as crashed and persist.
		await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		// Second reap on the now-terminal row should report the same reason
		// (idempotency for restart-recovery sweeps).
		const second = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(second.alreadyTerminal).toBe(true);
		expect(second.failureReason).toBe("crashed");
	});
});

describe("extractRateLimitFromEvents (warren-395e)", () => {
	function makeEvent(stream: "system" | "stdout" | "stderr", payload: unknown) {
		return {
			id: 1,
			runId: "run_x",
			burrowEventSeq: 1,
			ts: "2026-01-01T00:00:00.000Z",
			kind: "state_change",
			stream,
			payloadJson: payload,
		} as const;
	}

	test("returns null for empty event list", () => {
		expect(extractRateLimitFromEvents([])).toBeNull();
	});

	test("detects result with api_error_status 429", () => {
		const events = [makeEvent("system", { type: "result", is_error: true, api_error_status: 429 })];
		const info = extractRateLimitFromEvents(events);
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toBeNull();
	});

	test("extracts resumeAt from result api_error_status 429 with resetsAt", () => {
		const ts = "2026-06-29T08:00:00.000Z";
		const events = [
			makeEvent("system", { type: "result", is_error: true, api_error_status: 429, resetsAt: ts }),
		];
		const info = extractRateLimitFromEvents(events);
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toEqual(new Date(ts));
	});

	test("detects rate_limit_event with status rejected", () => {
		const ts = "2026-06-29T09:00:00.000Z";
		const events = [
			makeEvent("system", { type: "rate_limit_event", status: "rejected", resetsAt: ts }),
		];
		const info = extractRateLimitFromEvents(events);
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toEqual(new Date(ts));
	});

	test("detects session-limit text fallback", () => {
		const events = [
			makeEvent("system", {
				type: "result",
				is_error: true,
				result: "You've hit your session limit. It resets in 5 hours.",
			}),
		];
		expect(extractRateLimitFromEvents(events)).not.toBeNull();
	});

	test("ignores stdout events with rate-limit-looking payloads", () => {
		const events = [makeEvent("stdout", { type: "result", api_error_status: 429 })];
		expect(extractRateLimitFromEvents(events)).toBeNull();
	});

	test("returns null for normal failed run events (no 429 signal)", () => {
		const events = [
			makeEvent("system", { type: "result", is_error: true }),
			{
				id: 2,
				runId: "run_x",
				burrowEventSeq: 2,
				ts: "2026-01-01T00:00:00.000Z",
				kind: "text",
				stream: "stdout" as const,
				payloadJson: { text: "work done" },
			},
		];
		expect(extractRateLimitFromEvents(events)).toBeNull();
	});
});

describe("inferFailureReason — rate_limited classification (warren-395e)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("classifies running-on-entry with 429 result as rate_limited", async () => {
		// Seed a model-turn event AND a 429 result — verifies rate_limited wins
		// over the crashed heuristic.
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "Starting analysis." },
		});
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 2,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "result", is_error: true, api_error_status: 429 },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("rate_limited");
	});

	test("rate_limited run with resetsAt propagates resumeAt", async () => {
		const ts = "2026-07-01T06:00:00.000Z";
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: {
				type: "rate_limit_event",
				status: "rejected",
				resetsAt: ts,
			},
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("rate_limited");
		expect(result.resumeAt).toEqual(new Date(ts));
	});

	test("crashed run without 429 signal still classifies as crashed", async () => {
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "Doing work then crashing." },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("crashed");
	});

	test("rate_limited run without resetsAt propagates resumeAt as null", async () => {
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "result", is_error: true, api_error_status: 429 },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("rate_limited");
		expect(result.resumeAt).toBeNull();
	});
});
