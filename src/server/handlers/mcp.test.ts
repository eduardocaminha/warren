/**
 * Unit tests for the MCP Streamable HTTP handler (warren-83ab / pl-141f step 2).
 *
 * Tests exercise the JSON-RPC dispatch layer directly (no real server needed).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { bearerAuth } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { MCP_PROTOCOL_VERSION, PROPOSE_INTENT_TOOL } from "./mcp.ts";

const TOKEN = "mcp-test-token-1234567890abcdef";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

function makeBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch,
	});
}

async function makeDeps(repos: Repos): Promise<ServerDeps> {
	const client = makeBurrowClient();
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const burrowClientPool = new BurrowClientPool({ repos });
	burrowClientPool.register("local", client);
	const broker = new RunEventBroker();
	const bridges = createBridgeRegistry({
		repos,
		broker,
		burrowClientPool,
		bridge: async () => ({ written: 0, skipped: 0, errored: false }),
	});
	return {
		repos,
		burrowClientPool,
		broker,
		bridges,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

async function post(
	base: string,
	body: unknown,
	extraHeaders: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${base}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${TOKEN}`,
			...extraHeaders,
		},
		body: JSON.stringify(body),
	});
}

describe("POST /mcp (warren-83ab)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const deps = await makeDeps(repos);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		base = tcpUrl(handle);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("401 without bearer token", async () => {
		const res = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(res.status).toBe(401);
	});

	test("initialize returns protocolVersion and serverInfo", async () => {
		const res = await post(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			jsonrpc: string;
			id: number;
			result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } };
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(1);
		expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
		expect(body.result.serverInfo.name).toBe("warren");
		expect(body.result.capabilities).toMatchObject({ tools: {} });
	});

	test("ping returns empty result", async () => {
		const res = await post(base, { jsonrpc: "2.0", id: 2, method: "ping" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: unknown };
		expect(body.result).toEqual({});
	});

	test("tools/list returns propose_intent tool", async () => {
		const res = await post(base, { jsonrpc: "2.0", id: 3, method: "tools/list" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { tools: unknown[] } };
		expect(body.result.tools).toHaveLength(1);
		expect(body.result.tools[0]).toEqual(PROPOSE_INTENT_TOOL);
	});

	test("tools/call propose_intent returns acknowledgment", async () => {
		const res = await post(base, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "propose_intent",
				arguments: { goal: "ship MCP support" },
			},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		expect(body.result.content).toHaveLength(1);
		expect(body.result.content[0]?.type).toBe("text");
		expect(typeof body.result.content[0]?.text).toBe("string");
	});

	test("tools/call unknown tool returns -32602 error", async () => {
		const res = await post(base, {
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "not_a_tool" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32602);
	});

	test("unknown method returns -32601 error", async () => {
		const res = await post(base, { jsonrpc: "2.0", id: 6, method: "resources/list" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32601);
	});

	test("notification (no id) returns 202 with no body", async () => {
		const res = await post(base, {
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		expect(res.status).toBe(202);
		const text = await res.text();
		expect(text).toBe("");
	});

	test("malformed JSON returns parse error", async () => {
		const res = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${TOKEN}`,
			},
			body: "not json {",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32700);
	});

	test("non-object body returns invalid-request error", async () => {
		const res = await post(base, [1, 2, 3]);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32600);
	});

	test("id can be a string", async () => {
		const res = await post(base, { jsonrpc: "2.0", id: "req-abc", method: "ping" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: unknown };
		expect(body.id).toBe("req-abc");
	});
});
