/**
 * Live registry of `bridgeRunStream` controllers.
 *
 * The HTTP server boots, walks the runs table for (queued|running) rows
 * that have a `burrow_run_id`, and attaches a bridge to each — that's
 * the §9 "MAX(events.burrow_event_seq)+1 on warren restart" recovery.
 * Every subsequent `POST /runs` registers a new bridge for the spawned
 * run via `start()`. On shutdown, `stopAll()` aborts everyone in one
 * pass and awaits the drain so the events table stays consistent with
 * the burrow stream cursor.
 *
 * Idempotent against double-start: registering a runId that already has
 * an in-flight bridge is a no-op. That keeps recovery safe to re-run
 * (e.g. supervisor restart that races with a still-being-recorded
 * `POST /runs`).
 *
 * Reconnect on transport errors. `bridgeRunStream` is a single-pass
 * courier — when burrow's stream connection drops mid-run (e.g. the
 * burrow server's 10s `idleTimeout` kills a quiet GET /runs/:id/stream
 * → ECONNRESET in warren, see warren-b8fc + burrow-3d45) it returns
 * `errored: true` and the run keeps emitting events into burrow that
 * warren never sees. The registry wraps the bridge in a backoff loop
 * that re-invokes it until the run reaches a terminal state in warren's
 * DB (the reaper's territory, mx-fadaa2) or the registry is aborted.
 * Each reconnect re-reads `MAX(events.burrow_event_seq)` so the seq
 * dedupe in `bridgeRunStream` keeps the events table consistent.
 *
 * The registry stays small (one entry per active run); resolved bridges
 * remove themselves automatically so a long-lived server doesn't grow
 * unbounded. Tests inject a stub bridge factory to avoid a real burrow.
 */

import type { BurrowClient } from "../burrow-client/client.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunState } from "../db/schema.ts";
import {
	type BridgeLogger,
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	bridgeRunStream,
	type ReapRunInput,
	type ReapRunResult,
	type RunEventBroker,
	reapRun,
} from "../runs/index.ts";
import type { BridgeRegistry } from "./types.ts";

interface BridgeEntry {
	readonly burrowRunId: string;
	readonly abort: AbortController;
	readonly done: Promise<BridgeRunStreamResult>;
}

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(["succeeded", "failed", "cancelled"]);

/** Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s cap. */
export const DEFAULT_RECONNECT_BACKOFF_MS: readonly number[] = [
	1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];

export interface CreateBridgeRegistryInput {
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly burrowClient: BurrowClient;
	readonly logger?: BridgeLogger;
	/**
	 * Override the per-run bridge factory (tests). Defaults to the live
	 * `bridgeRunStream` from `../runs/`.
	 */
	readonly bridge?: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
	/**
	 * Override reap (tests). Defaults to the live `reapRun`. Fired when
	 * the bridge returns `terminalDetected` (warren-a69a) so the warren
	 * row finalizes without depending on an external reap scheduler.
	 */
	readonly reap?: (input: ReapRunInput) => Promise<ReapRunResult>;
	/**
	 * Backoff schedule (ms) for reconnecting after `errored: true`. Index
	 * `min(attempt, schedule.length-1)`. Tests pass `[0]` to disable
	 * sleep; production uses `DEFAULT_RECONNECT_BACKOFF_MS`.
	 */
	readonly reconnectBackoffMs?: readonly number[];
	/** Override the sleep primitive (tests). Default: `setTimeout`-based. */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function createBridgeRegistry(input: CreateBridgeRegistryInput): BridgeRegistry {
	const live = new Map<string, BridgeEntry>();
	const bridge = input.bridge ?? bridgeRunStream;
	const reap = input.reap ?? reapRun;
	const backoff = input.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
	const sleep = input.sleep ?? defaultSleep;

	function start(runId: string, burrowRunId: string): void {
		if (live.has(runId)) return;
		const abort = new AbortController();
		const done = runWithReconnect({
			runId,
			burrowRunId,
			repos: input.repos,
			broker: input.broker,
			burrowClient: input.burrowClient,
			signal: abort.signal,
			bridge,
			reap,
			backoff,
			sleep,
			...(input.logger !== undefined ? { logger: input.logger } : {}),
		});
		const entry: BridgeEntry = { burrowRunId, abort, done };
		live.set(runId, entry);
		void done.finally(() => {
			if (live.get(runId) === entry) live.delete(runId);
		});
	}

	async function stopAll(): Promise<void> {
		const entries = [...live.values()];
		for (const entry of entries) entry.abort.abort();
		await Promise.allSettled(entries.map((e) => e.done));
		live.clear();
	}

	return {
		start,
		stopAll,
		size: () => live.size,
	};
}

interface RunWithReconnectInput {
	readonly runId: string;
	readonly burrowRunId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly burrowClient: BurrowClient;
	readonly signal: AbortSignal;
	readonly bridge: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
	readonly reap: (input: ReapRunInput) => Promise<ReapRunResult>;
	readonly backoff: readonly number[];
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly logger?: BridgeLogger;
}

/**
 * Run `bridgeRunStream` in a loop, reconnecting on `errored: true`
 * with exponential backoff until the run is terminal in warren's DB,
 * the bridge ends naturally (`errored: false` ⇒ burrow closed the
 * stream because the run completed), or the registry aborts.
 */
async function runWithReconnect(input: RunWithReconnectInput): Promise<BridgeRunStreamResult> {
	let totalWritten = 0;
	let totalSkipped = 0;
	let attempt = 0;
	while (true) {
		const bridgeInput: BridgeRunStreamInput = {
			runId: input.runId,
			burrowRunId: input.burrowRunId,
			repos: input.repos,
			broker: input.broker,
			burrowClient: input.burrowClient,
			signal: input.signal,
			...(input.logger !== undefined ? { logger: input.logger } : {}),
		};
		const result = await input.bridge(bridgeInput);
		totalWritten += result.written;
		totalSkipped += result.skipped;

		if (result.terminalDetected !== undefined) {
			// warren-a69a: bridge observed a runtime-terminal event. Reap
			// inline so the warren row finalizes without depending on an
			// external scheduler. reap is idempotent + best-effort, so
			// errors land as `reap.completed`/`reap_failed` events on the
			// run rather than escaping back up the registry.
			try {
				await input.reap({
					runId: input.runId,
					outcome: result.terminalDetected.outcome,
					repos: input.repos,
					burrowClient: input.burrowClient,
					broker: input.broker,
					...(input.logger !== undefined ? { logger: input.logger } : {}),
				});
			} catch (err) {
				input.logger?.error?.(
					{
						runId: input.runId,
						burrowRunId: input.burrowRunId,
						err: err instanceof Error ? err.message : String(err),
					},
					"reap threw out of bridge terminal-detect path",
				);
			}
			return { written: totalWritten, skipped: totalSkipped, errored: result.errored };
		}

		if (input.signal.aborted) {
			return { written: totalWritten, skipped: totalSkipped, errored: result.errored };
		}
		if (!result.errored) {
			return { written: totalWritten, skipped: totalSkipped, errored: false };
		}

		// errored=true: the source iterator threw before burrow signalled
		// run-completion. If warren has already finalized the run (reaper
		// won the race), stop — there's nothing left to courier. Else
		// back off and reconnect.
		const row = input.repos.runs.get(input.runId);
		if (row === null || TERMINAL_RUN_STATES.has(row.state)) {
			input.logger?.info?.(
				{ runId: input.runId, burrowRunId: input.burrowRunId, state: row?.state ?? "unknown" },
				"bridge reconnect stopped: run is terminal",
			);
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}

		const delayMs = input.backoff[Math.min(attempt, input.backoff.length - 1)] ?? 0;
		attempt += 1;
		input.logger?.warn?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				attempt,
				delayMs,
				totalWritten,
				totalSkipped,
			},
			"bridge errored — reconnecting after backoff",
		);
		try {
			await input.sleep(delayMs, input.signal);
		} catch {
			// AbortError — signal fired during sleep. Bail out cleanly.
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}
		if (input.signal.aborted) {
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}
	}
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
		};
		if (signal.aborted) {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export interface BootBridgesResult {
	readonly registry: BridgeRegistry;
	readonly resumed: readonly { runId: string; burrowRunId: string }[];
	readonly skipped: readonly { runId: string; reason: string }[];
}

/**
 * Build a registry and prime it with bridges for every active run that
 * has a `burrow_run_id`. Active rows missing one are skipped — those
 * are partial spawns the spawn-rollback path should already have
 * cancelled. Surface them in `skipped` so the operator sees the count.
 */
export function bootBridges(input: CreateBridgeRegistryInput): BootBridgesResult {
	const registry = createBridgeRegistry(input);
	const candidates = input.repos.runs.listByState(["queued", "running"]);
	const resumed: { runId: string; burrowRunId: string }[] = [];
	const skipped: { runId: string; reason: string }[] = [];

	for (const run of candidates) {
		if (run.burrowRunId === null) {
			skipped.push({ runId: run.id, reason: "no_burrow_run_id" });
			input.logger?.warn?.(
				{ runId: run.id, state: run.state },
				"skipping recovery: run has no burrow_run_id",
			);
			continue;
		}
		registry.start(run.id, run.burrowRunId);
		resumed.push({ runId: run.id, burrowRunId: run.burrowRunId });
		input.logger?.info?.(
			{ runId: run.id, burrowRunId: run.burrowRunId, state: run.state },
			"resumed run stream bridge",
		);
	}

	return { registry, resumed, skipped };
}
