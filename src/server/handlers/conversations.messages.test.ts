/**
 * Tests for `POST /conversations/:id/messages` spawn-per-turn branch
 * (warren-61fa / pl-e118 step 2).
 *
 * When the anchoring run's effective runtime is spawn-per-turn
 * (e.g. `claude-code-chat`), the message handler must spawn a fresh
 * `mode:conversation` resume-run rather than steering the existing one.
 * Tests here cover:
 *   1. spawn-per-turn path: response carries `resumedRunId`, anchor rotates.
 *   2. pi-chat path unchanged: response still carries `steerMessageId`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { PlotCreator } from "../../plots/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";

const silentLogger = { info() {}, warn() {}, error() {} };

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface Call {
	method: string;
	path: string;
	body: unknown;
}

function makeBurrowClient(
	fix: { burrowId: string; burrowRunId: string; workspacePath: string },
	calls: Call[],
): BurrowClient {
	let burrowCounter = 0;
	let runCounter = 0;
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ method, path, body: reqBody });
			if (method === "POST" && path === "/burrows") {
				burrowCounter++;
				const burrowId = `${fix.burrowId}_${burrowCounter}`;
				return jsonRes(201, {
					id: burrowId,
					name: "burrow",
					kind: "task",
					projectRoot: "/data/projects/x/y",
					branch: "main",
					baseBranch: "main",
					originUrl: "https://github.com/x/y.git",
					workspacePath: fix.workspacePath,
					provider: "local",
					sandbox: { network: "open" },
					state: "running",
					createdAt: "2026-05-08T12:00:00Z",
					updatedAt: "2026-05-08T12:00:00Z",
				});
			}
			const matchRuns = path.match(/^\/burrows\/([^/]+)\/runs$/);
			if (method === "POST" && matchRuns) {
				const burrowId = matchRuns[1];
				runCounter++;
				const burrowRunId = `${fix.burrowRunId}_${runCounter}`;
				return jsonRes(201, {
					id: burrowRunId,
					burrowId,
					agentId: "leveret",
					prompt: "hello",
					resumeOfRunId: null,
					state: "queued",
					exitCode: null,
					errorMessage: null,
					metadataJson: null,
					queuedAt: "2026-05-08T12:00:01Z",
					startedAt: null,
					completedAt: null,
				});
			}
			const matchInbox = path.match(/^\/burrows\/([^/]+)\/inbox$/);
			if (method === "POST" && matchInbox) {
				const burrowId = matchInbox[1];
				return jsonRes(201, {
					id: "msg_inbox00000",
					burrowId,
					fromActor: "operator",
					body: String((reqBody as { body?: unknown })?.body ?? ""),
					priority: "normal",
					state: "unread",
					deliveredAtRunId: null,
					createdAt: "2026-05-08T12:00:02Z",
					deliveredAt: null,
				});
			}
			return jsonRes(404, {
				error: { code: "not_found", message: `unmatched ${method} ${path}` },
			});
		}),
	});
}

async function poolFor(repos: Repos, client: BurrowClient): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register("local", client);
	return pool;
}

async function depsFor(
	repos: Repos,
	burrowClient: BurrowClient,
	extras: { plotCreator?: PlotCreator } = {},
): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const burrowClientPool = await poolFor(repos, burrowClient);
	return {
		repos,
		burrowClientPool,
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			burrowClientPool,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		canopyConfig: {
			repoUrl: "https://example/agents.git",
			localDir: "/tmp/cn",
			cnBinary: "cn",
			gitBinary: "git",
		},
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		spawn: async (cmd) => {
			if (cmd[1] === "rev-parse") {
				return { stdout: "deadbeef".repeat(5), stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		},
		...(extras.plotCreator !== undefined ? { plotCreator: extras.plotCreator } : {}),
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

const PLOT_CREATOR: PlotCreator = {
	async create() {
		return {
			id: "plot-msg00000",
			name: "Conversation",
			status: "drafting" as const,
			intent_goal_preview: "",
			attachments_count: 0,
			last_event_ts: "2026-06-24T00:00:00Z",
			last_event_actor: "user:operator",
		};
	},
};

describe("POST /conversations/:id/messages — spawn-per-turn branch (warren-61fa)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";
	let calls: Call[];

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "leveret",
			renderedJson: {
				name: "leveret",
				version: 1,
				sections: { system: "you are leveret" },
				resolvedFrom: [],
				frontmatter: { runtime: "pi-chat" },
			},
		});
		const localPath = await mkdtemp(join(tmpdir(), "warren-msg-"));
		await require("node:fs/promises").mkdir(join(localPath, ".plot"), { recursive: true });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath,
			defaultBranch: "main",
			hasPlot: true,
		});
		projectId = project.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function boot(): Promise<string> {
		calls = [];
		const ws = await mkdtemp(join(tmpdir(), "warren-msg-ws-"));
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_msg0000000", burrowRunId: "run_msg0000000", workspacePath: ws },
			calls,
		);
		const deps = await depsFor(repos, burrowClient, { plotCreator: PLOT_CREATOR });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	async function createConversation(url: string, runtimeOverride?: string) {
		const res = await fetch(`${url}/conversations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				project_id: projectId,
				...(runtimeOverride !== undefined ? { runtime_override: runtimeOverride } : {}),
			}),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as {
			conversation: { id: string; anchoringRunId: string };
			run: { id: string };
		};
	}

	test("spawn-per-turn: spawns a resume-run, rotates anchor, returns resumedRunId", async () => {
		const url = await boot();
		const created = await createConversation(url, "claude-code-chat");
		const convId = created.conversation.id;
		const firstRunId = created.run.id;

		// Count dispatch calls before the message
		const dispatchsBefore = calls.filter(
			(c) => c.method === "POST" && /\/runs$/.test(c.path),
		).length;

		const res = await fetch(`${url}/conversations/${convId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "what should we build?" }),
		});
		expect(res.status).toBe(202);

		const body = (await res.json()) as {
			conversationId: string;
			message: { seq: number };
			resumedRunId?: string;
			steerMessageId?: string;
		};
		expect(body.conversationId).toBe(convId);
		expect(body.message.seq).toBe(2);
		// spawn-per-turn: resumedRunId present, steerMessageId absent
		expect(body.resumedRunId).toBeDefined();
		expect(body.steerMessageId).toBeUndefined();
		const resumedRunId = body.resumedRunId ?? "";

		// A new burrow run was dispatched (second dispatch call)
		const dispatchsAfter = calls.filter(
			(c) => c.method === "POST" && /\/runs$/.test(c.path),
		).length;
		expect(dispatchsAfter).toBe(dispatchsBefore + 1);

		// New run is a distinct warren run (not the same as the anchoring run)
		expect(resumedRunId).not.toBe(firstRunId);

		// The anchor was rotated to the new run
		const conv = await repos.conversations.require(convId);
		expect(conv.anchoringRunId).toBe(resumedRunId);

		// Operator message persisted to transcript
		const messages = await repos.messages.listByConversation(convId);
		expect(messages.map((m) => m.content)).toContain("what should we build?");
	});

	test("spawn-per-turn: new dispatch carries claude-code-chat runtime", async () => {
		const url = await boot();
		await createConversation(url, "claude-code-chat");
		// Identify the conversation
		const convs = await repos.conversations.listAll();
		const convId = convs[0]?.id ?? "";

		calls.length = 0; // reset to see only the message dispatch

		await fetch(`${url}/conversations/${convId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "next turn" }),
		});

		const upCall = calls.find((c) => c.method === "POST" && c.path === "/burrows");
		expect((upCall?.body as { agents?: string[] } | undefined)?.agents).toEqual([
			"claude-code-chat",
		]);
	});

	test("pi-chat path unchanged: steers the live session, returns steerMessageId", async () => {
		const url = await boot();
		const created = await createConversation(url); // no runtime_override → pi-chat

		const res = await fetch(`${url}/conversations/${created.conversation.id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "keep going" }),
		});
		expect(res.status).toBe(202);

		const body = (await res.json()) as {
			steerMessageId?: string;
			resumedRunId?: string;
		};
		expect(body.steerMessageId).toBe("msg_inbox00000");
		expect(body.resumedRunId).toBeUndefined();

		// Anchor NOT rotated (no new run spawned for pi-chat)
		const conv = await repos.conversations.require(created.conversation.id);
		expect(conv.anchoringRunId).toBe(created.conversation.anchoringRunId);
	});
});
