import type { Repos } from "../../db/repos/index.ts";
import type { EventRow, RunFailureReason, RunTerminalState } from "../../db/schema.ts";

export function isTerminal(state: string): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

/**
 * Scan a run's event log for the Anthropic session-limit 429 signal
 * (warren-395e). Returns `{ resumeAt: Date | null }` when any event
 * in the log carries the rate-limit signal, `null` otherwise.
 *
 * Three shapes are recognised (mirrors `extractRateLimitInfo` in
 * `terminal-detect.ts`, but operating on persisted `EventRow` payloads
 * rather than in-flight `RunEvent` objects):
 *
 *   1. `result` envelope with `api_error_status: 429`.
 *   2. `rate_limit_event` envelope with `status: "rejected"`.
 *   3. `result` envelope whose `result` text contains "session limit" +
 *      "reset" (forward-compat fallback for older claude-code versions).
 *
 * Called by `inferFailureReason` before the `crashed` / `no_model_response`
 * discriminator so a 429 run gets `rate_limited` rather than `crashed`.
 */
export function extractRateLimitFromEvents(
	events: readonly EventRow[],
): { resumeAt: Date | null } | null {
	for (const ev of events) {
		if (ev.stream !== "system") continue;
		const info = extractRateLimitFromPayload(ev.payloadJson);
		if (info !== null) return info;
	}
	return null;
}

/** Per-payload rate-limit signal extractor shared by the event scanner. */
function extractRateLimitFromPayload(payload: unknown): { resumeAt: Date | null } | null {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
	const env = payload as Record<string, unknown>;

	if (env.type === "result") {
		if (env.api_error_status === 429) return { resumeAt: parseResetsAt(env.resetsAt) };
		if (isSessionLimitText(env.result)) return { resumeAt: parseResetsAt(env.resetsAt) };
		return null;
	}
	if (env.type === "rate_limit_event") {
		if (env.status === "rejected") return { resumeAt: parseResetsAt(env.resetsAt) };
		return null;
	}
	return null;
}

function isSessionLimitText(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const lower = value.toLowerCase();
	return lower.includes("session limit") && lower.includes("reset");
}

function parseResetsAt(value: unknown): Date | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number" && Number.isFinite(value)) {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	if (typeof value === "string" && value.length > 0) {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	return null;
}

/**
 * Infer failure_reason from state-on-entry plus the event log
 * (warren-3c40, warren-5165, warren-395e). Only consulted when
 * `outcome === "failed"` and the caller didn't override.
 *
 *   queued on entry  → never_started (bridge never claimed the row)
 *   running, rate-limit signal in events → rate_limited (warren-395e)
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
 * The rate-limit check runs before the crashed/no_model_response
 * discriminator because a 429 often arrives before or after model output
 * (the session-limit fires mid-run) — checking last prevents a false
 * `crashed` classification.
 */
export async function inferFailureReason(
	repos: Repos,
	runId: string,
	stateOnEntry: string,
): Promise<RunFailureReason> {
	if (stateOnEntry === "queued") return "never_started";
	const events = await repos.events.listByRun(runId);
	if (extractRateLimitFromEvents(events) !== null) return "rate_limited";
	const sawModelTurn = events.some(
		(ev) =>
			ev.stream === "stdout" &&
			(ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_use"),
	);
	return sawModelTurn ? "crashed" : "no_model_response";
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
