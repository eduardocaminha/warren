/**
 * `warren run <agent> <project> -p "..."` — one-shot, no UI.
 *
 * Spawns a run via the §4.3 composition flow, opens a stream bridge so
 * events land in the warren events table, and tails them as NDJSON to
 * stdout until the burrow run terminates. When the bridge ends, fetches
 * the burrow run's terminal state, runs `reapRun` to finalize the warren
 * row + roundtrip mulch/seeds, and exits with a code that mirrors the
 * outcome (succeeded → 0, failed/cancelled → 1).
 *
 * Why bridge + tail rather than just `client.http.runs.stream` directly:
 * keeping the events going through the warren bridge means a CLI-driven
 * run lands in the same events table the HTTP UI would read, so an
 * operator can switch surfaces mid-run without losing scrollback. It
 * also ensures the dedup-by-seq logic exercises the same code path as
 * the server.
 *
 * SIGINT during a live run aborts the local tail but does not cancel
 * the burrow run — that's what `warren cancel` (deferred to V2) or the
 * UI does. The CLI prints a hint on first SIGINT, exits on the second.
 */

import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RunTerminalState } from "../../db/schema.ts";
import {
	type AutoOpenPrConfig,
	type BridgeRunStreamResult,
	bridgeRunStream,
	loadAutoOpenPrConfigFromEnv,
	RunEventBroker,
	reapRun,
	type SpawnRunResult,
	spawnRun,
	tailRunEvents,
} from "../../runs/index.ts";
import type { CliContext } from "../output.ts";
import { formatError, writeJsonLine } from "../output.ts";

export interface RunArgs {
	readonly agent: string;
	readonly project: string;
	readonly prompt: string;
	readonly trigger?: string;
}

export interface RunDeps {
	readonly repos: Repos;
	readonly burrowClient: BurrowClient;
	/** Optional broker injection — defaults to a fresh broker per run. */
	readonly broker?: RunEventBroker;
	/** Override the bridge factory (tests). Defaults to the live `bridgeRunStream`. */
	readonly bridge?: typeof bridgeRunStream;
	/** Override the spawn function (tests). Defaults to the live `spawnRun`. */
	readonly spawn?: typeof spawnRun;
	/** Override reap (tests). Defaults to the live `reapRun`. */
	readonly reap?: typeof reapRun;
	/** Override the burrow run state lookup (tests). */
	readonly fetchBurrowRunState?: (burrowRunId: string) => Promise<RunTerminalState>;
	/**
	 * Auto-open-PR config (warren-f6af). Defaults to
	 * `loadAutoOpenPrConfigFromEnv(process.env)`. Tests pass an explicit
	 * `{ enabled: false, ... }` to keep the network out of the surface.
	 */
	readonly autoOpenPr?: AutoOpenPrConfig;
}

export interface RunResult {
	readonly exitCode: number;
	readonly runId?: string;
	readonly state?: RunTerminalState;
}

export async function runRun(
	context: CliContext,
	deps: RunDeps,
	args: RunArgs,
): Promise<RunResult> {
	if (args.agent === "" || args.project === "" || args.prompt === "") {
		context.stdio.stderr.write("warren: agent, project, and --prompt are all required\n");
		return { exitCode: 2 };
	}

	const broker = deps.broker ?? new RunEventBroker();
	const spawn = deps.spawn ?? spawnRun;
	const bridge = deps.bridge ?? bridgeRunStream;
	const reap = deps.reap ?? reapRun;
	const autoOpenPr = deps.autoOpenPr ?? loadAutoOpenPrConfigFromEnv();
	const fetchBurrowRunState =
		deps.fetchBurrowRunState ?? defaultFetchBurrowRunState(deps.burrowClient);

	let spawnResult: SpawnRunResult;
	try {
		spawnResult = await spawn({
			repos: deps.repos,
			burrowClient: deps.burrowClient,
			agentName: args.agent,
			projectId: args.project,
			prompt: args.prompt,
			trigger: args.trigger ?? "cli",
			...(context.now !== undefined ? { now: context.now } : {}),
		});
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: 1 };
	}

	const runId = spawnResult.run.id;
	writeJsonLine(context.stdio.stdout, {
		event: "run.spawned",
		runId,
		agent: spawnResult.run.agentName,
		project: spawnResult.run.projectId,
		burrowId: spawnResult.burrow.id,
		burrowRunId: spawnResult.burrowRun.id,
	});

	const bridgeAbort = new AbortController();
	const tailAbort = new AbortController();

	const bridgePromise: Promise<BridgeRunStreamResult> = bridge({
		runId,
		burrowRunId: spawnResult.burrowRun.id,
		repos: deps.repos,
		broker,
		burrowClient: deps.burrowClient,
		signal: bridgeAbort.signal,
	});

	// When the bridge finishes (burrow run reached a terminal state and
	// the stream closed), close the broker so the tail iterator returns.
	const bridgeDone = bridgePromise.finally(() => {
		broker.close(runId);
	});

	try {
		for await (const event of tailRunEvents({
			runId,
			repos: { events: deps.repos.events },
			broker,
			follow: true,
			signal: tailAbort.signal,
		})) {
			writeJsonLine(context.stdio.stdout, {
				event: "run.event",
				runId,
				seq: event.burrowEventSeq,
				ts: event.ts,
				kind: event.kind,
				stream: event.stream,
				payload: event.payloadJson,
			});
		}
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		bridgeAbort.abort();
		await bridgeDone.catch(() => undefined);
		return { exitCode: 1, runId };
	}

	await bridgeDone.catch(() => undefined);

	let outcome: RunTerminalState;
	try {
		outcome = await fetchBurrowRunState(spawnResult.burrowRun.id);
	} catch (err) {
		context.stdio.stderr.write(`warren: failed to read burrow run state: ${formatError(err)}\n`);
		// Best-effort: assume failed so the warren row finalizes rather than stays running.
		outcome = "failed";
	}

	let finalState: RunTerminalState = outcome;
	try {
		const reaped = await reap({
			runId,
			outcome,
			repos: deps.repos,
			burrowClient: deps.burrowClient,
			broker,
			autoOpenPr,
			...(context.now !== undefined ? { now: context.now } : {}),
		});
		finalState = reaped.state;
		writeJsonLine(context.stdio.stdout, {
			event: "run.reaped",
			runId,
			state: finalState,
			alreadyTerminal: reaped.alreadyTerminal,
			mulch: {
				updated: reaped.mulchUpdated,
				skipped: reaped.mulchSkipped,
				appended: reaped.mulchAppended,
			},
			seedsClosed: reaped.seedsClosed,
			branchPushed: reaped.branchPushed,
			commitsAhead: reaped.commitsAhead,
			prUrl: reaped.prUrl,
			errors: reaped.errors,
		});
	} catch (err) {
		context.stdio.stderr.write(`warren: reap failed: ${formatError(err)}\n`);
		return { exitCode: 1, runId, state: outcome };
	}

	return {
		exitCode: finalState === "succeeded" ? 0 : 1,
		runId,
		state: finalState,
	};
}

function defaultFetchBurrowRunState(
	client: BurrowClient,
): (burrowRunId: string) => Promise<RunTerminalState> {
	return async (burrowRunId) => {
		const row = await withTransportMapping(client.config, () => client.http.runs.get(burrowRunId));
		const state = row.state;
		if (state === "succeeded" || state === "failed" || state === "cancelled") return state;
		// Stream returned but burrow says not-yet-terminal — race or stale read;
		// treat as failed so warren transitions out of running and the operator
		// gets a non-zero exit. Reap's emit("reap_failed", ...) will surface it.
		return "failed";
	};
}
