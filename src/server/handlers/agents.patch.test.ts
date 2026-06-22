import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "../types.ts";

/**
 * PATCH /agents/:name tests (warren-81a3 / pl-dec4 step 2).
 * Split from agents.test.ts to stay within the frozen line-count budget.
 */

async function poolFor(repos: Repos, client: BurrowClient) {
	const { BurrowClientPool } = await import("../../burrow-client/index.ts");
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register("local", client);
	return pool;
}

const silentLogger = { info() {}, warn() {}, error() {} };

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

async function depsFor(repos: Repos, burrowClient: BurrowClient): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const burrowClientPool = await poolFor(repos, burrowClient);
	const bridges: BridgeRegistry = createBridgeRegistry({
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
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

function patchSpawnStub(
	name: string,
	renderResponse: unknown,
	onUpdate?: (args: readonly string[]) => void,
): ServerDeps["spawn"] {
	return async (cmd) => {
		if (cmd[1] === "update") {
			onUpdate?.(cmd);
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		if (cmd[1] === "sync") {
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		if (cmd[1] === "render" && cmd[2] === name) {
			return { stdout: JSON.stringify(renderResponse), stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	};
}

describe("PATCH /agents/:name — project-tier write-back (warren-81a3 / pl-dec4 step 2)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const row = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = row.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("returns 400 when ?projectId is missing", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/agents/refactor-bot`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sections: [{ name: "system", body: "updated" }] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; hint?: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.hint).toContain("built-in and library agents are read-only");
	});

	test("returns 404 when agent doesn't exist at project tier", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/agents/missing-bot?projectId=${encodeURIComponent(projectId)}`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sections: [{ name: "system", body: "updated" }] }),
			},
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});

	test("returns 400 when agent is not project-tier (source: builtin)", async () => {
		// Seed a project-scoped row with source=builtin to hit the tier guard.
		// (Normally built-ins live at the global tier — this exercises the
		// defensive check that covers any non-project source string.)
		await repos.agents.upsert({
			name: "claude-code",
			projectId,
			renderedJson: {
				name: "claude-code",
				version: 1,
				sections: { system: "built-in prompt" },
				resolvedFrom: ["builtin:claude-code"],
				frontmatter: { source: "builtin" },
			},
		});
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/agents/claude-code?projectId=${encodeURIComponent(projectId)}`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sections: [{ name: "system", body: "hacked" }] }),
			},
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toContain("built-in");
	});

	test("returns 200 with refreshed row after successful update", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			projectId,
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "original prompt" },
				resolvedFrom: [],
				frontmatter: { source: `project:${projectId}` },
			},
		});

		const updatedRenderResponse = {
			success: true,
			command: "render",
			name: "refactor-bot",
			version: 2,
			sections: [{ name: "system", body: "updated prompt" }],
			resolvedFrom: [],
			frontmatter: {},
		};

		let capturedUpdateArgs: readonly string[] = [];
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps: ServerDeps = {
			...(await depsFor(repos, burrowClient)),
			spawn: patchSpawnStub("refactor-bot", updatedRenderResponse, (args) => {
				capturedUpdateArgs = args;
			}),
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/agents/refactor-bot?projectId=${encodeURIComponent(projectId)}`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sections: [{ name: "system", body: "updated prompt" }],
				}),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			name: string;
			renderedJson: { name: string; version: number };
			source: string;
			projectId: string | null;
		};
		expect(body.name).toBe("refactor-bot");
		expect(body.renderedJson.version).toBe(2);
		expect(body.source).toBe(`project:${projectId}`);
		expect(body.projectId).toBe(projectId);

		expect(capturedUpdateArgs).toContain("--section");
		expect(capturedUpdateArgs).toContain("system=updated prompt");

		const row = await repos.agents.require("refactor-bot", { projectId });
		expect((row.renderedJson as { version: number }).version).toBe(2);
	});

	test("passes frontmatter and frontmatterRemove flags to cn update", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			projectId,
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "prompt" },
				resolvedFrom: [],
				frontmatter: { source: `project:${projectId}`, runtime: "pi", deprecated: true },
			},
		});

		const updatedRenderResponse = {
			success: true,
			command: "render",
			name: "refactor-bot",
			version: 2,
			sections: [{ name: "system", body: "prompt" }],
			resolvedFrom: [],
			frontmatter: {},
		};

		let capturedUpdateArgs: readonly string[] = [];
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps: ServerDeps = {
			...(await depsFor(repos, burrowClient)),
			spawn: patchSpawnStub("refactor-bot", updatedRenderResponse, (args) => {
				capturedUpdateArgs = args;
			}),
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/agents/refactor-bot?projectId=${encodeURIComponent(projectId)}`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					frontmatter: { runtime: "claude-code" },
					frontmatterRemove: ["deprecated"],
				}),
			},
		);
		expect(res.status).toBe(200);

		expect(capturedUpdateArgs).toContain("--fm");
		expect(capturedUpdateArgs).toContain("runtime=claude-code");
		expect(capturedUpdateArgs).toContain("--remove-fm");
		expect(capturedUpdateArgs).toContain("deprecated");
	});
});
