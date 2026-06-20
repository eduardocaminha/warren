/**
 * Coordinator tests for rate-limit pause behavior (warren-3797).
 *
 * When a child run finishes with `failureReason === "rate_limited"`, the
 * coordinator must pause the plan-run (`paused_rate_limited`) instead of
 * failing it terminally. The paused child is reset to `pending` so it can be
 * re-dispatched after `resume_at`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import {
	advancePlanRun,
	RATE_LIMIT_FALLBACK_PAUSE_MS,
	RATE_LIMIT_RESUME_BUFFER_MS,
} from "./coordinator.ts";

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
