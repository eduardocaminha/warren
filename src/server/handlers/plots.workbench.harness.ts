import type { PlotEvent } from "@os-eco/plot-cli";
import type { Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type {
	AnswerPlotQuestionRequest,
	AnswerPlotQuestionResult,
	PlotAggregator,
	PlotQuestionAnswerer,
	PlotResolver,
	PlotSummary,
} from "../../plots/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { createBridgeRegistry } from "../bridges.ts";
import type { ServerDeps } from "../types.ts";
import { poolFor, silentLogger, tcpUrl } from "./handler-test-utils.ts";

export { silentLogger, tcpUrl };

export interface BuildDepsInput {
	repos: Repos;
	plotAggregator?: PlotAggregator;
	plotResolver?: PlotResolver;
	plotQuestionAnswerer?: PlotQuestionAnswerer;
}

export async function depsFor(input: BuildDepsInput): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const pool = await poolFor(input.repos);
	return {
		repos: input.repos,
		burrowClientPool: pool,
		broker,
		bridges: createBridgeRegistry({
			repos: input.repos,
			broker,
			burrowClientPool: pool,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(input.plotAggregator !== undefined ? { plotAggregator: input.plotAggregator } : {}),
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
		...(input.plotQuestionAnswerer !== undefined
			? { plotQuestionAnswerer: input.plotQuestionAnswerer }
			: {}),
	};
}

export function fakeResolver(map: Record<string, ProjectRow | null>): {
	resolver: PlotResolver;
	calls: string[];
} {
	const calls: string[] = [];
	const resolver: PlotResolver = {
		async resolve(plotId) {
			calls.push(plotId);
			return map[plotId] ?? null;
		},
	};
	return { resolver, calls };
}

export async function seedProject(
	repos: Repos,
	over: Partial<ProjectRow> & { id: string },
): Promise<ProjectRow> {
	return repos.projects.create({
		id: over.id,
		gitUrl: over.gitUrl ?? `https://example.test/${over.id}.git`,
		defaultBranch: over.defaultBranch ?? "main",
		localPath: over.localPath ?? `/tmp/projects/${over.id}`,
		hasPlot: over.hasPlot ?? false,
		hasSeeds: over.hasSeeds ?? false,
	});
}

export function fakeAggregator(rows: readonly PlotSummary[]): {
	agg: PlotAggregator;
	state: { invalidates: string[] };
} {
	const state = { invalidates: [] as string[] };
	const agg: PlotAggregator = {
		async listSummaries() {
			return rows;
		},
		async listNeedsAttention() {
			return [];
		},
		async countNeedsAttention() {
			return 0;
		},
		invalidate(projectId) {
			if (projectId) state.invalidates.push(projectId);
		},
	};
	return { agg, state };
}

export interface FakeQuestionAnswererCall {
	readonly input: AnswerPlotQuestionRequest;
}

export function fakeQuestionAnswerer(result: AnswerPlotQuestionResult): {
	answerer: PlotQuestionAnswerer;
	calls: FakeQuestionAnswererCall[];
} {
	const calls: FakeQuestionAnswererCall[] = [];
	const answerer: PlotQuestionAnswerer = {
		async answer(input) {
			calls.push({ input });
			return result;
		},
	};
	return { answerer, calls };
}

export function answeredEvent(over: {
	question_id?: string;
	text?: string;
	at?: string;
	actor?: string;
}): PlotEvent {
	return {
		type: "question_answered",
		actor: over.actor ?? "user:alice",
		at: over.at ?? "2026-05-18T05:00:00Z",
		data: {
			question_id: over.question_id ?? "2026-05-18T04:00:00Z",
			text: over.text ?? "ship oauth",
		},
	};
}
