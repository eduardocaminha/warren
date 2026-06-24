/**
 * Unit tests for the `plan_run_dispatched` Plot append helper
 * (warren-b89f / pl-7937 step 4). Covers the best-effort wrapper's
 * fire-and-log posture; the appender's own retry-on-rebuild loop is
 * exercised against a stub at this seam — the live `UserPlotClient`
 * round-trip is asserted by scenario 27 (warren-97a3).
 */

import { describe, expect, test } from "bun:test";
import type { Logger } from "../server/types.ts";
import {
	type AppendPlanRunDispatchedInput,
	emitPlanRunDispatchedToPlot,
	type PlanRunPlotAppender,
} from "./plot-appender.ts";

interface CapturedLog {
	level: "info" | "warn" | "error";
	obj: object;
	msg: string | undefined;
}

function makeLogger(captured: CapturedLog[]): Logger {
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

function makeAppender(opts: {
	calls?: AppendPlanRunDispatchedInput[];
	throws?: Error;
	activated?: boolean;
}): PlanRunPlotAppender {
	const calls = opts.calls ?? [];
	return {
		async appendPlanRunDispatched(input) {
			calls.push(input);
			if (opts.throws) throw opts.throws;
			return { activated: opts.activated ?? false };
		},
	};
}

describe("emitPlanRunDispatchedToPlot", () => {
	test("forwards the input through to the appender on success", async () => {
		const calls: AppendPlanRunDispatchedInput[] = [];
		const captured: CapturedLog[] = [];
		await emitPlanRunDispatchedToPlot({
			appender: makeAppender({ calls }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
			planId: "pl-x",
			childrenCount: 4,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
			planId: "pl-x",
			childrenCount: 4,
		});
		expect(captured.filter((c) => c.msg === "plan_run.plot_append_failed")).toHaveLength(0);
	});

	test("logs plan_run.plot_append_failed and swallows when the appender throws", async () => {
		const captured: CapturedLog[] = [];
		await emitPlanRunDispatchedToPlot({
			appender: makeAppender({ throws: new Error("boom") }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
			planId: "pl-x",
			childrenCount: 1,
		});
		const failure = captured.find((c) => c.msg === "plan_run.plot_append_failed");
		expect(failure).toBeDefined();
		expect(failure?.level).toBe("warn");
		const obj = failure?.obj as { planRunId?: string; plotId?: string; err?: string };
		expect(obj.planRunId).toBe("plr_1");
		expect(obj.plotId).toBe("plot_x");
		expect(obj.err).toBe("boom");
	});

	test("stringifies a non-Error throw value for the log payload", async () => {
		const captured: CapturedLog[] = [];
		await emitPlanRunDispatchedToPlot({
			appender: {
				async appendPlanRunDispatched() {
					throw "stringy failure";
				},
			},
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_y",
			handle: "operator",
			planRunId: "plr_2",
			planId: "pl-y",
			childrenCount: 0,
		});
		const failure = captured.find((c) => c.msg === "plan_run.plot_append_failed");
		expect(failure).toBeDefined();
		expect((failure?.obj as { err?: string }).err).toBe("stringy failure");
	});

	test("logs plan_run.plot_activated at info when appender returns activated:true (warren-15cc)", async () => {
		const captured: CapturedLog[] = [];
		await emitPlanRunDispatchedToPlot({
			appender: makeAppender({ activated: true }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_z",
			handle: "bob",
			planRunId: "plr_3",
			planId: "pl-z",
			childrenCount: 2,
		});
		const info = captured.find((c) => c.msg === "plan_run.plot_activated");
		expect(info).toBeDefined();
		expect(info?.level).toBe("info");
		const obj = info?.obj as { planRunId?: string; plotId?: string };
		expect(obj.planRunId).toBe("plr_3");
		expect(obj.plotId).toBe("plot_z");
	});

	test("does not log plan_run.plot_activated when appender returns activated:false", async () => {
		const captured: CapturedLog[] = [];
		await emitPlanRunDispatchedToPlot({
			appender: makeAppender({ activated: false }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_z",
			handle: "bob",
			planRunId: "plr_4",
			planId: "pl-z",
			childrenCount: 1,
		});
		expect(captured.filter((c) => c.msg === "plan_run.plot_activated")).toHaveLength(0);
	});
});
