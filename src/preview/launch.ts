/**
 * `launchPreview` — spawn `preview.command` as a long-lived burrow sidecar
 * after a successful agent run, drive its readiness probe, and persist the
 * resulting `preview_state` (R-19 / SPEC §11.L, warren-f156).
 *
 * The actual orchestration (gating on outcome / opt-in / worker locality)
 * lives in `src/runs/reap.ts`; this module owns the mechanics once those
 * gates pass:
 *
 *   1. **Allocate** a host port via `PreviewPortAllocator`. The allocator
 *      writes `preview_state='starting'` + `preview_port` atomically; if
 *      the range is exhausted, we surface that as a typed result and never
 *      touch burrow.
 *   2. **Spawn** the sidecar via `POST /burrows/:id/sidecars` with the
 *      configured `command` (run through `sh -c` so shell forms like
 *      `bun run dev` work without per-call argv-splitting) and the
 *      `inboundPortForward: { hostPort, sandboxPort: previewConfig.port }`
 *      so burrow opens the loopback bridge between the host port and the
 *      in-sandbox listener.
 *   3. **Probe** readiness from the warren-host side. Burrow's sidecar
 *      registry marks the sidecar `live` the moment the process is
 *      spawned, but the SPEC's `live` state means "readiness probe returned
 *      2xx" — that's a higher bar than "process didn't crash on startup".
 *      We poll `http://127.0.0.1:<hostPort><readiness_path or '/'>` until a
 *      2xx response, the timeout fires, or the sidecar exits early. The
 *      probe uses GET and treats any 2xx as ready.
 *   4. **Persist** the outcome via `RunsRepo.attachPreview`. `live`
 *      leaves `preview_port` set and clears `preview_failure_message`;
 *      `failed` populates `preview_failure_message` with the stderr tail
 *      and clears `preview_port` so the allocator can recycle the port.
 *      Failure cleanup also calls `sidecars.delete` best-effort so the
 *      process doesn't linger past the failure transition.
 *
 * Every observable side effect (port allocator, burrow client, readiness
 * fetch, clock, sleep) is injectable so unit tests don't touch real
 * sockets or wait on real timers.
 *
 * Result shape is a discriminated union — callers (reap) map each branch
 * onto a structured `reap_failed` event. Cancellation (manual teardown,
 * eviction worker) and TTLs are explicitly **out of scope here**; this
 * module only owns the starting → {live, failed} transition.
 */

import type { Repos } from "../db/repos/index.ts";
import {
	DEFAULT_PREVIEW_MODE,
	type PreviewMode,
	PreviewModeSchema,
	type ServerPreviewConfig,
} from "../warren-config/index.ts";
import { PORT_EXHAUSTED_REASON, type PreviewPortAllocator } from "./port-allocator.ts";

/* ----------------------------------------------------------------------- */
/* Public surface                                                           */
/* ----------------------------------------------------------------------- */

export interface PreviewSidecarsClient {
	create(input: {
		readonly burrowId: string;
		readonly command: readonly string[];
		readonly env?: Record<string, string>;
		readonly cwd?: string;
		readonly inboundPortForward?: { hostPort: number; sandboxPort: number };
		readonly readinessPath?: string;
	}): Promise<{ readonly id: string; readonly state: string }>;
	logs(
		burrowId: string,
		sidecarId: string,
		opts?: { tailBytes?: number },
	): Promise<{ readonly stdout: string; readonly stderr: string }>;
	delete(burrowId: string, sidecarId: string): Promise<void>;
}

export interface LaunchPreviewInput {
	readonly runId: string;
	readonly burrowId: string;
	readonly previewConfig: ServerPreviewConfig;
	readonly repos: Repos;
	readonly allocator: PreviewPortAllocator;
	readonly sidecars: PreviewSidecarsClient;
	readonly now?: () => Date;
	/** Override the readiness-probe HTTP fetch (tests). */
	readonly fetch?: typeof fetch;
	/** Override sleeping between probe attempts (tests). */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Cap the readiness probe loop. Defaults to `DEFAULT_READINESS_TIMEOUT_MS`. */
	readonly readinessTimeoutMs?: number;
	/** Pause between probe attempts. Defaults to `DEFAULT_READINESS_POLL_MS`. */
	readinessPollMs?: number;
	/** Per-call AbortController timeout. Defaults to `PROBE_PER_CALL_TIMEOUT_MS`. */
	readonly probePerCallTimeoutMs?: number;
}

export type LaunchPreviewResult =
	| {
			readonly ok: true;
			readonly port: number;
			readonly sidecarId: string;
	  }
	| {
			readonly ok: false;
			readonly reason: LaunchFailureReason;
			readonly message: string;
			/** Stderr tail captured from the sidecar (best-effort), if any. */
			readonly failureTail: string;
			/** Port the allocator claimed before the launch failed (released by us). */
			readonly port: number | null;
	  };

export type LaunchFailureReason =
	| "port_exhausted"
	| "create_failed"
	| "readiness_timeout"
	| "sidecar_exited";

/**
 * Default readiness probe wall clock. Sized to cover a cold `pnpm install` +
 * dev-server bind for projects with hundreds of deps (warren-0928); the probe
 * returns on first 2xx, so a larger ceiling only delays failure reporting and
 * doesn't slow the happy path. Override per-project via
 * `.warren/preview.yaml`'s `readiness_timeout`.
 */
export const DEFAULT_READINESS_TIMEOUT_MS = 300_000;
/** Default pause between probe attempts. */
export const DEFAULT_READINESS_POLL_MS = 500;
/**
 * Per-call probe timeout (warren-33eb). The outer `readinessTimeoutMs` is a
 * wall-clock bound on the loop *between* attempts; without a per-call
 * timeout a single hung `fetch()` (e.g. burrow forwarder accepted the TCP
 * connection but the dev server is mid-compile and never flushes bytes)
 * blocks the deadline check indefinitely. 2s is a conservative upper bound —
 * a dev server that can't return any byte for `GET /` within 2s is not
 * "ready" in the §11.L sense even if it's alive.
 */
export const PROBE_PER_CALL_TIMEOUT_MS = 2_000;
/** Stderr tail size copied into `preview_failure_message`. */
export const PREVIEW_FAILURE_TAIL_BYTES = 4096;

/* ----------------------------------------------------------------------- */
/* Implementation                                                           */
/* ----------------------------------------------------------------------- */

export async function launchPreview(input: LaunchPreviewInput): Promise<LaunchPreviewResult> {
	const now = input.now ?? (() => new Date());
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const sleep = input.sleep ?? defaultSleep;
	const timeoutMs = input.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	const pollMs = input.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
	const perCallTimeoutMs = input.probePerCallTimeoutMs ?? PROBE_PER_CALL_TIMEOUT_MS;

	const allocation = await input.allocator.allocate(input.runId, now());
	if (allocation.status === "exhausted") {
		const message = `preview port range exhausted (reason=${PORT_EXHAUSTED_REASON})`;
		await input.repos.runs.attachPreview(input.runId, {
			previewState: "failed",
			previewFailureMessage: message,
		});
		return { ok: false, reason: "port_exhausted", message, failureTail: "", port: null };
	}
	const port = allocation.port;

	let sidecarId: string;
	try {
		const created = await input.sidecars.create({
			burrowId: input.burrowId,
			command: ["sh", "-c", input.previewConfig.command],
			inboundPortForward: { hostPort: port, sandboxPort: input.previewConfig.port },
			...(input.previewConfig.readiness_path !== undefined
				? { readinessPath: input.previewConfig.readiness_path }
				: {}),
		});
		sidecarId = created.id;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await input.repos.runs.attachPreview(input.runId, {
			previewState: "failed",
			previewPort: null,
			previewFailureMessage: `sidecar create failed: ${truncate(message, PREVIEW_FAILURE_TAIL_BYTES)}`,
		});
		return {
			ok: false,
			reason: "create_failed",
			message,
			failureTail: "",
			port,
		};
	}

	const readinessPath = input.previewConfig.readiness_path ?? "/";
	const probeUrl = `http://127.0.0.1:${port}${readinessPath}`;
	const deadline = now().getTime() + timeoutMs;

	while (true) {
		const ready = await probeOnce(fetchImpl, probeUrl, perCallTimeoutMs);
		if (ready) {
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "live",
				previewLastHitAt: now().toISOString(),
				previewFailureMessage: null,
			});
			return { ok: true, port, sidecarId };
		}
		if (now().getTime() >= deadline) {
			const failureTail = await captureFailureTail(input.sidecars, input.burrowId, sidecarId);
			await safeDeleteSidecar(input.sidecars, input.burrowId, sidecarId);
			const message = `readiness probe did not return 2xx within ${timeoutMs}ms (probed ${probeUrl})`;
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "failed",
				previewPort: null,
				previewFailureMessage: composeFailureMessage(message, failureTail),
			});
			return {
				ok: false,
				reason: "readiness_timeout",
				message,
				failureTail,
				port,
			};
		}
		await sleep(pollMs);
	}
}

async function probeOnce(
	fetchImpl: typeof fetch,
	url: string,
	perCallTimeoutMs: number,
): Promise<boolean> {
	const ac = new AbortController();
	const tid = setTimeout(() => ac.abort(), perCallTimeoutMs);
	try {
		const res = await fetchImpl(url, {
			method: "GET",
			redirect: "manual",
			signal: ac.signal,
		});
		// 2xx ⇒ ready. 3xx is treated as ready too: a dev server that redirects
		// "/" → "/index" is ready; the proxy will follow on real traffic.
		if (res.ok || (res.status >= 300 && res.status < 400)) {
			await drainBody(res);
			return true;
		}
		await drainBody(res);
		return false;
	} catch {
		return false;
	} finally {
		clearTimeout(tid);
	}
}

async function drainBody(res: Response): Promise<void> {
	try {
		await res.body?.cancel();
	} catch {
		// stream may already be closed; ignore.
	}
}

async function captureFailureTail(
	sidecars: PreviewSidecarsClient,
	burrowId: string,
	sidecarId: string,
): Promise<string> {
	try {
		const logs = await sidecars.logs(burrowId, sidecarId, {
			tailBytes: PREVIEW_FAILURE_TAIL_BYTES,
		});
		const tail = logs.stderr.trim() !== "" ? logs.stderr : logs.stdout;
		return truncate(tail, PREVIEW_FAILURE_TAIL_BYTES);
	} catch {
		return "";
	}
}

async function safeDeleteSidecar(
	sidecars: PreviewSidecarsClient,
	burrowId: string,
	sidecarId: string,
): Promise<void> {
	try {
		await sidecars.delete(burrowId, sidecarId);
	} catch {
		// Best-effort cleanup — eviction worker also terminates lingering sidecars.
	}
}

function composeFailureMessage(headline: string, tail: string): string {
	if (tail === "") return headline;
	return `${headline}\n\n${tail}`;
}

function truncate(input: string, max: number): string {
	if (input.length <= max) return input;
	return `${input.slice(input.length - max)}`;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ----------------------------------------------------------------------- */
/* Env-driven config (preview launch host for PR annotation)                */
/* ----------------------------------------------------------------------- */

export const WARREN_PREVIEW_HOST_ENV = "WARREN_PREVIEW_HOST" as const;
export const WARREN_PREVIEW_MODE_ENV = "WARREN_PREVIEW_MODE" as const;

export interface PreviewLaunchConfig {
	/**
	 * Host suffix the proxy preamble matches on (`Host: run-<id>.<host>`).
	 * Null when the operator hasn't wired the proxy yet — `preview_launch`
	 * still runs (the eviction worker / manual teardown all key off
	 * `runs.preview_state`), but `pr_annotate_preview` skips because there
	 * is no URL to publish.
	 *
	 * In path mode (default, warren-fcb7 / SPEC §11.L path addendum) the proxy
	 * preamble derives the preview origin from the request's own `Host` and
	 * routes by path prefix, so `host` being null no longer disables the
	 * preview surface — only subdomain mode still requires this to be set.
	 */
	readonly host: string | null;
	/**
	 * Routing mode for previews (warren-fcb7 / SPEC §11.L path addendum).
	 * `path` (default): previews served at `https://<warren-host>/p/<run-id>/`.
	 * `subdomain`: previews served at `https://run-<id>.<host>/`. The env
	 * surface wins over any per-project `.warren/preview.yaml` `mode` pin
	 * (merge precedence enforced by the call site, not here).
	 */
	readonly mode: PreviewMode;
}

export type PreviewLaunchEnvLike = Readonly<Record<string, string | undefined>>;

export function loadPreviewLaunchConfigFromEnv(
	env: PreviewLaunchEnvLike = process.env,
): PreviewLaunchConfig {
	const rawHost = env[WARREN_PREVIEW_HOST_ENV];
	const trimmedHost = rawHost === undefined ? "" : rawHost.trim();
	const host = trimmedHost === "" ? null : trimmedHost;

	const rawMode = env[WARREN_PREVIEW_MODE_ENV];
	const trimmedMode = rawMode === undefined ? "" : rawMode.trim().toLowerCase();
	// Invalid / empty value silently falls back to DEFAULT_PREVIEW_MODE — the
	// env knob mirrors how other WARREN_PREVIEW_* values degrade (mx-d3b88f)
	// rather than blocking server boot. Doctor / readyz callers can layer on
	// a strict validation pass later if operators want one.
	const parsedMode = PreviewModeSchema.safeParse(trimmedMode);
	const mode: PreviewMode = parsedMode.success ? parsedMode.data : DEFAULT_PREVIEW_MODE;

	return { host, mode };
}

/**
 * Format the preview URL for a `live` preview. The host suffix is the
 * operator's `WARREN_PREVIEW_HOST`; URLs are always `https` per SPEC §11.D
 * (TLS terminates on the operator's reverse proxy).
 *
 * - **Subdomain mode** (`https://run-<id>.<host>`): the reviewer-facing
 *   shape from the original §11.L. No trailing slash so the URL stays
 *   stable across modes and existing PR annotations.
 * - **Path mode** (`https://<host>/p/<id>/`, warren-c3c4 / SPEC §11.L
 *   addendum): trailing slash is load-bearing — without it the browser
 *   resolves the upstream's root-relative HTML (`href="/assets/foo"`)
 *   against `/p/` instead of `/p/<id>/`, defeating the proxy preamble.
 */
export function formatPreviewUrl(runId: string, host: string, mode: PreviewMode): string {
	if (mode === "path") {
		return `https://${host}/p/${runId}/`;
	}
	return `https://run-${runId}.${host}`;
}
