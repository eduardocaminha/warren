/**
 * Coordinator tests for rate-limit pause behavior (warren-3797) and
 * resume/backoff/ceiling behavior (warren-e521).
 *
 * When a child run finishes with `failureReason === "rate_limited"`, the
 * coordinator must pause the plan-run (`paused_rate_limited`) instead of
 * failing it terminally. The paused child is reset to `pending` so it can be
 * re-dispatched after `resume_at`. Warren-e521 wires the resume: when
 * `now >= resume_at`, the plan transitions back to `running` and the child
 * is re-dispatched. A ceiling on retries fails the plan terminally.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import {
	advancePlanRun,
	RATE_LIMIT_FALLBACK_PAUSE_MS,
	RATE_LIMIT_RESUME_BUFFER_MS,
} from "./coordinator.ts";
import { computeResumeAt } from "./rate-limit-pause.ts";

describe("advancePlanRun — rate-limit pause (warren-3797)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("rate_limited child → paused_rate_limited, child reset to pending, resumeAt = resetsAt + buffer", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		const resetsAt = "2026-05-17T01:00:00.000Z";
		await h.repos.runs.finalize(runId, "failed", NOW, "rate_limited", resetsAt);
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});

		expect(result.kind).toBe("paused_rate_limited");
		if (result.kind === "paused_rate_limited") {
			expect(result.childSeq).toBe(1);
			const expected = new Date(Date.parse(resetsAt) + RATE_LIMIT_RESUME_BUFFER_MS).toISOString();
			expect(result.resumeAt).toBe(expected);
		}

		// plan-run transitions to paused_rate_limited
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("paused_rate_limited");
		expect(reloaded.resumeAt).not.toBeNull();

		// child is reset to pending (run_id cleared) so it can be re-dispatched
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		const child = children.find((c) => c.seq === 1);
		expect(child?.state).toBe("pending");
		expect(child?.runId).toBeNull();
		expect(child?.startedAt).toBeNull();
		expect(child?.endedAt).toBeNull();
		expect(child?.failureReason).toBeNull();
	});

	test("rate_limited without resetsAt falls back to now + RATE_LIMIT_FALLBACK_PAUSE_MS", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		// No resetsAt — burrow may omit it
		await h.repos.runs.finalize(runId, "failed", NOW, "rate_limited", null);
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});

		expect(result.kind).toBe("paused_rate_limited");
		if (result.kind === "paused_rate_limited") {
			const expected = new Date(NOW.getTime() + RATE_LIMIT_FALLBACK_PAUSE_MS).toISOString();
			expect(result.resumeAt).toBe(expected);
		}
	});

	test("rate_limited child emits plan_run.paused_rate_limited event", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		const resetsAt = "2026-05-17T02:00:00.000Z";
		await h.repos.runs.finalize(runId, "failed", NOW, "rate_limited", resetsAt);
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});

		const pausedEvent = h.events.find((e) => e.kind === "plan_run.paused_rate_limited");
		expect(pausedEvent).not.toBeUndefined();
		expect(pausedEvent?.payload.planRunId).toBe(h.planRun.id);
		expect(pausedEvent?.payload.childSeq).toBe(1);
		expect(pausedEvent?.payload.resetsAt).toBe(resetsAt);
		expect(typeof pausedEvent?.payload.resumeAt).toBe("string");
	});

	test("rate_limited child does NOT emit plan_run.failed", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "failed", NOW, "rate_limited", null);
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});

		expect(h.events.some((e) => e.kind === "plan_run.failed")).toBe(false);
	});

	test("other failure reasons still fail the plan (regression guard)", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "failed", NOW, "crashed");
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});

		expect(result.kind).toBe("plan_failed");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
	});

	test("paused_rate_limited plan-run returns noop (guard for early resume call)", async () => {
		const { planRun: paused } = await h.repos.planRuns.create({
			planId: "pl-paused",
			projectId: h.projectId,
			agentName: "claude-code",
			state: "paused_rate_limited",
			children: [{ seq: 1, seedId: "warren-c" }],
			now: NOW,
		});

		const result = await advancePlanRun({
			planRun: paused,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});

		expect(result.kind).toBe("noop");
		if (result.kind === "noop") {
			expect(result.reason).toBe("plan_paused_rate_limited");
		}
	});
});

/* ------------------------------------------------------------------ */
/* computeResumeAt — backoff logic (warren-e521)                       */
/* ------------------------------------------------------------------ */

describe("computeResumeAt (warren-e521)", () => {
	const config = {
		bufferMs: 30_000,
		backoffBaseMs: 60 * 60 * 1000, // 1h
		backoffCeilMs: 8 * 60 * 60 * 1000, // 8h
	};

	test("with resetsAt: resumeAt = resetsAt + bufferMs", () => {
		const resetsAt = "2026-05-17T01:00:00.000Z";
		const result = computeResumeAt(resetsAt, NOW, config, 0);
		const expected = new Date(Date.parse(resetsAt) + 30_000).toISOString();
		expect(result).toBe(expected);
	});

	test("with resetsAt: ignores retry count", () => {
		const resetsAt = "2026-05-17T01:00:00.000Z";
		expect(computeResumeAt(resetsAt, NOW, config, 0)).toBe(
			computeResumeAt(resetsAt, NOW, config, 3),
		);
	});

	test("without resetsAt: retry 0 → base", () => {
		const result = computeResumeAt(null, NOW, config, 0);
		const expected = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
		expect(result).toBe(expected);
	});

	test("without resetsAt: retry 1 → base * 2", () => {
		const result = computeResumeAt(null, NOW, config, 1);
		const expected = new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString();
		expect(result).toBe(expected);
	});

	test("without resetsAt: retry 2 → base * 4", () => {
		const result = computeResumeAt(null, NOW, config, 2);
		const expected = new Date(NOW.getTime() + 4 * 60 * 60 * 1000).toISOString();
		expect(result).toBe(expected);
	});

	test("without resetsAt: capped at backoffCeilMs", () => {
		// retry 10 → 1024h but capped at 8h
		const result = computeResumeAt(null, NOW, config, 10);
		const expected = new Date(NOW.getTime() + 8 * 60 * 60 * 1000).toISOString();
		expect(result).toBe(expected);
	});

	test("malformed resetsAt falls back to backoff", () => {
		const result = computeResumeAt("not-a-date", NOW, config, 0);
		const expected = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
		expect(result).toBe(expected);
	});
});

/* ------------------------------------------------------------------ */
/* Resume behavior (warren-e521)                                       */
/* ------------------------------------------------------------------ */

describe("advancePlanRun — rate-limit resume (warren-e521)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	const rateLimitConfig = {
		bufferMs: 30_000,
		backoffBaseMs: 60 * 60 * 1000,
		backoffCeilMs: 8 * 60 * 60 * 1000,
		maxRetries: 3,
	};

	async function buildPausedPlanRun(resumeAt: string, retries = 1) {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "failed", NOW, "rate_limited", null);
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
		});
		const fresh = await h.repos.planRuns.require(h.planRun.id);
		// Simulate pause with specific resumeAt and retries count
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { state: "pending", runId: null, startedAt: null, endedAt: null, failureReason: null },
		});
		// Directly set paused state with the desired resumeAt and retries
		await h.repos.planRuns.transitionTo(h.planRun.id, "paused_rate_limited", {
			resumeAt,
			rateLimitRetriesDelta: retries - fresh.rateLimitRetries,
		});
		return h.repos.planRuns.require(h.planRun.id);
	}

	test("before resume_at: returns noop", async () => {
		const resumeAt = new Date(NOW.getTime() + 60_000).toISOString(); // 1m in future
		await buildPausedPlanRun(resumeAt);
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			rateLimitConfig,
			now: () => NOW,
		});

		expect(result.kind).toBe("noop");
		if (result.kind === "noop") {
			expect(result.reason).toBe("plan_paused_rate_limited");
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("paused_rate_limited");
	});

	test("at resume_at: transitions to running and re-dispatches the pending child", async () => {
		const resumeAt = NOW.toISOString(); // exactly NOW = ready
		await buildPausedPlanRun(resumeAt);
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const dispatched: string[] = [];
		const spawn = h.spawnStub(() => {
			const id = `run-${dispatched.length + 1}`;
			dispatched.push(id);
			return id;
		});

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn,
			emit: h.emit,
			rateLimitConfig,
			now: () => NOW,
		});

		// Should have dispatched the child
		expect(result.kind).toBe("dispatched");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		expect(reloaded.resumeAt).toBeNull();
	});

	test("at resume_at: emits plan_run.resumed_rate_limited event", async () => {
		const resumeAt = NOW.toISOString();
		await buildPausedPlanRun(resumeAt, 1);
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			rateLimitConfig,
			now: () => NOW,
		});

		// resumed event must fire (on the most recently dispatched run)
		const resumedEvent = h.events.find((e) => e.kind === "plan_run.resumed_rate_limited");
		expect(resumedEvent).not.toBeUndefined();
		expect(resumedEvent?.payload.planRunId).toBe(h.planRun.id);
	});

	test("ceiling: rateLimitRetries >= maxRetries fails the plan terminally", async () => {
		const resumeAt = NOW.toISOString(); // ready to resume
		// Set retries equal to maxRetries (3)
		await buildPausedPlanRun(resumeAt, rateLimitConfig.maxRetries);
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		expect(planRun.rateLimitRetries).toBe(rateLimitConfig.maxRetries);

		let spawnCalled = false;
		const spawn = h.spawnStub(() => {
			spawnCalled = true;
			return "unused";
		});

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn,
			emit: h.emit,
			rateLimitConfig,
			now: () => NOW,
		});

		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toContain("rate_limit_ceiling_exceeded");
		}
		expect(spawnCalled).toBe(false);
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toContain("rate_limit_ceiling_exceeded");
	});

	test("ceiling disabled (maxRetries=0): never fails terminally on retry count alone", async () => {
		const noCeilingConfig = { ...rateLimitConfig, maxRetries: 0 };
		const resumeAt = NOW.toISOString();
		// Set very high retry count
		await buildPausedPlanRun(resumeAt, 100);
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			rateLimitConfig: noCeilingConfig,
			now: () => NOW,
		});

		// Should dispatch, not fail
		expect(result.kind).toBe("dispatched");
	});

	test("pause increments rateLimitRetries in the plan_run.paused_rate_limited event", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "failed", NOW, "rate_limited", null);
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			rateLimitConfig,
			now: () => NOW,
		});

		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.rateLimitRetries).toBe(1);

		const pausedEvent = h.events.find((e) => e.kind === "plan_run.paused_rate_limited");
		expect(pausedEvent?.payload.rateLimitRetries).toBe(1);
	});

	test("second rate-limit pause uses exponential backoff (no resetsAt)", async () => {
		// Simulate a plan that's been rate-limited once already (retries=1)
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		// Manually set retries=1 by doing a first-pause transition
		await h.repos.planRuns.transitionTo(h.planRun.id, "paused_rate_limited", {
			resumeAt: NOW.toISOString(),
			rateLimitRetriesDelta: 1,
		});
		// Reset to running so we can pause again
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { resumeAt: null });

		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "failed", NOW, "rate_limited", null);
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		expect(planRun.rateLimitRetries).toBe(1);

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			rateLimitConfig,
			now: () => NOW,
		});

		expect(result.kind).toBe("paused_rate_limited");
		if (result.kind === "paused_rate_limited") {
			// retry 1 → base * 2^1 = 2h
			const expected = new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString();
			expect(result.resumeAt).toBe(expected);
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.rateLimitRetries).toBe(2);
	});
});
