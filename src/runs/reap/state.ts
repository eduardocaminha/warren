import type { Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunTerminalState } from "../../db/schema.ts";

export function isTerminal(state: string): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

/**
 * Infer failure_reason from state-on-entry plus the event log
 * (warren-3c40, warren-5165, warren-395e). Only consulted when
 * `outcome === "failed"` and the caller didn't override.
 *
 *   queued on entry  → never_started (bridge never claimed the row)
 *   running, no model-turn output observed → no_model_response
 *   running, model-turn output observed, 429 system event → rate_limited
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
 * warren-395e: before concluding `crashed`, scan system events for the
 * rate-limit 429 signal (`api_error_status: 429`, `rate_limit_event`
 * with `status: "rejected"`, or the session-limit text). Callers that
 * have this information already pass `failureReason: "rate_limited"`
 * explicitly (via bridge-reconnect), so this path is a fallback for
 * callers that don't (e.g. boot reconciliation, manual reap).
 */
export async function inferFailureReason(
	repos: Repos,
	runId: string,
	stateOnEntry: string,
): Promise<RunFailureReason> {
	if (stateOnEntry === "queued") return "never_started";
	const events = await repos.events.listByRun(runId);
	const sawModelTurn = events.some(
		(ev) =>
			ev.stream === "stdout" &&
			(ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_use"),
	);
	if (!sawModelTurn) return "no_model_response";
	// Check for 429 rate-limit signal in system events before assuming crash.
	const rateLimited = events.some(
		(ev) => ev.stream === "system" && isRateLimitPayload(ev.payloadJson),
	);
	return rateLimited ? "rate_limited" : "crashed";
}

/**
 * Returns true when a system-event payload carries a Claude session-limit 429
 * signal (warren-395e). Mirrors the three shapes from detectRateLimitTerminal:
 * api_error_status 429, rate_limit_event with status rejected, or text
 * containing "session limit" + "resets".
 */
function isRateLimitPayload(payload: unknown): boolean {
	if (payload === null || typeof payload !== "object") return false;
	const env = payload as Record<string, unknown>;
	if (env.type === "result") {
		if (env.api_error_status === 429) return true;
		if (env.is_error === true && typeof env.result === "string") {
			const t = env.result.toLowerCase();
			return t.includes("session limit") && t.includes("resets");
		}
		return false;
	}
	return env.type === "rate_limit_event" && env.status === "rejected";
}

export async function transitionToTerminal(
	repos: Repos,
	runId: string,
	currentState: string,
	outcome: RunTerminalState,
	now: Date,
	failureReason: RunFailureReason | null,
): Promise<RunTerminalState> {
	if (currentState === "queued" && outcome !== "cancelled") {
		await repos.runs.markRunning(runId, now);
	}
	const finalized = await repos.runs.finalize(runId, outcome, now, failureReason);
	return finalized.state as RunTerminalState;
}
