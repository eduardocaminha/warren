/**
 * Shared types for the warren HTTP server (SPEC §8.1).
 *
 * The shape mirrors burrow's server (`@os-eco/burrow-cli` `src/server/`)
 * deliberately so a future operator who flips between the two can read
 * either codebase without retraining: same Route/RouteContext/ServeHandle
 * surface, same auth seam, same error envelope. Warren's HTTP face is
 * thin glue over the modules in `runs/`, `registry/`, `projects/`, and
 * `db/repos/` — this file just declares the seams the wiring rides on.
 *
 * `Logger`, `BridgeRegistry`, and `ServerDeps` live in `./deps.ts`
 * (warren-e0da: split to keep both files under 500 lines) and are
 * re-exported here so all existing import sites are unaffected.
 */

import type { BridgeRegistry, Logger, ServerDeps } from "./deps.ts";

export type { BridgeRegistry, Logger, ServerDeps };

/**
 * Error envelope rendered for every non-2xx response. Mirrors burrow's
 * `ErrorEnvelope` so an HTTP consumer hitting both surfaces uses one
 * decoder. `code` is the stable machine identifier; `message` is human;
 * `hint` is the optional recovery cue from `WarrenError.recoveryHint`.
 */
export interface ErrorEnvelope {
	error: {
		code: string;
		message: string;
		hint?: string;
	};
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Compiled route pattern. `paramNames` is the ordered list of `:foo`
 * segments captured by `regex`; the router populates `RouteContext.params`
 * from this list at request time without re-parsing the pattern.
 */
export interface RoutePattern {
	method: HttpMethod;
	pattern: string;
	regex: RegExp;
	paramNames: readonly string[];
}

/**
 * Per-request context handed to route handlers. `params` carries the
 * decoded `:foo` captures. `logger` is whatever pino instance the server
 * was booted with; tests pass a silent one.
 */
export interface RouteContext {
	readonly request: Request;
	readonly url: URL;
	readonly params: Readonly<Record<string, string>>;
	/**
	 * Per-request child logger pre-bound with `request_id` (warren-30af).
	 * Handlers should prefer this over `deps.logger` so every log line
	 * produced inside a request carries the correlation id that is also
	 * stamped into the response's `X-Request-ID` header.
	 */
	readonly logger: Logger;
	/**
	 * The correlation id stamped onto the outgoing response's
	 * `X-Request-ID` header (warren-30af / pl-7b06 step 19). Either
	 * the inbound header value (when well-formed) or a freshly minted
	 * UUID. Surfaced here so handlers that propagate the id into
	 * downstream calls (burrow, plot, etc.) don't have to re-parse it
	 * off the request.
	 */
	readonly requestId: string;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

export interface Route {
	readonly method: HttpMethod;
	readonly pattern: string;
	readonly handler: RouteHandler;
}

/**
 * Wire-level binding for `warren serve`. TCP is the canonical V1 deploy
 * (warren is fronted by Caddy/Fly edge for TLS — see SPEC §11.D); the
 * unix socket option is kept for any future "warren next to a reverse
 * proxy on the same box without a port" deploy. Defaults to ephemeral
 * loopback TCP for tests.
 */
export type Transport =
	| { readonly kind: "unix"; readonly path: string }
	| { readonly kind: "tcp"; readonly hostname: string; readonly port: number };

export interface ServeOptions {
	transport?: Transport;
	/** Auth strategy. Defaults to `NO_AUTH` for tests; main wires `bearerAuth`. */
	auth?: AuthProvider;
	/** Override the route table (tests); defaults to `buildRoutes(deps)`. */
	routes?: readonly Route[];
	logger?: Logger;
	/**
	 * Per-request idle timeout in seconds passed to `Bun.serve`. Defaults
	 * to 0 (disabled) so long-lived NDJSON streams aren't killed at the
	 * Bun runtime default of 10s (warren-b8fc). Tests override to assert
	 * the wire is plumbed.
	 */
	idleTimeout?: number;
	/**
	 * Host-match preview proxy preamble (R-19 / SPEC §11.L, warren-8a10).
	 * Runs BEFORE auth + route match. Returns a `Response` to short-circuit
	 * the request, or `null` to fall through to the regular pipeline.
	 * Undefined → no preview surface (zero overhead per request).
	 */
	previewProxy?: PreviewProxyHandler;
}

/** Host-match preview proxy preamble. See `src/preview/proxy/index.ts`. */
export type PreviewProxyHandler = (request: Request, url: URL) => Promise<Response | null>;

export interface ServeHandle {
	readonly transport: Transport;
	readonly url: string;
	stop(): Promise<void>;
}

export interface AuthOk {
	readonly ok: true;
}

export interface AuthDenied {
	readonly ok: false;
	readonly status: number;
	readonly code: string;
	readonly message: string;
	readonly challenge?: string;
}

export type AuthOutcome = AuthOk | AuthDenied;

export interface AuthProvider {
	authorize(request: Request): AuthOutcome;
}
