/**
 * Boot entry for `warren serve` (SPEC §8.2 / §10.3).
 *
 * Wires together every layer the server depends on:
 *   - load env-driven config (server bind, data dir, UI dist),
 *   - open the SQLite db (creates + migrates if missing),
 *   - construct the BurrowClient + RunEventBroker,
 *   - boot the BridgeRegistry (resumes any in-flight runs from the
 *     events-table cursor — SPEC §9 restart-recovery contract),
 *   - load the canopy + projects sub-configs,
 *   - resolve the AuthProvider,
 *   - call `startServer`.
 *
 * Returns a `WarrenServerHandle` whose `stop()` tears everything down
 * in the reverse order: aborts the wire, drains the bridges, closes
 * the db, closes the burrow client. The supervisor (Phase 12) will
 * own the SIGTERM/SIGINT plumbing — this entry just exposes the stop
 * function so an integration test or the CLI can call it directly.
 *
 * `bootServer` is async because the burrow probe at startup (used to
 * fail-fast when the socket is unreachable) is async. The probe is
 * non-fatal — warren will still start if burrow is down so /readyz
 * can report it — but logged.
 */

import pino from "pino";
import { BurrowClientPool } from "../burrow-client/index.ts";
import { type AnyWarrenDb, openDatabase, WARREN_DB_POOL_MAX_ENV } from "../db/client.ts";
import { createRepos } from "../db/repos/index.ts";
import { parseDatabaseUrl } from "../db/url.ts";
import { createPreviewAuth, type PreviewAuth } from "../preview/cookie.ts";
import {
	loadPreviewEvictionConfigFromEnv,
	startPreviewEvictionWorker,
} from "../preview/eviction.ts";
import { loadPreviewLaunchConfigFromEnv } from "../preview/launch.ts";
import { loadPreviewPortRangeFromEnv, PreviewPortAllocator } from "../preview/port-allocator.ts";
import { createPreviewProxyHandler } from "../preview/proxy.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../projects/clone.ts";
import { loadProjectsConfigFromEnv } from "../projects/config.ts";
import { seedBuiltinAgents } from "../registry/builtins/index.ts";
import { loadCanopyRegistryConfigFromEnv } from "../registry/config.ts";
import {
	loadAutoOpenPrConfigFromEnv,
	loadRunBranchPrefixFromEnv,
	RunEventBroker,
} from "../runs/index.ts";
import {
	loadWarrenServerConfigFromFile,
	requireSharedBurrowToken,
} from "../server-config/index.ts";
import { loadTriggerSchedulerConfigFromEnv } from "../triggers/index.ts";
import { createWarrenConfigCache } from "../warren-config/index.ts";
import { NO_AUTH, resolveAuth } from "./auth.ts";
import { bootBridges } from "./bridges.ts";
import { type EnvLike, loadServerConfigFromEnv } from "./config.ts";
import { loadWorkerProbeConfigFromEnv, startWorkerProbe } from "./probe.ts";
import { bootScheduler } from "./scheduler.ts";
import { startServer } from "./server.ts";
import type { AuthProvider, Logger, ServeHandle, ServerDeps } from "./types.ts";

export interface BootServerOptions {
	readonly env?: EnvLike;
	readonly noAuth?: boolean;
	/** Override the UI dist directory default (`<cwd>/src/ui/dist`). */
	readonly defaultUiDistDir?: string;
	/** Override `Date.now()` for deterministic tests. */
	readonly now?: () => Date;
}

export interface WarrenServerHandle extends ServeHandle {
	stop(): Promise<void>;
}

export async function bootServer(opts: BootServerOptions = {}): Promise<WarrenServerHandle> {
	const env = opts.env ?? process.env;
	const logger = pino({ name: "warren", level: env.WARREN_LOG_LEVEL ?? "info" });

	const serverConfig = loadServerConfigFromEnv({
		env,
		...(opts.noAuth !== undefined ? { noAuth: opts.noAuth } : {}),
		...(opts.defaultUiDistDir !== undefined ? { defaultUiDistDir: opts.defaultUiDistDir } : {}),
	});
	const canopyConfig = loadCanopyRegistryConfigFromEnv(env);
	const projectsConfig = loadProjectsConfigFromEnv(env);

	if (serverConfig.dbUrlConflict !== null) {
		logger.warn(
			{ url: serverConfig.dbUrl, path: serverConfig.dbUrlConflict },
			"WARREN_DB_URL and WARREN_DB_PATH are both set and disagree; WARREN_DB_URL wins",
		);
	}
	const pgPoolMax = resolvePgPoolMax(env);
	const db = await openDatabase({
		url: serverConfig.dbUrl,
		...(pgPoolMax !== undefined ? { pgPoolMax } : {}),
	});
	const repos = createReposForDialect(db);

	// Load the operator-facing TOML config (pl-9ba1 step 7 / warren-3909).
	// `workers` is `[]` when `[workers]` is absent — the zero-config path
	// still materializes a single synthetic `local` worker from
	// WARREN_BURROW_* env vars (acceptance #1: identical behavior). When
	// `[workers]` is declared, the file-driven `fromConfig` factory takes
	// over and acceptance #8 requires the shared bearer token to be set.
	const fileConfig = await loadWarrenServerConfigFromFile({ env });
	const burrowClientPool =
		fileConfig.workers.length > 0
			? await BurrowClientPool.fromConfig({
					repos,
					workers: fileConfig.workers,
					token: requireSharedBurrowToken(env),
					...(opts.now !== undefined ? { now: opts.now } : {}),
				})
			: await BurrowClientPool.fromEnv({
					env,
					repos,
					...(opts.now !== undefined ? { now: opts.now } : {}),
				});
	const broker = new RunEventBroker();

	logger.info(
		{
			dbUrl: redactDbUrl(serverConfig.dbUrl),
			dialect: db.dialect,
			transport: serverConfig.transport,
		},
		"warren server starting",
	);
	if (fileConfig.path !== null) {
		logger.info(
			{ path: fileConfig.path, workers: fileConfig.workers.length },
			"loaded warren.toml",
		);
	}

	// Seed built-in agents (warren-d3e9). Idempotent: existing rows
	// (whether seeded by an earlier boot or upserted by a refresh of a
	// same-named library agent) are preserved.
	const seedResult = await seedBuiltinAgents(repos.agents, undefined, opts.now);
	if (seedResult.seeded.length > 0) {
		logger.info({ agents: seedResult.seeded }, "seeded built-in agents");
	}

	const autoOpenPr = loadAutoOpenPrConfigFromEnv(env);
	if (autoOpenPr.enabled && autoOpenPr.token === "") {
		logger.warn(
			{},
			"WARREN_AUTO_OPEN_PR is enabled but GITHUB_TOKEN is unset; reap pr_open will skip with reap_failed events",
		);
	}

	const warrenConfigs = createWarrenConfigCache();
	const runBranchPrefixDefault = loadRunBranchPrefixFromEnv(env);
	const previewPortRange = loadPreviewPortRangeFromEnv(env);
	// The SQLite-backed port allocator is the only dialect today (warren-2277);
	// the postgres branch lights up when the repo layer becomes dialect-aware
	// (pl-f17e follow-up). Until then, postgres deployments skip preview
	// launches at the boot wiring step — same as `/readyz` (mx-b82a55).
	const portAllocator =
		db.dialect === "sqlite" ? new PreviewPortAllocator(db, previewPortRange) : undefined;
	const previewLaunchConfig = loadPreviewLaunchConfigFromEnv(env);
	const previewEvictionConfig = loadPreviewEvictionConfigFromEnv(env);

	const bridgesBoot = await bootBridges({
		repos,
		broker,
		burrowClientPool,
		logger: bridgeLoggerFromPino(logger),
		autoOpenPr,
		warrenConfigs,
		...(portAllocator !== undefined ? { portAllocator } : {}),
		previewLaunchConfig,
	});
	if (bridgesBoot.resumed.length > 0) {
		logger.info(
			{ count: bridgesBoot.resumed.length },
			"resumed run-stream bridges from active runs",
		);
	}
	if (bridgesBoot.skipped.length > 0) {
		logger.warn(
			{ count: bridgesBoot.skipped.length, runs: bridgesBoot.skipped },
			"skipped runs without burrow_run_id",
		);
	}

	// Best-effort startup probe so the operator sees a clear error if any
	// worker's burrow is down at boot — but we don't refuse to start, since
	// /readyz reports the live state and a freshly-installed warren often
	// boots before burrow's socket lands. `pool.probe()` aggregates per-
	// worker results without throwing, so a degraded multi-worker pool
	// surfaces every failing worker on one log line.
	burrowClientPool.probe().then((results) => {
		const failed = results.filter((r) => !r.ok);
		if (failed.length > 0) {
			logger.warn(
				{
					failed: failed.map((r) => ({
						worker: r.workerName,
						err: r.error?.message ?? "unknown",
					})),
				},
				"burrow probe failed at boot — /readyz will reflect this",
			);
		}
	});

	const probeConfig = loadWorkerProbeConfigFromEnv(env);
	const workerProbe = startWorkerProbe({
		pool: burrowClientPool,
		workers: repos.workers,
		config: probeConfig,
		logger: probeLoggerFromPino(logger),
	});
	if (probeConfig.disabled === true) {
		logger.info({}, "worker probe disabled via WARREN_WORKER_PROBE_DISABLED");
	} else {
		logger.info(
			{
				intervalMs: probeConfig.intervalMs ?? 30_000,
				timeoutMs: probeConfig.timeoutMs ?? 2_000,
			},
			"worker probe running",
		);
	}

	const schedulerConfig = loadTriggerSchedulerConfigFromEnv(env);
	const scheduler = bootScheduler({
		repos,
		burrowClientPool,
		bridges: bridgesBoot.registry,
		warrenConfigs,
		projectsConfig,
		projectSpawn: defaultSpawn,
		config: schedulerConfig,
		logger: schedulerLoggerFromPino(logger),
		...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});
	if (schedulerConfig.disabled) {
		logger.info({}, "scheduler disabled via WARREN_SCHEDULER_DISABLED");
	} else {
		logger.info(
			{ tickMs: schedulerConfig.tickMs, sdBinary: schedulerConfig.sdBinary },
			"scheduler running",
		);
	}

	// Preview TTL + LRU eviction worker (R-19 / SPEC §11.L, warren-ea6b).
	// Same sqlite-only gate as the port allocator: postgres deploys skip the
	// worker until the repo layer becomes dialect-aware (pl-f17e follow-up).
	const previewEvictionWorker =
		db.dialect === "sqlite"
			? startPreviewEvictionWorker({
					db,
					repos,
					burrowClientPool,
					warrenConfigs,
					config: previewEvictionConfig,
					logger: previewEvictionLoggerFromPino(logger),
					...(opts.now !== undefined ? { now: opts.now } : {}),
				})
			: null;
	if (previewEvictionWorker !== null) {
		if (previewEvictionConfig.disabled) {
			logger.info({}, "preview eviction disabled via WARREN_PREVIEW_EVICTION_DISABLED");
		} else {
			logger.info(
				{
					tickMs: previewEvictionConfig.tickMs,
					idleTtlMs: previewEvictionConfig.idleTtlMs,
					maxLifetimeMs: previewEvictionConfig.maxLifetimeMs,
					maxLive: previewEvictionConfig.maxLive,
				},
				"preview eviction worker running",
			);
		}
	}

	// Preview signed-cookie auth (R-19 / SPEC §11.L, warren-8a10). Both
	// surfaces (login handshake + proxy preamble) need the same secret;
	// derive from `WARREN_API_TOKEN` so a fresh-install operator doesn't
	// have a second token to manage. Disabled when `WARREN_PREVIEW_HOST`
	// is unset (no operator opt-in) or when warren booted with
	// `--no-auth` (no token to derive from).
	const previewAuth: PreviewAuth | undefined =
		previewLaunchConfig.host !== null && serverConfig.token !== null
			? createPreviewAuth(serverConfig.token, { cookieDomain: `.${previewLaunchConfig.host}` })
			: undefined;
	const previewHostForDeps =
		previewLaunchConfig.host !== null ? previewLaunchConfig.host : undefined;

	const deps: ServerDeps = {
		repos,
		db,
		burrowClientPool,
		broker,
		bridges: bridgesBoot.registry,
		...(canopyConfig !== null ? { canopyConfig } : {}),
		projectsConfig,
		logger,
		uiDistDir: serverConfig.uiDistDir,
		spawn: defaultSpawn,
		autoOpenPr,
		warrenConfigs,
		...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
		previewPortRange,
		previewMaxLive: previewEvictionConfig.maxLive,
		...(previewHostForDeps !== undefined ? { previewHost: previewHostForDeps } : {}),
		...(previewAuth !== undefined ? { previewAuth } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	};

	const auth: AuthProvider =
		serverConfig.token !== null ? resolveAuth({ token: serverConfig.token }) : NO_AUTH;

	const previewProxy =
		previewAuth !== undefined && previewLaunchConfig.host !== null
			? createPreviewProxyHandler({
					repos,
					previewAuth,
					config: { host: previewLaunchConfig.host },
					...(opts.now !== undefined ? { now: opts.now } : {}),
				})
			: undefined;
	if (previewLaunchConfig.host !== null && previewAuth === undefined) {
		logger.warn(
			{ host: previewLaunchConfig.host },
			"WARREN_PREVIEW_HOST is set but --no-auth disables the signed-cookie surface; preview proxy off",
		);
	}

	const handle = startServer(deps, {
		transport: serverConfig.transport,
		auth,
		logger,
		...(previewProxy !== undefined ? { previewProxy } : {}),
	});

	logger.info({ url: handle.url }, "warren server listening");

	return {
		transport: handle.transport,
		url: handle.url,
		stop: async () => {
			logger.info({}, "warren server stopping");
			// Stop the HTTP listener first so no new POSTs land mid-teardown,
			// then drain the scheduler so any in-flight tick finishes calling
			// spawnRun before bridges/burrow/db disappear under it.
			await handle.stop();
			await scheduler.stop();
			if (previewEvictionWorker !== null) await previewEvictionWorker.stop();
			await workerProbe.stop();
			await bridgesBoot.registry.stopAll();
			await burrowClientPool.close();
			await closeDatabase(db);
		},
	};
}

function probeLoggerFromPino(logger: Logger): {
	info(obj: object, msg?: string): void;
	warn(obj: object, msg?: string): void;
	error(obj: object, msg?: string): void;
	debug?(obj: object, msg?: string): void;
} {
	return {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
		debug: (obj, msg) => logger.debug?.(obj, msg),
	};
}

/**
 * Production `Bun.spawn` adaptor matching the SpawnFn shape the
 * registry/projects modules and the Phase-13 `/readyz` probes consume.
 * Identical to the CLI's `defaultSpawn` (output.ts) and the local
 * `defaultSpawn` in handlers.ts; the duplication is deliberate so
 * neither surface imports the other.
 */
const defaultSpawn: SpawnFn = async (
	cmd: readonly string[],
	opts: SpawnOptions,
): Promise<SpawnResult> => {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer =
		opts.timeoutMs !== undefined && opts.timeoutMs > 0
			? setTimeout(() => proc.kill(), opts.timeoutMs)
			: null;
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (timer !== null) clearTimeout(timer);
	return { stdout, stderr, exitCode: exitCode ?? 0 };
};

async function closeDatabase(db: AnyWarrenDb): Promise<void> {
	try {
		await db.close();
	} catch {
		// Closing twice during a panicked shutdown is fine.
	}
}

/**
 * Repo layer is sqlite-only today (R-13 pl-f17e: pg widening lands in a
 * later step alongside the test substrate and scenario 19). The boot
 * path opens the URL-driven db but explicitly refuses pg until the
 * repos can speak both dialects — fail-fast with a clear error rather
 * than letting a `.run()` call on a pg drizzle handle throw deep in a
 * request.
 */
function createReposForDialect(db: AnyWarrenDb): ReturnType<typeof createRepos> {
	if (db.dialect !== "sqlite") {
		throw new Error(
			`WARREN_DB_URL selected the '${db.dialect}' dialect, but the repo layer is sqlite-only today. ` +
				"Postgres boot lands with pl-f17e step 7 (warren-480a) — keep WARREN_DB_URL unset (or sqlite://) until then.",
		);
	}
	return createRepos(db);
}

/**
 * Read `WARREN_DB_POOL_MAX` (pg pool max). Undefined / blank → use the
 * `openDatabase` default. The pool size only matters on the postgres
 * branch; the sqlite branch ignores it.
 */
function resolvePgPoolMax(env: EnvLike): number | undefined {
	const raw = env[WARREN_DB_POOL_MAX_ENV];
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(
			`${WARREN_DB_POOL_MAX_ENV} must be a positive integer (got ${JSON.stringify(raw)})`,
		);
	}
	return parsed;
}

/**
 * Strip the userinfo (`user:password@`) from a postgres URL before
 * logging. sqlite URLs and bare sentinels pass through unchanged.
 * Defensive: any URL-parse failure falls back to the dialect-and-scheme
 * shorthand so a malformed URL never leaks creds into the log.
 */
function redactDbUrl(url: string): string {
	const parsed = parseDatabaseUrl(url);
	if (parsed.dialect === "sqlite") return url;
	try {
		const u = new URL(parsed.connectionString);
		if (u.username !== "" || u.password !== "") {
			u.username = "";
			u.password = "";
			return u.toString();
		}
		return parsed.connectionString;
	} catch {
		return "postgres://<unparseable>";
	}
}

function bridgeLoggerFromPino(logger: Logger): {
	info?(obj: object, msg?: string): void;
	warn?(obj: object, msg?: string): void;
	error?(obj: object, msg?: string): void;
} {
	return {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
	};
}

function schedulerLoggerFromPino(logger: Logger): {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
} {
	return {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
	};
}

function previewEvictionLoggerFromPino(logger: Logger): {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
} {
	return {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
	};
}

/**
 * CLI entry. Allows `bun run src/server/main.ts` to act as the warren
 * serve binary the supervisor (Phase 12) execs. Catches startup errors,
 * formats them, and exits non-zero so docker/fly's restart policy
 * kicks in.
 */
if (import.meta.main) {
	bootServer().catch((err) => {
		const message = err instanceof Error ? err.message : String(err);
		// eslint-disable-next-line no-console
		console.error(`warren: ${message}`);
		process.exit(1);
	});
}
