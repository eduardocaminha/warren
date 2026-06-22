import { describe, expect, test } from "bun:test";
import { PROMETHEUS_CONTENT_TYPE, type PromMetric, renderPrometheus } from "./prometheus.ts";

describe("renderPrometheus", () => {
	test("emits HELP + TYPE + one line per sample", () => {
		const metrics: PromMetric[] = [
			{
				name: "warren_runs",
				help: "Run count grouped by state.",
				type: "gauge",
				samples: [
					{ labels: { state: "running" }, value: 2 },
					{ labels: { state: "failed" }, value: 1 },
				],
			},
		];
		expect(renderPrometheus(metrics)).toBe(
			[
				"# HELP warren_runs Run count grouped by state.",
				"# TYPE warren_runs gauge",
				'warren_runs{state="running"} 2',
				'warren_runs{state="failed"} 1',
				"",
			].join("\n"),
		);
	});

	test("renders a sample with no labels", () => {
		const out = renderPrometheus([
			{ name: "warren_active_bridges", help: "Bridges.", type: "gauge", samples: [{ value: 0 }] },
		]);
		expect(out).toContain("warren_active_bridges 0");
		expect(out).not.toContain("warren_active_bridges{}");
	});

	test("escapes label values and help text", () => {
		const out = renderPrometheus([
			{
				name: "warren_log_messages_total",
				help: 'has "quotes" and \\ backslash',
				type: "counter",
				samples: [{ labels: { msg: 'a"b\\c\nd' }, value: 3 }],
			},
		]);
		expect(out).toContain('msg="a\\"b\\\\c\\nd"');
		expect(out).toContain('# HELP warren_log_messages_total has "quotes" and \\\\ backslash');
	});

	test("renders non-finite values per spec", () => {
		const out = renderPrometheus([
			{
				name: "g",
				help: "h",
				type: "gauge",
				samples: [{ value: Number.POSITIVE_INFINITY }, { value: Number.NaN }],
			},
		]);
		expect(out).toContain("g +Inf");
		expect(out).toContain("g NaN");
	});

	test("content type is the 0.0.4 exposition format", () => {
		expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
	});
});
