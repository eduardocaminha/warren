import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "./metrics-registry.ts";

describe("MetricsRegistry", () => {
	test("accumulates onto one series for the same name + labels", () => {
		const reg = new MetricsRegistry();
		reg.increment("warren_log_messages_total", { level: "warn" });
		reg.increment("warren_log_messages_total", { level: "warn" });
		reg.increment("warren_log_messages_total", { level: "error" });
		const snap = reg.snapshot();
		expect(snap).toEqual([
			{ name: "warren_log_messages_total", labels: { level: "error" }, value: 1 },
			{ name: "warren_log_messages_total", labels: { level: "warn" }, value: 2 },
		]);
	});

	test("label order does not split a series", () => {
		const reg = new MetricsRegistry();
		reg.increment("c", { a: "1", b: "2" });
		reg.increment("c", { b: "2", a: "1" });
		const snap = reg.snapshot();
		expect(snap).toHaveLength(1);
		expect(snap[0]?.value).toBe(2);
		expect(snap[0]?.labels).toEqual({ a: "1", b: "2" });
	});

	test("ignores non-positive increments", () => {
		const reg = new MetricsRegistry();
		reg.increment("c", {}, 0);
		reg.increment("c", {}, -3);
		expect(reg.snapshot()).toEqual([]);
	});

	test("custom increment amount", () => {
		const reg = new MetricsRegistry();
		reg.increment("c", {}, 5);
		expect(reg.snapshot()[0]?.value).toBe(5);
	});
});
