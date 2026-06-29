import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reapRun } from "./index.ts";
import { MAX_RATE_LIMIT_RESUME_ATTEMPTS } from "./run.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	makePool,
	setup,
} from "./test-helpers.ts";

// -------------------------------------------------------------------------
// Rate-limited pause+resume (warren-3f64)
// -------------------------------------------------------------------------

describe("reapRun — rate-limited pause+resume", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("skips pipeline, emits reap.rate_limited_paused, stamps resume_at on DB row (warren-3f64)", async () => {
		const resumeAt = new Date("2026-06-01T05:00:00.000Z");
		const e = fakeExec();

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			failureReason: "rate_limited",
			resumeAt,
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
		});

		// State is failed/rate_limited (not crashed)
		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("rate_limited");
		// Pipeline skipped: no git push was attempted
		expect(e.calls).toHaveLength(0);
		expect(result.branchPushed).toBe(false);
		// reap.rate_limited_paused event carries resumeAt + resumeAttempts
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const paused = events.find((ev) => ev.kind === "reap.rate_limited_paused");
		expect(paused).toBeDefined();
		expect(paused?.payloadJson).toMatchObject({
			resumeAt: "2026-06-01T05:00:00.000Z",
			resumeAttempts: 0,
		});
		// resume_at is stamped on the DB row so the scheduler can find it
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.resumeAt).toBe("2026-06-01T05:00:00.000Z");
	});

	test("at retry cap: does NOT stamp resume_at (permanent failure, warren-3f64)", async () => {
		// Create a fresh run that already has resumeAttempts = MAX so reap
		// should NOT set resume_at — the run becomes a permanent failure.
		const anchor = await ctx.repos.runs.require(ctx.runId);
		if (anchor.projectId === null) throw new Error("setup failed: no projectId");
		const run = await ctx.repos.runs.create({
			agentName: "refactor-bot",
			projectId: anchor.projectId,
			prompt: "retry cap test",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_retrycap001",
			burrowRunId: "run_retrycap001",
			resumeAttempts: MAX_RATE_LIMIT_RESUME_ATTEMPTS,
		});
		await ctx.repos.burrows.create({ id: "bur_retrycap001", workerId: "local" });
		await ctx.repos.runs.markRunning(run.id);

		const resumeAt = new Date("2026-06-01T05:00:00.000Z");

		const result = await reapRun({
			runId: run.id,
			outcome: "failed",
			failureReason: "rate_limited",
			resumeAt,
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("rate_limited");
		// At the cap: resume_at must remain null (no re-queue)
		const row = await ctx.repos.runs.require(run.id);
		expect(row.resumeAt).toBeNull();
	});
});
