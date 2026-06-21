/**
 * Concurrency gate for claude-code runs (warren-82a1).
 *
 * Reads `WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS` (default 2) to cap the
 * number of simultaneously queued+running claude-code runs. When the cap
 * is reached, `spawnRun` creates the run row in `queued` state but skips
 * burrow provisioning — the run holds a slot so the in-flight count stays
 * accurate, and this module's tick (`bootConcurrencyGateTick`) picks
 * pending runs up and provisions/dispatches them as slots open.
 *
 * Only the `claude-code` agent is gated; other agents (sapling, etc.) are
 * unaffected. The gate is intentionally simple: it counts total in-flight
 * claude-code runs globally (not per-project or per-worker). The goal is
 * to reduce the chance of hitting Anthropic's per-key rate limit, which
 * is also global.
 *
 * Config:
 *   WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS  integer ≥ 1, default 2.
 *                                           Set to 0 or leave unset for
 *                                           the default. Set to a large
 *                                           number to effectively disable
 *                                           the gate.
 */

import type { Burrow, Run as BurrowRun, HttpWorkspaceFile } from "@os-eco/burrow-cli";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import { readRuntimeId } from "../registry/schema.ts";
import type { BridgeRegistry } from "../server/types.ts";
import { composeRunBranch, resolveRunBranchPrefix } from "./branch.ts";
import { parseBurrowConfig } from "./burrow-config.ts";
import { buildSeedFiles } from "./seed.ts";
import { readCachedAgent } from "./spawn/agent-cache.ts";

/** The only agent name for which this gate applies. */
export const GATED_AGENT_NAME = "claude-code";

const ENV_KEY = "WARREN_MAX_CONCURRENT_CLAUDE_CODE_RUNS";
const DEFAULT_MAX = 2;
/** Minimum interval between gate ticks (ms). */
export const DEFAULT_GATE_TICK_MS = 5_000;

/** Returns true if the given agent name is subject to the concurrency gate. */
export function isGatedAgent(agentName: string): boolean {
	return agentName === GATED_AGENT_NAME;
}

/**
 * Read the concurrency cap from the environment.
 * Falls back to DEFAULT_MAX (2) for any non-positive or non-integer value.
 */
export function loadMaxConcurrentClaudeRuns(
	env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
	const raw = env[ENV_KEY];
	if (raw === undefined || raw === "") return DEFAULT_MAX;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX;
	return parsed;
}

/**
 * Count currently in-flight (queued + running) claude-code runs.
 * Pending gated runs (queued, burrow_id=null) are included — they hold a slot.
 */
export async function countActiveClaudeRuns(repos: Pick<Repos, "runs">): Promise<number> {
	return repos.runs.countInflightForAgent(GATED_AGENT_NAME);
}

/**
 * Returns true when adding another claude-code run would exceed the cap.
 * Callers should create a pending run row and return early instead of
 * provisioning a burrow.
 */
export async function isGateClosed(
	repos: Pick<Repos, "runs">,
	maxConcurrent: number,
): Promise<boolean> {
	const active = await countActiveClaudeRuns(repos);
	return active >= maxConcurrent;
}

// ---------------------------------------------------------------------------
// Gate tick: dispatch pending gated runs when slots open
// ---------------------------------------------------------------------------

export interface ConcurrencyGateTickDeps {
	readonly repos: Repos;
	readonly burrowClientPool: BurrowClientPool;
	readonly bridges: BridgeRegistry;
	/** Override the run-branch prefix default. */
	readonly runBranchPrefixDefault?: string;
	readonly now?: () => Date;
}

export interface ConcurrencyGateTickLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface GateTickResult {
	readonly dispatched: readonly string[];
	readonly errors: readonly { readonly runId: string; readonly reason: string }[];
}

/**
 * One pass of the concurrency gate tick. Looks for pending gated runs
 * (queued, no burrow) and dispatches them as slots open.
 *
 * Up to `maxConcurrent - active` runs are dispatched per tick so we
 * never overshoot the cap even if multiple pending runs exist.
 */
export async function runConcurrencyGateTick(
	deps: ConcurrencyGateTickDeps,
	opts: {
		maxConcurrent?: number;
		logger?: ConcurrencyGateTickLogger;
	} = {},
): Promise<GateTickResult> {
	const maxConcurrent = opts.maxConcurrent ?? loadMaxConcurrentClaudeRuns();
	const dispatched: string[] = [];
	const errors: { runId: string; reason: string }[] = [];

	const pending = await deps.repos.runs.listPendingDispatch(GATED_AGENT_NAME);
	if (pending.length === 0) return { dispatched, errors };

	// Pending runs (queued+no-burrow) are already counted in `active` but don't
	// consume a real slot yet — subtract them to get the truly-dispatched count.
	const active = await countActiveClaudeRuns(deps.repos);
	const reallyActive = active - pending.length;
	const available = maxConcurrent - reallyActive;
	if (available <= 0) return { dispatched, errors };

	const toDispatch = pending.slice(0, available);
	for (const run of toDispatch) {
		try {
			await dispatchPendingRun(deps, run, opts.logger);
			dispatched.push(run.id);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			errors.push({ runId: run.id, reason });
			opts.logger?.error({ runId: run.id, err: reason }, "concurrency gate: dispatch failed");
		}
	}
	return { dispatched, errors };
}

/**
 * Dispatch a pending run (queued, burrowId=null) by provisioning a burrow
 * and dispatching the run to it. Mirrors the second half of `spawnRun`.
 */
async function dispatchPendingRun(
	deps: ConcurrencyGateTickDeps,
	run: RunRow,
	logger?: ConcurrencyGateTickLogger,
): Promise<void> {
	if (run.projectId === null) {
		throw new Error(`pending run ${run.id} has no project (deleted?)`);
	}
	const project = await deps.repos.projects.require(run.projectId);

	const agentDef = readCachedAgent(
		run.renderedAgentJson as Parameters<typeof readCachedAgent>[0],
		run.agentName,
	);
	const burrowConfig = parseBurrowConfig(agentDef.sections.burrow_config);
	const seedResult = buildSeedFiles(agentDef);

	const placement = await deps.burrowClientPool.placeFor({ projectId: project.id });
	await deps.repos.runs.attachBurrow(run.id, { workerId: placement.workerName });

	const branch = composeRunBranch(
		resolveRunBranchPrefix({ envDefault: deps.runBranchPrefixDefault }),
		run.id,
	);

	let burrow: Burrow | null = null;
	try {
		burrow = await withTransportMapping(placement.client.config, () =>
			placement.client.burrowsUp({
				projectRoot: project.localPath,
				originUrl: project.gitUrl,
				agents: [readRuntimeId(agentDef)],
				branch,
				...(burrowConfig.network !== undefined ? { network: burrowConfig.network } : {}),
				...(seedResult.files.length > 0
					? { seed: { files: seedResult.files as HttpWorkspaceFile[] } }
					: {}),
				env: {},
			}),
		);
		const bur = burrow; // capture as const so closures below can narrow without !
		await deps.repos.burrows.create({
			id: bur.id,
			workerId: placement.workerName,
			...(deps.now !== undefined ? { now: deps.now() } : {}),
		});
		await deps.repos.runs.attachBurrow(run.id, { burrowId: bur.id });

		const burrowRun: BurrowRun = await withTransportMapping(placement.client.config, () =>
			placement.client.http.runs.create({
				burrowId: bur.id,
				agentId: readRuntimeId(agentDef),
				prompt: run.prompt,
			}),
		);
		await deps.repos.runs.attachBurrow(run.id, { burrowRunId: burrowRun.id });
		deps.bridges.start(run.id, burrowRun.id, bur.id);
		logger?.info({ runId: run.id, burrowId: bur.id }, "concurrency gate: dispatched pending run");
	} catch (err) {
		// Best-effort burrow cleanup on failure.
		if (burrow !== null) {
			const burId = burrow.id;
			try {
				await withTransportMapping(placement.client.config, () =>
					placement.client.http.burrows.destroy(burId, { archive: false }),
				);
			} catch {
				// ignore cleanup error — the original error is the one to surface
			}
		}
		throw err;
	}
}

export interface ConcurrencyGateHandle {
	stop(): void;
}

/**
 * Boot the concurrency gate tick on a recurring interval.
 * Single-flight: if a tick is still running when the next fires, the
 * new tick is skipped (same pattern as `bootScheduler`).
 */
export function bootConcurrencyGateTick(
	deps: ConcurrencyGateTickDeps,
	opts: {
		tickMs?: number;
		maxConcurrent?: number;
		logger?: ConcurrencyGateTickLogger;
		disabled?: boolean;
	} = {},
): ConcurrencyGateHandle {
	if (opts.disabled) return { stop: () => {} };

	const tickMs = opts.tickMs ?? DEFAULT_GATE_TICK_MS;
	let inFlight = false;

	const timer = setInterval(async () => {
		if (inFlight) return;
		inFlight = true;
		try {
			await runConcurrencyGateTick(deps, {
				maxConcurrent: opts.maxConcurrent,
				logger: opts.logger,
			});
		} catch (err) {
			opts.logger?.error({ err: String(err) }, "concurrency gate tick error");
		} finally {
			inFlight = false;
		}
	}, tickMs);

	return { stop: () => clearInterval(timer) };
}
