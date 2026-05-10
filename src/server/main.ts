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
import { BurrowClient } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos } from "../db/repos/index.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../projects/clone.ts";
import { loadProjectsConfigFromEnv } from "../projects/config.ts";
import { seedBuiltinAgents } from "../registry/builtins/index.ts";
import { loadCanopyRegistryConfigFromEnv } from "../registry/config.ts";
import { RunEventBroker } from "../runs/index.ts";
import { NO_AUTH, resolveAuth } from "./auth.ts";
import { bootBridges } from "./bridges.ts";
import { type EnvLike, loadServerConfigFromEnv } from "./config.ts";
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

	const db = await openDatabase({ path: serverConfig.dbPath });
	const repos = createRepos(db);
	const burrowClient = BurrowClient.fromEnv(env);
	const broker = new RunEventBroker();

	logger.info(
		{ dbPath: serverConfig.dbPath, transport: serverConfig.transport },
		"warren server starting",
	);

	// Seed built-in agents (warren-d3e9). Idempotent: existing rows
	// (whether seeded by an earlier boot or upserted by a refresh of a
	// same-named library agent) are preserved.
	const seedResult = seedBuiltinAgents(repos.agents, undefined, opts.now);
	if (seedResult.seeded.length > 0) {
		logger.info({ agents: seedResult.seeded }, "seeded built-in agents");
	}

	const bridgesBoot = bootBridges({
		repos,
		broker,
		burrowClient,
		logger: bridgeLoggerFromPino(logger),
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

	// Best-effort startup probe so the operator sees a clear error if
	// burrow is down at boot — but we don't refuse to start, since
	// /readyz reports the live state and a freshly-installed warren
	// often boots before burrow's socket lands.
	burrowClient.probe().catch((err) => {
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"burrow probe failed at boot — /readyz will reflect this",
		);
	});

	const deps: ServerDeps = {
		repos,
		burrowClient,
		broker,
		bridges: bridgesBoot.registry,
		...(canopyConfig !== null ? { canopyConfig } : {}),
		projectsConfig,
		logger,
		uiDistDir: serverConfig.uiDistDir,
		spawn: defaultSpawn,
		...(opts.now !== undefined ? { now: opts.now } : {}),
	};

	const auth: AuthProvider =
		serverConfig.token !== null ? resolveAuth({ token: serverConfig.token }) : NO_AUTH;

	const handle = startServer(deps, {
		transport: serverConfig.transport,
		auth,
		logger,
	});

	logger.info({ url: handle.url }, "warren server listening");

	return {
		transport: handle.transport,
		url: handle.url,
		stop: async () => {
			logger.info({}, "warren server stopping");
			await handle.stop();
			await bridgesBoot.registry.stopAll();
			await burrowClient.close();
			closeDatabase(db);
		},
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

function closeDatabase(db: WarrenDb): void {
	try {
		db.close();
	} catch {
		// Closing twice during a panicked shutdown is fine.
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
