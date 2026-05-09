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
 *      workspace; for any row in `closed` state whose `updatedAt` is
 *      newer than the project's row (or absent there entirely), mirror
 *      the row into the project's `.seeds/issues.jsonl`. Emits
 *      `seeds.closed` events. Narrower than a full LWW merge — only
 *      closes propagate, matching the spec wording "close seeds the
 *      agent marked done". Other seed mutations ride on the workspace
 *      branch push below.
 *
 *   3. Branch push — `git -C <workspacePath> push origin HEAD` so the
 *      agent's commits (code, test edits, sd sync output, etc.) land on
 *      the project's remote. Branch name comes from burrow's record.
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
import type { BurrowClient } from "../burrow-client/client.ts";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EventRow, RunFailureReason, RunTerminalState } from "../db/schema.ts";
import type { RunEventBroker } from "./events.ts";
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
	readonly burrowClient: BurrowClient;
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
}

export interface ReapStepError {
	readonly step: ReapStep;
	readonly message: string;
	readonly path?: string;
}

export type ReapStep = "workspace_lookup" | "mulch_merge" | "seeds_close" | "branch_push";

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
	readonly branchPushed: boolean;
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

	const run = input.repos.runs.require(input.runId);
	if (isTerminal(run.state)) {
		input.logger?.info?.(
			{ runId: run.id, state: run.state },
			"reap skipped: run already in terminal state",
		);
		return {
			state: run.state as RunTerminalState,
			failureReason: run.failureReason,
			mulchUpdated: 0,
			mulchSkipped: 0,
			mulchAppended: 0,
			seedsClosed: 0,
			branchPushed: false,
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
	const project = run.projectId !== null ? input.repos.projects.get(run.projectId) : null;
	const seq = createSeqAllocator(input.repos.events.maxSeqForRun(run.id) ?? 0);
	const errors: ReapStepError[] = [];
	const emit = (kind: string, payload: unknown): EventRow => {
		const row = input.repos.events.append({
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
	const fail = (step: ReapStep, err: unknown, path?: string): void => {
		const message = err instanceof Error ? err.message : String(err);
		const stepError: ReapStepError =
			path !== undefined ? { step, message, path } : { step, message };
		errors.push(stepError);
		emit("reap_failed", stepError);
		input.logger?.error?.({ runId: run.id, step, err: message, path }, "reap step failed");
	};

	let mulchUpdated = 0;
	let mulchSkipped = 0;
	let mulchAppended = 0;
	let seedsClosed = 0;
	let branchPushed = false;

	let workspacePath: string | null = null;
	let branch: string | null = null;
	if (run.burrowId === null) {
		fail("workspace_lookup", new Error("run has no burrow_id; nothing to reap from"));
	} else {
		try {
			const burrow = await withTransportMapping(input.burrowClient.config, () =>
				input.burrowClient.http.burrows.get(run.burrowId as string),
			);
			workspacePath = burrow.workspacePath;
			branch = typeof burrow.branch === "string" && burrow.branch !== "" ? burrow.branch : null;
		} catch (err) {
			fail("workspace_lookup", err);
		}
	}

	if (workspacePath !== null && project !== null) {
		try {
			const result = await mergeMulch(workspacePath, project.localPath, fs, emit, fail);
			mulchUpdated = result.updated;
			mulchSkipped = result.skipped;
			mulchAppended = result.appended;
		} catch (err) {
			fail("mulch_merge", err);
		}

		try {
			seedsClosed = await mirrorClosedSeeds(workspacePath, project.localPath, fs, emit);
		} catch (err) {
			fail("seeds_close", err);
		}

		try {
			await exec.run("git", ["push", "origin", branch !== null ? `HEAD:${branch}` : "HEAD"], {
				cwd: workspacePath,
				timeoutMs: 60_000,
			});
			branchPushed = true;
		} catch (err) {
			fail("branch_push", err, workspacePath);
		}
	} else if (workspacePath !== null && project === null) {
		emit("reap.orphaned", {
			projectId: run.projectId,
			message: "project was deleted; skipping mulch merge, seeds close, and branch push",
		});
	}

	const failureReason: RunFailureReason | null =
		input.outcome === "failed"
			? (input.failureReason ?? inferFailureReason(input.repos, run.id, stateOnEntry))
			: null;

	const finalState = transitionToTerminal(
		input.repos,
		run.id,
		stateOnEntry,
		input.outcome,
		now(),
		failureReason,
	);

	emit("reap.completed", {
		state: finalState,
		failureReason,
		mulch: { updated: mulchUpdated, skipped: mulchSkipped, appended: mulchAppended },
		seeds: { closed: seedsClosed },
		branchPushed,
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
			branchPushed,
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
		branchPushed,
		errors,
		alreadyTerminal: false,
	};
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
	emit: (kind: string, payload: unknown) => EventRow,
	fail: (step: ReapStep, err: unknown, path?: string) => void,
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
			const result = mergeMulchFile(domain, existing, incoming, emit);
			if (result.changed) {
				await fs.mkdirp(dirname(projectPath2));
				await fs.writeFile(projectPath2, result.merged);
			}
			updated += result.updated;
			skipped += result.skipped;
			appended += result.appended;
		} catch (err) {
			fail("mulch_merge", err, burrowPath);
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
export function mergeMulchFile(
	domain: string,
	existingBody: string,
	incomingBody: string,
	emit: (kind: string, payload: unknown) => EventRow,
): MulchFileMergeResult {
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
				emit("reap_failed", {
					step: "mulch_merge",
					message: `expertise/${domain}.jsonl: line is not a JSON object`,
				});
				continue;
			}
			parsed = raw as Record<string, unknown>;
		} catch (err) {
			emit("reap_failed", {
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
					emit("mulch.record.updated", {
						domain,
						id,
						previousRecordedAt: existing.recordedAt || null,
						newRecordedAt: recordedAt || null,
					});
				} else {
					skipped += 1;
					emit("mulch.record.skipped", {
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
		emit("mulch.record.added", { domain, id });
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

async function mirrorClosedSeeds(
	workspacePath: string,
	projectPath: string,
	fs: ReapFs,
	emit: (kind: string, payload: unknown) => EventRow,
): Promise<number> {
	const burrowFile = join(workspacePath, ".seeds", "issues.jsonl");
	const projectFile = join(projectPath, ".seeds", "issues.jsonl");

	const burrowBody = await fs.readFile(burrowFile);
	if (burrowBody === null) return 0;

	const projectBody = (await fs.readFile(projectFile)) ?? "";
	const projectRows = parseSeeds(projectBody);
	const projectIndex = new Map<string, number>();
	for (let i = 0; i < projectRows.length; i++) {
		const row = projectRows[i];
		if (row !== undefined) projectIndex.set(row.id, i);
	}

	let closed = 0;
	let changed = false;

	for (const incoming of parseSeeds(burrowBody)) {
		if (incoming.status !== "closed") continue;
		const existingIdx = projectIndex.get(incoming.id);
		if (existingIdx === undefined) {
			projectRows.push(incoming);
			projectIndex.set(incoming.id, projectRows.length - 1);
			closed += 1;
			changed = true;
			emit("seeds.closed", { id: incoming.id, mode: "added" });
			continue;
		}
		const existing = projectRows[existingIdx];
		if (existing === undefined) continue;
		if (existing.status === "closed" && existing.updatedAt >= incoming.updatedAt) continue;
		if (incoming.updatedAt <= existing.updatedAt) continue;
		projectRows[existingIdx] = incoming;
		closed += 1;
		changed = true;
		emit("seeds.closed", { id: incoming.id, mode: "updated" });
	}

	if (changed) {
		await fs.mkdirp(dirname(projectFile));
		await fs.writeFile(
			projectFile,
			projectRows.length === 0 ? "" : `${projectRows.map((r) => r.raw).join("\n")}\n`,
		);
	}

	return closed;
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
function inferFailureReason(repos: Repos, runId: string, stateOnEntry: string): RunFailureReason {
	if (stateOnEntry === "queued") return "never_started";
	const events = repos.events.listByRun(runId);
	const sawModelTurn = events.some(
		(ev) =>
			ev.stream === "stdout" &&
			(ev.kind === "text" || ev.kind === "thinking" || ev.kind === "tool_use"),
	);
	return sawModelTurn ? "crashed" : "no_model_response";
}

function transitionToTerminal(
	repos: Repos,
	runId: string,
	currentState: string,
	outcome: RunTerminalState,
	now: Date,
	failureReason: RunFailureReason | null,
): RunTerminalState {
	if (currentState === "queued" && outcome !== "cancelled") {
		repos.runs.markRunning(runId, now);
	}
	const finalized = repos.runs.finalize(runId, outcome, now, failureReason);
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
