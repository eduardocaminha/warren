import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@os-eco/burrow-cli";
import {
	detectRateLimitTerminal,
	detectRuntimeTerminal,
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

// ---------------------------------------------------------------------------
// detectRateLimitTerminal (warren-395e)
// ---------------------------------------------------------------------------

describe("detectRateLimitTerminal", () => {
	const RESETS_AT_MS = 1_800_000_000_000; // 2027-01-15 ~ epoch ms
	const RESETS_AT_S = 1_800_000_000; // same in epoch seconds

	// Helper: state_change/system envelope (claude-code batch)
	function rl(payload: Record<string, unknown>): RunEvent {
		return {
			id: 0,
			burrowId: "bur_x",
			runId: "run_x",
			seq: 2,
			kind: "state_change",
			stream: "system",
			payload,
			ts: new Date(2026, 4, 27, 12, 0, 0),
		};
	}

	// Helper: agent_end/system envelope (claude-code-chat)
	function chatEnd(payload: Record<string, unknown>): RunEvent {
		return { ...rl(payload), kind: "agent_end" };
	}

	describe("Signal 1 — api_error_status === 429 in result envelope", () => {
		test("api_error_status=429 is rate-limited", () => {
			expect(
				detectRateLimitTerminal(rl({ type: "result", is_error: true, api_error_status: 429 })),
			).not.toBeNull();
		});

		test("api_error_status=429 on agent_end carrier (chat)", () => {
			expect(
				detectRateLimitTerminal(chatEnd({ type: "result", is_error: true, api_error_status: 429 })),
			).not.toBeNull();
		});

		test("api_error_status=429 extracts resumeAt from rate_limit_event.resetsAt (epoch ms)", () => {
			const result = detectRateLimitTerminal(
				rl({
					type: "result",
					is_error: true,
					api_error_status: 429,
					rate_limit_event: { status: "rejected", resetsAt: RESETS_AT_MS },
				}),
			);
			expect(result).not.toBeNull();
			expect(result?.resumeAt?.getTime()).toBe(RESETS_AT_MS);
		});

		test("api_error_status=429 extracts resumeAt from rate_limit_event.resetsAt (epoch seconds)", () => {
			const result = detectRateLimitTerminal(
				rl({
					type: "result",
					is_error: true,
					api_error_status: 429,
					rate_limit_event: { status: "rejected", resetsAt: RESETS_AT_S },
				}),
			);
			expect(result).not.toBeNull();
			expect(result?.resumeAt?.getTime()).toBe(RESETS_AT_S * 1000);
		});

		test("api_error_status=429 extracts resumeAt from ISO string", () => {
			const iso = new Date(RESETS_AT_MS).toISOString();
			const result = detectRateLimitTerminal(
				rl({
					type: "result",
					is_error: true,
					api_error_status: 429,
					rate_limit_event: { status: "rejected", resetsAt: iso },
				}),
			);
			expect(result?.resumeAt?.getTime()).toBe(new Date(iso).getTime());
		});

		test("api_error_status=429 with no resetsAt yields resumeAt=undefined", () => {
			const result = detectRateLimitTerminal(
				rl({ type: "result", is_error: true, api_error_status: 429 }),
			);
			expect(result).not.toBeNull();
			expect(result?.resumeAt).toBeUndefined();
		});

		test("api_error_status=500 is not rate-limited", () => {
			expect(
				detectRateLimitTerminal(rl({ type: "result", is_error: true, api_error_status: 500 })),
			).toBeNull();
		});

		test("result without is_error=true and without api_error_status=429 is not rate-limited", () => {
			expect(detectRateLimitTerminal(rl({ type: "result", is_error: false }))).toBeNull();
		});
	});

	describe("Signal 2 — standalone rate_limit_event envelope", () => {
		test("rate_limit_event with status=rejected is rate-limited", () => {
			expect(
				detectRateLimitTerminal(
					rl({ type: "rate_limit_event", status: "rejected", resetsAt: RESETS_AT_MS }),
				),
			).not.toBeNull();
		});

		test("rate_limit_event with status=rejected extracts resumeAt", () => {
			const result = detectRateLimitTerminal(
				rl({ type: "rate_limit_event", status: "rejected", resetsAt: RESETS_AT_MS }),
			);
			expect(result?.resumeAt?.getTime()).toBe(RESETS_AT_MS);
		});

		test("rate_limit_event with status=allowed is not rate-limited", () => {
			expect(
				detectRateLimitTerminal(rl({ type: "rate_limit_event", status: "allowed" })),
			).toBeNull();
		});
	});

	describe("Signal 3 — text fallback", () => {
		test("result text with 'session limit' + 'resets' is rate-limited", () => {
			expect(
				detectRateLimitTerminal(
					rl({
						type: "result",
						is_error: true,
						result: "You've hit your session limit. Your session will resets at 10pm.",
					}),
				),
			).not.toBeNull();
		});

		test("text match is case-insensitive", () => {
			expect(
				detectRateLimitTerminal(
					rl({
						type: "result",
						is_error: true,
						result: "SESSION LIMIT exceeded. It RESETS soon.",
					}),
				),
			).not.toBeNull();
		});

		test("text with only 'session limit' (no 'resets') is not rate-limited", () => {
			expect(
				detectRateLimitTerminal(
					rl({ type: "result", is_error: true, result: "session limit exceeded." }),
				),
			).toBeNull();
		});

		test("text fallback yields resumeAt=undefined when no structured resetsAt", () => {
			const result = detectRateLimitTerminal(
				rl({
					type: "result",
					is_error: true,
					result: "You've hit your session limit. It resets tomorrow.",
				}),
			);
			expect(result).not.toBeNull();
			expect(result?.resumeAt).toBeUndefined();
		});
	});

	describe("stream / kind guards", () => {
		test("non-system stream is ignored", () => {
			expect(
				detectRateLimitTerminal({
					...rl({ type: "result", is_error: true, api_error_status: 429 }),
					stream: "stdout",
				}),
			).toBeNull();
		});

		test("non-state_change non-agent_end kind is ignored", () => {
			expect(
				detectRateLimitTerminal({
					...rl({ type: "result", is_error: true, api_error_status: 429 }),
					kind: "text",
				}),
			).toBeNull();
		});

		test("null payload is ignored", () => {
			expect(detectRateLimitTerminal({ ...rl({ type: "result" }), payload: null })).toBeNull();
		});
	});

	describe("detectRuntimeTerminal still returns 'failed' for 429", () => {
		test("api_error_status=429 result maps to 'failed' (regression lock)", () => {
			expect(
				detectRuntimeTerminal(rl({ type: "result", is_error: true, api_error_status: 429 })),
			).toBe("failed");
		});
	});
});
