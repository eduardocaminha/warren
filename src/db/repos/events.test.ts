import { describe, expect, test } from "bun:test";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { EventsRepo } from "./events.ts";
import { ProjectsRepo } from "./projects.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`EventsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const events = new EventsRepo(adapter);
			await agents.upsert({ name: "refactor-bot", renderedJson: {} });
			const project = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			// RunsRepo is not yet on the adapter (pl-f1be step 5), so seed the
			// FK target row directly through the adapter to keep this test
			// dialect-polymorphic.
			const runId = generateId("run");
			const db = adapter.drizzle as SqliteDrizzleDb;
			await adapter.runWrite(
				db.insert(adapter.schema.runs).values({
					id: runId,
					agentName: "refactor-bot",
					projectId: project.id,
					renderedAgentJson: {},
					state: "queued",
					prompt: "x",
					trigger: "manual",
				}),
			);
			return { handle, events, runId };
		};

		function append(
			events: EventsRepo,
			runId: string,
			seq: number,
			kind = "text",
			stream: "stdout" | "stderr" | "system" = "stdout",
		) {
			return events.append({
				runId,
				burrowEventSeq: seq,
				ts: new Date(2026, 4, 8, 12, 0, seq).toISOString(),
				kind,
				stream,
				payload: { seq },
			});
		}

		test("append returns the inserted row with an autoincrement id and parsed payload", async () => {
			const { handle, events, runId } = await open();
			try {
				const row = await append(events, runId, 1);
				expect(row.id).toBeGreaterThan(0);
				expect(row.runId).toBe(runId);
				expect(row.burrowEventSeq).toBe(1);
				expect(row.payloadJson).toEqual({ seq: 1 });
			} finally {
				await handle.close();
			}
		});

		test("listByRun returns events ordered by burrow_event_seq", async () => {
			const { handle, events, runId } = await open();
			try {
				await append(events, runId, 3);
				await append(events, runId, 1);
				await append(events, runId, 2);
				const got = (await events.listByRun(runId)).map((e) => e.burrowEventSeq);
				expect(got).toEqual([1, 2, 3]);
			} finally {
				await handle.close();
			}
		});

		test("listByRun({ sinceSeq }) excludes events at or below the cursor", async () => {
			const { handle, events, runId } = await open();
			try {
				await append(events, runId, 1);
				await append(events, runId, 2);
				await append(events, runId, 3);
				const got = (await events.listByRun(runId, { sinceSeq: 1 })).map((e) => e.burrowEventSeq);
				expect(got).toEqual([2, 3]);
			} finally {
				await handle.close();
			}
		});

		test("listByRun({ limit }) caps the page size", async () => {
			const { handle, events, runId } = await open();
			try {
				for (let i = 1; i <= 10; i++) await append(events, runId, i);
				expect((await events.listByRun(runId, { limit: 3 })).map((e) => e.burrowEventSeq)).toEqual([
					1, 2, 3,
				]);
			} finally {
				await handle.close();
			}
		});

		test("listTail returns the last N in seq-ascending order", async () => {
			const { handle, events, runId } = await open();
			try {
				for (let i = 1; i <= 5; i++) await append(events, runId, i);
				expect((await events.listTail(runId, 2)).map((e) => e.burrowEventSeq)).toEqual([4, 5]);
			} finally {
				await handle.close();
			}
		});

		test("listTail with limit <= 0 returns []", async () => {
			const { handle, events, runId } = await open();
			try {
				await append(events, runId, 1);
				expect(await events.listTail(runId, 0)).toEqual([]);
				expect(await events.listTail(runId, -1)).toEqual([]);
			} finally {
				await handle.close();
			}
		});

		test("maxSeqForRun returns null when no events exist, else the max seq", async () => {
			const { handle, events, runId } = await open();
			try {
				expect(await events.maxSeqForRun(runId)).toBeNull();
				await append(events, runId, 1);
				await append(events, runId, 7);
				await append(events, runId, 3);
				expect(await events.maxSeqForRun(runId)).toBe(7);
			} finally {
				await handle.close();
			}
		});

		test("countByRun reports the row count", async () => {
			const { handle, events, runId } = await open();
			try {
				expect(await events.countByRun(runId)).toBe(0);
				await append(events, runId, 1);
				await append(events, runId, 2);
				expect(await events.countByRun(runId)).toBe(2);
			} finally {
				await handle.close();
			}
		});

		test("nullable stream column round-trips as null", async () => {
			const { handle, events, runId } = await open();
			try {
				const row = await events.append({
					runId,
					burrowEventSeq: 1,
					ts: "2026-05-08T12:00:00.000Z",
					kind: "system",
					payload: {},
				});
				expect(row.stream).toBeNull();
			} finally {
				await handle.close();
			}
		});
	});
}

suite("sqlite");
if (isPostgresTestEnabled()) {
	suite("postgres");
}
