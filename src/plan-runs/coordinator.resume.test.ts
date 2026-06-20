import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SeedNotFoundError, SeedsCliError } from "../seeds-cli/index.ts";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun, type CoordinatorShowSeedFn } from "./coordinator.ts";

describe("advancePlanRun — resume phase", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	// warren-c117: a closed seed does NOT mean the child merged — the agent closes
	// the seed during work, before the PR merges. A pending child with a closed seed
	// must be dispatched (not skipped) so the serial merge gate is preserved.
	test("warren-c117: closed seed is dispatched, not skipped", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		let calls = 0;
		const showSeed: CoordinatorShowSeedFn = async (_p, seedId) => {
			calls += 1;
			// Both seeds report closed — neither should be skipped.
			return { id: seedId, status: "closed" };
		};
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed,
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		// seq=1 should be dispatched, not skipped.
		expect(result.kind).toBe("dispatched");
		expect(calls).toBe(1);
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("dispatched");
		expect(children.find((c) => c.seq === 2)?.state).toBe("pending");
	});

	// warren-c117: re-dispatch after rate-limit reset must not skip the child.
	// Scenario: seq=1 was dispatched, agent ran and closed the seed, the run hit
	// rate limit → child was reset to pending (rate-limit-pause.ts). On resume,
	// the coordinator must re-dispatch seq=1 instead of skipping it.
	test("warren-c117: rate-limit-reset child with closed seed is re-dispatched, not skipped", async () => {
		// Set up: seq=1 is in pending state (simulating rate-limit reset —
		// the child's fields were cleared but seed is already closed).
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		// Simulate rate-limit pause: paused_rate_limited then resumed to running.
		await h.repos.planRuns.transitionTo(h.planRun.id, "paused_rate_limited", {
			resumeAt: new Date(NOW.getTime() - 1000).toISOString(),
			rateLimitRetriesDelta: 1,
		});
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { resumeAt: null });
		const planRun = await h.repos.planRuns.require(h.planRun.id);

		const showSeed: CoordinatorShowSeedFn = async (_p, seedId) => {
			// Agent already closed the seed during the first (rate-limited) run.
			return { id: seedId, status: "closed" };
		};
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed,
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		// seq=1 must be re-dispatched, not skipped.
		expect(result.kind).toBe("dispatched");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("dispatched");
		// Skipped state must NOT appear — that would mean the serial gate was bypassed.
		expect(children.find((c) => c.seq === 1)?.state).not.toBe("skipped");
	});

	test("warren-0fed: a definitive SeedNotFoundError fails the child and the plan-run", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const showSeed: CoordinatorShowSeedFn = async (_p, seedId) => {
			throw new SeedNotFoundError(`sd show ${seedId} exited 1: Issue not found`);
		};
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed,
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.failedSeq).toBe(1);
			expect(result.reason).toBe("child_seed_not_found:warren-a");
		}
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("failed");
		expect(children.find((c) => c.seq === 1)?.failureReason).toBe("child_seed_not_found:warren-a");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("child_seed_not_found:warren-a");
	});

	test("warren-0fed: a transient sd failure stays a retryable noop, not terminal", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const showSeed: CoordinatorShowSeedFn = async (_p, seedId) => {
			throw new SeedsCliError(`sd show ${seedId} exited 1: database is locked`);
		};
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed,
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("noop");
		if (result.kind === "noop") {
			expect(result.reason).toContain("show_seed_failed");
		}
		// Plan-run stays running so the next tick retries.
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("pending");
	});
});
