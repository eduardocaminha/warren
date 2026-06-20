/**
 * Per-PlanRun decision loop (pl-a258 step 5 / warren-2623).
 *
 * `advancePlanRun` is the state machine: one call dispatches the next child,
 * waits for a run/merge, advances after a merge, pauses on rate-limit, fails
 * terminally on other errors, or returns noop when nothing is actionable.
 * The full state-machine spec lives in warren-2623 step (a)/(b)/(c).
 *
 * Resume semantics (warren-fcc9): a `closed` seed at dispatch time becomes
 * `skipped` so re-dispatching the same plan id picks up mid-plan.
 *
 * Trivial-merge (mx-fd8619): zero-commit push with `reap.empty_push` event
 * advances directly to `merged` without GitHub polling. Dropped commits
 * (warren-72b9) reap `failed` first.
 *
 * Events fire on the most recently dispatched child run (wired to
 * `repos.events.append` by the tick — mirrors `trigger.*` system events).
 * The coordinator never throws — all failure paths are in `AdvanceResult`.
 */

import type { Repos } from "../db/repos/index.ts";
import {
	PLAN_RUN_CHILD_TERMINAL_STATES,
	type PlanRunChildRow,
	type PlanRunChildState,
	type PlanRunRow,
} from "../db/schema.ts";
import { SeedNotFoundError, type SeedShowResult } from "../seeds-cli/index.ts";
import {
	DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS,
	DEFAULT_RATE_LIMIT_BACKOFF_CEIL_MS,
	DEFAULT_RATE_LIMIT_BUFFER_MS,
	DEFAULT_RATE_LIMIT_MAX_RETRIES,
	type RateLimitConfig,
} from "./config.ts";
import {
	type CoordinatorReopenPrFn,
	checkParentRunMerged,
	type HandleInFlightDecision,
	handleSucceededChild,
	isTerminalRun,
} from "./merge-gate.ts";
import type { AutoTransitionResult } from "./plot-transition.ts";
import type { PrMergeChecker } from "./pr-merge.ts";
import { pausePlanRunForRateLimit } from "./rate-limit-pause.ts";

export type { CoordinatorReopenPrFn, HandleInFlightDecision } from "./merge-gate.ts";
export {
	computeResumeAt,
	RATE_LIMIT_FALLBACK_PAUSE_MS,
	RATE_LIMIT_RESUME_BUFFER_MS,
} from "./rate-limit-pause.ts";

export type CoordinatorRepos = Pick<Repos, "planRuns" | "runs" | "events">;

export type CoordinatorShowSeedFn = (projectId: string, seedId: string) => Promise<SeedShowResult>;

export interface CoordinatorSpawnInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly prompt: string;
}

export interface CoordinatorSpawnResult {
	readonly runId: string;
}

export type CoordinatorSpawnFn = (input: CoordinatorSpawnInput) => Promise<CoordinatorSpawnResult>;

export type CoordinatorEmitFn = (
	runId: string,
	kind: PlanRunEventKind,
	payload: Record<string, unknown>,
) => Promise<void>;

/** warren-b290 / pl-7937: auto-transition the bound Plot to `done` on plan_succeeded. */
export type CoordinatorTransitionPlotFn = (planRun: PlanRunRow) => Promise<AutoTransitionResult>;

export const PLAN_RUN_EVENT_KINDS = [
	"plan_run.advanced",
	"plan_run.dispatched",
	"plan_run.waiting_for_merge",
	"plan_run.merged",
	"plan_run.failed",
	"plan_run.succeeded",
	"plan_run.plot_auto_done",
	"plan_run.plot_status_skipped",
	"plan_run.plot_auto_done_failed",
	"plan_run.waiting_for_pr_reopen",
	"plan_run.paused_rate_limited",
	"plan_run.resumed_rate_limited",
] as const;
export type PlanRunEventKind = (typeof PLAN_RUN_EVENT_KINDS)[number];

export type AdvanceResult =
	| { readonly kind: "dispatched"; readonly childRunId: string }
	| { readonly kind: "waiting_for_run" }
	| { readonly kind: "waiting_for_merge" }
	| { readonly kind: "waiting_for_parent_merge" }
	| {
			readonly kind: "advanced";
			readonly mergedChildSeq: number;
			readonly dispatchedChildSeq?: number;
	  }
	| { readonly kind: "plan_failed"; readonly failedSeq: number; readonly reason: string }
	| { readonly kind: "plan_succeeded" }
	| { readonly kind: "noop"; readonly reason: string }
	| { readonly kind: "paused_rate_limited"; readonly childSeq: number; readonly resumeAt: string };

export interface AdvancePlanRunInput {
	readonly planRun: PlanRunRow;
	readonly repos: CoordinatorRepos;
	readonly showSeed: CoordinatorShowSeedFn;
	readonly checkPrMerged: PrMergeChecker;
	readonly spawn: CoordinatorSpawnFn;
	readonly emit: CoordinatorEmitFn;
	/** warren-b290: plot auto-done hook on plan_succeeded. */
	readonly transitionPlot?: CoordinatorTransitionPlotFn;
	/** warren-3937: merge-wait budget (ms); 0 disables. Default: {@link DEFAULT_MERGE_TIMEOUT_MS}. */
	readonly mergeTimeoutMs?: number;
	/** warren-22de: PR-(re)open seam. */
	readonly reopenPr?: CoordinatorReopenPrFn;
	/** warren-e521: rate-limit pause/resume/ceiling config. */
	readonly rateLimitConfig?: RateLimitConfig;
	readonly now?: () => Date;
}

/** Default merge-wait budget: 30 minutes (warren-3937). */
export const DEFAULT_MERGE_TIMEOUT_MS = 30 * 60 * 1000;

const IN_FLIGHT_STATES: readonly PlanRunChildState[] = ["dispatched", "running", "pr_open"];

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
	bufferMs: DEFAULT_RATE_LIMIT_BUFFER_MS,
	backoffBaseMs: DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS,
	backoffCeilMs: DEFAULT_RATE_LIMIT_BACKOFF_CEIL_MS,
	maxRetries: DEFAULT_RATE_LIMIT_MAX_RETRIES,
};

export async function advancePlanRun(input: AdvancePlanRunInput): Promise<AdvanceResult> {
	const nowFn = input.now ?? (() => new Date());
	const mergeTimeoutMs = input.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS;
	const rateLimitConfig = input.rateLimitConfig ?? DEFAULT_RATE_LIMIT_CONFIG;
	let planRun = input.planRun;

	// (a) Queued → running.
	if (planRun.state === "queued") {
		const startedAt = nowFn().toISOString();
		planRun = await input.repos.planRuns.transitionTo(planRun.id, "running", { startedAt });
	}

	// (warren-e521) paused_rate_limited: wait until resume_at, then resume or fail at ceiling.
	// We track how many retries were in flight so the resumed_rate_limited event can be
	// emitted on the newly dispatched run rather than a stale (cleared) child run.
	let resumedFromRateLimit: { retries: number } | null = null;
	if (planRun.state === "paused_rate_limited") {
		const now = nowFn();
		if (planRun.resumeAt === null || now < new Date(planRun.resumeAt)) {
			return { kind: "noop", reason: "plan_paused_rate_limited" };
		}
		// Ceiling check: fail terminally if we've exhausted retries (0 = unlimited).
		if (rateLimitConfig.maxRetries > 0 && planRun.rateLimitRetries >= rateLimitConfig.maxRetries) {
			const reason = `rate_limit_ceiling_exceeded:retries=${planRun.rateLimitRetries}`;
			const endedAt = now.toISOString();
			await input.repos.planRuns.transitionTo(planRun.id, "failed", {
				endedAt,
				failureReason: reason,
				resumeAt: null,
			});
			// Emit on the most recent child run (may be null for a plan with no dispatches yet).
			const childrenForAnchor = await input.repos.planRuns.listChildren(planRun.id);
			const anchor = mostRecentDispatchedRunId(childrenForAnchor);
			if (anchor !== null) {
				await input.emit(anchor, "plan_run.failed", {
					planRunId: planRun.id,
					reason,
				});
			}
			return {
				kind: "plan_failed",
				failedSeq: childrenForAnchor.find((c) => c.state === "pending")?.seq ?? 0,
				reason,
			};
		}
		// Resume: transition back to running, then let the dispatch loop re-queue the child.
		// We'll emit plan_run.resumed_rate_limited on the NEW run after dispatch below.
		const retries = planRun.rateLimitRetries;
		planRun = await input.repos.planRuns.transitionTo(planRun.id, "running", { resumeAt: null });
		resumedFromRateLimit = { retries };
	}

	// warren-d9a2: gate on parent run's PR being merged before dispatching
	// the first child. Auto-plan-runs carry parentRunId — the parent's
	// branch has the seeds state the children need on main.
	if (planRun.parentRunId !== null) {
		const gateResult = await checkParentRunMerged({
			planRun,
			repos: input.repos,
			checkPrMerged: input.checkPrMerged,
			emit: input.emit,
			mergeTimeoutMs,
			now: nowFn,
		});
		if (gateResult !== null) return gateResult;
	}

	let mergedChildSeq: number | undefined;

	// Loop: reload children each iteration so a merge/skip falls through to dispatch.
	for (;;) {
		const children = await input.repos.planRuns.listChildren(planRun.id);
		const inFlight = children.find((c) => IN_FLIGHT_STATES.includes(c.state));

		if (inFlight !== undefined) {
			const decision = await handleInFlight({
				planRun,
				child: inFlight,
				repos: input.repos,
				checkPrMerged: input.checkPrMerged,
				emit: input.emit,
				mergeTimeoutMs,
				now: nowFn,
				reopenPr: input.reopenPr,
				rateLimitConfig,
			});
			if (decision.kind === "merged") {
				mergedChildSeq = inFlight.seq;
				continue;
			}
			if (decision.kind === "result") {
				return decision.result;
			}
		}

		// (c) Pick the next pending child.
		const next = await input.repos.planRuns.pickNextPending(planRun.id);
		if (next === null) {
			// All children terminal — succeed the plan.
			const endedAt = nowFn().toISOString();
			await input.repos.planRuns.transitionTo(planRun.id, "succeeded", { endedAt });
			const anchor = mostRecentDispatchedRunId(children);
			if (anchor !== null) {
				await input.emit(anchor, "plan_run.succeeded", { planRunId: planRun.id });
			}
			// warren-b290 / pl-7937 step 5: auto-transition the bound Plot to `done`
			// when plan_succeeded. Best-effort; no-op when plot_id is unset or hook absent.
			if (planRun.plotId !== null && input.transitionPlot !== undefined) {
				const transitionResult = await input.transitionPlot(planRun);
				if (anchor !== null) {
					const eventKind = transitionPlotEventKind(transitionResult);
					await input.emit(anchor, eventKind, {
						planRunId: planRun.id,
						plotId: planRun.plotId,
						...transitionPlotEventPayload(transitionResult),
					});
				}
			}
			return { kind: "plan_succeeded" };
		}

		// warren-0fed: a definitive "seed not found" is terminal — the
		// plan references an id that doesn't resolve (planned-but-never-
		// created, or only on an unmerged branch), so retrying forever
		// just spams plan_run.noop. Fail the child + plan-run. Any other
		// (transient: timeout / lock / malformed) sd failure stays a
		// retryable noop so a hung seed store can't kill healthy runs.
		//
		// warren-c117: do NOT skip on closed-seed status. A closed seed means
		// the agent finished work, not that the PR merged. A child that actually
		// merged is in `merged` state (terminal) and never reaches pickNextPending.
		// Skipping on seed-closed lets a rate-limit-reset pending child (whose
		// seed was closed before the run failed) bypass the serial merge gate.
		try {
			await input.showSeed(planRun.projectId, next.seedId);
		} catch (err) {
			if (err instanceof SeedNotFoundError) {
				const reason = `child_seed_not_found:${next.seedId}`;
				const endedAt = nowFn().toISOString();
				await input.repos.planRuns.updateChild({
					planRunId: planRun.id,
					seq: next.seq,
					patch: { state: "failed", failureReason: reason, endedAt },
					now: nowFn(),
				});
				await input.repos.planRuns.transitionTo(planRun.id, "failed", {
					endedAt,
					failureReason: reason,
				});
				const anchor = mostRecentDispatchedRunId(children);
				if (anchor !== null) {
					await input.emit(anchor, "plan_run.failed", {
						planRunId: planRun.id,
						failedSeq: next.seq,
						reason,
					});
				}
				return { kind: "plan_failed", failedSeq: next.seq, reason };
			}
			return {
				kind: "noop",
				reason: `show_seed_failed:${formatError(err)}`,
			};
		}

		// Dispatch the next child.
		const prompt = substituteSeedId(planRun.promptTemplate, next.seedId);
		let spawnResult: CoordinatorSpawnResult;
		try {
			spawnResult = await input.spawn({ planRun, child: next, prompt });
		} catch (err) {
			const reason = `dispatch_failed:${formatError(err)}`;
			const endedAt = nowFn().toISOString();
			await input.repos.planRuns.updateChild({
				planRunId: planRun.id,
				seq: next.seq,
				patch: { state: "failed", failureReason: reason, endedAt },
				now: nowFn(),
			});
			await input.repos.planRuns.transitionTo(planRun.id, "failed", {
				endedAt,
				failureReason: reason,
			});
			const anchor = mostRecentDispatchedRunId(children);
			if (anchor !== null) {
				await input.emit(anchor, "plan_run.failed", {
					planRunId: planRun.id,
					failedSeq: next.seq,
					reason,
				});
			}
			return { kind: "plan_failed", failedSeq: next.seq, reason };
		}

		await input.repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: next.seq,
			patch: {
				runId: spawnResult.runId,
				state: "dispatched",
				startedAt: nowFn().toISOString(),
			},
			now: nowFn(),
		});
		await input.emit(spawnResult.runId, "plan_run.dispatched", {
			planRunId: planRun.id,
			seq: next.seq,
			seedId: next.seedId,
		});
		// Emit resumed_rate_limited on the NEW run so observers see it paired with
		// the dispatch event (child's old runId was cleared during pause — warren-e521).
		if (resumedFromRateLimit !== null) {
			await input.emit(spawnResult.runId, "plan_run.resumed_rate_limited", {
				planRunId: planRun.id,
				rateLimitRetries: resumedFromRateLimit.retries,
			});
		}
		if (mergedChildSeq !== undefined) {
			await input.emit(spawnResult.runId, "plan_run.advanced", {
				planRunId: planRun.id,
				mergedChildSeq,
				dispatchedChildSeq: next.seq,
			});
			return {
				kind: "advanced",
				mergedChildSeq,
				dispatchedChildSeq: next.seq,
			};
		}
		return { kind: "dispatched", childRunId: spawnResult.runId };
	}
}

interface HandleInFlightInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly repos: CoordinatorRepos;
	readonly checkPrMerged: PrMergeChecker;
	readonly emit: CoordinatorEmitFn;
	readonly mergeTimeoutMs: number;
	readonly now: () => Date;
	readonly reopenPr?: CoordinatorReopenPrFn; // warren-22de: (re)open PR before failing
	readonly rateLimitConfig: RateLimitConfig; // warren-e521: backoff config for pause
}

async function handleInFlight(input: HandleInFlightInput): Promise<HandleInFlightDecision> {
	const { planRun, child, repos, emit, now, rateLimitConfig } = input;
	if (child.runId === null) {
		return {
			kind: "result",
			result: { kind: "noop", reason: `in_flight_child_missing_run_id:${child.seq}` },
		};
	}
	const run = await repos.runs.get(child.runId);
	if (run === null) {
		return {
			kind: "result",
			result: { kind: "noop", reason: `in_flight_child_run_not_found:${child.runId}` },
		};
	}

	if (!isTerminalRun(run)) {
		// Sync child.state with run.state so the UI sees `running` after
		// burrow emits its first event. Idempotent — the repo's updateChild
		// is a plain write.
		if (run.state === "running" && child.state === "dispatched") {
			await repos.planRuns.updateChild({
				planRunId: planRun.id,
				seq: child.seq,
				patch: { state: "running" },
				now: now(),
			});
		}
		return { kind: "result", result: { kind: "waiting_for_run" } };
	}

	// warren-3797: pause instead of fail when the child hit the rate limit.
	if (run.state === "failed" && run.failureReason === "rate_limited" && child.runId !== null) {
		const { childSeq, resumeAt } = await pausePlanRunForRateLimit({
			planRun,
			child: { ...child, runId: child.runId },
			run,
			repos,
			emit,
			now,
			rateLimitConfig,
		});
		return { kind: "result", result: { kind: "paused_rate_limited", childSeq, resumeAt } };
	}

	if (run.state === "failed" || run.state === "cancelled") {
		const detail = run.failureReason ?? run.state;
		const reason = `child_${detail}`;
		const endedAt = now().toISOString();
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			patch: { state: "failed", endedAt, failureReason: reason },
			now: now(),
		});
		await repos.planRuns.transitionTo(planRun.id, "failed", {
			endedAt,
			failureReason: reason,
		});
		await emit(child.runId, "plan_run.failed", {
			planRunId: planRun.id,
			failedSeq: child.seq,
			reason,
		});
		return {
			kind: "result",
			result: { kind: "plan_failed", failedSeq: child.seq, reason },
		};
	}

	// run.state === "succeeded": PR state machine extracted to merge-gate.ts (warren-e521).
	return handleSucceededChild({
		planRun,
		child: child as typeof child & { runId: string },
		run,
		repos,
		checkPrMerged: input.checkPrMerged,
		emit,
		mergeTimeoutMs: input.mergeTimeoutMs,
		now,
		reopenPr: input.reopenPr,
	});
}

function mostRecentDispatchedRunId(children: readonly PlanRunChildRow[]): string | null {
	for (let i = children.length - 1; i >= 0; i -= 1) {
		const child = children[i];
		if (child !== undefined && child.runId !== null) return child.runId;
	}
	return null;
}

function substituteSeedId(template: string, seedId: string): string {
	return template.replace(/\{seed_id\}/g, seedId);
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Exported for the API handler (warren-f923) to compute "is this plan-run
 * still advancing?" without re-loading every child.
 */
export function isChildTerminal(state: PlanRunChildState): boolean {
	return (PLAN_RUN_CHILD_TERMINAL_STATES as readonly string[]).includes(state);
}

function transitionPlotEventKind(result: AutoTransitionResult): PlanRunEventKind {
	if (result.kind === "transitioned") return "plan_run.plot_auto_done";
	if (result.kind === "skipped") return "plan_run.plot_status_skipped";
	return "plan_run.plot_auto_done_failed";
}

function transitionPlotEventPayload(result: AutoTransitionResult): Record<string, unknown> {
	if (result.kind === "skipped") return { currentStatus: result.currentStatus };
	if (result.kind === "failed") return { reason: result.reason };
	return {};
}
