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
