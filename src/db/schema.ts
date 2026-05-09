/**
 * SQLite schema for warren's durable state (SPEC §9).
 *
 * Four tables: agents (canopy registry cache), projects (cloned repos), runs
 * (warren-side run rows that mirror burrow's lifecycle), events (write-through
 * cache of burrow's stream — see SPEC §9 "event durability rationale"). The
 * V2 schedules + webhook_secrets tables are intentionally not declared.
 *
 * Timestamps are ISO8601 TEXT, mirroring the burrow event envelope `ts` field
 * so we don't translate at the stream boundary. JSON columns use drizzle's
 * `mode: "json"` (stored as TEXT under the hood; drizzle (de)serializes).
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_TERMINAL_STATES = [
	"succeeded",
	"failed",
	"cancelled",
] as const satisfies readonly RunState[];
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number];

/**
 * Failure-cause discriminator for a `failed` run (warren-3c40). `state:failed`
 * alone can't tell "burrow accepted the dispatch but never started the run"
 * (config/runtime issue) from "agent ran and crashed". Reap infers this from
 * the warren state on entry: still `queued` ⇒ no events ever flowed from
 * burrow ⇒ `never_started`; `running` ⇒ bridge claimed it on a real event ⇒
 * `crashed`. `timed_out` is reserved for a future deadline-based reaper —
 * burrow doesn't currently report a separate timeout state.
 *
 * Null on succeeded/cancelled rows.
 */
export const RUN_FAILURE_REASONS = ["never_started", "crashed", "timed_out"] as const;
export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];

export const EVENT_STREAMS = ["stdout", "stderr", "system"] as const;
export type EventStream = (typeof EVENT_STREAMS)[number];

export const agents = sqliteTable("agents", {
	name: text("name").primaryKey(),
	renderedJson: text("rendered_json", { mode: "json" }).notNull(),
	registeredAt: text("registered_at").notNull(),
	lastRefreshed: text("last_refreshed").notNull(),
});

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		gitUrl: text("git_url").notNull(),
		localPath: text("local_path").notNull(),
		defaultBranch: text("default_branch").notNull(),
		addedAt: text("added_at").notNull(),
		lastFetchedAt: text("last_fetched_at"),
		lastHeadSha: text("last_head_sha"),
	},
	(t) => [index("projects_git_url_idx").on(t.gitUrl)],
);

export const runs = sqliteTable(
	"runs",
	{
		id: text("id").primaryKey(),
		agentName: text("agent_name")
			.notNull()
			.references(() => agents.name),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id),
		burrowId: text("burrow_id"),
		burrowRunId: text("burrow_run_id"),
		renderedAgentJson: text("rendered_agent_json", { mode: "json" }).notNull(),
		state: text("state", { enum: RUN_STATES }).notNull(),
		failureReason: text("failure_reason", { enum: RUN_FAILURE_REASONS }),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		prompt: text("prompt").notNull(),
		trigger: text("trigger").notNull(),
	},
	(t) => [
		index("runs_state_idx").on(t.state),
		index("runs_project_started_idx").on(t.projectId, sql`${t.startedAt} DESC`),
		index("runs_agent_started_idx").on(t.agentName, sql`${t.startedAt} DESC`),
	],
);

export const events = sqliteTable(
	"events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		runId: text("run_id")
			.notNull()
			.references(() => runs.id),
		burrowEventSeq: integer("burrow_event_seq").notNull(),
		ts: text("ts").notNull(),
		kind: text("kind").notNull(),
		stream: text("stream", { enum: EVENT_STREAMS }),
		payloadJson: text("payload_json", { mode: "json" }).notNull(),
	},
	(t) => [
		index("events_run_seq_idx").on(t.runId, t.burrowEventSeq),
		index("events_run_ts_idx").on(t.runId, t.ts),
	],
);

export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type RunInsert = typeof runs.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
