import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import {
	DEFAULT_PLAN_RUN_MERGE_TIMEOUT_MS,
	DEFAULT_PLAN_RUN_TICK_MS,
	DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS,
	DEFAULT_RATE_LIMIT_BACKOFF_CEIL_MS,
	DEFAULT_RATE_LIMIT_BUFFER_MS,
	DEFAULT_RATE_LIMIT_MAX_RETRIES,
	loadPlanRunCoordinatorConfigFromEnv,
} from "./config.ts";

describe("loadPlanRunCoordinatorConfigFromEnv", () => {
	test("defaults when env unset", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({});
		expect(config.tickMs).toBe(DEFAULT_PLAN_RUN_TICK_MS);
		expect(config.disabled).toBe(false);
		expect(config.mergeTimeoutMs).toBe(DEFAULT_PLAN_RUN_MERGE_TIMEOUT_MS);
	});

	test("WARREN_PLAN_RUN_DISABLED honors the standard truthy set", () => {
		for (const v of ["1", "true", "TRUE", "yes", "on", " true "]) {
			expect(loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_DISABLED: v }).disabled).toBe(
				true,
			);
		}
	});

	test("WARREN_PLAN_RUN_DISABLED treats falsy strings as not-disabled", () => {
		for (const v of ["0", "false", "FALSE", "no", "off", ""]) {
			expect(loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_DISABLED: v }).disabled).toBe(
				false,
			);
		}
	});

	test("WARREN_PLAN_RUN_DISABLED treats out-of-set values as not-disabled", () => {
		for (const v of ["2", "enabled", "disable", "garbage"]) {
			expect(loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_DISABLED: v }).disabled).toBe(
				false,
			);
		}
	});

	test("parses WARREN_PLAN_RUN_MERGE_TIMEOUT_MS", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({
			WARREN_PLAN_RUN_MERGE_TIMEOUT_MS: "60000",
		});
		expect(config.mergeTimeoutMs).toBe(60000);
	});

	test("merge timeout of 0 disables the bound", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({
			WARREN_PLAN_RUN_MERGE_TIMEOUT_MS: "0",
		});
		expect(config.mergeTimeoutMs).toBe(0);
	});

	test("rejects negative merge timeout", () => {
		expect(() =>
			loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_MERGE_TIMEOUT_MS: "-1" }),
		).toThrow(ValidationError);
	});

	test("rejects non-numeric merge timeout", () => {
		expect(() =>
			loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_MERGE_TIMEOUT_MS: "soon" }),
		).toThrow(ValidationError);
	});

	// Rate-limit config env vars (warren-e521)

	test("rateLimitConfig defaults when env unset", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({});
		expect(config.rateLimitConfig.bufferMs).toBe(DEFAULT_RATE_LIMIT_BUFFER_MS);
		expect(config.rateLimitConfig.backoffBaseMs).toBe(DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS);
		expect(config.rateLimitConfig.backoffCeilMs).toBe(DEFAULT_RATE_LIMIT_BACKOFF_CEIL_MS);
		expect(config.rateLimitConfig.maxRetries).toBe(DEFAULT_RATE_LIMIT_MAX_RETRIES);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_BUFFER_MS parses correctly", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({
			WARREN_PLAN_RUN_RATE_LIMIT_BUFFER_MS: "60000",
		});
		expect(config.rateLimitConfig.bufferMs).toBe(60000);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_BUFFER_MS allows 0 (no buffer)", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({
			WARREN_PLAN_RUN_RATE_LIMIT_BUFFER_MS: "0",
		});
		expect(config.rateLimitConfig.bufferMs).toBe(0);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_BUFFER_MS rejects negative values", () => {
		expect(() =>
			loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_RATE_LIMIT_BUFFER_MS: "-1" }),
		).toThrow(ValidationError);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_BACKOFF_BASE_MS parses correctly", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({
			WARREN_PLAN_RUN_RATE_LIMIT_BACKOFF_BASE_MS: "3600000",
		});
		expect(config.rateLimitConfig.backoffBaseMs).toBe(3600000);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_BACKOFF_BASE_MS rejects zero", () => {
		expect(() =>
			loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_RATE_LIMIT_BACKOFF_BASE_MS: "0" }),
		).toThrow(ValidationError);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_BACKOFF_CEIL_MS parses correctly", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({
			WARREN_PLAN_RUN_RATE_LIMIT_BACKOFF_CEIL_MS: "28800000",
		});
		expect(config.rateLimitConfig.backoffCeilMs).toBe(28800000);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_BACKOFF_CEIL_MS rejects zero", () => {
		expect(() =>
			loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_RATE_LIMIT_BACKOFF_CEIL_MS: "0" }),
		).toThrow(ValidationError);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_MAX_RETRIES parses correctly", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({
			WARREN_PLAN_RUN_RATE_LIMIT_MAX_RETRIES: "3",
		});
		expect(config.rateLimitConfig.maxRetries).toBe(3);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_MAX_RETRIES of 0 disables the ceiling", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({
			WARREN_PLAN_RUN_RATE_LIMIT_MAX_RETRIES: "0",
		});
		expect(config.rateLimitConfig.maxRetries).toBe(0);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_MAX_RETRIES rejects negative values", () => {
		expect(() =>
			loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_RATE_LIMIT_MAX_RETRIES: "-1" }),
		).toThrow(ValidationError);
	});

	test("WARREN_PLAN_RUN_RATE_LIMIT_MAX_RETRIES rejects non-integer values", () => {
		expect(() =>
			loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_RATE_LIMIT_MAX_RETRIES: "2.5" }),
		).toThrow(ValidationError);
	});
});
