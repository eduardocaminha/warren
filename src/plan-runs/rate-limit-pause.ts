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
import type { CoordinatorEmitFn, CoordinatorRepos } from "./coordinator.ts";

/** Safety buffer added to `resets_at` when computing `resume_at` (warren-3797). */
export const RATE_LIMIT_RESUME_BUFFER_MS = 30_000;

/** Fallback pause when `resets_at` is absent from the rate-limit event (warren-3797). */
export const RATE_LIMIT_FALLBACK_PAUSE_MS = 60 * 60 * 1000;

export function computeResumeAt(resetsAt: string | null, now: Date): string {
	if (resetsAt !== null) {
		const base = Date.parse(resetsAt);
		if (!Number.isNaN(base)) {
			return new Date(base + RATE_LIMIT_RESUME_BUFFER_MS).toISOString();
		}
	}
	return new Date(now.getTime() + RATE_LIMIT_FALLBACK_PAUSE_MS).toISOString();
}

export interface PausePlanRunInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow & { readonly runId: string };
	readonly run: RunRow;
	readonly repos: CoordinatorRepos;
	readonly emit: CoordinatorEmitFn;
	readonly now: () => Date;
}

/**
 * Pause a rate-limited plan-run: reset the child to `pending`, transition
 * the plan-run to `paused_rate_limited`, emit the pause event, and return
 * the resume timestamp for the caller to surface in its `AdvanceResult`.
 */
export async function pausePlanRunForRateLimit(
	input: PausePlanRunInput,
): Promise<{ childSeq: number; resumeAt: string }> {
	const { planRun, child, run, repos, emit, now } = input;
	const resumeAt = computeResumeAt(run.resetsAt, now());
	await repos.planRuns.updateChild({
		planRunId: planRun.id,
		seq: child.seq,
		patch: { state: "pending", runId: null, startedAt: null, endedAt: null, failureReason: null },
		now: now(),
	});
	await repos.planRuns.transitionTo(planRun.id, "paused_rate_limited", { resumeAt });
	await emit(child.runId, "plan_run.paused_rate_limited", {
		planRunId: planRun.id,
		childSeq: child.seq,
		resumeAt,
		resetsAt: run.resetsAt,
	});
	return { childSeq: child.seq, resumeAt };
}
