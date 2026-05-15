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

/**
 * Preview environment lifecycle (R-19 / SPEC §11.L). Null on rows whose
 * project hasn't opted into previews; non-null once reap's
 * `preview_launch` sub-step has fired. See `src/db/schema/columns.ts`.
 */
export type PreviewState = "starting" | "live" | "failed" | "torn-down";

export const PREVIEW_ACTIVE_STATES: readonly PreviewState[] = ["starting", "live"];

export interface AgentRow {
	name: string;
	renderedJson: unknown;
	registeredAt: string;
	lastRefreshed: string;
	/** Provenance decorated by the server (warren-f6ad / readAgentSource). */
	source?: "builtin" | "library";
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
	/**
	 * Per-run cost in USD (warren-a7dc). Currently populated only for runs
	 * dispatched against the `pi` runtime — the bridge snapshots
	 * `get_session_stats` at run-start + run-end and persists the delta.
	 * Null for non-pi runtimes and for pi runs whose stats RPC failed.
	 */
	costUsd: number | null;
	/** Input tokens consumed (warren-a7dc); see `costUsd` for nullability. */
	tokensInput: number | null;
	/** Output tokens produced (warren-a7dc); see `costUsd` for nullability. */
	tokensOutput: number | null;
	/** Cache-read tokens (warren-a7dc); see `costUsd` for nullability. */
	tokensCacheRead: number | null;
	/** Cache-write tokens (warren-a7dc); see `costUsd` for nullability. */
	tokensCacheWrite: number | null;
	/**
	 * Per-run preview environment columns (R-19 / SPEC §11.L). All null on
	 * runs whose project hasn't opted into previews; populated by reap's
	 * `preview_launch` sub-step, the readiness probe, the host reverse
	 * proxy (`previewLastHitAt`), and the eviction worker / manual
	 * teardown route.
	 */
	previewState: PreviewState | null;
	previewPort: number | null;
	previewStartedAt: string | null;
	previewLastHitAt: string | null;
	previewFailureMessage: string | null;
}

/**
 * Wire envelope of `POST /runs/:id/preview/teardown` (R-19 / SPEC §11.L,
 * warren-d725). The handler is idempotent and always 200s with a CAS-
 * outcome discriminator: `tornDown: true` only when the call flipped a
 * `starting`/`live` row.
 */
export type PreviewTeardownStatus =
	| "torn-down"
	| "already-torn-down"
	| "already-failed"
	| "never-launched";

export interface PreviewTeardownResponse {
	status: PreviewTeardownStatus;
	tornDown: boolean;
	previousState: PreviewState | null;
	port: number | null;
}

export interface BurrowSummary {
	id: string;
	workspacePath: string;
}

/**
 * Wire-side input for `POST /runs`. `ref` is an optional branch / tag /
 * SHA the project clone should be checked out at before the run; omit
 * (or pass empty) to use `project.defaultBranch` (warren-1bb6, warren-7589).
 *
 * `providerOverride` / `modelOverride` are optional per-run overrides of
 * the agent's `frontmatter.provider` / `frontmatter.model`. Empty strings
 * are ignored. Runtimes that don't understand these fields (e.g.
 * claude-code) drop them silently; pi-style multi-provider runtimes map
 * them onto provider/model CLI flags.
 */
export interface CreateRunInput {
	agent: string;
	project: string;
	prompt: string;
	ref?: string;
	providerOverride?: string;
	modelOverride?: string;
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

/**
 * Wire envelope of `GET /preview/config` (R-19 / SPEC §11.L path addendum,
 * warren-016d). Deployment-wide preview routing mode + optional host. The
 * UI uses this to render the canonical preview URL in `PreviewCard` so
 * path-mode and subdomain-mode deploys both show a copyable string that
 * matches where the login handshake will redirect.
 *
 * `host === null` in path mode without `WARREN_PREVIEW_HOST` set; the UI
 * falls back to `window.location.origin` (previews ride on the same
 * hostname that serves the API/UI). Subdomain mode always carries `host`
 * because boot rejects that combo when the env var is unset.
 */
export type PreviewMode = "path" | "subdomain";

export interface PreviewConfigResponse {
	mode: PreviewMode;
	host: string | null;
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
	| "warren_config_schema_error"
	| "warren_config_deprecated";

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
	/**
	 * warren-618b: per-project default provider/model. Applied at spawn time
	 * with precedence operator override > project default > agent frontmatter.
	 * The NewRun page surfaces these as the provider/model auto-fill when no
	 * per-run override is typed.
	 */
	defaultProvider?: string;
	defaultModel?: string;
	/**
	 * warren-9993: per-project run-branch prefix override. Warren composes
	 * the burrow workspace branch as `${prefix}/${run.id}`; this field is
	 * surfaced read-only on the ProjectDetail config panel so operators can
	 * verify which prefix is in effect.
	 */
	runBranchPrefix?: string;
}

export interface WarrenConfigResponse {
	/** Parsed triggers, or `null` when the file is absent or malformed. */
	triggers: Trigger[] | null;
	/** Parsed defaults, or `null` when the file is absent or malformed. */
	defaults: DefaultsConfig | null;
	/** Per-file failures collected during this load. Empty on full success. */
	errors: WarrenConfigFileError[];
	/**
	 * Non-fatal advisories (warren-5840) — e.g. `defaults.json` deprecation.
	 * Surfaced separately from `errors` so the UI / doctor can render them
	 * as informational instead of failures.
	 */
	warnings: WarrenConfigFileError[];
}

/* ----------------------------------------------------------------------- */
/* Trigger summaries — `GET /projects/:id/triggers` (warren-99c3).         */
/*                                                                         */
/* Joins parsed .warren/triggers.yaml entries with the warren-side         */
/* triggers table state (lastFiredAt, nextFireAt, lastRunId) and a fresh   */
/* croner re-parse so the wire envelope reflects the current expression    */
/* even when the persisted row is stale (mx-a93eb5). `parseError` is       */
/* non-null when croner's strict parse rejects an expression that warren-  */
/* config's loose 5/6-token check accepted.                                */
/* ----------------------------------------------------------------------- */

export interface TriggerSummary {
	id: string;
	kind: "cron";
	cron: string;
	seed: string;
	role: string;
	timezone?: string;
	prompt?: string;
	lastFiredAt: string | null;
	nextFireAt: string | null;
	lastRunId: string | null;
	parseError: string | null;
}

export interface TriggersResponse {
	triggers: TriggerSummary[];
	errors: WarrenConfigFileError[];
}

/**
 * `POST /projects/:id/triggers/:triggerId/run` returns the spawned run row
 * plus the burrow summary — same envelope as `POST /runs` (mx-f3b48d).
 */
export interface RunTriggerResponse {
	run: RunRow;
	burrow: BurrowSummary;
}
