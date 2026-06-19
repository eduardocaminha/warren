import type { Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunTerminalState } from "../../db/schema.ts";

export function isTerminal(state: string): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

export interface InferredFailure {
	reason: RunFailureReason;
	/** ISO8601 reset timestamp from a rate_limit_event, or null. */
	rateLimitResetsAt: string | null;
}

/**
 * Infer failure_reason from state-on-entry plus the event log
 * (warren-3c40, warren-5165, warren-5249). Only consulted when
 * `outcome === "failed"` and the caller didn't override.
 *
 *   queued on entry  → never_started (bridge never claimed the row)
 *   running + rate_limit_event telemetry → rate_limited (warren-5249)
 *   running, no model-turn output observed → no_model_response
 *   running, model-turn output observed   → crashed
 *
 * "Model-turn output" = any event with `kind` in {text, thinking,
 * tool_use} on `stream=stdout`. burrow's jsonl-claude parser maps a
 * claude-code `assistant` envelope into one of those shapes per content
 * block (see burrow `src/runtime/parsers/jsonl-claude.ts`); a run that
 * dies before producing any assistant turn has none of them. The catch-
 * all on unparseable stdout lines also lands as `kind=text` — a known
 * minor false-negative in the rare case where claude-code prints non-
 * JSON to stdout before exiting.
 *
 * rate_limit_event (warren-5249): burrow's jsonl-claude parser maps the
 * Claude Code `{"type":"rate_limit_event","rate_limit_info":{...}}`
 * envelope to a `telemetry` event on the system stream. When present,
 * the run is classified `rate_limited` and `resets_at` is extracted
 * from `rate_limit_info.resets_at` (ISO8601 string, or null if absent).
 */
export async function inferFailureReason(
	repos: Repos,
	runId: string,
	stateOnEntry: string,
): Promise<InferredFailure> {
	if (stateOnEntry === "queued") return { reason: "never_started", rateLimitResetsAt: null };
	const events = await repos.events.listByRun(runId);

	// Rate limit takes priority: if burrow emitted a rate_limit_event
	// telemetry envelope, that's the definitive cause regardless of whether
	// the model produced any output before the limit hit.
	for (const ev of events) {
		if (ev.kind !== "telemetry" || ev.stream !== "system") continue;
		const p = ev.payloadJson as Record<string, unknown>;
		if (p.type !== "rate_limit_event") continue;
		const info = p.rate_limit_info;
		const resetsAt =
			info !== null &&
			typeof info === "object" &&
			typeof (info as Record<string, unknown>).resets_at === "string"
				? ((info as Record<string, unknown>).resets_at as string)
				: null;
		return { reason: "rate_limited", rateLimitResetsAt: resetsAt };
	}

	const sawModelTurn = events.some(
		(ev) =>
			ev.stream === "stdout" &&
			(ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_use"),
	);
	return { reason: sawModelTurn ? "crashed" : "no_model_response", rateLimitResetsAt: null };
}

/**
 * Resolve the failure reason (inferring from the event log when no
 * override is given) and transition the run to its terminal state in one
 * step (warren-5249 refactor). Returns `{ finalState, failureReason }`
 * so callers don't need a local `let failureReason` + separate
 * `transitionToTerminal` call.
 *
 * `failureReasonOverride` is non-null when the caller has already
 * determined the reason (e.g. `dropped_commit` from reap's dirty-tree
 * check, or `timed_out` from the watchdog). When null and
 * `outcome === "failed"`, the event log is scanned via
 * `inferFailureReason` to classify the root cause.
 */
export async function resolveAndTransition(
	repos: Repos,
	runId: string,
	currentState: string,
	outcome: RunTerminalState,
	now: Date,
	failureReasonOverride: RunFailureReason | null,
): Promise<{ finalState: RunTerminalState; failureReason: RunFailureReason | null }> {
	let failureReason: RunFailureReason | null = failureReasonOverride;
	let rateLimitResetsAt: string | null = null;
	if (outcome === "failed" && failureReason === null) {
		const inferred = await inferFailureReason(repos, runId, currentState);
		failureReason = inferred.reason;
		rateLimitResetsAt = inferred.rateLimitResetsAt;
	}
	if (currentState === "queued" && outcome !== "cancelled") {
		await repos.runs.markRunning(runId, now);
	}
	const finalized = await repos.runs.finalize(
		runId,
		outcome,
		now,
		failureReason,
		rateLimitResetsAt,
	);
	return { finalState: finalized.state as RunTerminalState, failureReason };
}
