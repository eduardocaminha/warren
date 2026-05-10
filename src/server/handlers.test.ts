import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import { NO_AUTH } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import { startServer } from "./server.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "./types.ts";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
};

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

interface BurrowFixture {
	burrowId: string;
	burrowRunId: string;
	workspacePath: string;
}

function makeBurrowClient(
	fix: BurrowFixture,
	calls: { method: string; path: string; body: unknown }[],
): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ method, path, body: reqBody });
			if (method === "POST" && path === "/burrows") {
				const burrow = {
					id: fix.burrowId,
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
				};
				return new Response(JSON.stringify(burrow), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			}
			if (method === "POST" && path === `/burrows/${fix.burrowId}/runs`) {
				const run = {
					id: fix.burrowRunId,
					burrowId: fix.burrowId,
					agentId: "refactor-bot",
					prompt: "hello",
					resumeOfRunId: null,
					state: "queued",
					exitCode: null,
					errorMessage: null,
					metadataJson: null,
					queuedAt: "2026-05-08T12:00:01Z",
					startedAt: null,
					completedAt: null,
				};
				return new Response(JSON.stringify(run), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({ error: { code: "not_found", message: `unmatched ${method} ${path}` } }),
				{
					status: 404,
					headers: { "content-type": "application/json" },
				},
			);
		}),
	});
}

function depsFor(repos: Repos, burrowClient: BurrowClient, bridges?: BridgeRegistry): ServerDeps {
	const broker = new RunEventBroker();
	return {
		repos,
		burrowClient,
		broker,
		bridges:
			bridges ??
			createBridgeRegistry({
				repos,
				broker,
				burrowClient,
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
		// No-op spawn so the project-refresh path inside `POST /runs` and
		// `POST /projects/:id/refresh` doesn't shell out to real `git`
		// against tmpdir paths the test never populated. Tests that need
		// to assert on spawn calls override `deps.spawn` directly.
		spawn: async (cmd) => {
			if (cmd[1] === "rev-parse") {
				return { stdout: "deadbeef".repeat(5), stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		},
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("POST /runs — spawn flow", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	let projectLocalPath = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "you are refactor-bot" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});

		// Real on-disk localPath so the project-refresh path inside POST
		// /runs (warren-1bb6) can pass its existsSync probe before the
		// stubbed spawn handles git fetch + reset --hard origin/main.
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-handlers-proj-"));

		repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		db.close();
	});

	test("provisions burrow, dispatches run, returns 201 + run id, registers a bridge", async () => {
		const project = repos.projects.listAll()[0];
		if (!project) throw new Error("project missing");

		// Use a real tmpdir for the burrow workspace so the handler's seed
		// step (real disk write into <ws>/.canopy/agent.json) doesn't fail.
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmpWs = await mkdtemp(join(tmpdir(), "warren-handlers-"));

		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_xxxxxxxxxxxx", burrowRunId: "run_zzzzzzzzzzzz", workspacePath: tmpWs },
			calls,
		);

		// Stub bridge so the handler's deps.bridges.start() lands in our
		// registry without needing a real burrow stream.
		const bridgeStarted: { runId: string; burrowRunId: string }[] = [];
		const bridges: BridgeRegistry = {
			start: (runId, burrowRunId) => {
				bridgeStarted.push({ runId, burrowRunId });
			},
			stopAll: async () => {},
			size: () => bridgeStarted.length,
		};
		const deps = depsFor(repos, burrowClient, bridges);

		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			run: { id: string; state: string };
			burrow: { id: string };
		};
		expect(body.run.id).toMatch(/^run_/);
		expect(body.run.state).toBe("queued");
		expect(body.burrow.id).toBe("bur_xxxxxxxxxxxx");
		expect(bridgeStarted.length).toBe(1);
		expect(bridgeStarted[0]?.burrowRunId).toBe("run_zzzzzzzzzzzz");
		expect(calls.some((c) => c.method === "POST" && c.path === "/burrows")).toBe(true);
		expect(calls.some((c) => c.path === "/burrows/bur_xxxxxxxxxxxx/runs")).toBe(true);
	});

	test("missing required field → 400 validation_error", async () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_xxxxxxxxxxxx", burrowRunId: "run_zzzzzzzzzzzz", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent: "refactor-bot", project: "prj_x" }), // missing prompt
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("empty body → 400 validation_error", async () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_xxxxxxxxxxxx", burrowRunId: "run_zzzzzzzzzzzz", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, { method: "POST" });
		expect(res.status).toBe(400);
	});
});

describe("POST /projects/:id/refresh — git fetch + hard reset", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectLocalPath = "";
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);

		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		projectLocalPath = await mkdtemp(join(tmpdir(), "warren-refresh-proj-"));

		const row = repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
		projectId = row.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		db.close();
	});

	test("refreshes the clone, stamps lastFetchedAt + lastHeadSha, returns 200", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/refresh`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			project: { id: string; lastHeadSha: string | null; lastFetchedAt: string | null };
			headSha: string;
			ref: string;
		};
		expect(body.project.id).toBe(projectId);
		expect(body.headSha).toBe("deadbeef".repeat(5));
		expect(body.ref).toBe("main");
		expect(body.project.lastHeadSha).toBe("deadbeef".repeat(5));
		expect(body.project.lastFetchedAt).not.toBeNull();
	});

	test("forwards an explicit ref into the refresh", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const seenRefs: string[] = [];
		const deps: ServerDeps = {
			...depsFor(repos, burrowClient),
			spawn: async (cmd) => {
				if (cmd[1] === "checkout") {
					seenRefs.push(cmd[3] ?? "");
				}
				if (cmd[1] === "rev-parse") {
					return { stdout: "abc1234".padEnd(40, "0"), stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${projectId}/refresh`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ref: "feature/x" }),
		});
		expect(res.status).toBe(200);
		expect(seenRefs).toEqual(["feature/x"]);
	});

	test("returns 404 for an unknown project id", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_doesnotexist/refresh`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
	});
});

describe("GET /agents — listing with source provenance (warren-d3e9)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		db.close();
	});

	test("returns source: 'builtin' when frontmatter.source === 'builtin'", async () => {
		repos.agents.upsert({
			name: "claude-code",
			renderedJson: {
				name: "claude-code",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: ["builtin:claude-code"],
				frontmatter: { source: "builtin" },
			},
		});
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agents: { name: string; source: string }[] };
		expect(body.agents[0]?.source).toBe("builtin");
	});

	test("returns source: 'library' for canopy-loaded rows (no source frontmatter)", async () => {
		repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/agents`);
		const body = (await res.json()) as { agents: { name: string; source: string }[] };
		expect(body.agents[0]?.source).toBe("library");
	});
});

describe("POST /agents/refresh without canopy library (warren-d3e9)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		db.close();
	});

	test("returns 400 with friendly hint when canopyConfig is undefined", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = depsFor(repos, burrowClient);
		// Strip canopyConfig — equivalent to booting without CANOPY_REPO_URL.
		const noCanopyDeps: ServerDeps = {
			repos: deps.repos,
			burrowClient: deps.burrowClient,
			broker: deps.broker,
			bridges: deps.bridges,
			projectsConfig: deps.projectsConfig,
			logger: deps.logger,
			uiDistDir: deps.uiDistDir,
			...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
		};
		handle = startServer(noCanopyDeps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/agents/refresh`, { method: "POST" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; hint?: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.hint).toContain("CANOPY_REPO_URL");
	});
});

describe("GET /runs/:id/events — NDJSON tail", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		repos.agents.upsert({ name: "x", renderedJson: { name: "x" } });
		const project = repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = repos.runs.create({
			agentName: "x",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { name: "x", sections: { system: "x" } },
			trigger: "manual",
		});
		repos.events.append({
			runId: run.id,
			burrowEventSeq: 1,
			ts: "2026-05-08T12:00:00Z",
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "bash" },
		});
		repos.events.append({
			runId: run.id,
			burrowEventSeq: 2,
			ts: "2026-05-08T12:00:01Z",
			kind: "tool_result",
			stream: "stdout",
			payload: { ok: true },
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		db.close();
	});

	test("non-follow returns the events as NDJSON", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const run = repos.runs.listAll()[0];
		if (!run) throw new Error("run missing");
		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/events`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/x-ndjson");
		const text = await res.text();
		const lines = text
			.trim()
			.split("\n")
			.filter((l) => l !== "");
		expect(lines.length).toBe(2);
		const first = JSON.parse(lines[0] ?? "{}") as { kind: string; seq: number };
		expect(first.kind).toBe("tool_use");
		expect(first.seq).toBe(1);
	});

	test("404 on unknown run id", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/run_unknown/events`);
		expect(res.status).toBe(404);
	});
});
