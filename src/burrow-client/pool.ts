/**
 * BurrowClientPool — multi-worker successor to the `BurrowClient.fromEnv()`
 * singleton (warren-41a2 / pl-9ba1 step 3, parent warren-6747).
 *
 * The pool owns the `Map<workerName, BurrowClient>` warren uses to reach the
 * physical burrow process behind each worker row in the `workers` table.
 * Today's single-container deploy boots a one-entry pool (synthetic `local`
 * worker built from `WARREN_BURROW_*` env vars); step 7 ([workers] config
 * loader) materializes additional entries when an operator declares them.
 *
 * Two routing entry points wrap the placement primitives from
 * {@link ../runs/placement.ts}:
 *
 *   - {@link placeFor} — pick a worker for a fresh burrow on a given project.
 *     Delegates to `placeForProject` (project-affinity → least-loaded →
 *     alphabetical tiebreak across `healthy` workers).
 *   - {@link clientFor} — look up the worker pinned to an existing burrow.
 *     Delegates to `placeForBurrow` (sticky-by-burrow; raises if the pinned
 *     worker is `unreachable`).
 *
 * Both return `{ workerName, client }` so callers can record the worker on
 * `runs.worker_id` / `burrows.worker_id` while issuing the HTTP call.
 *
 * The pool does not own the probe loop or state transitions — that lives in
 * step 6 (probe + drain admin API). What it does own:
 *   - constructing the local BurrowClient from env (today's zero-config path),
 *   - the {workerName → client} map,
 *   - a best-effort `probe()` that aggregates per-worker results without
 *     throwing (so /readyz can surface a degraded pool).
 */

import type { Transport } from "@os-eco/burrow-cli";
import { ValidationError, WarrenError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import { placeForBurrow, placeForProject } from "../runs/placement.ts";
import { BurrowClient } from "./client.ts";
import { type BurrowClientConfig, type EnvLike, loadBurrowClientConfigFromEnv } from "./config.ts";

/**
 * Worker name for the synthetic worker that backs today's single-container
 * deploy. `bootServer` upserts a row with this name into `workers` so
 * placement and `clientFor` have something to point at; the row's `url`
 * mirrors `WARREN_BURROW_*` env vars purely for operator-facing diagnostics
 * (the actual transport stays in `BurrowClient.config`, not in this row).
 */
export const LOCAL_WORKER_NAME = "local";

/**
 * Raised when placement returns a worker name the pool has no client for.
 * Indicates drift between the `workers` table and the pool's client map —
 * a `[workers]` config reload missed a row, or a worker was removed without
 * draining first. Surfaced as a structured error so HTTP handlers can map it
 * to a 503 rather than a stack trace.
 */
export class WorkerClientUnregisteredError extends WarrenError {
	readonly code = "worker_client_unregistered";
}

export interface PlacementResult {
	readonly workerName: string;
	readonly client: BurrowClient;
}

export interface ProbeResult {
	readonly workerName: string;
	readonly ok: boolean;
	readonly error?: Error;
}

export interface BurrowClientPoolDeps {
	readonly repos: Repos;
}

export interface BurrowClientPoolFromEnvOptions {
	readonly env?: EnvLike;
	readonly repos: Repos;
	/** Override `fetch` (forwarded to the constructed `BurrowClient`). */
	readonly fetch?: typeof fetch;
	/** Override `Date.now()` for the synthetic `local` worker's `addedAt`. */
	readonly now?: () => Date;
}

/**
 * One `[[workers]]` entry post-validation: `name` + `url` from the TOML
 * config plus the parsed burrow `Transport`. The server-config loader
 * (src/server-config/workers.ts) returns this shape so the pool factory
 * doesn't re-parse the URL.
 */
export interface ConfiguredWorker {
	readonly name: string;
	readonly url: string;
	readonly transport: Transport;
}

export interface BurrowClientPoolFromConfigOptions {
	readonly repos: Repos;
	/** Parsed `[[workers]]` rows; must contain at least one entry. */
	readonly workers: readonly ConfiguredWorker[];
	/**
	 * Bearer token shared across the pool (acceptance #8 of pl-9ba1). One
	 * value for every worker — per-worker tokens were rejected as plan
	 * alternative #3. `requireSharedBurrowToken` (src/server-config/
	 * workers.ts) is the typical producer; boot validates before calling.
	 */
	readonly token: string;
	/** Override `fetch` (forwarded to each constructed `BurrowClient`). */
	readonly fetch?: typeof fetch;
	/** Override `Date.now()` for each worker's `addedAt`. */
	readonly now?: () => Date;
}

export class BurrowClientPool {
	private readonly clients = new Map<string, BurrowClient>();
	private readonly deps: BurrowClientPoolDeps;

	constructor(deps: BurrowClientPoolDeps) {
		this.deps = deps;
	}

	/**
	 * Boot a single-worker pool from `WARREN_BURROW_*` env vars. Upserts the
	 * synthetic `local` row into `workers` (preserving an existing state so a
	 * boot doesn't clobber a probe-derived `unreachable`) and registers the
	 * env-derived `BurrowClient` under that name. This is the zero-config
	 * path: the steady state when no `[workers]` block has been configured.
	 */
	static fromEnv(opts: BurrowClientPoolFromEnvOptions): BurrowClientPool {
		const config = loadBurrowClientConfigFromEnv(opts.env ?? process.env);
		opts.repos.workers.upsert({
			name: LOCAL_WORKER_NAME,
			url: transportToUrl(config.transport),
			...(opts.now !== undefined ? { now: opts.now() } : {}),
		});
		const pool = new BurrowClientPool({ repos: opts.repos });
		const client = new BurrowClient(
			opts.fetch !== undefined ? { config, fetch: opts.fetch } : { config },
		);
		pool.register(LOCAL_WORKER_NAME, client);
		return pool;
	}

	/**
	 * Boot a multi-worker pool from a parsed `[workers]` config (pl-9ba1
	 * step 8 / warren-272c). Upserts every row into `workers` (preserving
	 * probe-derived state on re-boot) and registers each as a
	 * `BurrowClient` bound to the supplied shared bearer token.
	 *
	 * The synthetic `local` worker that `fromEnv` materializes is NOT
	 * created here — when an operator declares `[workers]`, that array
	 * defines the complete pool. Removed workers leave orphaned rows on
	 * disk by design (plan risk #1); `warren doctor` surfaces them as
	 * `worker_missing` and operators reconcile explicitly.
	 *
	 * Caller contract: `workers` must be non-empty. An empty array is a
	 * boot-flow bug (the boot path picks `fromEnv` for zero-config) and
	 * throws here rather than silently producing a pool that fails every
	 * `placeFor` with `NoEligibleWorkerError`.
	 */
	static fromConfig(opts: BurrowClientPoolFromConfigOptions): BurrowClientPool {
		if (opts.workers.length === 0) {
			throw new ValidationError("BurrowClientPool.fromConfig requires at least one worker", {
				recoveryHint: "use BurrowClientPool.fromEnv for the zero-config path",
			});
		}
		const pool = new BurrowClientPool({ repos: opts.repos });
		for (const w of opts.workers) {
			opts.repos.workers.upsert({
				name: w.name,
				url: w.url,
				...(opts.now !== undefined ? { now: opts.now() } : {}),
			});
			const config: BurrowClientConfig = { transport: w.transport, token: opts.token };
			const client = new BurrowClient(
				opts.fetch !== undefined ? { config, fetch: opts.fetch } : { config },
			);
			pool.register(w.name, client);
		}
		return pool;
	}

	/**
	 * Bind a `BurrowClient` to a worker name. `fromEnv` / `fromConfig` are
	 * the production callers; tests use this directly to wire a stub
	 * client per worker.
	 */
	register(workerName: string, client: BurrowClient): void {
		if (this.clients.has(workerName)) {
			throw new ValidationError(`worker '${workerName}' is already registered in the pool`, {
				recoveryHint: "call `pool.deregister(name)` before re-binding",
			});
		}
		this.clients.set(workerName, client);
	}

	/**
	 * Remove a worker's client. Closes the underlying client so its HTTP
	 * agent releases connections. Used by the drain → remove path when an
	 * operator decommissions a worker.
	 */
	async deregister(workerName: string): Promise<void> {
		const c = this.clients.get(workerName);
		if (c === undefined) return;
		this.clients.delete(workerName);
		await c.close();
	}

	get(workerName: string): BurrowClient {
		const c = this.clients.get(workerName);
		if (c === undefined) {
			throw new WorkerClientUnregisteredError(
				`no burrow client registered for worker '${workerName}'`,
				{
					recoveryHint:
						"placement returned a worker name with no pool entry — check that the `[workers]` config matches the `workers` table",
				},
			);
		}
		return c;
	}

	has(workerName: string): boolean {
		return this.clients.has(workerName);
	}

	entries(): readonly PlacementResult[] {
		return [...this.clients.entries()].map(([workerName, client]) => ({ workerName, client }));
	}

	names(): readonly string[] {
		return [...this.clients.keys()].sort();
	}

	get size(): number {
		return this.clients.size;
	}

	/**
	 * Pick a worker for a fresh burrow on `projectId`. See module doc and
	 * {@link placeForProject} for the placement rules.
	 */
	placeFor(input: { projectId: string }): PlacementResult {
		const workerName = placeForProject({ repos: this.deps.repos }, input);
		return { workerName, client: this.get(workerName) };
	}

	/**
	 * Look up the worker pinned to an existing burrow. Sticky-by-burrow; see
	 * {@link placeForBurrow} for the unreachable-fails-loudly contract.
	 */
	clientFor(input: { burrowId: string }): PlacementResult {
		const workerName = placeForBurrow({ repos: this.deps.repos }, input);
		return { workerName, client: this.get(workerName) };
	}

	/**
	 * Probe every registered worker. Returns one result per worker; transport
	 * failures land as `{ ok: false, error }` rather than throwing so the
	 * caller (e.g. `/readyz` / boot logging) can surface a degraded pool
	 * without aborting startup.
	 */
	async probe(timeoutMs?: number): Promise<readonly ProbeResult[]> {
		const entries: ReadonlyArray<readonly [string, BurrowClient]> = [...this.clients.entries()];
		const settled = await Promise.allSettled(
			entries.map(async ([, client]) => {
				await (timeoutMs !== undefined ? client.probe(timeoutMs) : client.probe());
			}),
		);
		return settled.map((s, i) => {
			const entry = entries[i];
			// entries[i] is defined for every i < settled.length by construction.
			const name = entry !== undefined ? entry[0] : "";
			if (s.status === "fulfilled") {
				return { workerName: name, ok: true };
			}
			const err = s.reason instanceof Error ? s.reason : new Error(String(s.reason));
			return { workerName: name, ok: false, error: err };
		});
	}

	/**
	 * Close every registered client. Errors are swallowed (allSettled) so a
	 * single misbehaving worker can't block server shutdown.
	 */
	async close(): Promise<void> {
		const clients = [...this.clients.values()];
		this.clients.clear();
		await Promise.allSettled(clients.map((c) => c.close()));
	}
}

/**
 * Render a `Transport` as the operator-facing URL stored on `workers.url`.
 * The transport itself stays in `BurrowClient.config`; this string is for
 * diagnostics (`GET /workers`, `warren doctor`) and `[workers]` config
 * round-tripping.
 */
function transportToUrl(t: Transport): string {
	return t.kind === "unix" ? `unix://${t.path}` : `http://${t.hostname}:${t.port}`;
}
