import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LOCAL_WORKER_NAME } from "../burrow-client/pool.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { COOKIE_NAME, createPreviewAuth, type PreviewAuth } from "./cookie.ts";
import { createPreviewProxyHandler, parsePreviewPathPrefix, parseRunIdFromHost } from "./proxy.ts";

function fetchStub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

const TOKEN = "test-token-very-secret-1234567890abcdef";
const HOST = "preview.warren.example.com";

describe("parseRunIdFromHost", () => {
	test("matches `run-<id>.<host>`", () => {
		expect(parseRunIdFromHost("run-abc.preview.warren.example.com", HOST)).toBe("abc");
		expect(parseRunIdFromHost("run-run_abc123.preview.warren.example.com", HOST)).toBe(
			"run_abc123",
		);
	});

	test("tolerates an optional port suffix on the Host header", () => {
		expect(parseRunIdFromHost("run-abc.preview.warren.example.com:8080", HOST)).toBe("abc");
	});

	test("rejects the bare warren host", () => {
		expect(parseRunIdFromHost("preview.warren.example.com", HOST)).toBeNull();
	});

	test("rejects deeper labels (security: no nested-subdomain spoofing)", () => {
		expect(parseRunIdFromHost("foo.run-abc.preview.warren.example.com", HOST)).toBeNull();
	});

	test("rejects non-`run-` prefix", () => {
		expect(parseRunIdFromHost("abc.preview.warren.example.com", HOST)).toBeNull();
	});

	test("rejects null + empty", () => {
		expect(parseRunIdFromHost(null, HOST)).toBeNull();
		expect(parseRunIdFromHost("", HOST)).toBeNull();
	});
});

describe("parsePreviewPathPrefix", () => {
	test("matches `/p/<runId>/<rest>`", () => {
		const r = parsePreviewPathPrefix("/p/run_abc/foo/bar");
		expect(r).toEqual({ runId: "run_abc", rest: "/foo/bar" });
	});

	test("matches `/p/<runId>/` with trailing slash and empty rest → `/`", () => {
		const r = parsePreviewPathPrefix("/p/run_abc/");
		expect(r).toEqual({ runId: "run_abc", rest: "/" });
	});

	test("matches `/p/<runId>` (no trailing slash) and defaults rest to `/`", () => {
		const r = parsePreviewPathPrefix("/p/run_abc");
		expect(r).toEqual({ runId: "run_abc", rest: "/" });
	});

	test("returns null for non-preview paths", () => {
		expect(parsePreviewPathPrefix("/")).toBeNull();
		expect(parsePreviewPathPrefix("/runs/run_abc")).toBeNull();
		expect(parsePreviewPathPrefix("/p")).toBeNull();
		expect(parsePreviewPathPrefix("/p/")).toBeNull();
		expect(parsePreviewPathPrefix("/projects")).toBeNull();
	});

	test("rejects path-traversal in the runId segment", () => {
		// `.` and `/` are not in the charset; a path-traversal attempt
		// either gets eaten by URL normalization upstream or returns null
		// here. The 'rest' segment can contain anything — it's just the
		// upstream URL path.
		expect(parsePreviewPathPrefix("/p/../etc/passwd")).toBeNull();
		expect(parsePreviewPathPrefix("/p/run.abc/foo")).toBeNull();
	});

	test("rest preserves query separator boundary (called with pathname only)", () => {
		// parsePreviewPathPrefix takes a pathname, not a full URL — the
		// proxy handler keeps `url.search` separately and re-attaches it
		// at forward time. So no `?` shows up in a real call.
		const r = parsePreviewPathPrefix("/p/run_abc/api/v1/list");
		expect(r).toEqual({ runId: "run_abc", rest: "/api/v1/list" });
	});
});

describe("createPreviewProxyHandler (subdomain mode)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		auth = createPreviewAuth(TOKEN, { secure: false });
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
		const run = await repos.runs.create({
			agentName: "agent",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_x",
			workerId: LOCAL_WORKER_NAME,
		});
		runId = run.id;
		await repos.runs.attachPreview(runId, {
			previewState: "live",
			previewPort: 30100,
			previewStartedAt: "2026-01-01T00:00:00Z",
			previewLastHitAt: "2026-01-01T00:00:00Z",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	function buildRequest(opts: {
		host: string;
		path?: string;
		cookie?: string | null;
		method?: string;
		extraHeaders?: Record<string, string>;
	}): { request: Request; url: URL } {
		const path = opts.path ?? "/";
		const headers: Record<string, string> = {
			host: opts.host,
			...(opts.extraHeaders ?? {}),
		};
		if (opts.cookie !== undefined && opts.cookie !== null) headers.cookie = opts.cookie;
		const request = new Request(`http://${opts.host}${path}`, {
			method: opts.method ?? "GET",
			headers,
		});
		const url = new URL(request.url);
		return { request, url };
	}

	function validCookieFor(thisRunId: string, now: Date): string {
		const c = auth.signCookie(thisRunId, now);
		return `${COOKIE_NAME}=${c.value}`;
	}

	test("returns null for hosts that don't match the preview suffix", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({ host: "warren.example.com" });
		expect(await handler(request, url)).toBeNull();
	});

	test("404 for unknown runId", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({ host: `run-doesnotexist.${HOST}` });
		const res = await handler(request, url);
		expect(res?.status).toBe(404);
	});

	test("501 cross-host (worker_id !== local) with R-12 deferral message", async () => {
		await repos.runs.attachBurrow(runId, { workerId: "remote-worker-2" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({ host: `run-${runId}.${HOST}` });
		const res = await handler(request, url);
		expect(res?.status).toBe(501);
		const body = (await res?.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("preview_remote_worker");
		expect(body.error.message).toContain("R-12");
	});

	test("503 when preview_state is not live", async () => {
		await repos.runs.attachPreview(runId, { previewState: "starting" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(503);
	});

	test("401 when cookie is missing — never 200, never 502 (SPEC §11.L risk #2)", async () => {
		let upstreamCalled = false;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => {
				upstreamCalled = true;
				return new Response("upstream");
			}),
		});
		const { request, url } = buildRequest({ host: `run-${runId}.${HOST}` });
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
		expect(upstreamCalled).toBe(false);
		const body = (await res?.json()) as { error: { code: string } };
		expect(body.error.code).toBe("preview_unauthorized");
	});

	test("401 when cookie is for a different run", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("upstream")),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor("run_other", new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
	});

	test("forwards a valid request to 127.0.0.1:<port>", async () => {
		const captured: { url: string | undefined; method: string | undefined; host: string | null } = {
			url: undefined,
			method: undefined,
			host: null,
		};
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async (input, init) => {
				captured.url = typeof input === "string" ? input : (input as Request).url;
				captured.method = init?.method;
				captured.host = (init?.headers as Headers).get("host");
				return new Response("ok-from-upstream", { status: 200 });
			}),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			path: "/some/page?q=1",
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("ok-from-upstream");
		expect(captured.url).toBe("http://127.0.0.1:30100/some/page?q=1");
		expect(captured.method).toBe("GET");
		expect(captured.host).toBe("127.0.0.1:30100");
	});

	test("strips Authorization + warren_preview cookie before forwarding", async () => {
		let forwardedAuth: string | null = "unset";
		let forwardedCookie: string | null = "unset";
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async (_input, init) => {
				const headers = init?.headers as Headers;
				forwardedAuth = headers.get("authorization");
				forwardedCookie = headers.get("cookie");
				return new Response("ok");
			}),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: `${validCookieFor(runId, new Date())}; other=keepme`,
			extraHeaders: { authorization: "Bearer leaky-token" },
		});
		await handler(request, url);
		expect(forwardedAuth).toBeNull();
		expect(forwardedCookie).toBeNull();
	});

	test("updates preview_last_hit_at BEFORE returning, debounced", async () => {
		let now = new Date("2026-01-01T01:00:00Z");
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST, lastHitDebounceMs: 30_000 },
			now: () => now,
			fetch: fetchStub(async () => new Response("ok")),
		});

		// Reset preview_last_hit_at well in the past so the first call writes.
		await repos.runs.attachPreview(runId, { previewLastHitAt: "2025-12-01T00:00:00Z" });

		const cookie = validCookieFor(runId, now);
		const first = buildRequest({ host: `run-${runId}.${HOST}`, cookie });
		const r1 = await handler(first.request, first.url);
		expect(r1?.status).toBe(200);
		const after1 = await repos.runs.require(runId);
		expect(after1.previewLastHitAt).toBe(now.toISOString());

		// Within the debounce window: last_hit_at must NOT be re-written.
		const before2 = after1.previewLastHitAt;
		now = new Date(now.getTime() + 5_000);
		const second = buildRequest({ host: `run-${runId}.${HOST}`, cookie });
		await handler(second.request, second.url);
		const after2 = await repos.runs.require(runId);
		expect(after2.previewLastHitAt).toBe(before2);

		// Past the debounce window: writes again.
		now = new Date(now.getTime() + 30_001);
		const third = buildRequest({ host: `run-${runId}.${HOST}`, cookie });
		await handler(third.request, third.url);
		const after3 = await repos.runs.require(runId);
		expect(after3.previewLastHitAt).toBe(now.toISOString());
	});

	test("WebSocket upgrade returns 426 (HTTP-only V1)", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor(runId, new Date()),
			extraHeaders: { upgrade: "websocket" },
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(426);
	});

	test("502 when upstream fetch throws", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(502);
	});
});

describe("createPreviewProxyHandler (path mode)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		// Path mode runs against the warren origin: no Domain attribute
		// on the cookie (warren-edff narrows scope to Path=/p/<id>/ in
		// the next step; this step still HMAC-verifies against runId).
		auth = createPreviewAuth(TOKEN, { secure: false, cookieDomain: null });
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
		const run = await repos.runs.create({
			agentName: "agent",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_x",
			workerId: LOCAL_WORKER_NAME,
		});
		runId = run.id;
		await repos.runs.attachPreview(runId, {
			previewState: "live",
			previewPort: 30200,
			previewStartedAt: "2026-01-01T00:00:00Z",
			previewLastHitAt: "2026-01-01T00:00:00Z",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	function buildPathRequest(opts: {
		path: string;
		cookie?: string | null;
		method?: string;
		extraHeaders?: Record<string, string>;
	}): { request: Request; url: URL } {
		const headers: Record<string, string> = {
			host: "warren.example.com",
			...(opts.extraHeaders ?? {}),
		};
		if (opts.cookie !== undefined && opts.cookie !== null) headers.cookie = opts.cookie;
		const request = new Request(`http://warren.example.com${opts.path}`, {
			method: opts.method ?? "GET",
			headers,
		});
		const url = new URL(request.url);
		return { request, url };
	}

	function validCookieFor(thisRunId: string, now: Date): string {
		const c = auth.signCookie(thisRunId, now);
		return `${COOKIE_NAME}=${c.value}`;
	}

	test("returns null for paths that don't start with /p/<id>", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const cases = ["/", "/runs/abc", "/p", "/p/", "/projects/list"];
		for (const path of cases) {
			const { request, url } = buildPathRequest({ path });
			expect(await handler(request, url)).toBeNull();
		}
	});

	test("subdomain-shaped Host on a non-preview path returns null in path mode", async () => {
		// In path mode the Host header is irrelevant — only the path
		// matters. A request to /runs/foo with a run-x.<host> Host
		// must fall through to the normal pipeline.
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const request = new Request(`http://run-${runId}.preview.warren.example.com/runs/x`, {
			headers: { host: `run-${runId}.preview.warren.example.com` },
		});
		const url = new URL(request.url);
		expect(await handler(request, url)).toBeNull();
	});

	test("404 for unknown runId in /p/<unknown>/", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({ path: "/p/run_doesnotexist/" });
		const res = await handler(request, url);
		expect(res?.status).toBe(404);
	});

	test("501 cross-host (worker_id !== local) with R-12 deferral message", async () => {
		await repos.runs.attachBurrow(runId, { workerId: "remote-worker-2" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({ path: `/p/${runId}/` });
		const res = await handler(request, url);
		expect(res?.status).toBe(501);
		const body = (await res?.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("preview_remote_worker");
		expect(body.error.message).toContain("R-12");
	});

	test("503 when preview_state is not live", async () => {
		await repos.runs.attachPreview(runId, { previewState: "starting" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(503);
	});

	test("401 when cookie is missing — never 200, never 502", async () => {
		let upstreamCalled = false;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => {
				upstreamCalled = true;
				return new Response("upstream");
			}),
		});
		const { request, url } = buildPathRequest({ path: `/p/${runId}/` });
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
		expect(upstreamCalled).toBe(false);
		const body = (await res?.json()) as { error: { code: string; hint: string } };
		expect(body.error.code).toBe("preview_unauthorized");
		// Path-mode hint points at the warren origin from the request.
		expect(body.error.hint).toContain(`/runs/${runId}/preview/login`);
		expect(body.error.hint).toContain(`/p/${runId}/`);
	});

	test("401 when cookie is for a different run", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("upstream")),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor("run_other", new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
	});

	test("forwards `/p/<id>/foo?q=1` → upstream `/foo?q=1` (prefix stripped)", async () => {
		const captured: { url: string | undefined; host: string | null } = {
			url: undefined,
			host: null,
		};
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input, init) => {
				captured.url = typeof input === "string" ? input : (input as Request).url;
				captured.host = (init?.headers as Headers).get("host");
				return new Response("ok-from-upstream", { status: 200 });
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/foo?q=1`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("ok-from-upstream");
		expect(captured.url).toBe("http://127.0.0.1:30200/foo?q=1");
		expect(captured.host).toBe("127.0.0.1:30200");
	});

	test("forwards `/p/<id>/` (root) → upstream `/`", async () => {
		let upstreamUrl: string | undefined;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input) => {
				upstreamUrl = typeof input === "string" ? input : (input as Request).url;
				return new Response("ok", { status: 200 });
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
		});
		await handler(request, url);
		expect(upstreamUrl).toBe("http://127.0.0.1:30200/");
	});

	test("forwards `/p/<id>` (no trailing slash) → upstream `/`", async () => {
		let upstreamUrl: string | undefined;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input) => {
				upstreamUrl = typeof input === "string" ? input : (input as Request).url;
				return new Response("ok", { status: 200 });
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}`,
			cookie: validCookieFor(runId, new Date()),
		});
		await handler(request, url);
		expect(upstreamUrl).toBe("http://127.0.0.1:30200/");
	});

	test("strips Authorization + warren_preview cookie before forwarding", async () => {
		let forwardedAuth: string | null = "unset";
		let forwardedCookie: string | null = "unset";
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (_input, init) => {
				const headers = init?.headers as Headers;
				forwardedAuth = headers.get("authorization");
				forwardedCookie = headers.get("cookie");
				return new Response("ok");
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: `${validCookieFor(runId, new Date())}; other=keepme`,
			extraHeaders: { authorization: "Bearer leaky-token" },
		});
		await handler(request, url);
		expect(forwardedAuth).toBeNull();
		expect(forwardedCookie).toBeNull();
	});

	test("updates preview_last_hit_at BEFORE returning, debounced", async () => {
		let now = new Date("2026-01-01T01:00:00Z");
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path", lastHitDebounceMs: 30_000 },
			now: () => now,
			fetch: fetchStub(async () => new Response("ok")),
		});
		await repos.runs.attachPreview(runId, { previewLastHitAt: "2025-12-01T00:00:00Z" });
		const cookie = validCookieFor(runId, now);
		const first = buildPathRequest({ path: `/p/${runId}/`, cookie });
		await handler(first.request, first.url);
		const after1 = await repos.runs.require(runId);
		expect(after1.previewLastHitAt).toBe(now.toISOString());

		// Within debounce: no write.
		const before2 = after1.previewLastHitAt;
		now = new Date(now.getTime() + 5_000);
		const second = buildPathRequest({ path: `/p/${runId}/`, cookie });
		await handler(second.request, second.url);
		const after2 = await repos.runs.require(runId);
		expect(after2.previewLastHitAt).toBe(before2);
	});

	test("WebSocket upgrade returns 426", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
			extraHeaders: { upgrade: "websocket" },
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(426);
	});

	test("502 when upstream fetch throws", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(502);
	});
});
