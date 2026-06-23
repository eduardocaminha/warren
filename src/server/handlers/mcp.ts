/**
 * Minimal MCP (Model Context Protocol) Streamable HTTP server for warren
 * (warren-83ab / pl-141f step 2).
 *
 * Exposes a single `propose_intent` tool via the MCP Streamable HTTP
 * transport (protocol version 2025-03-26). The handler is intentionally
 * side-effect-free: warren applies the intent patch host-side from the
 * `tool_use` event emitted by claude-code-chat (see `extractClaudeIntentPatch`
 * in `runs/stream/conversation-turn.ts`), so the MCP tool's return value is
 * purely an acknowledgment.
 *
 * Auth rides the normal warren bearer-token pipeline — `/mcp` is an API
 * path. The seeded `.mcp.json` (warren-b3e4) carries
 * `Authorization: Bearer ${WARREN_API_TOKEN}` so claude-code authenticates
 * without special-casing here.
 *
 * Scope: single-endpoint Streamable HTTP (POST only). SSE subscription
 * streams (GET) and JSON-RPC batch arrays are not implemented — the tool
 * is a simple fire-and-acknowledge call; neither feature is needed.
 */

import { VERSION } from "../../index.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler } from "../types.ts";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

/** JSON Schema for the propose_intent input. Exported for test assertions. */
export const PROPOSE_INTENT_INPUT_SCHEMA = {
	type: "object",
	properties: {
		goal: { type: "string" },
		non_goals: { type: "array", items: { type: "string" } },
		constraints: { type: "array", items: { type: "string" } },
		success_criteria: { type: "array", items: { type: "string" } },
	},
} as const;

export const PROPOSE_INTENT_TOOL = {
	name: "propose_intent",
	description:
		"Propose intent fields for the active Plot. Warren applies the patch host-side from the tool_use event; this acknowledgment is informational.",
	inputSchema: PROPOSE_INTENT_INPUT_SCHEMA,
} as const;

interface JsonRpcRequest {
	jsonrpc: string;
	id?: string | number | null;
	method: string;
	params?: unknown;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return v.jsonrpc === "2.0" && typeof v.method === "string";
}

function rpcOk(id: string | number | null | undefined, result: unknown): Response {
	return jsonResponse(200, { jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: string | number | null | undefined, code: number, message: string): Response {
	return jsonResponse(200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export function mcpHandler(): RouteHandler {
	return async (ctx) => {
		let body: unknown;
		try {
			body = await ctx.request.json();
		} catch {
			return jsonResponse(400, {
				jsonrpc: "2.0",
				id: null,
				error: { code: -32700, message: "Parse error: body must be valid JSON" },
			});
		}

		if (!isJsonRpcRequest(body)) {
			return jsonResponse(400, {
				jsonrpc: "2.0",
				id: null,
				error: { code: -32600, message: "Invalid Request: expected JSON-RPC 2.0 object" },
			});
		}

		const { id, method } = body;

		// JSON-RPC notifications have no `id` — respond 202 with no body.
		if (id === undefined) {
			return new Response(null, { status: 202 });
		}

		switch (method) {
			case "initialize":
				return rpcOk(id, {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "warren", version: VERSION },
				});

			case "ping":
				return rpcOk(id, {});

			case "tools/list":
				return rpcOk(id, { tools: [PROPOSE_INTENT_TOOL] });

			case "tools/call": {
				const params = body.params as Record<string, unknown> | undefined;
				const name = typeof params?.name === "string" ? params.name : "";
				if (name !== "propose_intent") {
					return rpcError(id, -32602, `Unknown tool: ${JSON.stringify(name)}`);
				}
				return rpcOk(id, {
					content: [{ type: "text", text: "Intent patch received." }],
				});
			}

			default:
				return rpcError(id, -32601, `Method not found: ${method}`);
		}
	};
}
