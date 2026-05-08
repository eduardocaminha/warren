/**
 * BurrowClient — warren's facade over `@os-eco/burrow-cli`'s HttpClient.
 *
 * The thin wrapper is mostly a construction helper plus a connection
 * probe. The real surface (burrows / runs / inbox / events / agents
 * namespaces) is forwarded straight from `HttpClient`; warren's own
 * HTTP API maps onto those routes 1:1 (SPEC §8.1) so adding a layer
 * of warren-specific methods would just produce noise.
 *
 * What the facade *does* add:
 *   1. Env-driven construction (`fromEnv`) so the warren process and
 *      its tests don't repeat transport-resolution logic.
 *   2. `probe()` — a healthz call wrapped in a timeout that converts
 *      transport-layer fetch failures (socket missing, ECONNREFUSED,
 *      timeout) into `BurrowUnreachableError`. Used by `/readyz`,
 *      `warren doctor`, and any startup path that needs to know
 *      whether burrow is reachable before continuing.
 *   3. Wire-error mapping — `withTransportMapping` runs an HttpClient
 *      call and rethrows transport-layer errors as the structured
 *      `BurrowUnreachableError`. Wrap calls in §4.3 composition flows
 *      where a unreachable burrow should turn into a 503 from warren
 *      rather than a stack trace.
 *
 * What it deliberately does *not* add:
 *   - No retry/backoff loop. Idempotency is per-route (burrow's
 *     concern), and warren's run lifecycle wants explicit failure not
 *     hidden retry. Add at the call site if needed.
 *   - No request logging here. The warren HTTP server logs at the
 *     route boundary; logging both would double up.
 *   - No higher-level types. The §4.3 spawn flow constructs its own
 *     domain types from `Burrow` / `Run`; this client returns burrow's
 *     wire types untouched.
 */

import { HttpClient, type HttpClientOptions } from "@os-eco/burrow-cli";
import { type BurrowClientConfig, type EnvLike, loadBurrowClientConfigFromEnv } from "./config.ts";
import { BurrowUnreachableError } from "./errors.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export interface BurrowClientOptions {
	readonly config: BurrowClientConfig;
	/** Override fetch (tests, instrumentation). Forwarded to the HttpClient. */
	readonly fetch?: typeof fetch;
}

export class BurrowClient {
	readonly http: HttpClient;
	readonly config: BurrowClientConfig;

	constructor(opts: BurrowClientOptions) {
		this.config = opts.config;
		const httpOpts: HttpClientOptions = { transport: opts.config.transport };
		if (opts.config.token !== undefined) httpOpts.token = opts.config.token;
		if (opts.fetch !== undefined) httpOpts.fetch = opts.fetch;
		this.http = new HttpClient(httpOpts);
	}

	static fromEnv(env: EnvLike = process.env, fetchImpl?: typeof fetch): BurrowClient {
		const config = loadBurrowClientConfigFromEnv(env);
		return new BurrowClient(fetchImpl !== undefined ? { config, fetch: fetchImpl } : { config });
	}

	/**
	 * Hit `/healthz` with a timeout and convert transport-layer failures
	 * into `BurrowUnreachableError`. Auth-protected routes are not
	 * exercised here — `/healthz` is auth-exempt by burrow's contract,
	 * so a successful probe means the socket is up but says nothing
	 * about token correctness. Use a real call (e.g. `burrows.list`)
	 * for an auth-aware liveness check.
	 */
	async probe(timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS): Promise<void> {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			await withTransportMapping(this.config, async () => {
				// HttpClient.healthz has no signal hook, so race against the timer
				// via Promise.race — abort still fires on the underlying fetch
				// because Bun propagates AbortSignal through the global `fetch`
				// when one is installed via setTimeout. Without that, the
				// timeout still wins because the race resolves first; the
				// outstanding fetch is GC'd when the response stream is dropped.
				const aborted = new Promise<never>((_, reject) => {
					ctrl.signal.addEventListener(
						"abort",
						() => reject(new BurrowUnreachableError(`burrow probe timed out after ${timeoutMs}ms`)),
						{ once: true },
					);
				});
				await Promise.race([this.http.healthz(), aborted]);
			});
		} finally {
			clearTimeout(timer);
		}
	}

	async close(): Promise<void> {
		await this.http.close();
	}
}

/**
 * Convert raw `fetch` failures into `BurrowUnreachableError` while
 * letting `BurrowError` (from the rehydrated server envelope) and
 * other structured errors pass through.
 */
export async function withTransportMapping<T>(
	config: BurrowClientConfig,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof BurrowUnreachableError) throw err;
		if (isTransportError(err)) {
			throw new BurrowUnreachableError(formatTransportError(config, err), { cause: err });
		}
		throw err;
	}
}

/**
 * A "transport error" is any error that isn't a structured response
 * from burrow's server. The HttpClient throws either:
 *   - `BurrowError` subclasses (server returned an error envelope), or
 *   - `HttpClientError` (server returned a recognized but unmapped code), or
 *   - whatever `fetch` rejects with when the request itself failed
 *     (socket missing, ECONNREFUSED, name resolution, abort).
 *
 * The first two carry a `.name` of `BurrowError` / `HttpClientError`.
 * Anything else here is by elimination a transport problem. We also
 * peek at the cause chain because Bun wraps lower-level errors in a
 * `TypeError: fetch failed` whose `.cause` carries the real `code`.
 */
export function isTransportError(err: unknown): err is Error {
	if (!(err instanceof Error)) return false;
	if (err.name === "BurrowError" || err.name === "HttpClientError") return false;
	// Walk parent error classes — every `BurrowError` subclass overrides `.name`.
	let cur: object | null = Object.getPrototypeOf(err) as object | null;
	while (cur !== null) {
		const proto = cur as { constructor?: { name?: string } };
		const n = proto.constructor?.name;
		if (n === "BurrowError" || n === "HttpClientError" || n === "WarrenError") return false;
		cur = Object.getPrototypeOf(cur) as object | null;
	}
	return true;
}

function formatTransportError(config: BurrowClientConfig, err: Error): string {
	const where =
		config.transport.kind === "unix"
			? `unix:${config.transport.path}`
			: `tcp://${config.transport.hostname}:${config.transport.port}`;
	const cause = extractCauseCode(err);
	return cause !== null
		? `burrow unreachable at ${where} (${cause})`
		: `burrow unreachable at ${where}: ${err.message}`;
}

function extractCauseCode(err: unknown): string | null {
	let cur: unknown = err;
	for (let i = 0; i < 5 && cur !== null && cur !== undefined; i++) {
		if (typeof cur === "object") {
			const obj = cur as { code?: unknown; cause?: unknown };
			if (typeof obj.code === "string") return obj.code;
			cur = obj.cause;
			continue;
		}
		break;
	}
	return null;
}
