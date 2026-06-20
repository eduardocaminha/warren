/**
 * Rate-limit pause helpers for the plan-run coordinator (warren-3797).
 *
 * When a child run ends with `failureReason === "rate_limited"`, the
 * coordinator calls `pausePlanRunForRateLimit` to pause the plan instead
 * of failing it. The child is reset to `pending` so it will be re-dispatched
 * after `resume_at`. Warren-e521 wires the tick to re-advance paused plans
 * once `now >= resume_at`.
 */

import type { PlanRunChildRow, PlanRunRow, RunRow } from "../db/schema.ts";
import type { RateLimitConfig } from "./config.ts";
import type { CoordinatorEmitFn, CoordinatorRepos } from "./coordinator.ts";

/** @deprecated Import from config.ts. Kept for back-compat with existing tests (warren-e521). */
export const RATE_LIMIT_RESUME_BUFFER_MS = 30_000;

/** @deprecated Import from config.ts. Kept for back-compat with existing tests (warren-e521). */
export const RATE_LIMIT_FALLBACK_PAUSE_MS = 60 * 60 * 1000;

/**
 * Compute the ISO8601 resume timestamp for a rate-limited plan-run.
 *
 * - When `resetsAt` is present and parseable: `resetsAt + bufferMs`.
 * - When `resetsAt` is absent: exponential backoff `min(base * 2^retries, ceil)`.
 *
 * `retries` is the CURRENT retry count BEFORE incrementing, so retry 0 → base,
 * retry 1 → base*2, etc., capped at `ceil`.
 */
export function computeResumeAt(
	resetsAt: string | null,
	now: Date,
	config: Pick<RateLimitConfig, "bufferMs" | "backoffBaseMs" | "backoffCeilMs">,
	retries: number,
): string {
	if (resetsAt !== null) {
		const base = Date.parse(resetsAt);
		if (!Number.isNaN(base)) {
			return new Date(base + config.bufferMs).toISOString();
		}
	}
	// Exponential backoff: base * 2^retries, capped at ceil.
	const pause = Math.min(config.backoffBaseMs * 2 ** retries, config.backoffCeilMs);
	return new Date(now.getTime() + pause).toISOString();
}

export interface PausePlanRunInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow & { readonly runId: string };
	readonly run: RunRow;
	readonly repos: CoordinatorRepos;
	readonly emit: CoordinatorEmitFn;
	readonly now: () => Date;
	readonly rateLimitConfig: Pick<RateLimitConfig, "bufferMs" | "backoffBaseMs" | "backoffCeilMs">;
}

/**
 * Pause a rate-limited plan-run: reset the child to `pending`, increment
 * `rateLimitRetries`, transition the plan-run to `paused_rate_limited`,
 * emit the pause event, and return the resume timestamp (warren-e521).
 */
export async function pausePlanRunForRateLimit(
	input: PausePlanRunInput,
): Promise<{ childSeq: number; resumeAt: string }> {
	const { planRun, child, run, repos, emit, now, rateLimitConfig } = input;
	const currentRetries = planRun.rateLimitRetries;
	const resumeAt = computeResumeAt(run.resetsAt, now(), rateLimitConfig, currentRetries);
	await repos.planRuns.updateChild({
		planRunId: planRun.id,
		seq: child.seq,
		patch: { state: "pending", runId: null, startedAt: null, endedAt: null, failureReason: null },
		now: now(),
	});
	await repos.planRuns.transitionTo(planRun.id, "paused_rate_limited", {
		resumeAt,
		rateLimitRetriesDelta: 1,
	});
	await emit(child.runId, "plan_run.paused_rate_limited", {
		planRunId: planRun.id,
		childSeq: child.seq,
		resumeAt,
		resetsAt: run.resetsAt,
		rateLimitRetries: currentRetries + 1,
	});
	return { childSeq: child.seq, resumeAt };
}
