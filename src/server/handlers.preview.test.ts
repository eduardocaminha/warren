import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { COOKIE_NAME, createPreviewAuth, type PreviewAuth } from "../preview/cookie.ts";
import { createPreviewProxyHandler } from "../preview/proxy.ts";
import { RunEventBroker } from "../runs/index.ts";
import { bearerAuth } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import { isAuthExempt } from "./handlers.ts";
import { startServer } from "./server.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "./types.ts";

const TOKEN = "test-token-very-secret-1234567890abcdef";
const HOST = "preview.warren.example.com";

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

async function depsFor(
	repos: Repos,
	previewAuth: PreviewAuth | undefined,
): Promise<{ deps: ServerDeps; bridges: BridgeRegistry }> {
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
	const deps: ServerDeps = {
		repos,
		burrowClientPool,
		broker,
		bridges,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(previewAuth !== undefined ? { previewAuth, previewHost: HOST } : {}),
	};
	return { deps, bridges };
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("isAuthExempt", () => {
	test("/healthz remains auth-exempt", () => {
		expect(isAuthExempt("/healthz")).toBe(true);
	});

	test("/runs/<id>/preview/login is auth-exempt (SPEC §11.L)", () => {
		expect(isAuthExempt("/runs/run_abc/preview/login")).toBe(true);
		expect(isAuthExempt("/runs/run_abc/preview/login/")).toBe(true);
	});

	test("other /runs/* surfaces remain gated", () => {
		expect(isAuthExempt("/runs")).toBe(false);
		expect(isAuthExempt("/runs/run_abc")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/events")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/preview")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/preview/login/extra")).toBe(false);
	});
});

describe("GET /runs/:id/preview/login", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "agent",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		runId = run.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("issues a signed cookie and redirects to the run subdomain when token matches", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { cookieDomain: `.${HOST}`, secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(TOKEN)}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(`https://run-${runId}.${HOST}/`);
		const setCookie = res.headers.get("set-cookie");
		expect(setCookie).toContain(`${COOKIE_NAME}=`);
		expect(setCookie).toContain(`Domain=.${HOST}`);
		expect(setCookie).toContain("HttpOnly");
	});

	test("401 when token is wrong (route auth-exempt, handler does its own check)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/login?token=wrong`, {
			redirect: "manual",
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("unauthorized");
	});

	test("401 when token is missing", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/login`, {
			redirect: "manual",
		});
		expect(res.status).toBe(401);
	});

	test("404 when the runId is unknown (no cookie issued)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/run_unknown/preview/login?token=${encodeURIComponent(TOKEN)}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(404);
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	test("400 when redirect points outside the run subdomain (no open redirect)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(
				TOKEN,
			)}&redirect=${encodeURIComponent("https://evil.example.com/")}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("preview_redirect_invalid");
	});

	test("400 when redirect is http (not https)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(
				TOKEN,
			)}&redirect=${encodeURIComponent(`http://run-${runId}.${HOST}/`)}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(400);
	});

	test("400 when redirect targets a different run id", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(
				TOKEN,
			)}&redirect=${encodeURIComponent(`https://run-otherrun.${HOST}/`)}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(400);
	});

	test("400-style validation when no preview surface configured", async () => {
		const { deps } = await depsFor(repos, undefined);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(TOKEN)}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});
});

describe("preview proxy preamble in startServer pipeline", () => {
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
		await db.close();
	});

	test("proxy preamble runs BEFORE auth + route match", async () => {
		// Wire a stub previewProxy that always responds with a known body.
		// Without preview-preamble-before-auth, an unauthenticated `/agents`
		// request would 401; with it, the preamble's response wins. This is
		// what guarantees Host-based preview routing doesn't have to
		// satisfy the bearer-auth gate first.
		const { deps } = await depsFor(repos, undefined);
		const proxiedBody = JSON.stringify({ preempted: true });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
			previewProxy: async () =>
				new Response(proxiedBody, { status: 200, headers: { "content-type": "application/json" } }),
		});
		// No bearer header — the auth gate would normally 401 every API
		// surface, but the proxy preamble short-circuits.
		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ preempted: true });
	});

	test("proxy preamble returning null falls through to the normal pipeline", async () => {
		const { deps } = await depsFor(repos, undefined);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
			// "Not a preview request" → null → request continues to auth + router.
			previewProxy: async () => null,
		});
		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(401);
	});

	test("proxy preamble can serve a live-preview unit-level forward without the auth gate", async () => {
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "agent",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			workerId: "local",
		});
		await repos.runs.attachPreview(run.id, {
			previewState: "live",
			previewPort: 30100,
			previewStartedAt: "2026-01-01T00:00:00Z",
			previewLastHitAt: "2026-01-01T00:00:00Z",
		});
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const proxy = createPreviewProxyHandler({
			repos,
			previewAuth,
			config: { host: HOST },
			fetch: (async () => new Response("upstream-ok")) as unknown as typeof fetch,
		});
		const cookie = previewAuth.signCookie(run.id, new Date());
		// Direct unit-style invocation of the proxy handler — Host header
		// constructed inside the Request bypasses Bun.fetch's host-rewriting.
		const req = new Request(`http://run-${run.id}.${HOST}/`, {
			headers: {
				host: `run-${run.id}.${HOST}`,
				cookie: `${COOKIE_NAME}=${cookie.value}`,
			},
		});
		const url = new URL(req.url);
		const res = await proxy(req, url);
		expect(res).not.toBeNull();
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("upstream-ok");
	});
});
