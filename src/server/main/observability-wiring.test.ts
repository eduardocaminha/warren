import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "../../observability/metrics-registry.ts";
import { bootObservability, captureBootFailure } from "./observability-wiring.ts";

describe("bootObservability", () => {
	test("wires a logger + registry and a no-op tracker when SENTRY_DSN is unset", async () => {
		const { logger, metricsRegistry, errorTracker } = await bootObservability({});
		expect(metricsRegistry).toBeInstanceOf(MetricsRegistry);
		expect(errorTracker.enabled).toBe(false);
		expect(typeof logger.info).toBe("function");
		// The sink hook counts warn/error lines onto the registry.
		logger.warn({ projectId: "p" }, "scheduler.cron_failed");
		expect(metricsRegistry.snapshot()).toEqual([
			{ name: "warren_log_messages_total", labels: { level: "warn" }, value: 1 },
		]);
	});

	test("respects WARREN_LOG_LEVEL without throwing", async () => {
		const { logger } = await bootObservability({ WARREN_LOG_LEVEL: "error" });
		expect(() => logger.error({}, "x")).not.toThrow();
	});
});

describe("captureBootFailure", () => {
	test("is a no-op that never throws when SENTRY_DSN is unset", async () => {
		await expect(captureBootFailure(new Error("boot boom"))).resolves.toBeUndefined();
	});
});
