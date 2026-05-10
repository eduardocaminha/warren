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
 * Failure-cause discriminator for a `failed` run (warren-3c40, warren-5165).
 * `state:failed` alone can't tell several different failure shapes apart.
 * Reap infers from the warren state on entry plus event content:
 *
 *   - still `queued` on entry ⇒ no events ever flowed from burrow ⇒
 *     `never_started` (config/runtime issue, e.g. under-specified prompt).
 *   - `running` on entry but events table holds no model-turn output
 *     (`text` / `thinking` / `tool_use` on stdout) ⇒ `no_model_response`
 *     (typically a credential/auth failure — the original warren-5165
 *     symptom was claude-code emitting an init system event then exiting
 *     with "Not logged in" before any assistant turn — but also covers
 *     rate-limit and provider-network failures).
 *   - `running` on entry with model output ⇒ `crashed` (agent ran and
 *     hit an unrecoverable error mid-conversation).
 *   - `timed_out` is reserved for a future deadline-based reaper — burrow
 *     doesn't currently report a separate timeout state.
 *
 * Null on succeeded/cancelled rows.
 */
export const RUN_FAILURE_REASONS = [
	"never_started",
	"no_model_response",
	"crashed",
	"timed_out",
] as const;
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
		// Nullable + ON DELETE SET NULL so deleting a project orphans its
		// runs instead of being blocked by the FK. The UI's delete-project
		// dialog promises 'Run history for this project is kept' (warren-5f19);
		// before this change, an FK constraint failure on delete combined
		// with the disk-first ordering in deleteProject left the project
		// row orphaned from its on-disk clone.
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		burrowId: text("burrow_id"),
		burrowRunId: text("burrow_run_id"),
		renderedAgentJson: text("rendered_agent_json", { mode: "json" }).notNull(),
		state: text("state", { enum: RUN_STATES }).notNull(),
		failureReason: text("failure_reason", { enum: RUN_FAILURE_REASONS }),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		prompt: text("prompt").notNull(),
		trigger: text("trigger").notNull(),
		// PR URL filled in by reap's pr_open sub-step (warren-f6af) when the
		// agent's branch push lands real commits and WARREN_AUTO_OPEN_PR is on.
		// Null encodes "no PR was opened" — auto-open disabled, push failed,
		// branch == defaultBranch, no commits ahead, or the GitHub call itself
		// errored (recorded as a `reap_failed` event with step=pr_open).
		prUrl: text("pr_url"),
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
