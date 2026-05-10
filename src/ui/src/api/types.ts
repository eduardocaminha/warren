// Wire-side type mirrors. The server returns the `runs.RunRow`,
// `agents.AgentRow`, and `projects.ProjectRow` shapes from drizzle. We
// duplicate them here so the UI doesn't depend on `src/db/schema.ts`
// (root tsconfig excludes `src/ui` deliberately — the boundary is the
// HTTP wire, not a TS import).

export type RunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const RUN_TERMINAL_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled"];

/** Failure-cause discriminator for `state:failed` rows (warren-3c40, warren-5165). */
export type RunFailureReason =
	| "never_started"
	| "no_model_response"
	| "crashed"
	| "timed_out";

export interface AgentRow {
	name: string;
	renderedJson: unknown;
	registeredAt: string;
	lastRefreshed: string;
}

export interface ProjectRow {
	id: string;
	gitUrl: string;
	localPath: string;
	defaultBranch: string;
	addedAt: string;
	lastFetchedAt: string | null;
	lastHeadSha: string | null;
}

export interface RefreshProjectResponse {
	project: ProjectRow;
	headSha: string;
	ref: string;
}

export interface RunRow {
	id: string;
	agentName: string;
	/**
	 * Null when the project was deleted after the run was created
	 * (warren-5f19). The FK is `ON DELETE SET NULL`, so run history
	 * survives a project delete as orphan rows.
	 */
	projectId: string | null;
	burrowId: string | null;
	burrowRunId: string | null;
	renderedAgentJson: unknown;
	state: RunState;
	failureReason: RunFailureReason | null;
	startedAt: string | null;
	endedAt: string | null;
	prompt: string;
	trigger: string;
	/**
	 * URL of the PR reap opened (warren-f6af). Null when reap's `pr_open`
	 * sub-step was skipped (auto-open disabled, no commits, push failed,
	 * branch == defaultBranch) or the GitHub call errored.
	 */
	prUrl: string | null;
}

export interface BurrowSummary {
	id: string;
	workspacePath: string;
}

/**
 * Wire-side input for `POST /runs`. `ref` is an optional branch / tag /
 * SHA the project clone should be checked out at before the run; omit
 * (or pass empty) to use `project.defaultBranch` (warren-1bb6, warren-7589).
 */
export interface CreateRunInput {
	agent: string;
	project: string;
	prompt: string;
	ref?: string;
}

export interface SpawnRunResponse {
	run: RunRow;
	burrow: BurrowSummary;
}

export interface CancelRunResponse {
	state: RunState;
	alreadyTerminal: boolean;
	burrowRun: { state: string } | null;
}

export interface SteerRunResponse {
	message: unknown;
}

export interface RefreshAgentsResponse {
	clone: { localPath: string; head: string };
	registered: { name: string }[];
	skipped: { name: string; reason: string }[];
	removed: { name: string }[];
}

export interface ReadyCheckResult {
	name: string;
	ok: boolean;
	message?: string;
}

export interface ReadyzResponse {
	ok: boolean;
	checks: ReadyCheckResult[];
}

export interface RunEvent {
	id: number;
	runId: string;
	seq: number;
	ts: string;
	kind: string;
	stream: "stdout" | "stderr" | "system" | null;
	payload: unknown;
}

/**
 * Payload shape of the `reap.completed` system event (warren-f3bb,
 * warren-3c40). Fields are typed loosely because the wire is JSON; use
 * narrow guards before reading. `commitsAhead` is null when reap could
 * not compute the count (no `baseBranch`, rev-list failed, or push
 * failed); `0` is the silent-no-op shape (`branchPushed: true` but
 * agent never committed); positive means real work shipped.
 */
export interface ReapCompletedPayload {
	state?: RunState;
	failureReason?: RunFailureReason | null;
	branchPushed?: boolean;
	commitsAhead?: number | null;
	/** PR URL when reap auto-opened one (warren-f6af). */
	prUrl?: string | null;
	mulch?: { updated?: number; skipped?: number; appended?: number };
	seeds?: { closed?: number };
	errors?: { step: string; message: string; path?: string }[];
}

export interface ApiErrorEnvelope {
	error: { code: string; message: string; hint?: string };
}

/* ----------------------------------------------------------------------- */
/* Per-project `.warren/` config envelope (warren-435b, warren-756a).      */
/*                                                                         */
/* Mirrors src/warren-config/load.ts LoadedWarrenConfig — kept manually    */
/* in sync because src/ui/ is excluded from the root tsconfig and the     */
/* boundary is the HTTP wire, not a TS import (mx-1bd551).                 */
/* ----------------------------------------------------------------------- */

export type WarrenConfigFileErrorCode =
	| "warren_config_parse_error"
	| "warren_config_schema_error";

export interface WarrenConfigFileError {
	/** Project-relative path, e.g. `.warren/triggers.yaml`. */
	file: string;
	code: WarrenConfigFileErrorCode;
	message: string;
}

/**
 * Cron trigger entry. The `kind: 'cron'` discriminator leaves room for
 * future webhook-style triggers without a breaking schema rev (mx-3636de).
 */
export interface CronTrigger {
	id: string;
	kind: "cron";
	cron: string;
	seed: string;
	role: string;
	timezone?: string;
	prompt?: string;
}

export type Trigger = CronTrigger;

export interface DefaultsConfig {
	defaultRole?: string;
	defaultBranch?: string;
	defaultPrompt?: string;
}

export interface WarrenConfigResponse {
	/** Parsed triggers, or `null` when the file is absent or malformed. */
	triggers: Trigger[] | null;
	/** Parsed defaults, or `null` when the file is absent or malformed. */
	defaults: DefaultsConfig | null;
	/** Per-file failures collected during this load. Empty on full success. */
	errors: WarrenConfigFileError[];
}
