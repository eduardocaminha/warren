/**
 * warren-796b: coordinator dirty-PR recovery tests. Exercises the
 * `handleDirtyPr` path in `in-flight.ts` via the full `advancePlanRun`
 * interface. Extracted as a sibling file so each describe callback stays
 * under the 500-line Biome threshold.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CheckPrMergedResult } from "../runs/pr.ts";
import { type Harness, NOW, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun, type RecoverDirtyPrFn } from "./coordinator.ts";

/* ----------------------------------------------------------------------- */
/* Helpers                                                                  */
/* ----------------------------------------------------------------------- */

async function setupPrOpenChild(
	harness: Harness,
	prUrl: string,
	endedAt: Date = NOW,
): Promise<string> {
	await harness.repos.planRuns.transitionTo(harness.planRun.id, "running", {
		startedAt: NOW.toISOString(),
	});
	const runId = await harness.makeRun("warren-a");
	await harness.repos.runs.markRunning(runId, NOW);
	await harness.repos.runs.finalize(runId, "succeeded", endedAt);
	await harness.repos.runs.setPrUrl(runId, prUrl);
	await harness.repos.planRuns.updateChild({
		planRunId: harness.planRun.id,
		seq: 1,
		patch: {
			runId,
			state: "pr_open",
			startedAt: NOW.toISOString(),
		},
	});
	return runId;
}

const PR_URL = "https://github.com/x/y/pull/42";

/* ----------------------------------------------------------------------- */
/* Tests                                                                    */
/* ----------------------------------------------------------------------- */

describe("advancePlanRun — dirty PR recovery (warren-796b)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});
	afterEach(async () => {
		await h.db.close();
	});

	test("dirty PR + seam recovers → waiting_for_merge, plan still running", async () => {
		const runId = await setupPrOpenChild(h, PR_URL);
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const checkPrMerged = async (): Promise<CheckPrMergedResult> => ({ kind: "dirty" });
		const recoverDirtyPr: RecoverDirtyPrFn = async () => "recovered";

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			recoverDirtyPr,
			mergeTimeoutMs: 60_000,
			now: () => NOW,
		});

		expect(result.kind).toBe("waiting_for_merge");
		// Plan must still be running — not failed.
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		// Diagnostic event includes dirtyRecovery marker.
		const ev = h.events.find((e) => e.kind === "plan_run.waiting_for_merge");
		expect(ev).toBeDefined();
		expect(ev?.payload.dirtyRecovery).toBe("recovered");
		expect(ev?.runId).toBe(runId);
	});

	test("dirty PR + seam returns code_conflict → plan_failed with pr_dirty_code_conflict", async () => {
		await setupPrOpenChild(h, PR_URL);
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const checkPrMerged = async (): Promise<CheckPrMergedResult> => ({ kind: "dirty" });
		const recoverDirtyPr: RecoverDirtyPrFn = async () => "code_conflict";

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			recoverDirtyPr,
			mergeTimeoutMs: 60_000,
			now: () => NOW,
		});

		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("pr_dirty_code_conflict");
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("pr_dirty_code_conflict");
		// The plan_run.failed event payload carries the prUrl.
		const failEv = h.events.find((e) => e.kind === "plan_run.failed");
		expect(failEv?.payload.prUrl).toBe(PR_URL);
	});

	test("dirty PR + seam returns error → treated as open (waiting_for_merge, no failure)", async () => {
		await setupPrOpenChild(h, PR_URL);
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const checkPrMerged = async (): Promise<CheckPrMergedResult> => ({ kind: "dirty" });
		const recoverDirtyPr: RecoverDirtyPrFn = async () => "error";

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			recoverDirtyPr,
			mergeTimeoutMs: 60_000,
			now: () => NOW,
		});

		// Falls through to handleOpenPr: still within budget → waiting_for_merge.
		expect(result.kind).toBe("waiting_for_merge");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
	});

	test("dirty PR + no recovery seam → treated as open (waiting_for_merge)", async () => {
		await setupPrOpenChild(h, PR_URL);
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const checkPrMerged = async (): Promise<CheckPrMergedResult> => ({ kind: "dirty" });
		// No recoverDirtyPr seam wired.

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			mergeTimeoutMs: 60_000,
			now: () => NOW,
		});

		expect(result.kind).toBe("waiting_for_merge");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
	});

	test("dirty PR + noop recovery + budget exceeded → plan_failed (child_pr_merge_timeout)", async () => {
		const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
		await setupPrOpenChild(h, PR_URL, NOW);
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const checkPrMerged = async (): Promise<CheckPrMergedResult> => ({ kind: "dirty" });
		const recoverDirtyPr: RecoverDirtyPrFn = async () => "noop";

		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			recoverDirtyPr,
			mergeTimeoutMs: 60_000,
			// now is 2 hours past endedAt → budget exceeded
			now: () => new Date(NOW.getTime() + TWO_HOURS_MS),
		});

		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("child_pr_merge_timeout");
		}
	});
});
