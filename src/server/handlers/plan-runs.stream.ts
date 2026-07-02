/**
 * `GET /plan-runs/:id/events` handler and its tail generator.
 *
 * Extracted from `plan-runs.ts` (warren-e0da) to keep both files under the
 * 500-line threshold. See `plan-runs.ts` for the POST/GET/cancel handlers.
 */

import { ndjsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { parseBoolean, requireParam } from "./index.ts";
import { asNdjsonStream, bridgeAbort, eventToNdjson } from "./runs/index.ts";

/**
 * `GET /plan-runs/:id/events` — NDJSON tail of the union of every child
 * run's events. Read-only: snapshots `events.listByRunIds(...)` first,
 * then subscribes to the broker for each child run. Live arrivals after
 * the snapshot are deduped by (runId, burrowEventSeq).
 *
 * `?follow=1` keeps the stream open until the client disconnects or the
 * plan-run reaches a terminal state. Default (no follow) returns the
 * snapshot then closes.
 */
export function streamPlanRunEventsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const planRun = await deps.repos.planRuns.require(id);
		const follow = parseBoolean(ctx.url.searchParams.get("follow"), "follow") ?? false;
		const ctrl = bridgeAbort(ctx.request.signal);

		const source = tailPlanRunEvents({
			planRun,
			repos: deps.repos,
			broker: deps.broker,
			follow,
			signal: ctrl.signal,
		});
		return ndjsonResponse(asNdjsonStream(source, (row) => eventToNdjson(row, null), ctrl));
	};
}

interface TailPlanRunEventsInput {
	readonly planRun: { id: string };
	readonly repos: ServerDeps["repos"];
	readonly broker: ServerDeps["broker"];
	readonly follow: boolean;
	readonly signal: AbortSignal;
}

type PlanRunEventRow = {
	id: number;
	runId: string;
	burrowEventSeq: number;
	ts: string;
	kind: string;
	stream: string | null;
	payloadJson: unknown;
};

/**
 * Tail the union of every plan-run child's events. History first (via
 * `events.listByRunIds`), then live arrivals from `broker.subscribe(runId)`
 * for each known child runId. Newly-dispatched children are picked up by a
 * polling watcher so a stream opened before child 2 lands still sees its
 * events without a reconnect.
 *
 * Live events are deduped by (runId, burrowEventSeq) against the high-water
 * mark established during history replay, so a row that lands in the gap
 * between snapshot and subscribe isn't either dropped or duplicated.
 */
async function* tailPlanRunEvents(
	input: TailPlanRunEventsInput,
): AsyncGenerator<PlanRunEventRow, void, void> {
	const seenSeq = new Map<string, number>();

	const initialChildren = await input.repos.planRuns.listChildren(input.planRun.id);
	const initialRunIds = initialChildren.map((c) => c.runId).filter((v): v is string => v !== null);
	const history = await input.repos.events.listByRunIds(initialRunIds);
	for (const row of history) {
		const prev = seenSeq.get(row.runId) ?? 0;
		if (row.burrowEventSeq > prev) seenSeq.set(row.runId, row.burrowEventSeq);
		yield row;
	}

	if (!input.follow) return;

	// Shared event queue fed by every per-child subscription pump.
	const queue: PlanRunEventRow[] = [];
	let waiter: (() => void) | null = null;
	const wake = (): void => {
		const fn = waiter;
		if (fn !== null) {
			waiter = null;
			fn();
		}
	};
	input.signal.addEventListener("abort", wake, { once: true });

	const subscribed = new Set<string>();
	const subscribe = (runId: string): void => {
		if (subscribed.has(runId)) return;
		subscribed.add(runId);
		const sub = input.broker.subscribe(runId, { signal: input.signal });
		void (async () => {
			try {
				for await (const row of sub) {
					queue.push(row as PlanRunEventRow);
					wake();
				}
			} catch {
				// broker.subscribe ends via signal abort or close — ignore.
			}
		})();
	};
	for (const runId of initialRunIds) subscribe(runId);

	const watcherIntervalMs = 2_000;
	const watcher = setInterval(() => {
		void (async () => {
			try {
				const fresh = await input.repos.planRuns.listChildren(input.planRun.id);
				for (const child of fresh) {
					if (child.runId !== null) subscribe(child.runId);
				}
			} catch {
				// Best-effort — a missed reload pings again next tick.
			}
		})();
	}, watcherIntervalMs);

	try {
		while (!input.signal.aborted) {
			const row = queue.shift();
			if (row === undefined) {
				await new Promise<void>((resolve) => {
					waiter = resolve;
				});
				continue;
			}
			const prev = seenSeq.get(row.runId) ?? 0;
			if (row.burrowEventSeq <= prev) continue;
			seenSeq.set(row.runId, row.burrowEventSeq);
			yield row;
		}
	} finally {
		clearInterval(watcher);
	}
}
