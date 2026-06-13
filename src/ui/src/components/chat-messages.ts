/**
 * Pure transcript/stream merge logic for the chat surface, split out of
 * `Chat.tsx` so the merge/dedup contract is unit-testable without
 * pulling in React's JSX runtime (warren-0732 / pl-de53 step 4).
 *
 * Two event vocabularies feed the surface (warren-4ccc):
 *   - Legacy brainstorm turns: `user_message` / `agent_message` with
 *     payload `{actor, content}`.
 *   - pi-chat (Leveret) runs: `text` / `thinking` (payload `{text}`),
 *     `tool_use` (a pi `toolCall` block: `{name, arguments}`), and
 *     `tool_result` (a pi `toolResult` message: `{toolName, isError,
 *     content:[{text}]}`). All other pi kinds — `state_change`,
 *     `telemetry`, `mulch.record.skipped`, `reap.*` — are noise and are
 *     not materialized into bubbles.
 */

import type { MessageRow, RunEvent } from "@/api/types.ts";

/** Event kinds the chat surface materializes into bubbles. */
const USER_KIND = "user_message";
const AGENT_KIND = "agent_message";
const TEXT_KIND = "text";
const THINKING_KIND = "thinking";
const TOOL_USE_KIND = "tool_use";
const TOOL_RESULT_KIND = "tool_result";

/** Longest single-line fragment surfaced in a compact tool activity row. */
const MAX_TOOL_FRAGMENT = 120;

/** Bubble payload shape — matches `appendUserMessage`/`appendAgentMessage`. */
interface MessagePayload {
	actor?: string;
	content?: string;
}

export interface ChatMessage {
	readonly id: number | string;
	readonly seq: number;
	readonly kind: "user" | "agent" | "tool" | "thinking";
	readonly actor: string;
	readonly content: string;
	readonly ts: string;
	/** Set for `tool_result` rows that reported an error, so the row styles itself. */
	readonly isError?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Collapse whitespace to a single line and clamp to `max` characters. */
function clampLine(value: string, max = MAX_TOOL_FRAGMENT): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Read a pi `{text}` payload (text / thinking blocks). */
function textOf(payload: unknown): string {
	const obj = asRecord(payload);
	return typeof obj.text === "string" ? obj.text : "";
}

/** Pick the most informative string argument of a `tool_use` invocation. */
function firstToolArg(args: Record<string, unknown>): string | null {
	for (const key of ["command", "cmd", "path", "file_path", "query", "pattern", "url"]) {
		const candidate = args[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	for (const value of Object.values(args)) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

/** Compact one-line label for a `tool_use` (pi `toolCall`) event. */
function formatToolUse(payload: unknown): string {
	const obj = asRecord(payload);
	const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : "tool";
	const arg = firstToolArg(asRecord(obj.arguments));
	return arg !== null ? `${name}: ${clampLine(arg)}` : name;
}

/** Concatenate the text blocks of a `tool_result` payload `content` array. */
function toolResultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const text = asRecord(block).text;
		if (typeof text === "string") parts.push(text);
	}
	return parts.join(" ");
}

/** Compact one-line label + error flag for a `tool_result` event. */
function formatToolResult(payload: unknown): { content: string; isError: boolean } {
	const obj = asRecord(payload);
	const name = typeof obj.toolName === "string" && obj.toolName.length > 0 ? obj.toolName : "tool";
	const isError = obj.isError === true;
	const label = isError ? `${name} failed` : name;
	const text = clampLine(toolResultText(obj.content));
	return { content: text.length > 0 ? `${label} → ${text}` : label, isError };
}

/** Map a persisted transcript row to a chat bubble, or null to skip it. */
export function transcriptRowToMessage(row: MessageRow): ChatMessage | null {
	let kind: ChatMessage["kind"];
	if (row.role === "user") kind = "user";
	else if (row.role === "assistant") kind = "agent";
	else return null; // system / tool rows are not rendered as bubbles.
	return {
		id: row.id,
		seq: row.seq,
		kind,
		actor: row.role,
		content: row.content,
		ts: row.createdAt,
	};
}

/**
 * Stable dedupe key for a chat bubble. User/agent turns dedupe on
 * (kind, content) so a transcript row and its matching streamed event
 * render once. Tool/thinking rows exist only in the live stream and may
 * legitimately repeat (e.g. the same `bash: ls` twice), so they key on
 * their unique event id and never collapse.
 */
export function messageDedupeKey(m: ChatMessage): string {
	if (m.kind === "tool" || m.kind === "thinking") return `${m.kind}\u0000${m.id}`;
	return `${m.kind}\u0000${m.content}`;
}

/**
 * Extract the chat-message digest from a streamed RunEvent, or null when
 * the event is not renderable as a bubble (lifecycle / telemetry / noise).
 */
export function toMessage(evt: RunEvent): ChatMessage | null {
	const base = { id: evt.id, seq: evt.seq, ts: evt.ts };
	switch (evt.kind) {
		case USER_KIND:
		case AGENT_KIND: {
			const payload = asRecord(evt.payload) as MessagePayload;
			const content = typeof payload.content === "string" ? payload.content : "";
			const actor = typeof payload.actor === "string" ? payload.actor : "unknown";
			return { ...base, kind: evt.kind === USER_KIND ? "user" : "agent", actor, content };
		}
		case TEXT_KIND: {
			const text = textOf(evt.payload);
			return text.length === 0 ? null : { ...base, kind: "agent", actor: "agent", content: text };
		}
		case THINKING_KIND: {
			const text = textOf(evt.payload);
			return text.length === 0
				? null
				: { ...base, kind: "thinking", actor: "agent", content: text };
		}
		case TOOL_USE_KIND:
			return { ...base, kind: "tool", actor: "tool", content: formatToolUse(evt.payload) };
		case TOOL_RESULT_KIND: {
			const { content, isError } = formatToolResult(evt.payload);
			return { ...base, kind: "tool", actor: "tool", content, isError };
		}
		default:
			return null;
	}
}

/**
 * Merge the persisted transcript (history) with the live event stream
 * into the ordered bubble list the chat renders. Transcript rows render
 * even when the stream yields no message events (e.g. a never_started
 * anchoring run), and a transcript row whose (kind, content) matches a
 * streamed event is rendered once rather than duplicated. The transcript
 * renders first (it is the persisted history); stream messages not
 * already in the transcript follow.
 */
export function buildChatMessages(
	transcript: readonly MessageRow[] | undefined,
	events: readonly RunEvent[],
): ChatMessage[] {
	const streamMessages = events
		.map(toMessage)
		.filter((m): m is ChatMessage => m !== null)
		.sort((a, b) => a.seq - b.seq);
	const transcriptMessages = (transcript ?? [])
		.map(transcriptRowToMessage)
		.filter((m): m is ChatMessage => m !== null)
		.sort((a, b) => a.seq - b.seq);
	const seen = new Set(transcriptMessages.map(messageDedupeKey));
	const merged = [...transcriptMessages];
	for (const m of streamMessages) {
		const key = messageDedupeKey(m);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(m);
	}
	return merged;
}
