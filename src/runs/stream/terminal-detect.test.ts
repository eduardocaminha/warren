import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@os-eco/burrow-cli";
import {
	detectRuntimeTerminal,
	extractRateLimitInfo,
	isClaudeAgentEnd,
	isPiAgentEnd,
} from "./terminal-detect.ts";

/**
 * warren-6fcc / pl-5516 step 2: focused unit coverage for
 * detectRuntimeTerminal's pi `agent_end` branch. Mirrors burrow's pi parser
 * wire shape: kind="state_change", stream="system", payload.type="agent_end"
 * (burrow `src/runtime/parsers/pi.ts:86-98`).
 *
 * Cases lock the OR-arms of the failure discriminator:
 *   - stopReason === "error"        → failed (overloaded_error 529 payload)
 *   - non-empty errorMessage alone  → failed (rate_limit / network)
 *   - neither signal present        → succeeded (regression-lock: zero-token /
 *                                     empty-content alone is NOT a failure)
 *
 * The bridge-breaks-on-terminal + persistence invariants are already covered
 * by warren-2687 in stream.test.ts; this file exercises the pure mapping
 * function so we don't drag the full bridge fixture in just to assert the
 * branch.
 */
function envelope(payload: Record<string, unknown>): RunEvent {
	return {
		id: 0,
		burrowId: "bur_x",
		runId: "run_x",
		seq: 1,
		kind: "state_change",
		stream: "system",
		payload,
		ts: new Date(2026, 4, 27, 12, 0, 0),
	};
}

describe("detectRuntimeTerminal — pi agent_end", () => {
	test.each<[string, Record<string, unknown>, "failed" | "succeeded"]>([
		[
			"stopReason='error' (overloaded_error 529 payload)",
			{
				type: "agent_end",
				stopReason: "error",
				errorMessage: '{"type":"error","error":{"type":"overloaded_error"}}',
				usage: { input: 0, output: 0, totalTokens: 0 },
				content: [],
				willRetry: true,
			},
			"failed",
		],
		[
			"non-empty errorMessage alone",
			{ type: "agent_end", errorMessage: "rate_limit_error", messages: [] },
			"failed",
		],
		[
			"no error markers, zero usage / empty content (noop run)",
			{ type: "agent_end", stopReason: "end_turn", errorMessage: "", content: [] },
			"succeeded",
		],
		["plain agent_end with no error fields", { type: "agent_end", messages: [] }, "succeeded"],
	])("warren-6fcc: %s", (name, payload, outcome) => {
		// Test name shows the case; outcome is asserted below.
		void name;
		expect(detectRuntimeTerminal(envelope(payload))).toBe(outcome);
	});

	test("non-system stream is ignored even with error signals", () => {
		const ev = envelope({ type: "agent_end", stopReason: "error", errorMessage: "x" });
		expect(detectRuntimeTerminal({ ...ev, stream: "stdout" })).toBeNull();
	});

	test("non-state_change, non-agent_end kind is ignored", () => {
		const ev = envelope({ type: "agent_end", stopReason: "error", errorMessage: "x" });
		expect(detectRuntimeTerminal({ ...ev, kind: "text" })).toBeNull();
	});

	test("null or non-object payload is ignored", () => {
		const ev = envelope({ type: "agent_end" });
		expect(detectRuntimeTerminal({ ...ev, payload: null })).toBeNull();
		expect(detectRuntimeTerminal({ ...ev, payload: "agent_end" })).toBeNull();
	});

	test("unknown envelope type yields null", () => {
		expect(detectRuntimeTerminal(envelope({ type: "assistant" }))).toBeNull();
	});
});

describe("detectRuntimeTerminal — claude-code result", () => {
	test("result with is_error=true is failed", () => {
		expect(detectRuntimeTerminal(envelope({ type: "result", is_error: true }))).toBe("failed");
	});

	test("result without is_error is succeeded", () => {
		expect(detectRuntimeTerminal(envelope({ type: "result", is_error: false }))).toBe("succeeded");
		expect(detectRuntimeTerminal(envelope({ type: "result" }))).toBe("succeeded");
	});
});

describe("detectRuntimeTerminal — claude-code-chat agent_end (warren-8b7c)", () => {
	function chatAgentEnd(payload: Record<string, unknown>): RunEvent {
		return {
			id: 0,
			burrowId: "bur_x",
			runId: "run_x",
			seq: 1,
			kind: "agent_end",
			stream: "system",
			payload,
			ts: new Date(2026, 4, 27, 12, 0, 0),
		};
	}

	test("agent_end with is_error=false maps to succeeded", () => {
		expect(
			detectRuntimeTerminal(
				chatAgentEnd({ type: "result", subtype: "success", is_error: false, session_id: "s1" }),
			),
		).toBe("succeeded");
	});

	test("agent_end with is_error=true maps to failed", () => {
		expect(
			detectRuntimeTerminal(chatAgentEnd({ type: "result", is_error: true, session_id: "s1" })),
		).toBe("failed");
	});

	test("agent_end without is_error maps to succeeded", () => {
		expect(detectRuntimeTerminal(chatAgentEnd({ type: "result", session_id: "s1" }))).toBe(
			"succeeded",
		);
	});

	test("agent_end with payload.type !== result returns null (not the chat shape)", () => {
		expect(detectRuntimeTerminal(chatAgentEnd({ type: "agent_end" }))).toBeNull();
		expect(detectRuntimeTerminal(chatAgentEnd({ type: "other" }))).toBeNull();
	});

	test("agent_end on non-system stream returns null", () => {
		expect(
			detectRuntimeTerminal({ ...chatAgentEnd({ type: "result" }), stream: "stdout" }),
		).toBeNull();
	});

	test("pi state_change/agent_end path is unchanged", () => {
		expect(detectRuntimeTerminal(envelope({ type: "agent_end", messages: [] }))).toBe("succeeded");
		expect(
			detectRuntimeTerminal(
				envelope({ type: "agent_end", stopReason: "error", errorMessage: "x" }),
			),
		).toBe("failed");
	});
});

describe("isClaudeAgentEnd (warren-8b7c)", () => {
	function chatAgentEnd(overrides: Partial<RunEvent> = {}): RunEvent {
		return {
			id: 0,
			burrowId: "bur_x",
			runId: "run_x",
			seq: 1,
			kind: "agent_end",
			stream: "system",
			payload: { type: "result", is_error: false, session_id: "s1" },
			ts: new Date(2026, 4, 27, 12, 0, 0),
			...overrides,
		};
	}

	test("matches claude-code-chat agent_end on system stream", () => {
		expect(isClaudeAgentEnd(chatAgentEnd())).toBe(true);
	});

	test("rejects non-system stream", () => {
		expect(isClaudeAgentEnd(chatAgentEnd({ stream: "stdout" }))).toBe(false);
	});

	test("rejects state_change kind (pi's shape)", () => {
		expect(isClaudeAgentEnd(chatAgentEnd({ kind: "state_change" }))).toBe(false);
	});

	test("rejects text kind", () => {
		expect(isClaudeAgentEnd(chatAgentEnd({ kind: "text" }))).toBe(false);
	});

	test("pi state_change/agent_end envelope does NOT match isClaudeAgentEnd", () => {
		expect(isClaudeAgentEnd(envelope({ type: "agent_end", messages: [] }))).toBe(false);
	});
});

describe("extractRateLimitInfo (warren-395e)", () => {
	function chatAgentEndEvent(payload: Record<string, unknown>): RunEvent {
		return {
			id: 0,
			burrowId: "bur_x",
			runId: "run_x",
			seq: 1,
			kind: "agent_end",
			stream: "system",
			payload,
			ts: new Date(2026, 4, 27, 12, 0, 0),
		};
	}

	// Shape 1: state_change result with api_error_status 429
	test("detects result with api_error_status 429 (no resetsAt)", () => {
		const info = extractRateLimitInfo(
			envelope({ type: "result", is_error: true, api_error_status: 429 }),
		);
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toBeNull();
	});

	test("detects result with api_error_status 429 and ISO resetsAt", () => {
		const ts = "2026-01-01T12:00:00.000Z";
		const info = extractRateLimitInfo(
			envelope({ type: "result", is_error: true, api_error_status: 429, resetsAt: ts }),
		);
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toEqual(new Date(ts));
	});

	test("detects result with api_error_status 429 and epoch-ms resetsAt", () => {
		const epochMs = 1_800_000_000_000;
		const info = extractRateLimitInfo(
			envelope({ type: "result", is_error: true, api_error_status: 429, resetsAt: epochMs }),
		);
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toEqual(new Date(epochMs));
	});

	// Shape 2: rate_limit_event
	test("detects rate_limit_event with status rejected (no resetsAt)", () => {
		const info = extractRateLimitInfo(envelope({ type: "rate_limit_event", status: "rejected" }));
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toBeNull();
	});

	test("detects rate_limit_event with status rejected and resetsAt", () => {
		const ts = "2026-06-01T00:00:00.000Z";
		const info = extractRateLimitInfo(
			envelope({ type: "rate_limit_event", status: "rejected", resetsAt: ts }),
		);
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toEqual(new Date(ts));
	});

	test("ignores rate_limit_event with status !== rejected", () => {
		expect(
			extractRateLimitInfo(envelope({ type: "rate_limit_event", status: "allowed" })),
		).toBeNull();
	});

	// Shape 3: session limit text fallback
	test("detects session-limit text in result field", () => {
		const info = extractRateLimitInfo(
			envelope({
				type: "result",
				is_error: true,
				result: "You've hit your session limit. It resets at midnight.",
			}),
		);
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toBeNull();
	});

	test("session-limit text match is case-insensitive", () => {
		const info = extractRateLimitInfo(
			envelope({
				type: "result",
				is_error: true,
				result: "SESSION LIMIT REACHED. Will RESET soon.",
			}),
		);
		expect(info).not.toBeNull();
	});

	// Shape for claude-code-chat: kind="agent_end"
	test("detects agent_end result with api_error_status 429", () => {
		const ts = "2026-07-01T00:00:00.000Z";
		const info = extractRateLimitInfo(
			chatAgentEndEvent({ type: "result", is_error: true, api_error_status: 429, resetsAt: ts }),
		);
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toEqual(new Date(ts));
	});

	// Negative cases
	test("non-429 result returns null", () => {
		expect(extractRateLimitInfo(envelope({ type: "result", is_error: true }))).toBeNull();
	});

	test("normal succeeded result returns null", () => {
		expect(extractRateLimitInfo(envelope({ type: "result", is_error: false }))).toBeNull();
	});

	test("non-system stream returns null", () => {
		const ev = envelope({ type: "result", api_error_status: 429 });
		expect(extractRateLimitInfo({ ...ev, stream: "stdout" })).toBeNull();
	});

	test("non-state_change non-agent_end kind returns null", () => {
		const ev = envelope({ type: "result", api_error_status: 429 });
		expect(extractRateLimitInfo({ ...ev, kind: "text" })).toBeNull();
	});

	test("resetsAt with invalid string returns null resumeAt", () => {
		const info = extractRateLimitInfo(
			envelope({ type: "result", api_error_status: 429, resetsAt: "not-a-date" }),
		);
		expect(info).not.toBeNull();
		expect(info?.resumeAt).toBeNull();
	});

	test("existing non-rate-limit result events are unaffected", () => {
		// Regression: a normal pi agent_end should still return null.
		expect(
			extractRateLimitInfo(envelope({ type: "agent_end", stopReason: "end_turn", content: [] })),
		).toBeNull();
	});
});

describe("isPiAgentEnd", () => {
	test("matches pi agent_end on the state_change/system carrier", () => {
		expect(isPiAgentEnd(envelope({ type: "agent_end", stopReason: "end_turn" }))).toBe(true);
	});

	test("rejects claude-code result envelope (pi-only concern)", () => {
		expect(isPiAgentEnd(envelope({ type: "result", is_error: false }))).toBe(false);
	});

	test("rejects non-system stream", () => {
		const ev = envelope({ type: "agent_end" });
		expect(isPiAgentEnd({ ...ev, stream: "stdout" })).toBe(false);
	});

	test("rejects non-state_change kind", () => {
		const ev = envelope({ type: "agent_end" });
		expect(isPiAgentEnd({ ...ev, kind: "text" })).toBe(false);
	});

	test("rejects null or non-object payload", () => {
		const ev = envelope({ type: "agent_end" });
		expect(isPiAgentEnd({ ...ev, payload: null })).toBe(false);
		expect(isPiAgentEnd({ ...ev, payload: 42 })).toBe(false);
	});
});
