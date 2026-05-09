// Wire-side type mirrors. The server returns the `runs.RunRow`,
// `agents.AgentRow`, and `projects.ProjectRow` shapes from drizzle. We
// duplicate them here so the UI doesn't depend on `src/db/schema.ts`
// (root tsconfig excludes `src/ui` deliberately — the boundary is the
// HTTP wire, not a TS import).

export type RunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const RUN_TERMINAL_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled"];

/** Failure-cause discriminator for `state:failed` rows (warren-3c40). */
export type RunFailureReason = "never_started" | "crashed" | "timed_out";

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
	projectId: string;
	burrowId: string | null;
	burrowRunId: string | null;
	renderedAgentJson: unknown;
	state: RunState;
	failureReason: RunFailureReason | null;
	startedAt: string | null;
	endedAt: string | null;
	prompt: string;
	trigger: string;
}

export interface BurrowSummary {
	id: string;
	workspacePath: string;
}

export interface SpawnRunResponse {
	run: RunRow;
	burrow: BurrowSummary;
}

export interface CancelRunResponse {
	state: RunState;
	alreadyTerminal: boolean;
	burrowRun: unknown;
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

export interface ApiErrorEnvelope {
	error: { code: string; message: string; hint?: string };
}
