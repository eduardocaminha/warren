/**
 * Scenario 38 — Rate-limit resilience (warren-016a / pl-eba6 step 4).
 *
 * Exercises two independent resilience properties end-to-end:
 *
 * A. report-only-dirty → success
 *    The `report-only-stub` canopy agent (report_only=true / runtime=stub-shell)
 *    writes files but never commits — leaving a dirty workspace. Reap must
 *    classify the run as `succeeded`, not `dropped_commit`, because the
 *    report-only exemption (warren-4e30) applies.
 *
 * B. 429 → paused (not crashed) → retry → success
 *    The `rate-limit-stub` canopy agent (runtime=claude-code-429) emits
 *    api_error_status=429 on first invocation. Reap must classify the run as
 *    `failed/rate_limited` (not `crashed`) and stamp `resume_at`. The scheduler
 *    tick retries automatically (WARREN_SCHEDULER_TICK_MS=1000 keeps this fast).
 *    The retry run uses the same stub, which emits success on second invocation.
 *
 * Both sub-scenarios use the in-proc fixture's sample project and canopy repo.
 * The `report-only-stub` and `rate-limit-stub` agents are registered in
 * buildCanopyRepo() (fixtures.ts), and the `claude-code-429` burrow runtime is
 * registered in burrow-with-stub.ts.
 *
 * In-proc only: the test drives the scheduler tick cadence via
 * WARREN_SCHEDULER_TICK_MS, which only the in-proc launcher wires.
 */

import { unlink } from "node:fs/promises";
import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { sleep } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
}

interface RunRow {
	readonly id: string;
	readonly agentName: string;
	readonly projectId: string | null;
	readonly state: string;
	readonly failureReason: string | null;
	readonly parentRunId: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

interface ListRunsResponse {
	readonly runs: readonly RunRow[];
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const RUN_TIMEOUT_MS = 60_000;
const RETRY_TIMEOUT_MS = 90_000;
const POLL_MS = 500;
// Flag file the 429 stub uses to distinguish first run from retry.
const FLAG_FILE = "/tmp/warren-accept-38-ran-once";

export const scenario: Scenario = {
	id: "38",
	title:
		"rate-limit resilience: report-only-dirty→success and 429→paused→retry→success (warren-016a)",
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

		// Refresh agents so warren picks up the canopy agents added by
		// buildCanopyRepo(): report-only-stub and rate-limit-stub.
		await http.expectStatus("POST", "/agents/refresh", 200);

		// -----------------------------------------------------------------------
		// Part A: report-only-dirty → success
		// -----------------------------------------------------------------------
		ctx.logger.info("Part A: report-only-dirty → success");

		const reportOnlyRun = await spawnRun(http, "report-only-stub", project.id);
		ctx.logger.info(`Part A: dispatched run ${reportOnlyRun.id}`);

		const reportOnlyFinal = await waitForTerminal(http, reportOnlyRun.id, RUN_TIMEOUT_MS);
		assertEqual(
			reportOnlyFinal.state,
			"succeeded",
			`Part A: report-only run ${reportOnlyRun.id} expected state=succeeded (not dropped_commit), ` +
				`got state=${reportOnlyFinal.state} failureReason=${reportOnlyFinal.failureReason}`,
		);
		assertTrue(
			reportOnlyFinal.failureReason === null,
			`Part A: report-only run should have null failureReason; got ${JSON.stringify(reportOnlyFinal.failureReason)}`,
		);
		ctx.logger.info("Part A: PASSED — report-only run succeeded (not dropped_commit)");

		// -----------------------------------------------------------------------
		// Part B: 429 → paused (not crashed) → retry → success
		// -----------------------------------------------------------------------
		ctx.logger.info("Part B: 429 → paused → retry → success");

		// Clear the flag so the stub emits 429 on this dispatch.
		await clearFlag();

		const rateLimitRun = await spawnRun(http, "rate-limit-stub", project.id);
		ctx.logger.info(`Part B: dispatched run ${rateLimitRun.id}`);

		// First run should end as failed/rate_limited, NOT crashed.
		const rateLimitFinal = await waitForTerminal(http, rateLimitRun.id, RUN_TIMEOUT_MS);
		assertEqual(
			rateLimitFinal.state,
			"failed",
			`Part B: rate-limit run ${rateLimitRun.id} expected state=failed; got ${rateLimitFinal.state}`,
		);
		assertEqual(
			rateLimitFinal.failureReason,
			"rate_limited",
			`Part B: rate-limit run ${rateLimitRun.id} expected failureReason=rate_limited (not crashed); ` +
				`got ${JSON.stringify(rateLimitFinal.failureReason)}`,
		);
		ctx.logger.info("Part B: first run paused as rate_limited (not crashed) ✓");

		// The scheduler (WARREN_SCHEDULER_TICK_MS=1000) should retry within
		// RETRY_TIMEOUT_MS. Poll for a second run whose parentRunId is the
		// rate-limited run. The retry run should complete as succeeded.
		const retryRun = await waitForRetryRun(http, rateLimitRun.id, project.id, RETRY_TIMEOUT_MS);
		ctx.logger.info(`Part B: retry run ${retryRun.id} dispatched by scheduler`);

		const retryFinal = await waitForTerminal(http, retryRun.id, RUN_TIMEOUT_MS);
		assertEqual(
			retryFinal.state,
			"succeeded",
			`Part B: retry run ${retryRun.id} expected state=succeeded; got ${retryFinal.state} ` +
				`failureReason=${retryFinal.failureReason}`,
		);
		ctx.logger.info("Part B: PASSED — retry run succeeded after rate-limit pause");
	},
};

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const existing = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const found = existing.projects.find((p) => p.gitUrl === gitUrl);
	if (found !== undefined) return found;
	return await http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function spawnRun(http: WarrenHttp, agent: string, projectId: string): Promise<RunRow> {
	const resp = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
		body: { agent, project: projectId, prompt: `scenario-38 ${agent}` },
	});
	return resp.run;
}

async function waitForTerminal(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<RunRow> {
	const deadline = Date.now() + timeoutMs;
	let last: RunRow | undefined;
	while (Date.now() < deadline) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row;
		if (TERMINAL_STATES.has(row.state)) return row;
		await sleep(POLL_MS);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach terminal state within ${timeoutMs}ms (last state=${last?.state ?? "unknown"})`,
	);
}

/**
 * Poll GET /runs?projectId=... until a run appears with parentRunId matching
 * the rate-limited run. The scheduler tick creates this run when it detects
 * resume_at has elapsed.
 */
async function waitForRetryRun(
	http: WarrenHttp,
	parentRunId: string,
	projectId: string,
	timeoutMs: number,
): Promise<RunRow> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const resp = await http.expectJson<ListRunsResponse>(
			"GET",
			`/runs?project=${encodeURIComponent(projectId)}`,
			200,
		);
		const retry = resp.runs.find((r) => r.parentRunId === parentRunId);
		if (retry !== undefined) return retry;
		await sleep(POLL_MS);
	}
	throw new AcceptanceError(
		`no retry run appeared (parentRunId=${parentRunId}) within ${timeoutMs}ms — ` +
			"scheduler may not have fired or resume_at was not set",
	);
}

async function clearFlag(): Promise<void> {
	try {
		await unlink(FLAG_FILE);
	} catch {
		// Flag didn't exist; that's fine — the stub treats absence as "first run".
	}
}
