/**
 * Shared helpers + fixtures for the `POST /plot-plan-runs` test suites
 * (warren-59db / pl-7c4f). Extracted from plot-plan-runs.test.ts so the
 * happy-path/filter tests (plot-plan-runs.test.ts) and the
 * validation/error tests (plot-plan-runs.validation.test.ts) share a
 * single copy of every stub/fixture. Mirrors the precedent of
 * src/diagnostics/checks.test-helpers.ts (warren-7a15) and
 * src/server/handlers/projects.test-helpers.ts (warren-a715).
 */

import type { Attachment } from "@os-eco/plot-cli";
import type { Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type { PlanRunPlotAppender } from "../../plan-runs/plot-appender.ts";
import type {
	PlanSynthesizer,
	SynthesizePlanInput,
	SynthesizePlanResult,
} from "../../plot-plan-runs/index.ts";
import type {
	PlotReader,
	PlotResolver,
	ReadPlotRequest,
	ReadPlotResult,
} from "../../plots/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { createBridgeRegistry } from "../bridges.ts";
import type { BridgeRegistry, Logger, ServerDeps } from "../types.ts";
import {
	makeSdSpawn,
	planShowResult,
	poolFor,
	type SdCall,
	seedShowResult,
	silentLogger,
	tcpUrl,
} from "./handler-test-utils.ts";

export type { SdCall };
export { makeSdSpawn, planShowResult, seedShowResult, silentLogger, tcpUrl };

export function makeAttachment(
	id: string,
	type: Attachment["type"],
	ref: string,
	role = "tracks",
): Attachment {
	return {
		id,
		type,
		ref,
		role,
		added_at: "2026-05-19T00:00:00.000Z",
		added_by: "user:operator",
	};
}

export function makePlotReader(envelope: ReadPlotResult): PlotReader {
	return {
		async read(_input: ReadPlotRequest) {
			return envelope;
		},
	};
}

export function makePlotResolver(map: Record<string, ProjectRow>): PlotResolver {
	return {
		async resolve(plotId) {
			return map[plotId] ?? null;
		},
	};
}

export interface SynthesizeCall extends SynthesizePlanInput {}

export function makeSynthesizer(opts: {
	calls?: SynthesizeCall[];
	result?: SynthesizePlanResult;
	error?: Error;
}): PlanSynthesizer {
	const calls = opts.calls ?? [];
	return {
		async synthesize(input) {
			calls.push(input);
			if (opts.error) throw opts.error;
			return (
				opts.result ?? {
					parentSeedId: "wa-syn",
					planId: "pl-syn",
					children: [...input.candidateSeedIds],
				}
			);
		},
	};
}

export interface BuildDepsInput {
	repos: Repos;
	sdSpawn: import("../../projects/clone.ts").SpawnFn;
	bridges?: BridgeRegistry;
	planRunPlotAppender?: PlanRunPlotAppender;
	planSynthesizer?: PlanSynthesizer;
	plotReader?: PlotReader;
	plotResolver?: PlotResolver;
	logger?: Logger;
}

export async function depsFor(input: BuildDepsInput): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const pool = await poolFor(input.repos);
	return {
		repos: input.repos,
		burrowClientPool: pool,
		broker,
		bridges:
			input.bridges ??
			createBridgeRegistry({
				repos: input.repos,
				broker,
				burrowClientPool: pool,
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: input.logger ?? silentLogger,
		uiDistDir: null,
		seedsCli: { sdBinary: "sd", spawn: input.sdSpawn },
		...(input.planRunPlotAppender !== undefined
			? { planRunPlotAppender: input.planRunPlotAppender }
			: {}),
		...(input.planSynthesizer !== undefined ? { planSynthesizer: input.planSynthesizer } : {}),
		...(input.plotReader !== undefined ? { plotReader: input.plotReader } : {}),
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
	};
}

export function plotEnvelope(opts: { attachments: Attachment[]; id?: string }): ReadPlotResult {
	return {
		id: opts.id ?? "plot-deadbeef",
		name: "Test Plot",
		status: "active",
		intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
		attachments: opts.attachments,
		event_log: [],
	};
}
