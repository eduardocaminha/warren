/**
 * Scenario 31 — Plot → synthesized plan-run roundtrip (warren-af97 /
 * pl-f404 step 5 / SPEC §11.Q). Composes scenarios 25 (Plot dispatch),
 * 27 (PlanRun + Plot), and 29 (PlotDetail surfaces) against one
 * `.plot/`-and-`.seeds/`-enabled fixture, exercising the synthesis
 * endpoint `POST /plot-plan-runs` end-to-end:
 *
 *   1. Synthesizer mints a throwaway parent seed + plan whose children
 *      adopt the Plot's open `seeds_issue` attachments via
 *      `existing_seed` (seeds-cli 0.4.7, warren-d519). Closed attachments
 *      and `sd_plan`-shaped attachments (ref ~ `^pl-`) are filtered at
 *      the handler edge.
 *   2. The persisted PlanRun row carries `plotId`, so every §11.P.Plot
 *      hook lights up unchanged: `plan_run_dispatched` lands at
 *      POST-time, every child run inherits `PLOT_ID`+`PLOT_ACTOR` env
 *      injection (acceptance-soft-skip on warren-a346 today, same as
 *      scenarios 25/27/29), per-child `run_dispatched` appends to the
 *      Plot events.jsonl, and the Plot auto-transitions
 *      `active → done` on `plan_succeeded`.
 *   3. Re-dispatching the same Plot mints a SECOND synthesized plan
 *      (no clobber, no idempotency) — SPEC §11.Q acceptance #6.
 *
 * Negative paths covered (SPEC §11.Q acceptance #5):
 *   - malformed `plot_id` → 400 `plot_id_invalid` (warren-bae5)
 *   - non-existent `plot_id` → 400 `plot_id_not_found` (warren-bae5)
 *   - project without `.plot/` → 400 `project_lacks_plot`
 *   - Plot with zero dispatchable attachments → 400
 *     `no_dispatchable_seeds`
 *
 * The `project_lacks_seeds` arm is unit-test-only here: a project with
 * `.plot/` but no `.seeds/` requires a third fixture clone for one
 * assertion already covered by `handlers.plot-plan-runs.test.ts`.
 *
 * Topology: in-proc only, per-scenario stack so the
 * `WARREN_GH_FETCH_OVERRIDE=merged` / `WARREN_STUB_NO_COMMIT_SEEDS`
 * / `WARREN_PLAN_RUN_TICK_MS` knobs stay scoped (mirrors scenarios
 * 26 / 27 / 29). Two project clones — one fully wired
 * (`.plot/`+`.seeds/`) and one bare — so the `project_lacks_plot`
 * arm runs against a real cloned project.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly hasSeeds?: boolean;
	readonly hasPlot?: boolean;
}

interface PlanRunRow {
	readonly id: string;
	readonly planId: string;
	readonly projectId: string;
	readonly agentName: string;
	readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	readonly plotId: string | null;
}

interface PlanRunChildRow {
	readonly planRunId: string;
	readonly seq: number;
	readonly seedId: string;
	readonly runId: string | null;
	readonly state:
		| "pending"
		| "dispatched"
		| "running"
		| "pr_open"
		| "merged"
		| "failed"
		| "skipped";
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly plotId: string | null;
}

interface CreatePlotPlanRunResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
	readonly synthesizedPlanId: string;
	readonly parentSeedId: string;
}

interface PlanRunDetailResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
	readonly runs: readonly RunRow[];
}

interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly kind: string;
	readonly payload: Record<string, unknown> | null;
}

interface ErrorEnvelope {
	readonly error?: { readonly code?: string; readonly message?: string };
}

interface PlotSnapshot {
	readonly id: string;
	readonly status: string;
}

const PLOTTED_PROJECT_URL = "https://github.com/warren-acceptance/sample-plot-plan-run-synth.git";
const BARE_PROJECT_URL = "https://github.com/warren-acceptance/sample-plot-plan-run-synth-bare.git";

// Pre-committed seeds in the plotted fixture. SEED_C is wired into
// WARREN_STUB_NO_COMMIT_SEEDS so its dispatch drives the trivial-merge
// branch (reap commitsAhead=0 → child → merged without GH polling).
const SEED_A = "ah-acc31-aaaa";
const SEED_B = "ah-acc31-bbbb";
const SEED_C = "ah-acc31-cccc";
const SEED_CLOSED = "ah-acc31-zzzz";
const SD_PLAN_REF = "pl-acc31-other";
const SEED_TS = "2026-05-18T00:00:00.000Z";

const TERMINAL_PLAN_STATES = new Set(["succeeded", "failed", "cancelled"]);
const PLAN_DEADLINE_MS = 120_000;
const POLL_INTERVAL_MS = 500;
const PLOT_FILE_POLL_TIMEOUT_MS = 10_000;
/**
 * Auto-done landing budget — the plan-run state flips to `succeeded`
 * BEFORE the transitionPlot hook writes. 1.5s ≫ 1s coordinator tick.
 * Mirrors scenarios 27/29 (`POST_PLAN_FLUSH_MS`).
 */
const POST_PLAN_FLUSH_MS = 1_500;

export const scenario: Scenario = {
	id: "31",
	title:
		"Plot → synthesized plan-run roundtrip — POST /plot-plan-runs synthesizes a plan from open seeds_issue attachments, walks children to merged, auto-dones the Plot; re-dispatch mints a second plan; typed 4xx for malformed plot_id, missing .plot/, and zero dispatchable seeds",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-31-"));
		const plottedFixture = join(scenarioRoot, "plotted-fixture");
		const bareFixture = join(scenarioRoot, "bare-fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");

		const { happyPlotId, emptyPlotId } = await buildPlottedFixture({
			fixturePath: plottedFixture,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
		});
		await buildBareFixture({
			fixturePath: bareFixture,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
		});
		await writeGitConfigRedirects(gitConfigPath, [
			{ harnessGitConfigPath: join(ctx.tmp, "git-config") },
			{ fakeUrl: PLOTTED_PROJECT_URL, localPath: plottedFixture },
			{ fakeUrl: BARE_PROJECT_URL, localPath: bareFixture },
		]);
		ctx.logger.debug(
			`scenario-31: plottedFixture=${plottedFixture} happyPlot=${happyPlotId} emptyPlot=${emptyPlotId}`,
		);

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					WARREN_STUB_SLEEP_MS: "0",
					// Stub GH PR-open + checkPullRequestMerged so the
					// coordinator short-circuits to merged without a real
					// GitHub fixture (matches scenarios 26 / 27 / 29).
					WARREN_GH_FETCH_OVERRIDE: "merged",
					// Drive the trivial-merge branch on SEED_C: stub agent
					// skips workspace mutations, reap → commitsAhead=0, the
					// coordinator advances without GH polling.
					WARREN_STUB_NO_COMMIT_SEEDS: SEED_C,
					WARREN_PLAN_RUN_TICK_MS: "1000",
				},
			});
			ctx.logger.info(`scenario-31: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const plotted = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PLOTTED_PROJECT_URL },
			});
			assertEqual(plotted.hasSeeds, true, "plotted project surfaces hasSeeds=true (warren-9990)");
			assertEqual(plotted.hasPlot, true, "plotted project surfaces hasPlot=true (warren-4e20)");

			const bare = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: BARE_PROJECT_URL },
			});
			assertEqual(bare.hasPlot, false, "bare project surfaces hasPlot=false");

			// =====================================================
			// Negative paths (cheap — exercise before walking a plan).
			// =====================================================

			// (a) Malformed plot_id → 400 plot_id_invalid (warren-bae5).
			// Same regex gate POST /plan-runs uses; verified up-front so
			// a typo never reaches the project lookup.
			{
				const res = await http.request("POST", "/plot-plan-runs", {
					body: {
						plot_id: "not-a-plot-id",
						project_id: plotted.id,
						agent_name: "claude-code",
					},
				});
				assertEqual(
					res.status,
					400,
					"malformed plot_id → 400 (plot_id_invalid handler-edge reject)",
				);
				const body = (await res.json()) as ErrorEnvelope;
				assertEqual(
					body.error?.code,
					"plot_id_invalid",
					`malformed plot_id error code; got '${body.error?.code}'`,
				);
			}

			// (b) Well-formed but non-existent plot_id → 400
			// plot_id_not_found (plotResolver rejects).
			{
				const res = await http.request("POST", "/plot-plan-runs", {
					body: {
						plot_id: "plot-deadbeef",
						project_id: plotted.id,
						agent_name: "claude-code",
					},
				});
				assertEqual(
					res.status,
					400,
					"non-existent plot_id → 400 (plot_id_not_found resolver reject)",
				);
				const body = (await res.json()) as ErrorEnvelope;
				assertEqual(
					body.error?.code,
					"plot_id_not_found",
					`non-existent plot_id error code; got '${body.error?.code}'`,
				);
			}

			// (c) Bare project (no .plot/) → 400 project_lacks_plot.
			{
				const res = await http.request("POST", "/plot-plan-runs", {
					body: {
						plot_id: happyPlotId,
						project_id: bare.id,
						agent_name: "claude-code",
					},
				});
				assertEqual(res.status, 400, "bare project → 400 (project_lacks_plot handler-edge reject)");
				const body = (await res.json()) as ErrorEnvelope;
				assertEqual(
					body.error?.code,
					"project_lacks_plot",
					`bare project error code; got '${body.error?.code}'`,
				);
			}

			// (d) Plot with zero dispatchable attachments → 400
			// no_dispatchable_seeds. The empty plot was seeded with one
			// closed seed_issue + one sd_plan-shaped seeds_issue and no
			// open attachments — both filtered, leaving an empty
			// candidate list.
			{
				const res = await http.request("POST", "/plot-plan-runs", {
					body: {
						plot_id: emptyPlotId,
						project_id: plotted.id,
						agent_name: "claude-code",
					},
				});
				assertEqual(
					res.status,
					400,
					"empty-candidates plot → 400 (no_dispatchable_seeds handler-edge reject)",
				);
				const body = (await res.json()) as ErrorEnvelope;
				assertEqual(
					body.error?.code,
					"no_dispatchable_seeds",
					`empty-candidates error code; got '${body.error?.code}'`,
				);
			}

			// =====================================================
			// Happy path — synthesize + walk to completion + auto-done.
			// =====================================================

			const plotEventsPath = join(plotted.localPath, ".plot", `${happyPlotId}.events.jsonl`);
			const plotJsonPath = join(plotted.localPath, ".plot", `${happyPlotId}.json`);

			const created = await http.expectJson<CreatePlotPlanRunResponse>(
				"POST",
				"/plot-plan-runs",
				201,
				{
					body: {
						plot_id: happyPlotId,
						project_id: plotted.id,
						agent_name: "claude-code",
						prompt_template: "closeseed {seed_id}",
					},
				},
			);
			assertEqual(
				created.planRun.plotId,
				happyPlotId,
				"synthesis happy path: response planRun.plotId matches the dispatched plotId",
			);
			assertEqual(
				created.planRun.state,
				"queued",
				"synthesis happy path: planRun state starts as 'queued'",
			);
			assertTrue(
				/^pl-[a-z0-9]+$/i.test(created.synthesizedPlanId),
				`synthesis happy path: synthesizedPlanId is pl-* shaped (got '${created.synthesizedPlanId}')`,
			);
			assertTrue(
				typeof created.parentSeedId === "string" && created.parentSeedId.length > 0,
				`synthesis happy path: parentSeedId is a non-empty string (got '${created.parentSeedId}')`,
			);

			// Children equal the OPEN, non-sd_plan attachments only —
			// closed (SEED_CLOSED) and sd_plan (SD_PLAN_REF) refs were
			// filtered at the handler edge (steps 6 + 7 in SPEC §11.Q).
			const childSeeds = created.children.map((c) => c.seedId).sort();
			assertEqual(
				JSON.stringify(childSeeds),
				JSON.stringify([SEED_A, SEED_B, SEED_C].sort()),
				`synthesis happy path: children adopt open non-sd_plan attachments only (got [${childSeeds.join(", ")}])`,
			);

			const planRunId = created.planRun.id;
			ctx.logger.debug(`scenario-31: planRunId=${planRunId} synth=${created.synthesizedPlanId}`);

			// Walk to terminal. Three children: two regular + one
			// trivial-merge (SEED_C via WARREN_STUB_NO_COMMIT_SEEDS).
			const finished = await waitForPlanState(http, planRunId, "succeeded", PLAN_DEADLINE_MS);
			assertEqual(
				finished.planRun.state,
				"succeeded",
				"synthesis happy path: plan-run reaches terminal 'succeeded'",
			);
			assertEqual(finished.children.length, 3, "synthesis happy path: still 3 children");
			for (const child of finished.children) {
				assertEqual(
					child.state,
					"merged",
					`synthesis happy path: child seq=${child.seq} (seed=${child.seedId}) ended in 'merged'`,
				);
				assertTrue(
					typeof child.runId === "string" && child.runId.length > 0,
					`synthesis happy path: child seq=${child.seq} has a runId`,
				);
			}
			assertEqual(finished.runs.length, 3, "synthesis happy path: detail fans out 3 runs");
			for (const run of finished.runs) {
				assertEqual(
					run.plotId,
					happyPlotId,
					`synthesis happy path: child run ${run.id} carries plotId=${happyPlotId} (spawn.plotId inherited from plan-run)`,
				);
			}

			// Wait one tick past the plan_succeeded arm so the
			// transitionPlot write lands; refreshProjectClone snapshots
			// .plot/ across resets (warren-fdd2) so a single post-
			// completion read sees every host-side append.
			await sleep(POST_PLAN_FLUSH_MS);
			const parsedSeen = parsePlotLines(await readPlotEventLines(plotEventsPath));

			// plan_run_dispatched lands at POST time (warren-b89f /
			// pl-7937 step 4 — inherited unchanged by §11.Q step 9).
			const planRunDispatched = parsedSeen.find(
				(ev) =>
					ev.type === "plan_run_dispatched" &&
					(ev.data as { plan_run_id?: unknown } | null)?.plan_run_id === planRunId,
			);
			if (planRunDispatched === undefined) {
				throw new AcceptanceError(
					`synthesis happy path: missing 'plan_run_dispatched' for planRun=${planRunId} in on-disk events.jsonl (${parsedSeen.length} parsed events)`,
				);
			}
			assertEqual(
				planRunDispatched.actor,
				"user:operator",
				"synthesis happy path: plan_run_dispatched actor defaults to user:operator",
			);

			// Per-child run_dispatched events accumulate for every child
			// (Phase 1 host-side appender — independent of commitsAhead,
			// so SEED_C's trivial-merge also fires).
			const runDispatchedSet = new Set(
				parsedSeen
					.filter((ev) => ev.type === "run_dispatched")
					.map((ev) => (ev.data as { run_id?: unknown } | null)?.run_id)
					.filter((id): id is string => typeof id === "string"),
			);
			const missingRunDispatched = finished.runs.filter((r) => !runDispatchedSet.has(r.id));
			if (missingRunDispatched.length > 0) {
				throw new AcceptanceError(
					`synthesis happy path: missing per-child 'run_dispatched' for runIds=[${missingRunDispatched
						.map((r) => r.id)
						.join(", ")}]; saw runIds=[${[...runDispatchedSet].join(", ")}]`,
				);
			}

			// Auto-done: persisted .json snapshot + status_changed event.
			const finalSnapshot = await waitForPlotStatus(
				plotJsonPath,
				"done",
				PLOT_FILE_POLL_TIMEOUT_MS,
			);
			assertEqual(
				finalSnapshot.status,
				"done",
				"synthesis happy path: .plot/<id>.json status flipped to 'done'",
			);
			const parsedAfterDone = parsePlotLines(await readPlotEventLines(plotEventsPath));
			const statusChanged = parsedAfterDone.find((ev) => {
				if (ev.type !== "status_changed") return false;
				if (ev.actor !== "user:operator") return false;
				const data = ev.data as { to?: unknown; status?: unknown } | null;
				const to = data?.to ?? data?.status;
				return to === "done";
			});
			if (statusChanged === undefined) {
				throw new AcceptanceError(
					"synthesis happy path: missing 'status_changed' → done by user:operator in on-disk events.jsonl",
				);
			}

			const planRunEvents = await fetchAllPlanRunEvents(http, planRunId);
			const planKinds = new Set(planRunEvents.map((e) => e.kind));
			if (!planKinds.has("plan_run.plot_auto_done")) {
				throw new AcceptanceError(
					`synthesis happy path: missing 'plan_run.plot_auto_done' on plan-run stream; saw kinds=[${[...planKinds].join(", ")}]`,
				);
			}
			for (const forbidden of [
				"plan_run.plot_status_skipped",
				"plan_run.plot_auto_done_failed",
				"plan_run.plot_append_failed",
			] as const) {
				if (planKinds.has(forbidden)) {
					throw new AcceptanceError(
						`synthesis happy path: unexpected '${forbidden}' on plan-run stream — happy path should hit only plan_run.plot_auto_done`,
					);
				}
			}

			// SOFT_SKIP (warren-a346, shared with scenarios 25/27/29): the
			// per-child sandbox carrying PLOT_ID + PLOT_ACTOR. burrow-cli
			// 0.3.x doesn't yet forward body.env into the sandbox, so the
			// claude-stub agent's `PLOT_ID=<id>` echo never fires. Flip
			// to a hard AcceptanceError when warren-a346 lands and the
			// burrow-cli pin advances.
			const childRunEvents = await Promise.all(
				finished.runs.map(async (r) => ({
					runId: r.id,
					events: await fetchAllRunEvents(http, r.id),
				})),
			);
			const missingEnvEcho: string[] = [];
			for (const { runId, events } of childRunEvents) {
				if (findTextEvent(events, `PLOT_ID=${happyPlotId}`) === undefined) {
					missingEnvEcho.push(runId);
				}
			}
			if (missingEnvEcho.length > 0) {
				ctx.logger.warn(
					`scenario-31 (warren-a346 pending): ${missingEnvEcho.length}/${finished.runs.length} child run(s) missing 'PLOT_ID=${happyPlotId}' echo — burrow does not yet forward body.env into the sandbox; runIds=${missingEnvEcho.join(", ")}`,
				);
			}

			// =====================================================
			// Re-dispatch (SPEC §11.Q acceptance #6).
			// Second POST against the same Plot mints a NEW synthesized
			// plan (different plan_id, different parent seed id). We
			// don't walk the second PlanRun to completion — the Plot is
			// already `done` and the auto-done hook would correctly
			// no-op or surface plan_run.plot_status_skipped, which is a
			// different code path. Verifying the dispatch returns 201
			// with a fresh synthesizedPlanId proves the "no clobber, no
			// idempotency" contract.
			// =====================================================
			const second = await http.expectJson<CreatePlotPlanRunResponse>(
				"POST",
				"/plot-plan-runs",
				201,
				{
					body: {
						plot_id: happyPlotId,
						project_id: plotted.id,
						agent_name: "claude-code",
						prompt_template: "closeseed {seed_id}",
					},
				},
			);
			assertEqual(
				second.planRun.plotId,
				happyPlotId,
				"re-dispatch: second planRun also carries plotId",
			);
			assertTrue(
				second.synthesizedPlanId !== created.synthesizedPlanId,
				`re-dispatch: second synthesizedPlanId differs from first (got '${second.synthesizedPlanId}' vs '${created.synthesizedPlanId}')`,
			);
			assertTrue(
				second.parentSeedId !== created.parentSeedId,
				`re-dispatch: second parentSeedId differs from first (got '${second.parentSeedId}' vs '${created.parentSeedId}')`,
			);
			// Cancel the second PlanRun so the scenario teardown isn't
			// racing the coordinator's tick loop (Plot is `done`, the
			// auto-done arm will skip cleanly, but cancellation is the
			// cheaper exit).
			await http
				.request("POST", `/plan-runs/${encodeURIComponent(second.planRun.id)}/cancel`)
				.catch(() => undefined);
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
		}
	},
};

interface BuildPlottedFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
}

interface BuildPlottedFixtureResult {
	readonly happyPlotId: string;
	readonly emptyPlotId: string;
}

/**
 * Build the `.seeds/`-and-`.plot/`-enabled fixture. Two Plots:
 *   - happy: 3 open seeds_issue + 1 closed seeds_issue + 1 sd_plan-
 *     shaped seeds_issue attached. Three are dispatchable after
 *     filtering; the 4th (closed) and 5th (`pl-*` ref) drop out.
 *   - empty: 1 closed seeds_issue + 1 sd_plan-shaped seeds_issue —
 *     both filtered, leaving zero candidates so the synthesis handler
 *     surfaces NoDispatchableSeedsError.
 */
async function buildPlottedFixture(
	input: BuildPlottedFixtureInput,
): Promise<BuildPlottedFixtureResult> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });
	await mkdir(join(input.fixturePath, ".seeds"), { recursive: true });

	const burrowToml = await readFile(join(input.sourceSamplePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceSamplePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	await copyFile(
		join(input.sourceSamplePath, "tools", "claude-code-stub-agent.sh"),
		join(input.fixturePath, "tools", "claude-code-stub-agent.sh"),
	);
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# warren acceptance plot-plan-run synthesis fixture\n\nUsed by scripts/acceptance/scenarios/31-plot-plan-run-synthesis.ts.\n",
	);

	await writeFile(
		join(input.fixturePath, ".seeds", "config.yaml"),
		`project: "sample-plot-plan-run-synth"\nversion: "1"\nmax_plan_depth: 3\n`,
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "issues.jsonl"),
		[
			seedRowOpen(SEED_A),
			seedRowOpen(SEED_B),
			seedRowOpen(SEED_C),
			seedRowClosed(SEED_CLOSED),
		].join(""),
	);
	// Pre-seed `.seeds/plans.jsonl` empty — the synthesizer appends to
	// it at POST time. sd plan show would reject a non-existent file,
	// but `sd plan submit` creates it idempotently.
	await writeFile(join(input.fixturePath, ".seeds", "plans.jsonl"), "");

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);

	const plotEnv: Record<string, string> = { ...env, PLOT_ACTOR: "user:acceptance" };

	// Happy Plot: 3 open + 1 closed + 1 sd_plan-shaped attachments.
	await runIn(input.fixturePath, ["plot", "init", "scenario-31-happy"], plotEnv);
	const happyList = await runIn(input.fixturePath, ["plot", "list", "--json"], plotEnv);
	const happyPlots = JSON.parse(happyList.stdout) as ReadonlyArray<{ id: string }>;
	const happyPlotId = happyPlots[0]?.id;
	if (happyPlotId === undefined) {
		throw new AcceptanceError(
			`scenario-31 fixture: happy plot init missing id (${happyList.stdout})`,
		);
	}
	await runIn(input.fixturePath, ["plot", "status", happyPlotId, "ready"], plotEnv);
	await runIn(input.fixturePath, ["plot", "status", happyPlotId, "active"], plotEnv);
	await runIn(
		input.fixturePath,
		["plot", "attach", happyPlotId, `seeds_issue:${SEED_A}`, "--role", "primary"],
		plotEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", happyPlotId, `seeds_issue:${SEED_B}`, "--role", "primary"],
		plotEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", happyPlotId, `seeds_issue:${SEED_C}`, "--role", "primary"],
		plotEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", happyPlotId, `seeds_issue:${SEED_CLOSED}`, "--role", "context"],
		plotEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", happyPlotId, `seeds_issue:${SD_PLAN_REF}`, "--role", "context"],
		plotEnv,
	);

	// Empty-candidates Plot — both attachments will be filtered.
	await runIn(input.fixturePath, ["plot", "init", "scenario-31-empty"], plotEnv);
	const allList = await runIn(input.fixturePath, ["plot", "list", "--json"], plotEnv);
	const allPlots = JSON.parse(allList.stdout) as ReadonlyArray<{ id: string }>;
	const emptyPlotId = allPlots.map((p) => p.id).find((id) => id !== happyPlotId);
	if (emptyPlotId === undefined) {
		throw new AcceptanceError(
			`scenario-31 fixture: empty plot init missing distinct id (${allList.stdout})`,
		);
	}
	await runIn(input.fixturePath, ["plot", "status", emptyPlotId, "ready"], plotEnv);
	await runIn(input.fixturePath, ["plot", "status", emptyPlotId, "active"], plotEnv);
	await runIn(
		input.fixturePath,
		["plot", "attach", emptyPlotId, `seeds_issue:${SEED_CLOSED}`, "--role", "context"],
		plotEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", emptyPlotId, `seeds_issue:${SD_PLAN_REF}`, "--role", "context"],
		plotEnv,
	);

	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(
		input.fixturePath,
		["git", "commit", "-m", "init: plot-plan-run synthesis acceptance fixture"],
		env,
	);

	return { happyPlotId, emptyPlotId };
}

interface BuildBareFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
}

/**
 * Bare fixture: a project clone with no `.plot/` and no `.seeds/`.
 * Used to exercise the `project_lacks_plot` arm — the
 * `hasPlot` gate fires before the seeds-cli reachability check.
 */
async function buildBareFixture(input: BuildBareFixtureInput): Promise<void> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });

	const burrowToml = await readFile(join(input.sourceSamplePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceSamplePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	await copyFile(
		join(input.sourceSamplePath, "tools", "claude-code-stub-agent.sh"),
		join(input.fixturePath, "tools", "claude-code-stub-agent.sh"),
	);
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# warren acceptance plot-plan-run synthesis bare fixture\n\nUsed by scripts/acceptance/scenarios/31-plot-plan-run-synthesis.ts (project_lacks_plot arm).\n",
	);

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);
	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(input.fixturePath, ["git", "commit", "-m", "init: bare plot-plan-run fixture"], env);
}

interface GitConfigEntry {
	readonly harnessGitConfigPath?: string;
	readonly fakeUrl?: string;
	readonly localPath?: string;
}

/**
 * Write a layered git-config: append the harness's existing
 * insteadOf rules (so cn/sd clones still resolve), then append
 * fresh insteadOf rules for each fixture URL → local path mapping.
 */
async function writeGitConfigRedirects(
	configPath: string,
	entries: readonly GitConfigEntry[],
): Promise<void> {
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.harnessGitConfigPath !== undefined) {
			if (existsSync(entry.harnessGitConfigPath)) {
				const body = await readFile(entry.harnessGitConfigPath, "utf8");
				out.push(body.trimEnd());
			}
			continue;
		}
		if (entry.fakeUrl !== undefined && entry.localPath !== undefined) {
			out.push(`[url "${entry.localPath}"]`);
			out.push(`\tinsteadOf = ${entry.fakeUrl}`);
		}
	}
	out.push("");
	await writeFile(configPath, `${out.join("\n")}\n`);
}

function seedRowOpen(id: string): string {
	const row = {
		id,
		title: `scenario-31 ${id}`,
		status: "open",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
	};
	return `${JSON.stringify(row)}\n`;
}

function seedRowClosed(id: string): string {
	const row = {
		id,
		title: `scenario-31 ${id}`,
		status: "closed",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		closedAt: SEED_TS,
	};
	return `${JSON.stringify(row)}\n`;
}

async function waitForPlanState(
	http: WarrenHttp,
	planRunId: string,
	target: string,
	timeoutMs: number,
): Promise<PlanRunDetailResponse> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<PlanRunDetailResponse>(
			"GET",
			`/plan-runs/${encodeURIComponent(planRunId)}`,
			200,
		);
		last = row.planRun.state;
		if (row.planRun.state === target) return row;
		if (TERMINAL_PLAN_STATES.has(row.planRun.state)) {
			throw new AcceptanceError(
				`plan-run ${planRunId}: expected '${target}', reached terminal '${row.planRun.state}'`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`plan-run ${planRunId} did not reach '${target}' within ${timeoutMs}ms (last=${last})`,
	);
}

async function fetchAllPlanRunEvents(http: WarrenHttp, planRunId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/plan-runs/${encodeURIComponent(planRunId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

async function fetchAllRunEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

function findTextEvent(events: readonly EventRow[], needle: string): EventRow | undefined {
	return events.find(
		(e) =>
			e.kind === "text" &&
			typeof e.payload?.text === "string" &&
			(e.payload.text as string).includes(needle),
	);
}

async function readPlotEventLines(path: string): Promise<ReadonlySet<string>> {
	const seen = new Set<string>();
	try {
		const body = await readFile(path, "utf8");
		for (const line of body.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			seen.add(trimmed);
		}
	} catch {
		// File not yet present — return empty set.
	}
	return seen;
}

interface ParsedPlotEvent {
	readonly type: string;
	readonly actor: string;
	readonly at: string;
	readonly data: unknown;
}

function parsePlotLines(lines: ReadonlySet<string>): ParsedPlotEvent[] {
	const out: ParsedPlotEvent[] = [];
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const row = parsed as { type?: unknown; actor?: unknown; at?: unknown; data?: unknown };
		if (
			typeof row.type !== "string" ||
			typeof row.actor !== "string" ||
			typeof row.at !== "string"
		) {
			continue;
		}
		out.push({ type: row.type, actor: row.actor, at: row.at, data: row.data ?? null });
	}
	return out;
}

async function readPlotSnapshot(path: string): Promise<PlotSnapshot> {
	const body = await readFile(path, "utf8");
	return JSON.parse(body) as PlotSnapshot;
}

async function waitForPlotStatus(
	path: string,
	target: string,
	timeoutMs: number,
): Promise<PlotSnapshot> {
	const start = Date.now();
	let lastStatus = "unknown";
	while (Date.now() - start < timeoutMs) {
		try {
			const snap = await readPlotSnapshot(path);
			lastStatus = snap.status;
			if (snap.status === target) return snap;
		} catch {
			// not yet present or mid-write
		}
		await sleep(100);
	}
	throw new AcceptanceError(
		`Plot at ${path} did not reach status='${target}' within ${timeoutMs}ms (last=${lastStatus})`,
	);
}

interface RunResult {
	stdout: string;
	stderr: string;
}

async function runIn(
	cwd: string,
	cmd: readonly string[],
	env: Record<string, string>,
): Promise<RunResult> {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new AcceptanceError(
			`scenario-31 command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
		);
	}
	return { stdout, stderr };
}

function withGitIdentity(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "/tmp",
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
