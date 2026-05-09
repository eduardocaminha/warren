/**
 * Bridge burrow's per-run event stream into warren's events table and
 * fan-out broker (SPEC §4.3 step 5, §9 "event durability rationale").
 *
 * The bridge is the only writer to `events` (rows always land via
 * `bridgeRunStream` → `EventsRepo.append`); the broker is published
 * to immediately after each row commits so live tailers see fresh
 * events without waiting on a polling interval.
 *
 * Resume semantics. Burrow's `runs.stream` always tails from the start
 * of the burrow's event history (the route doesn't accept `?since=`
 * for the run-scoped variant), so warren dedupes on the consumer side:
 * `EventsRepo.maxSeqForRun(runId)` gives the last seq we persisted, and
 * any incoming event whose `seq <= maxSeq` is dropped. This is the
 * "MAX(events.burrow_event_seq) + 1" recovery point in SPEC §4.3 — we
 * implement it client-side because the wire route doesn't.
 *
 * The bridge swallows transport-layer errors (BurrowUnreachableError
 * et al.) and just returns; it logs the failure if a logger was
 * supplied. The supervising layer (Phase 9 HTTP server, Phase 12
 * supervisor) is responsible for restart policy.
 *
 * State mirroring is intentionally limited to the queued → running
 * edge: as soon as the bridge sees its first event from burrow, it
 * atomically claims the warren row via `RunsRepo.claimById` so HTTP
 * clients polling `/runs/:id` stop seeing 'queued' while the agent is
 * actively working. Terminal transitions still belong to Phase 7
 * (reap); the bridge never finalizes a run.
 *
 * Terminal detection (warren-a69a). Burrow's run-stream is an infinite
 * poll on the events table — it never auto-closes when the burrow run
 * reaches a terminal state. Without an in-stream signal, the bridge
 * would keep polling forever and warren's run would stay 'running' even
 * after the agent exited. So the bridge inspects each persisted event
 * for a runtime-terminal shape (claude-code: `kind=state_change`,
 * `stream=system`, `payload.type=result`); on a match, it sets
 * `terminalDetected` on the result and breaks. The registry layer
 * (server/bridges.ts) reads `terminalDetected` and calls `reapRun` —
 * the bridge does not transition warren state itself (mx-fadaa2).
 *
 * Restart recovery. `recoverActiveRunStreams` walks the runs table for
 * rows in {queued, running} that already have a `burrow_run_id`, and
 * starts a bridge for each. It returns the in-flight bridges so the
 * caller can stop them on shutdown.
 */

import type { RunEvent } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../burrow-client/client.ts";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EventStream, RunTerminalState } from "../db/schema.ts";
import { EVENT_STREAMS } from "../db/schema.ts";
import type { RunEventBroker } from "./events.ts";

/**
 * Optional logger interface — pino-compatible subset, but typed loosely
 * so callers can pass any structured logger. We never construct one here.
 */
export interface BridgeLogger {
	info?(obj: object, msg?: string): void;
	warn?(obj: object, msg?: string): void;
	error?(obj: object, msg?: string): void;
}

export interface BridgeRunStreamInput {
	readonly runId: string;
	/** Burrow's run id (column `runs.burrow_run_id`). */
	readonly burrowRunId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly burrowClient: BurrowClient;
	readonly signal?: AbortSignal;
	/** Override the stream source (tests). Default: `client.http.runs.stream`. */
	readonly source?: (signal: AbortSignal) => AsyncIterable<RunEvent>;
	readonly logger?: BridgeLogger;
}

export interface BridgeRunStreamResult {
	/** Number of events written to the events table during the bridge run. */
	readonly written: number;
	/** Number of events skipped because their seq was at-or-below MAX(seq). */
	readonly skipped: number;
	/** True when the bridge ended because of an error (logged but not thrown). */
	readonly errored: boolean;
	/**
	 * Set when the bridge broke out of the poll loop because it observed a
	 * runtime-terminal event (warren-a69a). The registry layer uses this
	 * as the signal to call `reapRun` with the inferred outcome. Absent
	 * for bridges that ended via abort, error, or natural source close.
	 */
	readonly terminalDetected?: { readonly outcome: RunTerminalState };
}

/**
 * Pump events from burrow's `/runs/:id/stream` into the warren events
 * table and fan-out broker. Returns when the source iterator ends, the
 * signal aborts, or the source throws — whichever comes first.
 *
 * The function is async-iteration shaped (one pass, no resume after
 * return) — call it again from the supervisor if the bridge needs to
 * resume against a still-live burrow run.
 */
export async function bridgeRunStream(input: BridgeRunStreamInput): Promise<BridgeRunStreamResult> {
	const { runId, burrowRunId, repos, broker } = input;
	const ctrl = new AbortController();
	const onAbort = (): void => ctrl.abort();
	if (input.signal !== undefined) {
		if (input.signal.aborted) ctrl.abort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}

	const resumeSeq = repos.events.maxSeqForRun(runId) ?? 0;
	const source = input.source ?? defaultSource(input.burrowClient, burrowRunId);

	let written = 0;
	let skipped = 0;
	let errored = false;
	let claimed = false;
	let terminalDetected: { outcome: RunTerminalState } | undefined;

	try {
		for await (const event of source(ctrl.signal)) {
			if (ctrl.signal.aborted) break;
			if (!claimed) {
				const claimedRun = repos.runs.claimById(runId);
				if (claimedRun !== null) {
					input.logger?.info?.({ runId, burrowRunId }, "bridge transitioned run queued → running");
				}
				claimed = true;
			}
			if (event.seq <= resumeSeq) {
				skipped += 1;
				continue;
			}
			const row = repos.events.append({
				runId,
				burrowEventSeq: event.seq,
				ts: toIsoString(event.ts),
				kind: event.kind,
				stream: normalizeStream(event.stream),
				payload: event.payload,
			});
			written += 1;
			broker.publish(runId, row);

			const outcome = detectRuntimeTerminal(event);
			if (outcome !== null) {
				terminalDetected = { outcome };
				input.logger?.info?.(
					{ runId, burrowRunId, outcome, seq: event.seq },
					"bridge observed runtime-terminal event; reap will finalize",
				);
				break;
			}
		}
	} catch (err) {
		errored = true;
		input.logger?.error?.(
			{
				runId,
				burrowRunId,
				written,
				skipped,
				err: err instanceof Error ? err.message : String(err),
			},
			"run stream bridge errored",
		);
	} finally {
		if (input.signal !== undefined) input.signal.removeEventListener("abort", onAbort);
		ctrl.abort();
		broker.close(runId);
	}

	input.logger?.info?.(
		{ runId, burrowRunId, written, skipped, errored },
		"run stream bridge ended",
	);
	return terminalDetected !== undefined
		? { written, skipped, errored, terminalDetected }
		: { written, skipped, errored };
}

/**
 * Inspect a burrow event for a runtime-terminal shape (warren-a69a).
 * Returns the warren-side outcome to reap with, or `null` if the event
 * doesn't carry a terminal signal.
 *
 * The only runtime warren currently dispatches to is claude-code, which
 * emits a `result` envelope as its final stream-json line. burrow's
 * jsonl-claude parser surfaces that as `kind=state_change`,
 * `stream=system`, with `payload.type === "result"`. The `is_error`
 * field on that payload distinguishes a clean exit from a crash; we map
 * `is_error: true` → `failed`, anything else → `succeeded`. burrow's
 * own cancel path emits a different terminal shape; that case is
 * handled by `cancelRun` which already has the burrow run state in
 * hand, so the bridge doesn't need to detect it here.
 *
 * Future runtimes (sapling, etc.) extend this dispatch by adding their
 * runtime-specific terminal shape.
 */
function detectRuntimeTerminal(event: RunEvent): RunTerminalState | null {
	if (event.kind !== "state_change") return null;
	if (event.stream !== "system") return null;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return null;
	const env = payload as Record<string, unknown>;
	if (env.type !== "result") return null;
	return env.is_error === true ? "failed" : "succeeded";
}

/**
 * Default source factory: shells through the HttpClient. Wrapping in
 * `withTransportMapping` is moot here because the iterator yields
 * after the initial fetch returns — but the initial fetch can still
 * fail with a transport error, and we want that to surface as
 * `BurrowUnreachableError` for consistency with the spawn flow.
 */
function defaultSource(
	client: BurrowClient,
	burrowRunId: string,
): (signal: AbortSignal) => AsyncIterable<RunEvent> {
	return (signal) => {
		return {
			[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
				const inner = client.http.runs.stream(burrowRunId, { signal });
				return {
					next: () =>
						withTransportMapping(client.config, () => inner.next()) as Promise<
							IteratorResult<RunEvent>
						>,
					return: () => inner.return(undefined) as Promise<IteratorResult<RunEvent>>,
				};
			},
		};
	};
}

/**
 * Burrow's wire `stream` is `'stdout' | 'stderr' | 'system'`; warren's
 * column accepts the same enum but is nullable. Coerce unknown values
 * to null so a forward-compatible burrow can ship new stream tags
 * without crashing the bridge — the event still lands, just without a
 * stream tag.
 */
function normalizeStream(value: unknown): EventStream | null {
	if (typeof value !== "string") return null;
	return (EVENT_STREAMS as readonly string[]).includes(value) ? (value as EventStream) : null;
}

function toIsoString(ts: Date | string): string {
	return ts instanceof Date ? ts.toISOString() : ts;
}

export interface RecoverActiveRunStreamsInput {
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly burrowClient: BurrowClient;
	readonly logger?: BridgeLogger;
	/** Override the bridge factory (tests). Defaults to `bridgeRunStream`. */
	readonly bridge?: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
}

export interface ActiveBridge {
	readonly runId: string;
	readonly burrowRunId: string;
	readonly abort: AbortController;
	readonly done: Promise<BridgeRunStreamResult>;
}

export interface RecoverActiveRunStreamsResult {
	readonly bridges: readonly ActiveBridge[];
	readonly skipped: readonly { runId: string; reason: "no_burrow_run_id" }[];
}

/**
 * Walk the runs table for rows in {queued, running} that have a
 * `burrow_run_id` attached and start a bridge for each. Idempotent
 * across restarts; the resume seq filter means re-subscribing to a
 * run we already have full history for is harmless. Returns
 * controllers so the caller can `abort()` on shutdown.
 *
 * Runs in active states without a `burrow_run_id` are skipped — those
 * are partial spawns (a burrow was provisioned but `POST /runs`
 * never landed) which the spawn flow's rollback should already have
 * cancelled. Surfaced in `skipped` so the operator sees them.
 */
export function recoverActiveRunStreams(
	input: RecoverActiveRunStreamsInput,
): RecoverActiveRunStreamsResult {
	const { repos, broker, burrowClient, logger } = input;
	const bridge = input.bridge ?? bridgeRunStream;
	const candidates = repos.runs.listByState(["queued", "running"]);

	const bridges: ActiveBridge[] = [];
	const skipped: { runId: string; reason: "no_burrow_run_id" }[] = [];

	for (const run of candidates) {
		if (run.burrowRunId === null) {
			skipped.push({ runId: run.id, reason: "no_burrow_run_id" });
			logger?.warn?.(
				{ runId: run.id, state: run.state },
				"skipping recovery: run has no burrow_run_id",
			);
			continue;
		}
		const abort = new AbortController();
		const bridgeInput: BridgeRunStreamInput = {
			runId: run.id,
			burrowRunId: run.burrowRunId,
			repos,
			broker,
			burrowClient,
			signal: abort.signal,
			...(logger !== undefined ? { logger } : {}),
		};
		const done = bridge(bridgeInput);
		bridges.push({
			runId: run.id,
			burrowRunId: run.burrowRunId,
			abort,
			done,
		});
		logger?.info?.(
			{ runId: run.id, burrowRunId: run.burrowRunId, state: run.state },
			"resumed run stream bridge",
		);
	}

	return { bridges, skipped };
}
