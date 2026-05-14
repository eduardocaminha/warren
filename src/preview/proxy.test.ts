import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LOCAL_WORKER_NAME } from "../burrow-client/pool.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { COOKIE_NAME, createPreviewAuth, type PreviewAuth } from "./cookie.ts";
import { createPreviewProxyHandler, parseRunIdFromHost } from "./proxy.ts";

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

describe("createPreviewProxyHandler", () => {
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
			config: { host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({ host: "warren.example.com" });
		expect(await handler(request, url)).toBeNull();
	});

	test("404 for unknown runId", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { host: HOST },
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
			config: { host: HOST },
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
			config: { host: HOST },
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
			config: { host: HOST },
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
			config: { host: HOST },
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
			config: { host: HOST },
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
			config: { host: HOST },
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
			config: { host: HOST, lastHitDebounceMs: 30_000 },
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
			config: { host: HOST },
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
			config: { host: HOST },
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
