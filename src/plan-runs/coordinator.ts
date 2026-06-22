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
import { buildDispatchPrompt } from "../runs/dispatch-prompt.ts";
import { SeedNotFoundError, type SeedShowResult } from "../seeds-cli/index.ts";
import {
	DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS,
	DEFAULT_RATE_LIMIT_BACKOFF_CEIL_MS,
	DEFAULT_RATE_LIMIT_BUFFER_MS,
	DEFAULT_RATE_LIMIT_MAX_RETRIES,
	type RateLimitConfig,
} from "./config.ts";
import {
	defaultResolveExecution,
	executionFields,
	failChildAndPlan,
	handleInFlight,
} from "./in-flight.ts";
import { type CoordinatorReopenPrFn, checkParentRunMerged } from "./merge-gate.ts";
import type { AutoTransitionResult } from "./plot-transition.ts";
import type { PrMergeChecker } from "./pr-merge.ts";

export type { CoordinatorReopenPrFn, HandleInFlightDecision } from "./merge-gate.ts";
export {
	computeResumeAt,
	RATE_LIMIT_FALLBACK_PAUSE_MS,
	RATE_LIMIT_RESUME_BUFFER_MS,
} from "./rate-limit-pause.ts";

export type CoordinatorRepos = Pick<Repos, "planRuns" | "runs" | "events">;

export type CoordinatorShowSeedFn = (projectId: string, seedId: string) => Promise<SeedShowResult>;

/**
 * Per-child execution routing decision (pl-fb43 step 5 / warren-d9f3).
 *
 * `executionProjectId` is the project whose repo is cloned into the burrow
 * workspace — where the child actually does its work. It is the coordination
 * project (`planRun.projectId`) for an untagged child, or the project a
 * child seed's `extensions.repo` resolved to. `repoRef` carries the raw
 * `extensions.repo` string when the child was routed (null on fallback) so
 * the emitted events and Plot mirror are self-describing.
 */
export interface ChildExecution {
	readonly executionProjectId: string;
	readonly repoRef: string | null;
}

/**
 * Resolve a child's execution project from its seed `extensions.repo`
 * (pl-fb43 step 5). Implemented in src/plan-runs/dispatch.ts on top of
 * `resolveTargetProject`; throws `TargetProjectUnresolvedError` when a
 * present repo tag matches no registered project, which the coordinator
 * routes to the existing plan_failed path. Default (tests / unwired) maps
 * every child to the coordination project.
 */
export type CoordinatorResolveExecutionFn = (
	planRun: PlanRunRow,
	seedExtensions: Record<string, unknown> | undefined,
) => Promise<ChildExecution>;

export interface CoordinatorSpawnInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly prompt: string;
	/** Resolved execution routing for this child (pl-fb43 step 5). */
	readonly execution?: ChildExecution;
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
	/** pl-fb43 step 5: per-child execution-repo resolver (default = coordination project). */
	readonly resolveExecution?: CoordinatorResolveExecutionFn;
	/** warren-b290: Plot auto-done hook fired on plan_succeeded when plotId is set. */
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
	const resolveExecution = input.resolveExecution ?? defaultResolveExecution;
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
				showSeed: input.showSeed,
				resolveExecution,
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
		let seedShow: SeedShowResult;
		try {
			seedShow = await input.showSeed(planRun.projectId, next.seedId);
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

		// pl-fb43 step 5: resolve the child's execution repo from its
		// `extensions.repo` tag (fallback = the coordination project). A
		// present-but-unresolvable tag fails this child + the plan via the
		// existing plan_failed path with a typed `unresolved_repo:` reason.
		let execution: ChildExecution;
		try {
			execution = await resolveExecution(planRun, seedShow.extensions);
		} catch (err) {
			const reason = `unresolved_repo:${formatError(err)}`;
			return await failChildAndPlan({
				repos: input.repos,
				planRun,
				seq: next.seq,
				anchorRunId: mostRecentDispatchedRunId(children),
				reason,
				emit: input.emit,
				now: nowFn,
			});
		}

		// Dispatch the next child; seed text inlined via the shared builder.
		const prompt = buildDispatchPrompt({
			template: planRun.promptTemplate,
			seed: { id: next.seedId, title: seedShow.title, body: seedShow.description },
		});
		let spawnResult: CoordinatorSpawnResult;
		try {
			spawnResult = await input.spawn({ planRun, child: next, prompt, execution });
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
				// pl-fb43 step 6 / warren-57f6: persist the resolved execution
				// project so the detail API + UI can show which repo this child
				// targeted without re-reading the seed's `extensions.repo`.
				executionProjectId: execution.executionProjectId,
				state: "dispatched",
				startedAt: nowFn().toISOString(),
			},
			now: nowFn(),
		});
		const execFields = executionFields(execution);
		await input.emit(spawnResult.runId, "plan_run.dispatched", {
			planRunId: planRun.id,
			seq: next.seq,
			seedId: next.seedId,
			...execFields,
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
				...execFields,
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

/* handleInFlight + execution helpers live in ./in-flight.ts (size budget). */

function mostRecentDispatchedRunId(children: readonly PlanRunChildRow[]): string | null {
	for (let i = children.length - 1; i >= 0; i -= 1) {
		const child = children[i];
		if (child !== undefined && child.runId !== null) return child.runId;
	}
	return null;
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
