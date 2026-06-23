import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type {
	AppendPlanRunDispatchedInput,
	PlanRunPlotAppender,
} from "../../plan-runs/plot-appender.ts";
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

export interface BuildDepsInput {
	repos: Repos;
	sdSpawn: import("../../projects/clone.ts").SpawnFn;
	bridges?: BridgeRegistry;
	planRunPlotAppender?: PlanRunPlotAppender;
	logger?: Logger;
	plotResolver?: import("../../plots/index.ts").PlotResolver;
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
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
	};
}

export function makePlanRunAppender(
	opts: { calls?: AppendPlanRunDispatchedInput[]; throws?: Error } = {},
): PlanRunPlotAppender {
	const calls = opts.calls ?? [];
	return {
		async appendPlanRunDispatched(input) {
			calls.push(input);
			if (opts.throws) throw opts.throws;
		},
	};
}

export interface CapturedLog {
	level: "info" | "warn" | "error";
	obj: object;
	msg: string | undefined;
}

export function makeCaptureLogger(captured: CapturedLog[]): Logger {
	return {
		info(obj, msg) {
			captured.push({ level: "info", obj, msg });
		},
		warn(obj, msg) {
			captured.push({ level: "warn", obj, msg });
		},
		error(obj, msg) {
			captured.push({ level: "error", obj, msg });
		},
	};
}

export interface PlanRunFixture {
	db: WarrenDb;
	repos: Repos;
	projectId: string;
	seedyProjectId: string;
	plottedProjectId: string;
	barePlottedProjectId: string;
}

export async function setupPlanRunFixture(): Promise<PlanRunFixture> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);

	await repos.agents.upsert({
		name: "claude-code",
		renderedJson: {
			name: "claude-code",
			version: 1,
			sections: { system: "you are claude" },
			resolvedFrom: [],
			frontmatter: {},
		},
	});

	const seedy = await repos.projects.create({
		gitUrl: "https://github.com/x/seedy.git",
		localPath: "/tmp/seedy",
		defaultBranch: "main",
		hasSeeds: true,
	});
	const bare = await repos.projects.create({
		gitUrl: "https://github.com/x/bare.git",
		localPath: "/tmp/bare",
		defaultBranch: "main",
		hasSeeds: false,
	});
	const plotted = await repos.projects.create({
		gitUrl: "https://github.com/x/plotted.git",
		localPath: "/tmp/plotted",
		defaultBranch: "main",
		hasSeeds: true,
		hasPlot: true,
	});
	const barePlotted = await repos.projects.create({
		gitUrl: "https://github.com/x/bare-plotted.git",
		localPath: "/tmp/bare-plotted",
		defaultBranch: "main",
		hasSeeds: false,
		hasPlot: true,
	});
	return {
		db,
		repos,
		projectId: bare.id,
		seedyProjectId: seedy.id,
		plottedProjectId: plotted.id,
		barePlottedProjectId: barePlotted.id,
	};
}
