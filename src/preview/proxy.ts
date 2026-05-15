/**
 * Reverse proxy preamble for per-run previews (R-19 / SPEC §11.L,
 * warren-8a10; path-mode addendum warren-8085 / pl-f4ea).
 *
 * The proxy is an in-process Bun route, not a separate reverse proxy.
 * `tryHandlePreviewProxy` runs *before* the normal auth gate and route
 * match in `src/server/server.ts`. There are two routing modes, picked
 * at config time from `WARREN_PREVIEW_MODE`:
 *
 *   - **Subdomain mode** (operator owns a wildcard CNAME + cert):
 *     match `Host: run-<runId>.<previewHost>`. URL forwarded upstream
 *     keeps `url.pathname` verbatim.
 *
 *   - **Path mode** (default; reuses warren's own host + cert): match
 *     `^/p/<runId>(/<rest>)?$` on the request path. The `/p/<runId>`
 *     prefix is stripped before forwarding so the upstream sees a
 *     request rooted at `<rest>` (or `/` when `rest` is empty).
 *
 * In either mode the rest of the seam is identical:
 *
 *   1. **Resolve the run.** `runs.preview_state` must be `live`;
 *      anything else (`starting`, `failed`, `torn-down`, null) → 503
 *      with the state in the body so a reviewer can tell `still
 *      booting` apart from `evicted`. Unknown runId → 404.
 *
 *   2. **Cross-host check.** `runs.worker_id !== LOCAL_WORKER_NAME`
 *      returns **501** with an explicit R-12 deferral message. Silent
 *      fall-through to a closed loopback port would manifest as
 *      "preview works for some runs, not others"; the SPEC's
 *      acceptance scenario asserts this path explicitly.
 *
 *   3. **Signed-cookie auth.** Verify the `warren_preview` cookie
 *      against the runId via `PreviewAuth.verifyCookie`. Missing /
 *      invalid / expired cookie → **401** with a body pointing the
 *      browser at the `/runs/:id/preview/login` handshake. Bearer-
 *      in-header is impossible for a browser hitting the preview
 *      origin directly, so cookie is the only auth surface.
 *
 *   4. **last_hit_at debounce.** Update `runs.preview_last_hit_at`
 *      **before** forwarding (SPEC §11.L: a slow upstream response
 *      must not make the preview look idle to the eviction worker).
 *      Debounced via an in-memory `Map<runId, lastFlushAtMs>` to
 *      ~once per `DEFAULT_DEBOUNCE_MS` (default 30s) per run — keeps
 *      the hot path cheap. The map is a single-process singleton; a
 *      warren restart forgets it, but the persisted
 *      `preview_last_hit_at` is the source of truth so eviction
 *      doesn't false-trigger.
 *
 *   5. **Forward.** Rewrite the URL to
 *      `http://127.0.0.1:<preview_port>` preserving the (mode-specific)
 *      upstream path + query string, strip the inbound `Host` /
 *      `Cookie` / `Authorization` headers (preview app should not see
 *      warren's auth state), and stream the body through. The
 *      upstream response is returned as-is so the browser sees the
 *      preview content + headers verbatim. Path-mode HTML rewriting
 *      (`<base>` injection + `Location:` rewrite) lands in a
 *      follow-up step (warren-ab3a); this module is content-agnostic.
 *
 * WebSocket upgrades are not yet supported: Bun.serve's WS surface is
 * accept-then-handle, not transparent-proxy, so a true `Upgrade: websocket`
 * relay needs `server.upgrade()` plus a paired raw socket to the upstream.
 * V1 ships HTTP-only; a 426 is returned for upgrade requests so the
 * client can fall back. A follow-up seed under `pl-2c59` will add WS
 * support once an operator demands it.
 *
 * Every observable side effect (clock, runs repo, fetch) is injectable
 * so unit tests don't touch real sockets or wait on real timers.
 */

import { LOCAL_WORKER_NAME } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import type { PreviewProxyHandler } from "../server/types.ts";
import type { PreviewMode } from "../warren-config/index.ts";
import type { PreviewAuth } from "./cookie.ts";

export type { PreviewProxyHandler };

/** SPEC §11.L: debounce `preview_last_hit_at` writes to ~once per 30s. */
export const DEFAULT_DEBOUNCE_MS = 30_000;

/** Cookie header name written into the redirect body so a browser falls
 *  back gracefully when it didn't get redirected through the login route. */
export const LOGIN_PATH_PREFIX = "/runs/";

/** URL path prefix the path-mode matcher anchors to (`/p/<runId>/...`). */
export const PREVIEW_PATH_PREFIX = "/p";

interface PreviewProxyConfigBase {
	/** Local-worker name. Defaults to the pool's `LOCAL_WORKER_NAME`
	 *  constant; only tests should override. */
	readonly localWorkerName?: string;
	/** Override the debounce window (tests). */
	readonly lastHitDebounceMs?: number;
}

export interface PreviewProxyConfigSubdomain extends PreviewProxyConfigBase {
	readonly mode: "subdomain";
	/** Operator-facing host suffix the proxy matches against `Host:`
	 *  headers (`run-<runId>.<host>`). Resolved at boot from
	 *  `WARREN_PREVIEW_HOST`. */
	readonly host: string;
}

export interface PreviewProxyConfigPath extends PreviewProxyConfigBase {
	readonly mode: "path";
	/** Operator's warren host (informational — used only in the 401
	 *  hint URL). Path mode derives the preview origin from the
	 *  request's own `Host` header, so this is allowed to be null. */
	readonly host?: string | null;
}

export type PreviewProxyConfig = PreviewProxyConfigSubdomain | PreviewProxyConfigPath;

export interface PreviewProxyDeps {
	readonly repos: Repos;
	readonly previewAuth: PreviewAuth;
	readonly config: PreviewProxyConfig;
	/** Override `fetch` for the upstream forward (tests). */
	readonly fetch?: typeof fetch;
	/** Override `Date.now()` so debounce + cookie expiry can be pinned. */
	readonly now?: () => Date;
}

/**
 * Match `run-<runId>.<host>` against `Host:`. Returns the runId on a
 * match, `null` otherwise. Tolerates an optional `:port` suffix because
 * Caddy / Fly edges sometimes preserve the upstream port in the Host
 * header (especially on `http://` dev deploys).
 */
export function parseRunIdFromHost(hostHeader: string | null, suffix: string): string | null {
	if (hostHeader === null || hostHeader.length === 0) return null;
	// Strip optional `:port`.
	const colon = hostHeader.lastIndexOf(":");
	const host =
		colon !== -1 && /^\d+$/.test(hostHeader.slice(colon + 1))
			? hostHeader.slice(0, colon)
			: hostHeader;
	if (host === suffix) return null;
	const suffixDot = `.${suffix}`;
	if (!host.endsWith(suffixDot)) return null;
	const prefix = host.slice(0, host.length - suffixDot.length);
	if (!prefix.startsWith("run-")) return null;
	const runId = prefix.slice("run-".length);
	if (runId.length === 0) return null;
	// runIds are generated as `run_<base32>` (see `generateId`). The dot is
	// disallowed in run subdomains; reject anything else so a multi-label
	// `Host: deeper.run-X.<host>` doesn't accidentally route here.
	if (runId.includes(".")) return null;
	return runId;
}

/**
 * Match `/p/<runId>` (with optional `/<rest>`) on a URL pathname.
 * Returns `{runId, rest}` where `rest` is the remainder of the path
 * (always starts with `/`; defaults to `/` when the request was for
 * `/p/<runId>` with no trailing slash). Returns null when the path
 * doesn't match the preview prefix — the caller falls through to the
 * regular pipeline.
 *
 * The runId charset is intentionally permissive (`[A-Za-z0-9_-]+`) so
 * any future change to `generateId`'s alphabet keeps matching; the
 * DB lookup (`repos.runs.get`) is the actual source of truth and
 * issues a 404 for unknown IDs. The single-segment shape (no `/`,
 * no `.`) is what protects against path-traversal escapes from the
 * prefix.
 */
export function parsePreviewPathPrefix(pathname: string): { runId: string; rest: string } | null {
	const match = /^\/p\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
	if (match === null) return null;
	const runId = match[1];
	if (runId === undefined || runId.length === 0) return null;
	const rest = match[2] ?? "/";
	return { runId, rest };
}

/**
 * Build the proxy handler. The returned function is wired into the
 * server preamble; it returns a `Response` to short-circuit the
 * request, or `null` to fall through to the regular auth + route
 * pipeline.
 */
export function createPreviewProxyHandler(deps: PreviewProxyDeps): PreviewProxyHandler {
	const fetchImpl = deps.fetch ?? globalThis.fetch;
	const now = deps.now ?? (() => new Date());
	const localWorkerName = deps.config.localWorkerName ?? LOCAL_WORKER_NAME;
	const debounceMs = deps.config.lastHitDebounceMs ?? DEFAULT_DEBOUNCE_MS;
	const lastFlush = new Map<string, number>();
	const mode = deps.config.mode;

	return async (request: Request, url: URL): Promise<Response | null> => {
		let runId: string;
		let upstreamPath: string;

		if (mode === "subdomain") {
			const hostHeader = request.headers.get("host");
			const parsed = parseRunIdFromHost(hostHeader, deps.config.host);
			if (parsed === null) return null;
			runId = parsed;
			upstreamPath = url.pathname;
		} else {
			const parsed = parsePreviewPathPrefix(url.pathname);
			if (parsed === null) return null;
			runId = parsed.runId;
			upstreamPath = parsed.rest;
		}

		const run = await deps.repos.runs.get(runId);
		if (run === null) {
			return previewError(404, "preview_not_found", `no run with id ${runId}`);
		}

		if (run.workerId !== null && run.workerId !== localWorkerName) {
			return previewError(
				501,
				"preview_remote_worker",
				`preview proxying is local-worker-only in V1; run.worker_id=${run.workerId} (R-12 deferral, see SPEC §11.L)`,
			);
		}

		if (run.previewState !== "live") {
			const stateLabel = run.previewState ?? "unset";
			return previewError(
				503,
				"preview_not_live",
				`preview is not live (preview_state=${stateLabel})`,
			);
		}

		const port = run.previewPort;
		if (port === null) {
			return previewError(
				503,
				"preview_port_missing",
				"preview is marked live but has no port allocated",
			);
		}

		// WebSocket upgrades: punt explicitly rather than silently dropping
		// the Upgrade header on the forward. A future seed wires `server.upgrade()`
		// + paired upstream socket.
		const upgrade = request.headers.get("upgrade");
		if (upgrade !== null && upgrade.toLowerCase() === "websocket") {
			return previewError(
				426,
				"preview_ws_not_implemented",
				"WebSocket proxying is not yet implemented for preview environments",
			);
		}

		// Auth: signed cookie verifies against this run's id (so a cookie
		// scoped to .<host> can't be used to reach a sibling preview).
		const cookieHeader = request.headers.get("cookie");
		if (!deps.previewAuth.verifyCookie(cookieHeader, runId, now())) {
			return previewUnauthorized(runId, deps.config, url);
		}

		// SPEC §11.L: update last_hit_at BEFORE forwarding (debounced).
		await maybeFlushLastHit(deps.repos, run, lastFlush, debounceMs, now());

		return forwardToUpstream(fetchImpl, request, upstreamPath, url.search, port);
	};
}

async function maybeFlushLastHit(
	repos: Repos,
	run: RunRow,
	lastFlush: Map<string, number>,
	debounceMs: number,
	now: Date,
): Promise<void> {
	const last = lastFlush.get(run.id) ?? 0;
	const nowMs = now.getTime();
	if (nowMs - last < debounceMs) return;
	lastFlush.set(run.id, nowMs);
	try {
		await repos.runs.attachPreview(run.id, { previewLastHitAt: now.toISOString() });
	} catch {
		// Best-effort: a transient db error here shouldn't 502 the proxy.
		// The next debounced flush retries; the eviction worker reads the
		// last persisted value as the source of truth.
		lastFlush.delete(run.id);
	}
}

async function forwardToUpstream(
	fetchImpl: typeof fetch,
	request: Request,
	upstreamPath: string,
	search: string,
	port: number,
): Promise<Response> {
	const upstreamUrl = `http://127.0.0.1:${port}${upstreamPath}${search}`;
	const headers = new Headers(request.headers);
	// Strip warren-internal auth state. The preview app must never see
	// the operator's bearer token or signed-cookie — even though `fetch`
	// would forward them verbatim if we left them in.
	headers.delete("host");
	headers.delete("authorization");
	headers.delete("cookie");
	// Rewrite Host to the upstream loopback so apps that rely on Host for
	// routing or URL composition don't see `run-<id>.<host>`.
	headers.set("host", `127.0.0.1:${port}`);

	const method = request.method.toUpperCase();
	const init: RequestInit = {
		method,
		headers,
		redirect: "manual",
	};
	if (method !== "GET" && method !== "HEAD") {
		init.body = request.body;
		// Streaming bodies require duplex: 'half'; node/Bun both accept it.
		(init as RequestInit & { duplex?: string }).duplex = "half";
	}

	try {
		const upstream = await fetchImpl(upstreamUrl, init);
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: upstream.headers,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return previewError(
			502,
			"preview_upstream_unreachable",
			`could not reach preview upstream at ${upstreamUrl}: ${message}`,
		);
	}
}

function previewError(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code, message } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * 401 envelope with a mode-aware hint pointing at the login handshake.
 * Subdomain mode emits an absolute URL keyed off the configured host;
 * path mode keeps the hint relative (the warren origin matches the
 * inbound request, but the proxy preamble is below the auth layer that
 * would otherwise validate that origin).
 */
function previewUnauthorized(runId: string, config: PreviewProxyConfig, url: URL): Response {
	const loginPath = `${LOGIN_PATH_PREFIX}${runId}/preview/login`;
	const hint =
		config.mode === "subdomain"
			? `GET https://${config.host}${loginPath}?token=<WARREN_API_TOKEN>&redirect=https://run-${runId}.${config.host}/`
			: `GET ${url.origin}${loginPath}?token=<WARREN_API_TOKEN>&redirect=${url.origin}/p/${runId}/`;
	const body = {
		error: {
			code: "preview_unauthorized",
			message: "preview requires a signed-cookie session",
			hint,
		},
	};
	return new Response(JSON.stringify(body), {
		status: 401,
		headers: {
			"content-type": "application/json",
			// Browsers don't honor WWW-Authenticate for cookie schemes, but
			// the header is informative for CLI consumers.
			"www-authenticate": 'Cookie realm="warren-preview"',
		},
	});
}

// Re-export PreviewMode so call sites that wire the proxy don't have
// to dual-import from warren-config.
export type { PreviewMode };
