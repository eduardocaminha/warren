import { describe, expect, test } from "bun:test";
import { forwardLogToSinks, type LogForwardTracker, pinoLevelName } from "./log-sink.ts";
import { MetricsRegistry } from "./metrics-registry.ts";

function makeTracker() {
	const calls: {
		kind: "exception" | "message";
		arg: unknown;
		context?: Record<string, unknown>;
	}[] = [];
	const tracker: LogForwardTracker = {
		captureException: (err, context) => calls.push({ kind: "exception", arg: err, context }),
		captureMessage: (message, context) => calls.push({ kind: "message", arg: message, context }),
	};
	return { tracker, calls };
}

describe("pinoLevelName", () => {
	test("maps numeric levels to names", () => {
		expect(pinoLevelName(60)).toBe("fatal");
		expect(pinoLevelName(50)).toBe("error");
		expect(pinoLevelName(40)).toBe("warn");
		expect(pinoLevelName(30)).toBe("info");
	});
});

describe("forwardLogToSinks", () => {
	test("counts warn lines but does not capture them to Sentry", () => {
		const metrics = new MetricsRegistry();
		const { tracker, calls } = makeTracker();
		forwardLogToSinks(40, [{ projectId: "p" }, "scheduler.cron_failed"], { metrics, tracker });
		expect(metrics.snapshot()).toEqual([
			{ name: "warren_log_messages_total", labels: { level: "warn" }, value: 1 },
		]);
		expect(calls).toHaveLength(0);
	});

	test("ignores info/debug lines entirely", () => {
		const metrics = new MetricsRegistry();
		const { tracker, calls } = makeTracker();
		forwardLogToSinks(30, [{}, "server.request"], { metrics, tracker });
		expect(metrics.snapshot()).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	test("captures an error-level line carrying an Error as an exception", () => {
		const { tracker, calls } = makeTracker();
		const err = new Error("boom");
		forwardLogToSinks(50, [{ err, runId: "r1" }, "ops.stats.tick_failed"], { tracker });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.kind).toBe("exception");
		expect(calls[0]?.arg).toBe(err);
		expect(calls[0]?.context).toMatchObject({ runId: "r1", msg: "ops.stats.tick_failed" });
	});

	test("captures an error-level line without an Error as a message", () => {
		const { tracker, calls } = makeTracker();
		forwardLogToSinks(50, [{ route: "x" }, "server: handler threw"], { tracker });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.kind).toBe("message");
		expect(calls[0]?.arg).toBe("server: handler threw");
	});

	test("handles a string-only log call", () => {
		const { tracker, calls } = makeTracker();
		forwardLogToSinks(50, ["bare message"], { tracker });
		expect(calls[0]?.kind).toBe("message");
		expect(calls[0]?.arg).toBe("bare message");
	});
});
