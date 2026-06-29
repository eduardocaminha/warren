/**
 * Runtime-terminal envelope detection (warren-a69a, warren-2687,
 * warren-36c0, warren-8b7c). Pure functions — given a single `RunEvent`,
 * classify whether it represents the runtime's terminal lifecycle envelope.
 *
 * Three roles:
 *   - `detectRuntimeTerminal` returns the warren-side outcome to reap
 *     with (or `null`) and powers the bridge's "break on terminal" loop.
 *   - `isPiAgentEnd` distinguishes pi's `agent_end` envelope for the
 *     piStats out-of-band snapshot branch — both shapes ride the same
 *     state_change/system carrier, but only pi's `agent_end` should
 *     trigger the pi-specific terminal snapshot.
 *   - `isClaudeAgentEnd` matches claude-code-chat's turn-boundary event
 *     (kind="agent_end", distinct from pi's state_change shape). Used by
 *     the bridge's conversation keep-alive to flush the turn's assistant
 *     text before breaking on terminal.
 *   - `extractRateLimitInfo` inspects a single event for the Anthropic
 *     session-limit 429 signals (warren-395e) and extracts `resumeAt`.
 */

import type { RunEvent } from "@os-eco/burrow-cli";
import type { RunTerminalState } from "../../db/schema.ts";

/**
 * Inspect a burrow event for a runtime-terminal shape (warren-a69a,
 * warren-2687, warren-8b7c).
 * Returns the warren-side outcome to reap with, or `null` if the event
 * doesn't carry a terminal signal.
 *
 * Three runtime terminal shapes are recognised:
 *
 *   - claude-code (batch): burrow's jsonl-claude parser emits
 *     `kind="state_change"`, `payload.type === "result"`. The `is_error`
 *     field distinguishes a clean exit from a crash; `is_error: true` →
 *     `failed`, anything else → `succeeded`.
 *   - claude-code-chat (spawn-per-turn): burrow's jsonl-claude-chat parser
 *     maps the `result` line to `kind="agent_end"` (NOT `state_change`) so
 *     the session_id in the payload can be forwarded to the next `--resume`.
 *     The same `is_error` discriminator applies.
 *   - pi: burrow's pi parser emits `payload.type === "agent_end"` on the
 *     `kind="state_change"` carrier as the final lifecycle envelope.
 *     `stopReason === "error"` or a non-empty `errorMessage` → `failed`
 *     (warren-1ac2 / pl-5516); absent both → `succeeded`. Zero-token /
 *     empty-content alone is NOT a failure signal.
 *
 * burrow's own cancel path emits a different terminal shape; that case
 * is handled by `cancelRun`. Future runtimes extend this dispatch by
 * adding their runtime-specific terminal shape.
 */
export function detectRuntimeTerminal(event: RunEvent): RunTerminalState | null {
	if (event.stream !== "system") return null;
	// claude-code-chat (warren-8b7c): kind="agent_end" (see module header).
	if (event.kind === "agent_end") return detectClaudeAgentEndOutcome(event.payload);
	if (event.kind !== "state_change") return null;
	return detectStateChangeOutcome(event.payload);
}

/** claude-code-chat carrier: kind="agent_end", payload.type="result". */
function detectClaudeAgentEndOutcome(payload: unknown): RunTerminalState | null {
	if (payload === null || typeof payload !== "object") return null;
	const env = payload as Record<string, unknown>;
	if (env.type !== "result") return null;
	return env.is_error === true ? "failed" : "succeeded";
}

/** claude-code (batch) + pi carrier: kind="state_change". */
function detectStateChangeOutcome(payload: unknown): RunTerminalState | null {
	if (payload === null || typeof payload !== "object") return null;
	const env = payload as Record<string, unknown>;
	if (env.type === "result") return env.is_error === true ? "failed" : "succeeded";
	if (env.type === "agent_end") {
		const err = env.errorMessage;
		const failed = env.stopReason === "error" || (typeof err === "string" && err.length > 0);
		return failed ? "failed" : "succeeded";
	}
	return null;
}

/**
 * Match pi's `agent_end` terminal envelope (warren-36c0). Burrow's pi parser
 * (burrow `src/runtime/parsers/pi.ts`) maps every pi lifecycle line to a
 * RunEvent with `kind="state_change"`, `stream="system"`, and the original
 * envelope shoved into `payload` — so `event.kind === "agent_end"` never
 * matches on real pi runs. The piStats snapshot branch (bridgeRunStream)
 * checks this predicate to fire the terminal `get_session_stats` fetch
 * before the bridge breaks on terminal detection. Distinct from
 * `detectRuntimeTerminal`, which also accepts claude-code's `result`
 * envelope — piStats is a pi-only concern.
 */
export function isPiAgentEnd(event: RunEvent): boolean {
	if (event.kind !== "state_change") return false;
	if (event.stream !== "system") return false;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return false;
	const env = payload as Record<string, unknown>;
	return env.type === "agent_end";
}

/**
 * Match claude-code-chat's turn-boundary event (warren-8b7c). The
 * jsonl-claude-chat parser (burrow `src/runtime/parsers/jsonl-claude-chat.ts`)
 * maps every `result` line to an event with `kind="agent_end"` so the
 * `session_id` travels in the payload to the next turn's `--resume`. This is
 * structurally distinct from pi's `agent_end` shape, which rides the
 * `kind="state_change"` carrier — the two predicates are mutually exclusive.
 *
 * Used by the bridge's conversation keep-alive to flush the turn's accumulated
 * assistant text before falling through to `detectRuntimeTerminal` (which also
 * recognises this shape and breaks the loop). Gated separately from
 * `isPiAgentEnd` so the pi path is byte-unchanged.
 */
export function isClaudeAgentEnd(event: RunEvent): boolean {
	return event.kind === "agent_end" && event.stream === "system";
}

/**
 * Inspect a single event for the Anthropic session-limit 429 rate-limit
 * signal (warren-395e). Returns `{ resumeAt }` when a rate-limit is detected,
 * where `resumeAt` is the extracted reset timestamp (or `null` if the event
 * doesn't carry a parseable `resetsAt`). Returns `null` when the event
 * carries no rate-limit signal at all.
 *
 * Three signal shapes are recognised:
 *
 *   1. claude-code `result` event with `api_error_status: 429` —
 *      `kind="state_change"`, `stream="system"`, `payload.type="result"`,
 *      `payload.api_error_status === 429`.
 *
 *   2. claude-code-chat `agent_end` result with `api_error_status: 429` —
 *      `kind="agent_end"`, `stream="system"`, `payload.type="result"`,
 *      `payload.api_error_status === 429`.
 *
 *   3. `rate_limit_event` pre-terminal advisory —
 *      `kind="state_change"`, `stream="system"`,
 *      `payload.type="rate_limit_event"`, `payload.status="rejected"`.
 *      Carries `resetsAt` (epoch-ms number or ISO-8601 string).
 *
 * The `resetsAt` field may appear on shapes 1 and 3; on shape 2 it is
 * unlikely but handled consistently. Falls back to matching the
 * "session limit" text in `payload.result` when `api_error_status` is
 * absent (forward compat for minor claude-code version drift).
 *
 * Always match on multiple signals (plan risk #2). Prefer the structured
 * `api_error_status` / `rate_limit_event` over the text fallback.
 */
export function extractRateLimitInfo(event: RunEvent): { resumeAt: Date | null } | null {
	if (event.stream !== "system") return null;

	if (event.kind === "state_change") {
		return extractRateLimitFromPayload(event.payload);
	}
	if (event.kind === "agent_end") {
		// claude-code-chat shape: kind="agent_end", payload.type="result"
		const env = asObject(event.payload);
		if (env === null || env.type !== "result") return null;
		if (env.api_error_status === 429) return { resumeAt: parseResetsAt(env.resetsAt) };
		if (isSessionLimitText(env.result)) return { resumeAt: parseResetsAt(env.resetsAt) };
		return null;
	}
	return null;
}

/** Inner dispatcher for `kind="state_change"` payloads. */
function extractRateLimitFromPayload(payload: unknown): { resumeAt: Date | null } | null {
	const env = asObject(payload);
	if (env === null) return null;

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

/** Cast unknown to a plain object, returning null for non-objects. */
function asObject(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/**
 * Match the "session limit . resets" text in a result's `result` field.
 * Claude-code may emit this in the human-readable result message when the
 * structured `api_error_status` is unavailable on older versions (plan risk #2).
 */
function isSessionLimitText(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const lower = value.toLowerCase();
	return lower.includes("session limit") && lower.includes("reset");
}

/**
 * Parse `resetsAt` from a rate-limit event payload into a `Date`.
 * Accepts epoch-milliseconds (number) or ISO-8601 / HTTP-date strings.
 * Returns `null` when the value is absent or unparseable (plan risk #3).
 */
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
