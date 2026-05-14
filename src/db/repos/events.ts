/**
 * Repository for the `events` table.
 *
 * Warren's events table is a write-through cache of burrow's stream (SPEC
 * §9). Each row carries the burrow-side `seq` so we can resume the stream
 * at MAX(burrow_event_seq) + 1 after a warren restart mid-run, and so the UI
 * replays events in the same order burrow emitted them.
 */

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { EventRow, EventStream } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export interface AppendEventInput {
	runId: string;
	burrowEventSeq: number;
	ts: string;
	kind: string;
	stream?: EventStream | null;
	payload: unknown;
}

export class EventsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get events() {
		return this.adapter.schema.events;
	}

	async append(input: AppendEventInput): Promise<EventRow> {
		return this.adapter.runReturningOne<EventRow>(
			this.db
				.insert(this.events)
				.values({
					runId: input.runId,
					burrowEventSeq: input.burrowEventSeq,
					ts: input.ts,
					kind: input.kind,
					stream: input.stream ?? null,
					payloadJson: input.payload,
				})
				.returning(),
		);
	}

	async listByRun(
		runId: string,
		opts: { sinceSeq?: number; limit?: number } = {},
	): Promise<EventRow[]> {
		const where =
			opts.sinceSeq !== undefined
				? and(eq(this.events.runId, runId), gt(this.events.burrowEventSeq, opts.sinceSeq))
				: eq(this.events.runId, runId);
		const q = this.db
			.select()
			.from(this.events)
			.where(where)
			.orderBy(asc(this.events.burrowEventSeq));
		return this.adapter.pickAll(opts.limit ? q.limit(opts.limit) : q);
	}

	/**
	 * Last N events for a run, returned in ascending seq order (oldest-first
	 * within the window). Powers the UI's "tail buffer" — `listByRun({limit})`
	 * returns the FIRST N which is the wrong end for live tail.
	 */
	async listTail(runId: string, limit: number): Promise<EventRow[]> {
		if (limit <= 0) return [];
		const rows = await this.adapter.pickAll(
			this.db
				.select()
				.from(this.events)
				.where(eq(this.events.runId, runId))
				.orderBy(desc(this.events.burrowEventSeq))
				.limit(limit),
		);
		return rows.reverse();
	}

	/**
	 * Highest burrow_event_seq we've persisted for a run, or null if none.
	 * Used at warren startup to compute the resume offset for live runs
	 * (SPEC §9 "MAX(events.burrow_event_seq) + 1").
	 */
	async maxSeqForRun(runId: string): Promise<number | null> {
		const row = await this.adapter.pickOne<{ max: number | null }>(
			this.db
				.select({ max: sql<number | null>`max(${this.events.burrowEventSeq})` })
				.from(this.events)
				.where(eq(this.events.runId, runId)),
		);
		const raw = row?.max ?? null;
		return raw === null ? null : Number(raw);
	}

	async countByRun(runId: string): Promise<number> {
		const row = await this.adapter.pickOne<{ n: number | string }>(
			this.db
				.select({ n: sql<number>`count(*)` })
				.from(this.events)
				.where(eq(this.events.runId, runId)),
		);
		return Number(row?.n ?? 0);
	}
}
