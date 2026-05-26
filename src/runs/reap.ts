/**
 * `reapRun` — SPEC §4.3 step 6 + §11.A.
 *
 * Once burrow says a run reached a terminal state, warren runs reap to
 * close out the run. Three best-effort sub-steps run in order:
 *
 *   1. Mulch merge — copy `.mulch/expertise/*.jsonl` from the burrow
 *      workspace back into the project's persistent `.mulch/`, with
 *      last-write-wins by record `recorded_at`. Same `id` + newer ts →
 *      overwrite (`mulch.record.updated`); same `id` + older-or-equal ts
 *      → drop (`mulch.record.skipped`); no `id` → append.
 *
 *   2. Seeds close mirror — read `.seeds/issues.jsonl` from the burrow
 *      workspace over the HTTP file surface
 *      (`burrowClient.http.files.read`, R-07). A 404/NotFoundError means
 *      the agent never created the file; treat as "nothing to mirror"
 *      and return 0. For any row in `closed` state whose `updatedAt` is
 *      newer than the project's row (or absent there entirely), mirror
 *      the row into the project's `.seeds/issues.jsonl` (still on disk —
 *      the project clone is warren-side). Emits `seeds.closed` events.
 *      Narrower than a full LWW merge — only closes propagate, matching
 *      the spec wording "close seeds the agent marked done". Other seed
 *      mutations ride on the workspace branch push below.
 *
 *   3. Branch push — `git -C <workspacePath> push origin HEAD` so the
 *      agent's commits (code, test edits, sd sync output, etc.) land on
 *      the project's remote. Branch name comes from burrow's record.
 *      After a successful push, reap counts commits ahead of `baseBranch`
 *      with `git rev-list --count <baseBranch>..HEAD` and surfaces it as
 *      `commitsAhead`. When the count is 0, an extra `reap.empty_push`
 *      event fires (warren-f3bb): the push command exit-0'd but landed
 *      no work — the silent twin of warren-67cc / warren-a69a where the
 *      agent never ran `git commit` (or its commit failed). `branchPushed`
 *      keeps its "push command exited zero" semantics; `commitsAhead`
 *      is the load-bearing observability field.
 *
 * Then warren's run row transitions to the burrow-observed outcome
 * (queued/running → succeeded|failed|cancelled). queued → succeeded is
 * not a legal direct transition (see RunsRepo's state machine), so
 * reap promotes queued → running first when the outcome is succeeded
 * or failed.
 *
 * Failure-cause discriminator (warren-3c40, warren-5165). When
 * `outcome === "failed"`, reap records *why* it failed in
 * `runs.failure_reason` and on the `reap.completed` event. Inputs to the
 * inference: state on entry plus the event log.
 *
 *   - `queued` on entry ⇒ no events ever flowed from burrow ⇒
 *     `never_started` (an under-specified agent prompt is the typical
 *     cause).
 *   - `running` on entry, no model-turn events ever observed
 *     (`kind=text|thinking|tool_use` on `stream=stdout`) ⇒
 *     `no_model_response`. Original warren-5165 symptom: claude-code
 *     emitted an init system event, then printed "Not logged in" and
 *     exited before any assistant turn. Generalizes to credential
 *     failures, rate-limit denials, and provider-network failures.
 *   - `running` on entry with model output ⇒ `crashed` (agent ran and
 *     hit an unrecoverable error mid-conversation).
 *
 * Callers may pass `failureReason` explicitly to override (e.g. a future
 * deadline-based reaper passing `timed_out`).
 *
 * Reap errors never fail the run — each sub-step is wrapped, and any
 * thrown error is recorded as a `reap_failed` event on the run with
 * the failing step name. The state transition still runs regardless,
 * so a reap failure cannot leave the warren row stuck in `running`.
 *
 * Idempotent: calling `reapRun` against a row already in a terminal
 * state is a no-op — useful for restart-recovery sweeps that re-issue
 * reap for runs that finalized in burrow while warren was offline.
 *
 * Every observable side effect (file IO, git push, system clock,
 * burrow client) is injectable so unit tests don't touch disk or shell.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { NotFoundError } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../burrow-client/client.ts";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EventRow, RunFailureReason, RunTerminalState } from "../db/schema.ts";
import { parseDurationMs } from "../preview/duration.ts";
import {
	formatPreviewUrl,
	type LaunchPreviewInput,
	type LaunchPreviewResult,
	launchPreview,
	type PreviewLaunchConfig,
} from "../preview/launch.ts";
import type { PreviewPortAllocator } from "../preview/port-allocator.ts";
import { parseGitHubUrl } from "../projects/url.ts";
import { readAutoPlanRunAgent } from "../registry/schema.ts";
import { DEFAULT_PREVIEW_MODE, type ServerPreviewConfig } from "../warren-config/index.ts";
import type { RunEventBroker } from "./events.ts";
import {
	type AutoOpenPrConfig,
	type BuildPrContentInput,
	buildPrContent,
	type OpenPullRequestInput,
	type OpenPullRequestResult,
	openPullRequest,
	type PrCommit,
	type PrSeed,
} from "./pr.ts";
import {
	type AnnotatePrPreviewInput,
	type AnnotatePrPreviewResult,
	annotatePrPreview,
} from "./pr-annotate.ts";
import type { PrTemplateOverrides } from "./pr-template.ts";
import type { BridgeLogger } from "./stream.ts";

const execFileAsync = promisify(execFile);

/* ----------------------------------------------------------------------- */
/* Public surface                                                           */
/* ----------------------------------------------------------------------- */

export interface ReapFs {
	readonly mkdirp: (path: string) => Promise<void>;
	/** Read a file as utf-8. Resolves to `null` if the file does not exist. */
	readonly readFile: (path: string) => Promise<string | null>;
	readonly writeFile: (path: string, contents: string) => Promise<void>;
	/** List filenames in a directory. Resolves to `[]` if the dir does not exist. */
	readonly readdir: (path: string) => Promise<readonly string[]>;
}

export interface ReapExec {
	/** Run a command; resolves on exit-0, rejects with an `Error` whose
	 * `message` carries stderr otherwise. Mirrors `child_process.execFile`. */
	readonly run: (
		cmd: string,
		args: readonly string[],
		opts: { cwd: string; timeoutMs?: number },
	) => Promise<{ stdout: string; stderr: string }>;
}

export interface ReapRunInput {
	readonly runId: string;
	/** The burrow-observed terminal state to transition the warren row into. */
	readonly outcome: RunTerminalState;
	readonly repos: Repos;
	/**
	 * Multi-worker burrow pool (warren-c0c9 / pl-9ba1 step 5). reap resolves
	 * the owning worker via `pool.clientFor({burrowId: run.burrowId})` for
	 * the workspace lookup + seeds-close mirror http calls. Propagates
	 * `StickyWorkerUnreachableError` (503 via src/server/errors.ts) when the
	 * pinned worker is `unreachable`.
	 */
	readonly burrowClientPool: BurrowClientPool;
	/** If supplied, every reap-emitted event is published here too. */
	readonly broker?: RunEventBroker;
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
	readonly now?: () => Date;
	readonly logger?: BridgeLogger;
	/**
	 * Override the inferred failure reason (warren-3c40, warren-5165). Reap
	 * normally infers from state-on-entry plus the event log: `queued` ⇒
	 * `never_started`, `running` with no assistant output ⇒
	 * `no_model_response`, `running` with assistant output ⇒ `crashed`.
	 * Pass an explicit value when a higher-level caller has better
	 * information (e.g. a deadline-based reaper passing `timed_out`).
	 * Ignored when `outcome !== "failed"`.
	 */
	readonly failureReason?: RunFailureReason;
	/**
	 * Auto-open-PR config (warren-f6af). When omitted or `enabled: false`,
	 * the `pr_open` sub-step is skipped entirely (no event emitted, no
	 * runs.pr_url update). Higher-level callers (HTTP server boot, CLI
	 * `warren run`) load this from env via `loadAutoOpenPrConfigFromEnv`
	 * and pass it through; tests pass `{ enabled: false, ... }` (or omit)
	 * to keep the network out of the unit-test surface.
	 */
	readonly autoOpenPr?: AutoOpenPrConfig;
	/**
	 * Override the PR-open seam (tests). Defaults to the live
	 * `openPullRequest`. Receives the same input shape as the production
	 * function so tests can assert call arguments.
	 */
	readonly openPr?: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
	/**
	 * Per-run preview environments (R-19 / SPEC §11.L, warren-f156). When
	 * the project has opted in via `.warren/defaults.json` and `outcome ===
	 * "succeeded"`, reap launches `preview.command` as a long-lived burrow
	 * sidecar in the same workspace (`preview_launch`) and — if `pr_open`
	 * produced a PR url — patches the live URL into the PR body
	 * (`pr_annotate_preview`). Both sub-steps are best-effort: failure
	 * emits `reap_failed` events with `step` ∈ {`preview_launch`,
	 * `pr_annotate_preview`} and never fails the run.
	 *
	 * Both `previewConfig` and `portAllocator` must be supplied together;
	 * omit `previewConfig` to skip the launch entirely (matching projects
	 * that haven't opted in). Tests typically omit; production wiring
	 * resolves the config from the per-project `.warren/defaults.json`
	 * loader and constructs one allocator per warren process.
	 */
	readonly previewConfig?: ServerPreviewConfig;
	readonly portAllocator?: PreviewPortAllocator;
	readonly previewLaunchConfig?: PreviewLaunchConfig;
	/**
	 * PR-body template overrides parsed from `.warren/pr-template.md`
	 * (warren-bd49). Threaded into `buildPrContent`'s named-fragment
	 * composer; missing-or-empty keeps the built-in defaults. Caller
	 * (bridges.ts / scheduler) loads this from the per-project warren
	 * config cache the same way it resolves `previewConfig`.
	 */
	readonly prTemplate?: PrTemplateOverrides;
	/**
	 * Override the preview-launch mechanics (tests). Defaults to
	 * `launchPreview`. Receives the resolved input shape, including the
	 * port allocator and the worker-local burrow client, so tests can
	 * assert call arguments without touching real sidecars.
	 */
	readonly launchPreview?: (input: LaunchPreviewInput) => Promise<LaunchPreviewResult>;
	/**
	 * Override the preview-annotation seam (tests). Defaults to
	 * `annotatePrPreview`.
	 */
	readonly annotatePrPreview?: (input: AnnotatePrPreviewInput) => Promise<AnnotatePrPreviewResult>;
}

export interface ReapStepError {
	readonly step: ReapStep;
	readonly message: string;
	readonly path?: string;
}

export type ReapStep =
	| "workspace_lookup"
	| "mulch_merge"
	| "seeds_close"
	| "seeds_commit"
	| "plot_merge"
	| "plot_commit"
	| "auto_plan_run"
	| "branch_push"
	| "pr_open"
	| "preview_launch"
	| "pr_annotate_preview";

export interface ReapRunResult {
	readonly state: RunTerminalState;
	/**
	 * Failure-cause discriminator (warren-3c40, warren-5165). Set only
	 * when `state === "failed"`; null on succeeded/cancelled. Distinguishes
	 * "burrow accepted dispatch but never started the run" (`never_started`)
	 * from "agent started but produced no model output before exiting"
	 * (`no_model_response`, typically credential/runtime failure) from
	 * "agent ran and crashed mid-conversation" (`crashed`) — all three
	 * shared an observable shape before this field existed.
	 */
	readonly failureReason: RunFailureReason | null;
	readonly mulchUpdated: number;
	readonly mulchSkipped: number;
	readonly mulchAppended: number;
	readonly seedsClosed: number;
	readonly seedsCreated: number;
	/**
	 * Plot event log lines appended to the project's `.plot/plot-*.events.jsonl`
	 * files after merging the burrow workspace's deltas (warren-7e0f /
	 * pl-2047 step 6). Idempotent re-runs report 0 — the merge dedups by
	 * full-line content so a second sweep over the same workspace adds
	 * nothing.
	 */
	readonly plotEventsAppended: number;
	/**
	 * Distinct `plot-*.json` files overwritten in the project's `.plot/` from
	 * a newer workspace copy (warren-7e0f). Last-write-wins on `updated_at`
	 * mirrors the mulch-merge primitive; ties with different contents emit
	 * a `plot.conflict` event but leave the project copy untouched.
	 */
	readonly plotsUpdated: number;
	/**
	 * New agent-emitted `decision_made` / `question_posed` /
	 * `artifact_produced` events mirrored into warren's event stream tagged
	 * with `plot_id` (warren-7e0f). Idempotent — re-runs against an already
	 * merged workspace re-mirror nothing because the underlying file merge
	 * is content-dedup'd.
	 */
	readonly plotEventsMirrored: number;
	/**
	 * True when reap authored a `chore(warren): plot state` commit in the
	 * workspace before `branch_push` so origin's workspace branch carries
	 * the `.plot/` deltas (warren-343a, shape (a) commit-through-reap).
	 * Set when host-side appender writes in `<project>/.plot/` (or merge
	 * deltas from the burrow workspace) had not yet been committed by the
	 * agent — reap stages them and authors a warren-identity commit so
	 * the push isn't empty. False when nothing needed staging (agent had
	 * already committed everything, project has no `.plot/`, or the merge
	 * produced no on-disk delta) and false when the commit attempt failed
	 * (the failure surfaces as a `reap_failed` step=`plot_commit` event).
	 */
	readonly plotCommitted: boolean;
	/**
	 * True when reap authored a `chore(warren): seeds state` commit in the
	 * workspace before `branch_push` so origin's workspace branch carries
	 * the `.seeds/` deltas (warren-7ecc). Mirrors `plotCommitted` (warren-
	 * 343a, shape (a) commit-through-reap) but for the seeds tracker:
	 * agents with narrowly-scoped write contracts (the planner, see
	 * src/registry/builtins/planner.ts) are forbidden from running
	 * `git commit`, so `sd plan submit` writes to `.seeds/issues.jsonl` +
	 * `.seeds/plans.jsonl` and warren has to stage and commit them on the
	 * agent's behalf — otherwise the push lands empty and the plan is lost.
	 * Set when project has `.seeds/` and there's a real `.seeds/` delta the
	 * agent never committed. False when nothing needed staging or when the
	 * commit attempt failed (the failure surfaces as a `reap_failed`
	 * step=`seeds_commit` event).
	 */
	readonly seedsCommitted: boolean;
	readonly branchPushed: boolean;
	/**
	 * Commits the pushed branch is ahead of its base (warren-f3bb). `null`
	 * when the count couldn't be computed — burrow returned no `baseBranch`,
	 * `git rev-list` failed, or the push itself failed. `0` means the push
	 * landed no new work (silent no-op shape). Positive means real commits
	 * shipped. Distinguishes the `branchPushed: true, ahead_by: 0` shape
	 * (agent never committed) from the `branchPushed: true, ahead_by: N`
	 * shape (agent shipped real work) — the two are visually identical
	 * without this field.
	 */
	readonly commitsAhead: number | null;
	/**
	 * URL of the PR reap opened (warren-f6af). Null when the `pr_open`
	 * sub-step was skipped (auto-open disabled, missing token, push
	 * failed, branch == defaultBranch, no commits ahead) or when the
	 * GitHub call itself errored (errors append to `errors` instead).
	 */
	readonly prUrl: string | null;
	/**
	 * Terminal state of the preview launch (R-19 / SPEC §11.L,
	 * warren-f156). `null` when the sub-step was skipped (project didn't
	 * opt in, outcome !== succeeded, worker !== local, type !== server) —
	 * not when it failed. `live` / `failed` carry the matching
	 * `runs.preview_state` transition. The full failure tail lives on
	 * `runs.preview_failure_message`; reap surfaces only the lifecycle
	 * state here so callers can branch quickly.
	 */
	readonly previewState: "live" | "failed" | null;
	/**
	 * Allocated host port for a `live` or `failed` preview. Cleared when
	 * the launch was skipped or when the failure path released the port
	 * (port-exhausted, readiness timeout, sidecar exited early).
	 */
	readonly previewPort: number | null;
	/**
	 * URL the `pr_annotate_preview` sub-step patched into the PR body
	 * (`https://run-<id>.<host>`). Null when annotation was skipped (no
	 * PR opened, `WARREN_PREVIEW_HOST` unset, or launch failed) or when
	 * the GitHub call itself errored (errors append to `errors`).
	 */
	readonly previewUrl: string | null;
	/**
	 * True when reap auto-dispatched a plan-run for a plan the agent created
	 * during this run (warren-a32a). Requires `auto_plan_run: true` in the
	 * agent's canopy frontmatter, `outcome === "succeeded"`, and at least one
	 * new plan detected in the workspace's `.seeds/plans.jsonl`.
	 */
	readonly autoPlanRunCreated: boolean;
	readonly autoPlanRunId: string | null;
	readonly autoPlanRunPlanId: string | null;
	readonly errors: readonly ReapStepError[];
	/** True when the row was already terminal on entry — sub-steps were skipped. */
	readonly alreadyTerminal: boolean;
}

/* ----------------------------------------------------------------------- */
/* Implementation                                                           */
/* ----------------------------------------------------------------------- */

export async function reapRun(input: ReapRunInput): Promise<ReapRunResult> {
	const fs = input.fs ?? defaultFs;
	const exec = input.exec ?? defaultExec;
	const now = input.now ?? (() => new Date());

	const run = await input.repos.runs.require(input.runId);
	if (isTerminal(run.state)) {
		input.logger?.info?.(
			{ runId: run.id, state: run.state },
			"reap skipped: run already in terminal state",
		);
		const idempotentPreviewState =
			run.previewState === "live" || run.previewState === "failed" ? run.previewState : null;
		return {
			state: run.state as RunTerminalState,
			failureReason: run.failureReason,
			mulchUpdated: 0,
			mulchSkipped: 0,
			mulchAppended: 0,
			seedsClosed: 0,
			seedsCreated: 0,
			plotEventsAppended: 0,
			plotsUpdated: 0,
			plotEventsMirrored: 0,
			plotCommitted: false,
			seedsCommitted: false,
			branchPushed: false,
			commitsAhead: null,
			prUrl: run.prUrl,
			previewState: idempotentPreviewState,
			previewPort: run.previewPort,
			previewUrl: null,
			autoPlanRunCreated: false,
			autoPlanRunId: null,
			autoPlanRunPlanId: null,
			errors: [],
			alreadyTerminal: true,
		};
	}

	// State on entry is the discriminator: still `queued` means the bridge
	// never claimed it (no events ever flowed from burrow), so this is a
	// "burrow never started the run" failure rather than a real crash.
	const stateOnEntry = run.state;

	// `run.projectId` is null when the project was deleted while the run
	// existed (warren-5f19): the FK is `ON DELETE SET NULL`, so the run
	// row survives the delete as an orphan. We can still finalize the
	// state (the events were already streamed), but the mulch-merge,
	// seeds-close, and branch-push sub-steps target the project clone on
	// disk, which is gone. Skip them and emit a single system event so
	// operators can see why reap was a no-op.
	const project = run.projectId !== null ? await input.repos.projects.get(run.projectId) : null;
	const seq = createSeqAllocator((await input.repos.events.maxSeqForRun(run.id)) ?? 0);
	const errors: ReapStepError[] = [];
	const emit = async (kind: string, payload: unknown): Promise<EventRow> => {
		const row = await input.repos.events.append({
			runId: run.id,
			burrowEventSeq: seq.next(),
			ts: now().toISOString(),
			kind,
			stream: "system",
			payload,
		});
		input.broker?.publish(run.id, row);
		return row;
	};
	const fail = async (step: ReapStep, err: unknown, path?: string): Promise<void> => {
		const message = err instanceof Error ? err.message : String(err);
		const stepError: ReapStepError =
			path !== undefined ? { step, message, path } : { step, message };
		errors.push(stepError);
		await emit("reap_failed", stepError);
		input.logger?.error?.({ runId: run.id, step, err: message, path }, "reap step failed");
	};

	let mulchUpdated = 0;
	let mulchSkipped = 0;
	let mulchAppended = 0;
	let seedsClosed = 0;
	let seedsCreated = 0;
	let plotEventsAppended = 0;
	let plotsUpdated = 0;
	let plotEventsMirrored = 0;
	let plotCommitted = false;
	let seedsCommitted = false;
	let branchPushed = false;
	let commitsAhead: number | null = null;
	let prUrl: string | null = null;
	let previewLaunchState: "live" | "failed" | null = null;
	let previewLaunchPort: number | null = null;
	let previewUrl: string | null = null;
	let autoPlanRunCreated = false;
	let autoPlanRunId: string | null = null;
	let autoPlanRunPlanId: string | null = null;

	let workspacePath: string | null = null;
	let branch: string | null = null;
	let workerClient: BurrowClient | null = null;
	if (run.burrowId === null) {
		await fail("workspace_lookup", new Error("run has no burrow_id; nothing to reap from"));
	} else {
		try {
			workerClient = (await input.burrowClientPool.clientFor({ burrowId: run.burrowId })).client;
			const burrow = await withTransportMapping(workerClient.config, () =>
				(workerClient as BurrowClient).http.burrows.get(run.burrowId as string),
			);
			workspacePath = burrow.workspacePath;
			branch = typeof burrow.branch === "string" && burrow.branch !== "" ? burrow.branch : null;
		} catch (err) {
			await fail("workspace_lookup", err);
		}
	}
	// Base branch for the empty-push count comes from the project row, not
	// burrow: burrow's `BurrowRow` does not expose `baseBranch` at the top
	// level (it's tucked into `providerStateJson`), and warren's projects
	// table already pins `defaultBranch` (notNull) at clone time. For V1
	// the primary flow always carves the workspace branch off
	// `project.defaultBranch`, so this is the correct reference for
	// `git rev-list --count <baseBranch>..HEAD`.
	const baseBranch: string | null = project?.defaultBranch ?? null;

	if (workspacePath !== null && project !== null) {
		try {
			const result = await mergeMulch(workspacePath, project.localPath, fs, emit, fail);
			mulchUpdated = result.updated;
			mulchSkipped = result.skipped;
			mulchAppended = result.appended;
		} catch (err) {
			await fail("mulch_merge", err);
		}

		try {
			// workerClient is set whenever workspacePath !== null (both land in
			// the same try-block above), so the cast is sound.
			const mirrorResult = await mirrorSeeds({
				burrowClient: workerClient as BurrowClient,
				burrowId: run.burrowId as string,
				projectPath: project.localPath,
				fs,
				emit,
			});
			seedsClosed = mirrorResult.closed;
			seedsCreated = mirrorResult.created;
		} catch (err) {
			await fail("seeds_close", err);
		}

		try {
			const result = await mergePlot(workspacePath, project.localPath, fs, emit, fail);
			plotEventsAppended = result.eventsAppended;
			plotsUpdated = result.plotsUpdated;
			plotEventsMirrored = result.mirrored;
		} catch (err) {
			await fail("plot_merge", err);
		}

		// warren-343a / shape (a) commit-through-reap: replicate the merged
		// `.plot/` from the project clone into the workspace and author a
		// `chore(warren): plot state` commit when there's a staged delta the
		// agent never committed. This is the carrier for host-side appender
		// writes (defaultPlotAppender, defaultPlanRunPlotAppender,
		// autoTransitionPlotToDone — see SPEC §11.O) and for any
		// agent-emitted `.plot/` lines that the agent left uncommitted.
		// Skipped when the project has no `.plot/`. Best-effort: failures
		// emit `reap_failed` step=`plot_commit` and do not fail the run.
		if (project.hasPlot) {
			try {
				plotCommitted = await stagePlotForCommit({
					workspacePath,
					projectPath: project.localPath,
					fs,
					exec,
					emit,
				});
			} catch (err) {
				await fail("plot_commit", err, join(workspacePath, ".plot"));
			}
		}

		// warren-7ecc: same commit-through-reap shape as plot_commit but for
		// `.seeds/`. Closes the planner-default-prompt bug: planner is
		// forbidden from running `git commit` (src/registry/builtins/planner.ts
		// system prompt), so its `sd plan submit` writes to
		// `.seeds/issues.jsonl` + `.seeds/plans.jsonl` and warren has to
		// stage and commit them on the agent's behalf — otherwise the push
		// lands empty (reap.empty_push fires) and the spawned plan is lost.
		// Skipped when the project has no `.seeds/`. Best-effort: failures
		// emit `reap_failed` step=`seeds_commit` and do not fail the run.

		// warren-a32a: snapshot the workspace's plans.jsonl BEFORE
		// stageSeedsForCommit (which copies project→workspace and may
		// overwrite the agent's version). The project baseline is read
		// alongside so the diff can identify agent-created plans.
		let workspacePlanIds: Set<string> | null = null;
		let baselinePlanIds: Set<string> | null = null;
		let workspacePlansBody: string | null = null;
		if (project.hasSeeds && input.outcome === "succeeded" && hasAutoPlanRunFrontmatter(run)) {
			try {
				const baselineBody =
					(await fs.readFile(join(project.localPath, ".seeds", "plans.jsonl"))) ?? "";
				baselinePlanIds = parsePlanIds(baselineBody);
				workspacePlansBody =
					(await fs.readFile(join(workspacePath, ".seeds", "plans.jsonl"))) ?? "";
				workspacePlanIds = parsePlanIds(workspacePlansBody);
			} catch {
				// Non-fatal — detection failure degrades to no auto-dispatch.
			}
		}

		if (project.hasSeeds) {
			try {
				seedsCommitted = await stageSeedsForCommit({
					workspacePath,
					projectPath: project.localPath,
					fs,
					exec,
					emit,
				});
			} catch (err) {
				await fail("seeds_commit", err, join(workspacePath, ".seeds"));
			}
		}

		// warren-a32a: auto-dispatch plan-runs for plans the agent created.
		if (
			workspacePlanIds !== null &&
			baselinePlanIds !== null &&
			workspacePlansBody !== null &&
			workspacePlanIds.size > baselinePlanIds.size
		) {
			const newPlanIds: string[] = [];
			for (const id of workspacePlanIds) {
				if (!baselinePlanIds.has(id)) newPlanIds.push(id);
			}
			for (const planId of newPlanIds) {
				try {
					const children = parsePlanChildren(workspacePlansBody, planId);
					if (children.length === 0) continue;
					const result = await input.repos.planRuns.create({
						planId,
						projectId: project.id,
						agentName: resolveAutoPlanRunAgent(run),
						children: children.map((seedId, i) => ({ seq: i + 1, seedId })),
						trigger: "auto_plan_run",
						ref: project.defaultBranch,
						...(run.plotId !== null ? { plotId: run.plotId } : {}),
					});
					autoPlanRunCreated = true;
					autoPlanRunId = result.planRun.id;
					autoPlanRunPlanId = planId;
					await emit("auto_plan_run_created", {
						planId,
						planRunId: result.planRun.id,
						childCount: children.length,
					});
				} catch (err) {
					await fail("auto_plan_run", err);
				}
			}
		}

		try {
			await exec.run("git", ["push", "origin", branch !== null ? `HEAD:${branch}` : "HEAD"], {
				cwd: workspacePath,
				timeoutMs: 60_000,
			});
			branchPushed = true;
		} catch (err) {
			await fail("branch_push", err, workspacePath);
		}

		// Empty-push observability (warren-f3bb): branchPushed alone can't
		// tell apart a real-work push from a no-op against an unchanged
		// HEAD (the agent never `git commit`-ed). Count commits ahead of
		// the project's defaultBranch; surface zero as `reap.empty_push`
		// and pin the count on `commitsAhead`. rev-list failures are
		// non-fatal — a missing base ref or transient git error degrades
		// to `commitsAhead: null` rather than failing the reap step.
		if (branchPushed && baseBranch !== null) {
			try {
				const out = await exec.run("git", ["rev-list", "--count", `${baseBranch}..HEAD`], {
					cwd: workspacePath,
					timeoutMs: 10_000,
				});
				const parsed = Number.parseInt(out.stdout.trim(), 10);
				commitsAhead = Number.isFinite(parsed) ? parsed : null;
			} catch (err) {
				input.logger?.info?.(
					{ runId: run.id, err: err instanceof Error ? err.message : String(err) },
					"reap commits-ahead count failed; continuing",
				);
			}
			if (commitsAhead === 0) {
				await emit("reap.empty_push", {
					branch,
					baseBranch,
					message:
						"git push exited zero but the branch landed no new commits — agent did not commit",
				});
			}
		}

		// Auto-open PR (warren-f6af). Best-effort: failures emit a
		// `reap_failed` step=pr_open event but do not fail the run. Skip
		// silently when:
		//   - autoOpenPr config is absent or disabled (operator opt-out),
		//   - outcome !== "succeeded" (conservative V1: don't spam draft
		//     PRs for crashed runs; gate revisited if needed),
		//   - branchPushed === false (nothing to PR),
		//   - commitsAhead is null or 0 (push landed no work),
		//   - branch is null or matches project.defaultBranch (push went
		//     straight to the default branch; PR would be empty),
		//   - GITHUB_TOKEN is unset (logged via reap_failed so operators
		//     see why; not a hard error).
		if (
			input.autoOpenPr?.enabled === true &&
			input.outcome === "succeeded" &&
			branchPushed &&
			commitsAhead !== null &&
			commitsAhead > 0 &&
			branch !== null &&
			branch !== project.defaultBranch
		) {
			try {
				const prContext = await gatherPrContext({
					workspacePath: workspacePath as string,
					projectPath: project.localPath,
					baseBranch: project.defaultBranch,
					prompt: run.prompt,
					exec,
				});
				const opened = await tryOpenPr({
					project,
					branch,
					autoOpen: input.autoOpenPr,
					run,
					prContext,
					previewOptedIn: input.previewConfig !== undefined,
					openPr: input.openPr ?? openPullRequest,
					...(input.prTemplate !== undefined ? { prTemplate: input.prTemplate } : {}),
				});
				if (opened.ok) {
					prUrl = opened.url;
					await input.repos.runs.setPrUrl(run.id, prUrl);
					await emit("reap.pr_opened", { prUrl, mode: opened.mode, branch, baseBranch });
				} else {
					await fail("pr_open", new Error(`${opened.reason}: ${opened.message}`));
				}
			} catch (err) {
				await fail("pr_open", err);
			}
		}

		// Preview launch (warren-f156 / SPEC §11.L, 5th best-effort sub-step).
		// Mirrors pr_open's pattern (mx-05abb2): runs only when `outcome ===
		// "succeeded"` and the project opted in via `.warren/defaults.json`,
		// never fails the run. Failure surfaces as `preview_state: failed`
		// with the stderr tail in `preview_failure_message`. The sub-step
		// requires the worker that hosts the burrow be `local` for V1 —
		// cross-host preview routing is the explicit R-12 deferral in §11.L.
		if (
			input.outcome === "succeeded" &&
			input.previewConfig !== undefined &&
			input.portAllocator !== undefined &&
			workerClient !== null &&
			run.burrowId !== null
		) {
			if (run.workerId !== null && run.workerId !== "local") {
				const message = `preview launch skipped: cross-host preview routing deferred to R-12 (run.worker_id='${run.workerId}')`;
				await fail("preview_launch", new Error(message));
				previewLaunchState = "failed";
				await input.repos.runs.attachPreview(run.id, {
					previewState: "failed",
					previewFailureMessage: message,
				});
			} else {
				try {
					// warren-0928: per-project override of the readiness probe
					// wall clock. The schema validated shape + bounds at load
					// time, so parseDurationMs is infallible here.
					const readinessTimeoutMs =
						input.previewConfig.readiness_timeout !== undefined
							? parseDurationMs(input.previewConfig.readiness_timeout)
							: undefined;
					// warren-d9e7: same plumb-through for the setup pre-step. The
					// launcher applies setupTimeoutMs only when previewConfig.setup
					// is also set, so projects without a setup command see the
					// existing single-sidecar path unchanged.
					const setupTimeoutMs =
						input.previewConfig.setup_timeout !== undefined
							? parseDurationMs(input.previewConfig.setup_timeout)
							: undefined;
					// warren-9b15: same plumb-through for the phase-1 connect budget.
					// Schema validated bounds at load time so parseDurationMs is
					// infallible here; omitting the key when the field is absent
					// preserves the existing single-phase budget for projects that
					// haven't opted in.
					const connectTimeoutMs =
						input.previewConfig.connect_timeout !== undefined
							? parseDurationMs(input.previewConfig.connect_timeout)
							: undefined;
					const result = await (input.launchPreview ?? launchPreview)({
						runId: run.id,
						burrowId: run.burrowId,
						previewConfig: input.previewConfig,
						repos: input.repos,
						allocator: input.portAllocator,
						sidecars: workerClient.http.sidecars,
						now,
						...(readinessTimeoutMs !== undefined ? { readinessTimeoutMs } : {}),
						...(setupTimeoutMs !== undefined ? { setupTimeoutMs } : {}),
						...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
					});
					if (result.ok) {
						previewLaunchState = "live";
						previewLaunchPort = result.port;
						await emit("preview_launched", {
							port: result.port,
							sidecarId: result.sidecarId,
						});
					} else {
						previewLaunchState = "failed";
						previewLaunchPort = result.port;
						await fail("preview_launch", new Error(`${result.reason}: ${result.message}`));
					}
				} catch (err) {
					previewLaunchState = "failed";
					await fail("preview_launch", err);
				}
			}
		}

		// PR-annotate preview (warren-f156 / SPEC §11.L, 6th best-effort sub-
		// step). Mirrors pr_open's pattern: idempotent PATCH on the PR body
		// replacing the `<!-- warren:preview-start -->…<!-- warren:preview-end -->`
		// fragment with the live URL or the failure tail. Skipped when no PR
		// was opened, when launch was skipped entirely (`previewLaunchState
		// === null`), or when the host suffix isn't configured (operator
		// hasn't wired `WARREN_PREVIEW_HOST` yet — the launch still ran so
		// state stays observable in the UI, but no URL exists to publish).
		const previewHost = input.previewLaunchConfig?.host ?? null;
		const previewMode = input.previewLaunchConfig?.mode ?? DEFAULT_PREVIEW_MODE;
		if (
			prUrl !== null &&
			previewLaunchState !== null &&
			input.autoOpenPr?.enabled === true &&
			input.autoOpenPr.token !== ""
		) {
			try {
				if (previewLaunchState === "live" && previewHost === null) {
					await fail(
						"pr_annotate_preview",
						new Error(
							"WARREN_PREVIEW_HOST unset; cannot patch preview URL into PR (launch state stays live)",
						),
					);
				} else {
					const failureTail =
						previewLaunchState === "failed"
							? ((await input.repos.runs.require(run.id)).previewFailureMessage ?? "")
							: "";
					const result = await (input.annotatePrPreview ?? annotatePrPreview)({
						prUrl,
						token: input.autoOpenPr.token,
						preview:
							previewLaunchState === "live"
								? {
										state: "live",
										url: formatPreviewUrl(run.id, previewHost as string, previewMode),
									}
								: { state: "failed", failureTail },
					});
					if (result.ok) {
						if (previewLaunchState === "live") {
							previewUrl = formatPreviewUrl(run.id, previewHost as string, previewMode);
						}
						await emit("preview_annotated", {
							prUrl,
							previewUrl,
							mode: result.mode,
							state: previewLaunchState,
						});
					} else {
						await fail("pr_annotate_preview", new Error(`${result.reason}: ${result.message}`));
					}
				}
			} catch (err) {
				await fail("pr_annotate_preview", err);
			}
		}
	} else if (workspacePath !== null && project === null) {
		await emit("reap.orphaned", {
			projectId: run.projectId,
			message: "project was deleted; skipping mulch merge, seeds close, and branch push",
		});
	}

	const failureReason: RunFailureReason | null =
		input.outcome === "failed"
			? (input.failureReason ?? (await inferFailureReason(input.repos, run.id, stateOnEntry)))
			: null;

	const finalState = await transitionToTerminal(
		input.repos,
		run.id,
		stateOnEntry,
		input.outcome,
		now(),
		failureReason,
	);

	await emit("reap.completed", {
		state: finalState,
		failureReason,
		mulch: { updated: mulchUpdated, skipped: mulchSkipped, appended: mulchAppended },
		seeds: { closed: seedsClosed, created: seedsCreated, committed: seedsCommitted },
		plot: {
			eventsAppended: plotEventsAppended,
			plotsUpdated,
			mirrored: plotEventsMirrored,
			committed: plotCommitted,
		},
		branchPushed,
		commitsAhead,
		prUrl,
		previewState: previewLaunchState,
		previewPort: previewLaunchPort,
		previewUrl,
		autoPlanRun: { created: autoPlanRunCreated, id: autoPlanRunId, planId: autoPlanRunPlanId },
		errors,
	});

	if (input.broker !== undefined) input.broker.close(run.id);

	input.logger?.info?.(
		{
			runId: run.id,
			state: finalState,
			failureReason,
			mulchUpdated,
			mulchSkipped,
			mulchAppended,
			seedsClosed,
			seedsCreated,
			seedsCommitted,
			plotEventsAppended,
			plotsUpdated,
			plotEventsMirrored,
			plotCommitted,
			branchPushed,
			commitsAhead,
			prUrl,
			previewState: previewLaunchState,
			previewPort: previewLaunchPort,
			previewUrl,
			autoPlanRunCreated,
			autoPlanRunId,
			errored: errors.length > 0,
		},
		"reap completed",
	);

	return {
		state: finalState,
		failureReason,
		mulchUpdated,
		mulchSkipped,
		mulchAppended,
		seedsClosed,
		seedsCreated,
		plotEventsAppended,
		plotsUpdated,
		plotEventsMirrored,
		plotCommitted,
		seedsCommitted,
		branchPushed,
		commitsAhead,
		prUrl,
		previewState: previewLaunchState,
		previewPort: previewLaunchPort,
		previewUrl,
		autoPlanRunCreated,
		autoPlanRunId,
		autoPlanRunPlanId,
		errors,
		alreadyTerminal: false,
	};
}

/* ----------------------------------------------------------------------- */
/* PR open (warren-f6af)                                                    */
/* ----------------------------------------------------------------------- */

interface TryOpenPrInput {
	readonly project: { gitUrl: string; defaultBranch: string };
	readonly branch: string;
	readonly autoOpen: AutoOpenPrConfig;
	readonly run: {
		id: string;
		agentName: string;
		prompt: string;
		startedAt: string | null;
		endedAt: string | null;
		costUsd: number | null;
		tokensInput: number | null;
		tokensOutput: number | null;
		tokensCacheRead: number | null;
	};
	readonly prContext: PrContext;
	readonly previewOptedIn: boolean;
	readonly openPr: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
	readonly prTemplate?: PrTemplateOverrides;
}

async function tryOpenPr(input: TryOpenPrInput): Promise<OpenPullRequestResult> {
	if (input.autoOpen.token === "") {
		return {
			ok: false,
			reason: "missing_token",
			message: "GITHUB_TOKEN unset; skipping auto-open PR",
		};
	}
	const parsed = parseGitHubUrl(input.project.gitUrl);
	const contentInput: BuildPrContentInput = {
		prompt: input.run.prompt,
		runId: input.run.id,
		agentName: input.run.agentName,
		commits: input.prContext.commits,
		diffStat: input.prContext.diffStat,
		previewOptedIn: input.previewOptedIn,
		...(input.autoOpen.warrenBaseUrl !== null
			? { warrenBaseUrl: input.autoOpen.warrenBaseUrl }
			: {}),
		...(input.prContext.seed !== null ? { seed: input.prContext.seed } : {}),
		...(input.run.startedAt !== null ? { startedAt: input.run.startedAt } : {}),
		...(input.run.endedAt !== null ? { endedAt: input.run.endedAt } : {}),
		...(input.run.costUsd !== null ? { costUsd: input.run.costUsd } : {}),
		...(input.run.tokensInput !== null ? { tokensInput: input.run.tokensInput } : {}),
		...(input.run.tokensOutput !== null ? { tokensOutput: input.run.tokensOutput } : {}),
		...(input.run.tokensCacheRead !== null ? { tokensCacheRead: input.run.tokensCacheRead } : {}),
		...(input.prTemplate !== undefined ? { templateOverrides: input.prTemplate } : {}),
	};
	const content = buildPrContent(contentInput);
	return input.openPr({
		owner: parsed.owner,
		repo: parsed.name,
		head: input.branch,
		base: input.project.defaultBranch,
		title: content.title,
		body: content.body,
		token: input.autoOpen.token,
	});
}

/* ----------------------------------------------------------------------- */
/* PR context gathering (warren-9ee3)                                       */
/* ----------------------------------------------------------------------- */

interface GatherPrContextInput {
	readonly workspacePath: string;
	readonly projectPath: string;
	readonly baseBranch: string;
	readonly prompt: string;
	readonly exec: ReapExec;
}

interface PrContext {
	readonly commits: readonly PrCommit[];
	readonly diffStat: string;
	readonly seed: PrSeed | null;
}

/**
 * Best-effort gathering of the data buildPrContent needs to fill in the
 * commits / files-changed / seeds sections. Each sub-call is wrapped: a
 * git error or missing `sd` CLI degrades to empty data rather than
 * failing the PR open.
 */
async function gatherPrContext(input: GatherPrContextInput): Promise<PrContext> {
	const [commits, diffStat, seed] = await Promise.all([
		collectCommits(input.workspacePath, input.baseBranch, input.exec),
		collectDiffStat(input.workspacePath, input.baseBranch, input.exec),
		resolveSeed(input.prompt, input.projectPath, input.exec),
	]);
	return { commits, diffStat, seed };
}

async function collectCommits(
	workspacePath: string,
	baseBranch: string,
	exec: ReapExec,
): Promise<PrCommit[]> {
	try {
		const out = await exec.run(
			"git",
			["log", "--reverse", "--pretty=format:%H %s", `${baseBranch}..HEAD`],
			{ cwd: workspacePath, timeoutMs: 10_000 },
		);
		const commits: PrCommit[] = [];
		for (const raw of out.stdout.split("\n")) {
			const line = raw.trimEnd();
			if (line === "") continue;
			const sp = line.indexOf(" ");
			if (sp === -1) continue;
			commits.push({ sha: line.slice(0, sp), subject: line.slice(sp + 1) });
		}
		return commits;
	} catch {
		return [];
	}
}

async function collectDiffStat(
	workspacePath: string,
	baseBranch: string,
	exec: ReapExec,
): Promise<string> {
	try {
		const out = await exec.run("git", ["diff", "--stat", `${baseBranch}..HEAD`], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		});
		return out.stdout;
	} catch {
		return "";
	}
}

// Matches seed ids like `warren-17a4`, `seeds-9ee3`, `mulch-cafe` — a
// lowercase prefix with optional internal dashes, followed by `-` and a
// 4+ char lowercase-hex suffix. Trailing hex suffix anchors the match;
// the prefix-with-dashes regex would otherwise eat ordinary words.
const SEED_ID_RE = /\b([a-z][a-z-]*-[a-f0-9]{4,})\b/;

async function resolveSeed(prompt: string, cwd: string, exec: ReapExec): Promise<PrSeed | null> {
	const m = SEED_ID_RE.exec(prompt);
	if (m === null) return null;
	const id = m[1];
	if (id === undefined) return null;
	try {
		const out = await exec.run("sd", ["show", id, "--format", "json"], {
			cwd,
			timeoutMs: 10_000,
		});
		const parsed: unknown = JSON.parse(out.stdout);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		const issue = obj.issue ?? obj;
		if (issue === null || typeof issue !== "object" || Array.isArray(issue)) return null;
		const title = (issue as Record<string, unknown>).title;
		if (typeof title !== "string" || title === "") return null;
		return { id, title };
	} catch {
		return null;
	}
}

/* ----------------------------------------------------------------------- */
/* Mulch merge (SPEC §11.A)                                                 */
/* ----------------------------------------------------------------------- */

interface MulchMergeResult {
	updated: number;
	skipped: number;
	appended: number;
}

interface MulchEntry {
	raw: string;
	id: string | null;
	recordedAt: string;
}

async function mergeMulch(
	workspacePath: string,
	projectPath: string,
	fs: ReapFs,
	emit: (kind: string, payload: unknown) => Promise<EventRow>,
	fail: (step: ReapStep, err: unknown, path?: string) => Promise<void>,
): Promise<MulchMergeResult> {
	const burrowDir = join(workspacePath, ".mulch", "expertise");
	const projectDir = join(projectPath, ".mulch", "expertise");
	const filenames = (await fs.readdir(burrowDir)).filter((n) => n.endsWith(".jsonl")).sort();

	let updated = 0;
	let skipped = 0;
	let appended = 0;

	for (const filename of filenames) {
		const domain = filename.slice(0, -".jsonl".length);
		const burrowPath = join(burrowDir, filename);
		const projectPath2 = join(projectDir, filename);
		try {
			const incoming = await fs.readFile(burrowPath);
			if (incoming === null) continue;
			const existing = (await fs.readFile(projectPath2)) ?? "";
			const result = await mergeMulchFile(domain, existing, incoming, emit);
			if (result.changed) {
				await fs.mkdirp(dirname(projectPath2));
				await fs.writeFile(projectPath2, result.merged);
			}
			updated += result.updated;
			skipped += result.skipped;
			appended += result.appended;
		} catch (err) {
			await fail("mulch_merge", err, burrowPath);
		}
	}

	return { updated, skipped, appended };
}

interface MulchFileMergeResult {
	merged: string;
	changed: boolean;
	updated: number;
	skipped: number;
	appended: number;
}

/**
 * Pure: merge a single domain's JSONL. Existing entries keep their
 * original order; new (or replaced) entries land at the end of the
 * file in incoming order. Anonymous records (no `id`) always append —
 * spec §11.A says they have no conflict possible.
 *
 * Exported for unit-testing in isolation from the disk + event surface.
 */
export async function mergeMulchFile(
	domain: string,
	existingBody: string,
	incomingBody: string,
	emit: (kind: string, payload: unknown) => Promise<EventRow>,
): Promise<MulchFileMergeResult> {
	const entries: MulchEntry[] = [];
	const idIndex = new Map<string, number>();

	for (const line of splitLines(existingBody)) {
		let parsed: Record<string, unknown> | null = null;
		try {
			const raw: unknown = JSON.parse(line);
			if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
				parsed = raw as Record<string, unknown>;
			}
		} catch {
			// keep an unparseable line as-is so we never lose data the user wrote.
		}
		const id = parsed !== null && typeof parsed.id === "string" ? parsed.id : null;
		const recordedAt =
			parsed !== null && typeof parsed.recorded_at === "string" ? parsed.recorded_at : "";
		const idx = entries.length;
		entries.push({ raw: line, id, recordedAt });
		if (id !== null) idIndex.set(id, idx);
	}

	let updated = 0;
	let skipped = 0;
	let appended = 0;

	for (const line of splitLines(incomingBody)) {
		let parsed: Record<string, unknown>;
		try {
			const raw: unknown = JSON.parse(line);
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
				await emit("reap_failed", {
					step: "mulch_merge",
					message: `expertise/${domain}.jsonl: line is not a JSON object`,
				});
				continue;
			}
			parsed = raw as Record<string, unknown>;
		} catch (err) {
			await emit("reap_failed", {
				step: "mulch_merge",
				message: `expertise/${domain}.jsonl: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
			});
			continue;
		}
		const id = typeof parsed.id === "string" ? parsed.id : null;
		const recordedAt = typeof parsed.recorded_at === "string" ? parsed.recorded_at : "";

		if (id !== null) {
			const existingIdx = idIndex.get(id);
			if (existingIdx !== undefined) {
				const existing = entries[existingIdx];
				if (existing === undefined) continue;
				if (recordedAt > existing.recordedAt) {
					entries[existingIdx] = { raw: line, id, recordedAt };
					updated += 1;
					await emit("mulch.record.updated", {
						domain,
						id,
						previousRecordedAt: existing.recordedAt || null,
						newRecordedAt: recordedAt || null,
					});
				} else {
					skipped += 1;
					await emit("mulch.record.skipped", {
						domain,
						id,
						incomingRecordedAt: recordedAt || null,
						existingRecordedAt: existing.recordedAt || null,
					});
				}
				continue;
			}
		}

		const idx = entries.length;
		entries.push({ raw: line, id, recordedAt });
		if (id !== null) idIndex.set(id, idx);
		appended += 1;
		await emit("mulch.record.added", { domain, id });
	}

	const merged = entries.length === 0 ? "" : `${entries.map((e) => e.raw).join("\n")}\n`;
	const changed = updated > 0 || appended > 0 || (merged !== existingBody && existingBody !== "");
	return { merged, changed, updated, skipped, appended };
}

/* ----------------------------------------------------------------------- */
/* Seeds close mirror                                                       */
/* ----------------------------------------------------------------------- */

interface SeedRow {
	id: string;
	status: string;
	updatedAt: string;
	raw: string;
}

interface MirrorClosedSeedsInput {
	readonly burrowClient: BurrowClient;
	readonly burrowId: string;
	readonly projectPath: string;
	readonly fs: ReapFs;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

interface MirrorSeedsResult {
	readonly closed: number;
	readonly created: number;
}

async function mirrorSeeds(input: MirrorClosedSeedsInput): Promise<MirrorSeedsResult> {
	const { burrowClient, burrowId, projectPath, fs, emit } = input;
	const projectFile = join(projectPath, ".seeds", "issues.jsonl");

	let burrowBody: string;
	try {
		const out = await withTransportMapping(burrowClient.config, () =>
			burrowClient.http.files.read(burrowId, ".seeds/issues.jsonl"),
		);
		burrowBody = out.contents;
	} catch (err) {
		if (err instanceof NotFoundError) return { closed: 0, created: 0 };
		throw err;
	}

	const projectBody = (await fs.readFile(projectFile)) ?? "";
	const projectRows = parseSeeds(projectBody);
	const projectIndex = new Map<string, number>();
	for (let i = 0; i < projectRows.length; i++) {
		const row = projectRows[i];
		if (row !== undefined) projectIndex.set(row.id, i);
	}

	let closed = 0;
	let created = 0;
	let changed = false;

	for (const incoming of parseSeeds(burrowBody)) {
		const existingIdx = projectIndex.get(incoming.id);
		if (existingIdx === undefined) {
			projectRows.push(incoming);
			projectIndex.set(incoming.id, projectRows.length - 1);
			changed = true;
			if (incoming.status === "closed") {
				closed += 1;
				await emit("seeds.closed", { id: incoming.id, mode: "added" });
			} else {
				created += 1;
				await emit("seeds.created", { id: incoming.id, status: incoming.status });
			}
			continue;
		}
		if (incoming.status !== "closed") continue;
		const existing = projectRows[existingIdx];
		if (existing === undefined) continue;
		if (existing.status === "closed" && existing.updatedAt >= incoming.updatedAt) continue;
		if (incoming.updatedAt <= existing.updatedAt) continue;
		projectRows[existingIdx] = incoming;
		closed += 1;
		changed = true;
		await emit("seeds.closed", { id: incoming.id, mode: "updated" });
	}

	if (changed) {
		await fs.mkdirp(dirname(projectFile));
		await fs.writeFile(
			projectFile,
			projectRows.length === 0 ? "" : `${projectRows.map((r) => r.raw).join("\n")}\n`,
		);
	}

	return { closed, created };
}

function parseSeeds(body: string): SeedRow[] {
	const out: SeedRow[] = [];
	for (const line of splitLines(body)) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const obj = parsed as Record<string, unknown>;
			const id = typeof obj.id === "string" ? obj.id : null;
			const status = typeof obj.status === "string" ? obj.status : null;
			const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : "";
			if (id === null || status === null) continue;
			out.push({ id, status, updatedAt, raw: line });
		} catch {
			// skip unparseable lines; we never want to corrupt the project's seeds file.
		}
	}
	return out;
}

/* ----------------------------------------------------------------------- */
/* Plot merge (warren-7e0f / pl-2047 step 6)                                 */
/* ----------------------------------------------------------------------- */

/**
 * Event types whose agent-emitted occurrences mirror into warren's event
 * stream. Mirrors the SPEC §11 Plot ACL surface: the three event kinds
 * that capture meaningful agent-side decisions an operator wants visible
 * on the warren run page. Other event types (note, plot_created,
 * attachment_added) merge into the project's `.plot/` but are not
 * surfaced — they are either trivial or already represented by their own
 * warren-side primitives.
 */
const MIRRORED_PLOT_EVENT_TYPES = new Set(["decision_made", "question_posed", "artifact_produced"]);

interface PlotMergeResult {
	eventsAppended: number;
	plotsUpdated: number;
	mirrored: number;
}

interface ParsedPlotEvent {
	type: string;
	actor: string;
	at: string;
	data: unknown;
}

/**
 * Replay the burrow workspace's `.plot/` deltas back into the project's
 * persistent `.plot/`. Two file kinds get merged:
 *
 *   1. `plot-*.events.jsonl` — append-only event log. Deduped by full-line
 *      content; new lines from the workspace get appended in workspace
 *      order. Idempotent: a re-run against an already-merged workspace
 *      appends nothing.
 *
 *   2. `plot-*.json` — Plot state document. Last-write-wins on
 *      `updated_at` (same primitive as mulch's `recorded_at` LWW per
 *      mx-spec §11.A). Equal `updated_at` with different contents emits
 *      a `plot.conflict` event and leaves the project copy untouched —
 *      operators triage manually.
 *
 * Agent-emitted `decision_made` / `question_posed` / `artifact_produced`
 * entries appearing in the appended event tail are mirrored into
 * warren's event stream tagged with `plot_id` so the run page surfaces
 * coordination signal without a separate Plot-side polling loop.
 *
 * Best-effort like the surrounding sub-steps — any error emits a
 * `reap_failed` step=plot_merge event and is swallowed so the caller's
 * state transition still runs.
 */
async function mergePlot(
	workspacePath: string,
	projectPath: string,
	fs: ReapFs,
	emit: (kind: string, payload: unknown) => Promise<EventRow>,
	fail: (step: ReapStep, err: unknown, path?: string) => Promise<void>,
): Promise<PlotMergeResult> {
	const burrowDir = join(workspacePath, ".plot");
	const projectDir = join(projectPath, ".plot");
	const filenames = await fs.readdir(burrowDir);

	// Group filenames by plot id so each plot's events + json get merged
	// together. The .index.db SQLite file is intentionally excluded — the
	// Plot library rebuilds it from the json+events pair, so copying it
	// across would create stale rows.
	const plotIds = new Set<string>();
	for (const name of filenames) {
		if (name.startsWith("plot-") && name.endsWith(".events.jsonl")) {
			plotIds.add(name.slice(0, -".events.jsonl".length));
		} else if (name.startsWith("plot-") && name.endsWith(".json")) {
			plotIds.add(name.slice(0, -".json".length));
		}
	}

	let eventsAppended = 0;
	let plotsUpdated = 0;
	let mirrored = 0;

	for (const plotId of [...plotIds].sort()) {
		const eventsName = `${plotId}.events.jsonl`;
		const burrowEventsPath = join(burrowDir, eventsName);
		const projectEventsPath = join(projectDir, eventsName);
		try {
			const incoming = await fs.readFile(burrowEventsPath);
			if (incoming !== null) {
				const existing = (await fs.readFile(projectEventsPath)) ?? "";
				const result = mergePlotEventsFile(existing, incoming);
				if (result.changed) {
					await fs.mkdirp(dirname(projectEventsPath));
					await fs.writeFile(projectEventsPath, result.merged);
				}
				eventsAppended += result.appended;
				for (const ev of result.newEvents) {
					if (!MIRRORED_PLOT_EVENT_TYPES.has(ev.type)) continue;
					if (!ev.actor.startsWith("agent:")) continue;
					await emit(`plot.${ev.type}`, {
						plotId,
						actor: ev.actor,
						at: ev.at,
						data: ev.data,
					});
					mirrored += 1;
				}
			}
		} catch (err) {
			await fail("plot_merge", err, burrowEventsPath);
		}

		const jsonName = `${plotId}.json`;
		const burrowJsonPath = join(burrowDir, jsonName);
		const projectJsonPath = join(projectDir, jsonName);
		try {
			const incoming = await fs.readFile(burrowJsonPath);
			if (incoming !== null) {
				const existing = await fs.readFile(projectJsonPath);
				const result = mergePlotJsonFile(existing, incoming);
				if (result.changed) {
					await fs.mkdirp(dirname(projectJsonPath));
					await fs.writeFile(projectJsonPath, result.merged);
					plotsUpdated += 1;
					await emit("plot.updated", { plotId });
				}
				if (result.conflict !== null) {
					await emit("plot.conflict", { plotId, reason: result.conflict });
				}
			}
		} catch (err) {
			await fail("plot_merge", err, burrowJsonPath);
		}
	}

	return { eventsAppended, plotsUpdated, mirrored };
}

interface PlotEventsMergeResult {
	merged: string;
	changed: boolean;
	appended: number;
	newEvents: ParsedPlotEvent[];
}

/**
 * Pure: merge a single Plot's events.jsonl. Existing project lines keep
 * their position and order; workspace lines not already present land at
 * the tail in workspace order. Append-only events have no LWW shape —
 * dedup by exact line content is the natural primitive.
 *
 * Exported for unit testing in isolation from the disk + event surface.
 */
export function mergePlotEventsFile(
	existingBody: string,
	incomingBody: string,
): PlotEventsMergeResult {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const line of splitLines(existingBody)) {
		if (seen.has(line)) continue;
		seen.add(line);
		lines.push(line);
	}
	let appended = 0;
	const newEvents: ParsedPlotEvent[] = [];
	for (const line of splitLines(incomingBody)) {
		if (seen.has(line)) continue;
		seen.add(line);
		lines.push(line);
		appended += 1;
		const parsed = parsePlotEvent(line);
		if (parsed !== null) newEvents.push(parsed);
	}
	const merged = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
	const changed = appended > 0 || (merged !== existingBody && existingBody !== "");
	return { merged, changed, appended, newEvents };
}

function parsePlotEvent(line: string): ParsedPlotEvent | null {
	try {
		const raw: unknown = JSON.parse(line);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
		const obj = raw as Record<string, unknown>;
		const type = typeof obj.type === "string" ? obj.type : null;
		const actor = typeof obj.actor === "string" ? obj.actor : null;
		const at = typeof obj.at === "string" ? obj.at : null;
		if (type === null || actor === null || at === null) return null;
		return { type, actor, at, data: obj.data };
	} catch {
		return null;
	}
}

interface PlotJsonMergeResult {
	merged: string;
	changed: boolean;
	conflict: string | null;
}

/**
 * Pure: merge a single Plot's plot-id.json. LWW on `updated_at`. Equal
 * `updated_at` with content drift is a real conflict (two writers
 * touched the same revision) — surface it as `plot.conflict` and keep
 * the existing project copy so an operator can triage.
 *
 * Exported for unit testing.
 */
export function mergePlotJsonFile(existing: string | null, incoming: string): PlotJsonMergeResult {
	if (existing === null) return { merged: incoming, changed: true, conflict: null };
	if (existing === incoming) return { merged: existing, changed: false, conflict: null };
	const existingTs = readUpdatedAt(existing);
	const incomingTs = readUpdatedAt(incoming);
	if (incomingTs > existingTs) {
		return { merged: incoming, changed: true, conflict: null };
	}
	if (incomingTs < existingTs) {
		return { merged: existing, changed: false, conflict: null };
	}
	return {
		merged: existing,
		changed: false,
		conflict: "updated_at matches but contents differ",
	};
}

/* ----------------------------------------------------------------------- */
/* Plot commit-through-reap (warren-343a, shape (a))                         */
/* ----------------------------------------------------------------------- */

/**
 * Filenames matching this prefix are gitignored derived state per
 * ../plot/README.md — the SQLite index Plot rebuilds on demand. Skipping
 * these on copy mirrors the snapshot/restore wrapper in
 * src/projects/refresh.ts (mx-239786) and keeps the warren-authored
 * commit free of churn.
 */
const PLOT_INDEX_SKIP_PREFIX = ".index.db";

interface StagePlotForCommitInput {
	readonly workspacePath: string;
	readonly projectPath: string;
	readonly fs: ReapFs;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

/**
 * Replicate every committable `.plot/` file from the project clone into
 * the burrow workspace, then stage `.plot/` and author a
 * `chore(warren): plot state` commit when there's a real delta the agent
 * never committed. Returns true when a warren-identity commit landed.
 *
 * The project clone is the union point: by this step `mergePlot` has
 * already merged the workspace's agent-side `.plot/` writes into the
 * project clone, and the project clone also carries any host-side
 * appender writes (`defaultPlotAppender`, `defaultPlanRunPlotAppender`,
 * `autoTransitionPlotToDone`) that warren wrote at dispatch / plan-run
 * coordination time. Copying that union back into the workspace gives
 * `git push` a single canonical view to ship to origin.
 *
 * `.plot/.index.db*` files are skipped — derived SQLite state Plot
 * rebuilds via `plot rebuild-index` (mx-239786). Anything that isn't
 * `plot-*.json` or `plot-*.events.jsonl` is also skipped: the SPEC §11.O
 * file layout for `.plot/` is flat and these two extensions cover the
 * full carrier surface; filtering keeps stray dotfiles out of the warren
 * commit.
 *
 * `git add .plot/` honors a project-level `.gitignore` of `.plot/` — a
 * project that gitignored the directory has opted out of committing
 * Plot state, and the staged-changes check below sees no entries.
 */
async function stagePlotForCommit(input: StagePlotForCommitInput): Promise<boolean> {
	const { workspacePath, projectPath, fs, exec, emit } = input;
	const projectPlotDir = join(projectPath, ".plot");
	const workspacePlotDir = join(workspacePath, ".plot");

	const entries = await fs.readdir(projectPlotDir);
	let copied = 0;
	for (const name of entries) {
		if (name.startsWith(PLOT_INDEX_SKIP_PREFIX)) continue;
		if (!name.startsWith("plot-")) continue;
		if (!name.endsWith(".json") && !name.endsWith(".events.jsonl")) continue;
		const contents = await fs.readFile(join(projectPlotDir, name));
		if (contents === null) continue;
		if (copied === 0) await fs.mkdirp(workspacePlotDir);
		await fs.writeFile(join(workspacePlotDir, name), contents);
		copied += 1;
	}
	if (copied === 0) return false;

	await exec.run("git", ["add", "--", ".plot/"], {
		cwd: workspacePath,
		timeoutMs: 10_000,
	});

	// `git diff --cached --quiet -- .plot/` exits non-zero when there are
	// staged changes under .plot/ — the natural primitive for "did the
	// add actually pick up a delta the agent hadn't already committed".
	let hasStagedDelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ".plot/"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		});
		hasStagedDelta = false;
	} catch {
		hasStagedDelta = true;
	}
	if (!hasStagedDelta) return false;

	await exec.run(
		"git",
		[
			"-c",
			"user.name=warren",
			"-c",
			"user.email=warren@os-eco.dev",
			"commit",
			"-m",
			"chore(warren): plot state",
		],
		{ cwd: workspacePath, timeoutMs: 10_000 },
	);
	await emit("reap.plot_committed", {
		message: "chore(warren): plot state",
		filesStaged: copied,
	});
	return true;
}

/* ----------------------------------------------------------------------- */
/* Seeds commit-through-reap (warren-7ecc)                                   */
/* ----------------------------------------------------------------------- */

/**
 * Seeds-tracker files committed by warren on the agent's behalf. The
 * SPEC for `.seeds/` (../seeds/SPEC.md) pins a flat layout of two
 * jsonl carriers — `issues.jsonl` (the issue queue) and `plans.jsonl`
 * (sd plan submit output, the planner's primary write). `config.yaml`
 * and `templates.jsonl` are committed by the human at `sd init` time
 * and don't get rewritten by agent activity, so excluding them keeps
 * the warren-authored commit narrow.
 */
const SEEDS_COMMITTABLE_FILES: readonly string[] = ["issues.jsonl", "plans.jsonl"];

interface StageSeedsForCommitInput {
	readonly workspacePath: string;
	readonly projectPath: string;
	readonly fs: ReapFs;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

/**
 * Replicate `.seeds/issues.jsonl` + `.seeds/plans.jsonl` from the
 * project clone into the burrow workspace, stage `.seeds/`, and author
 * a `chore(warren): seeds state` commit when there's a real delta the
 * agent never committed. Returns true when a warren-identity commit
 * landed.
 *
 * The carrier shape mirrors stagePlotForCommit (warren-343a) — agents
 * with narrowly-scoped write contracts (planner, see
 * src/registry/builtins/planner.ts) are forbidden from running
 * `git commit`. The planner's `sd plan submit` writes
 * `.seeds/issues.jsonl` + `.seeds/plans.jsonl` inside the workspace;
 * without this step the push exits zero, lands no work, and reap fires
 * `reap.empty_push`. The project clone is the union point: by this
 * step `mirrorSeeds` has already merged closed-status rows and
 * newly-created rows from the workspace back into the project's
 * `issues.jsonl`. Copying the union back into the workspace gives
 * `git push` a single canonical view to ship to origin.
 *
 * `git add .seeds/` honors a project-level `.gitignore` of `.seeds/`
 * — a project that gitignored the directory has opted out of
 * committing seeds state, and the staged-changes check below sees no
 * entries.
 */
async function stageSeedsForCommit(input: StageSeedsForCommitInput): Promise<boolean> {
	const { workspacePath, projectPath, fs, exec, emit } = input;
	const projectSeedsDir = join(projectPath, ".seeds");
	const workspaceSeedsDir = join(workspacePath, ".seeds");

	let copied = 0;
	for (const name of SEEDS_COMMITTABLE_FILES) {
		const contents = await fs.readFile(join(projectSeedsDir, name));
		if (contents === null) continue;
		if (copied === 0) await fs.mkdirp(workspaceSeedsDir);
		await fs.writeFile(join(workspaceSeedsDir, name), contents);
		copied += 1;
	}
	if (copied === 0) return false;

	await exec.run("git", ["add", "--", ".seeds/"], {
		cwd: workspacePath,
		timeoutMs: 10_000,
	});

	let hasStagedDelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ".seeds/"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		});
		hasStagedDelta = false;
	} catch {
		hasStagedDelta = true;
	}
	if (!hasStagedDelta) return false;

	await exec.run(
		"git",
		[
			"-c",
			"user.name=warren",
			"-c",
			"user.email=warren@os-eco.dev",
			"commit",
			"-m",
			"chore(warren): seeds state",
		],
		{ cwd: workspacePath, timeoutMs: 10_000 },
	);
	await emit("reap.seeds_committed", {
		message: "chore(warren): seeds state",
		filesStaged: copied,
	});
	return true;
}

/* ----------------------------------------------------------------------- */
/* Auto plan-run detection (warren-a32a)                                    */
/* ----------------------------------------------------------------------- */

function hasAutoPlanRunFrontmatter(run: { renderedAgentJson: unknown }): boolean {
	const json = run.renderedAgentJson;
	if (json === null || typeof json !== "object" || Array.isArray(json)) return false;
	const fm = (json as Record<string, unknown>).frontmatter;
	if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return false;
	return (fm as Record<string, unknown>).auto_plan_run === true;
}

function resolveAutoPlanRunAgent(run: { renderedAgentJson: unknown; agentName: string }): string {
	const json = run.renderedAgentJson;
	if (json !== null && typeof json === "object" && !Array.isArray(json)) {
		const fm = (json as Record<string, unknown>).frontmatter;
		if (fm !== null && typeof fm === "object" && !Array.isArray(fm)) {
			const override = readAutoPlanRunAgent(fm as Record<string, unknown>);
			if (override !== undefined) return override;
		}
	}
	return run.agentName;
}

function parsePlanIds(body: string): Set<string> {
	const ids = new Set<string>();
	for (const line of splitLines(body)) {
		try {
			const raw: unknown = JSON.parse(line);
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
			const id = (raw as Record<string, unknown>).id;
			if (typeof id === "string" && id.length > 0) ids.add(id);
		} catch {
			// skip unparseable lines
		}
	}
	return ids;
}

function parsePlanChildren(body: string, planId: string): string[] {
	for (const line of splitLines(body)) {
		try {
			const raw: unknown = JSON.parse(line);
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
			const obj = raw as Record<string, unknown>;
			if (obj.id !== planId) continue;
			const children = obj.children;
			if (!Array.isArray(children)) return [];
			return children.filter((c): c is string => typeof c === "string" && c.length > 0);
		} catch {
			// skip unparseable lines
		}
	}
	return [];
}

function readUpdatedAt(body: string): string {
	try {
		const raw: unknown = JSON.parse(body);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "";
		const ts = (raw as Record<string, unknown>).updated_at;
		return typeof ts === "string" ? ts : "";
	} catch {
		return "";
	}
}

/* ----------------------------------------------------------------------- */
/* State machine bridge                                                     */
/* ----------------------------------------------------------------------- */

/**
 * Infer failure_reason from state-on-entry plus the event log
 * (warren-3c40, warren-5165). Only consulted when `outcome === "failed"`
 * and the caller didn't override.
 *
 *   queued on entry  → never_started (bridge never claimed the row)
 *   running, no model-turn output observed → no_model_response
 *   running, model-turn output observed   → crashed
 *
 * "Model-turn output" = any event with `kind` in {text, thinking,
 * tool_use} on `stream=stdout`. burrow's jsonl-claude parser maps a
 * claude-code `assistant` envelope into one of those shapes per content
 * block (see burrow `src/runtime/parsers/jsonl-claude.ts`); a run that
 * dies before producing any assistant turn has none of them. The catch-
 * all on unparseable stdout lines also lands as `kind=text` — a known
 * minor false-negative in the rare case where claude-code prints non-
 * JSON to stdout before exiting.
 */
async function inferFailureReason(
	repos: Repos,
	runId: string,
	stateOnEntry: string,
): Promise<RunFailureReason> {
	if (stateOnEntry === "queued") return "never_started";
	const events = await repos.events.listByRun(runId);
	const sawModelTurn = events.some(
		(ev) =>
			ev.stream === "stdout" &&
			(ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_use"),
	);
	return sawModelTurn ? "crashed" : "no_model_response";
}

async function transitionToTerminal(
	repos: Repos,
	runId: string,
	currentState: string,
	outcome: RunTerminalState,
	now: Date,
	failureReason: RunFailureReason | null,
): Promise<RunTerminalState> {
	if (currentState === "queued" && outcome !== "cancelled") {
		await repos.runs.markRunning(runId, now);
	}
	const finalized = await repos.runs.finalize(runId, outcome, now, failureReason);
	return finalized.state as RunTerminalState;
}

/* ----------------------------------------------------------------------- */
/* Helpers                                                                  */
/* ----------------------------------------------------------------------- */

function isTerminal(state: string): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

function splitLines(body: string): string[] {
	const out: string[] = [];
	for (const raw of body.split("\n")) {
		const trimmed = raw.trim();
		if (trimmed === "") continue;
		out.push(trimmed);
	}
	return out;
}

function createSeqAllocator(start: number): { next: () => number } {
	let cur = start;
	return {
		next: () => {
			cur += 1;
			return cur;
		},
	};
}

const defaultFs: ReapFs = {
	mkdirp: async (path) => {
		await mkdir(path, { recursive: true });
	},
	readFile: async (path) => {
		try {
			return await readFile(path, "utf8");
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	},
	writeFile: async (path, contents) => {
		await writeFile(path, contents);
	},
	readdir: async (path) => {
		try {
			return await readdir(path);
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
	},
};

const defaultExec: ReapExec = {
	run: async (cmd, args, opts) => {
		const execOpts: { cwd: string; timeout?: number } = { cwd: opts.cwd };
		if (opts.timeoutMs !== undefined) execOpts.timeout = opts.timeoutMs;
		const { stdout, stderr } = await execFileAsync(cmd, [...args], execOpts);
		return { stdout, stderr };
	},
};

function isEnoent(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}
