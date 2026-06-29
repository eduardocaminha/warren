import { describe, expect, test } from "bun:test";
import type { HealAlert } from "./alert.ts";
import {
	buildHealPrompt,
	type DecideHealDispatchInput,
	decideHealDispatch,
	type HealerSettings,
} from "./dispatch.ts";

const SETTINGS: HealerSettings = { enabled: true, maxRetries: 3, cooldownMinutes: 30 };
const NOW = new Date("2026-06-22T12:00:00.000Z");

function input(over: Partial<DecideHealDispatchInput>): DecideHealDispatchInput {
	return {
		settings: SETTINGS,
		history: { attempts: 0, lastAttemptAt: null },
		now: NOW,
		...over,
	};
}

describe("decideHealDispatch", () => {
	test("dispatches when enabled, under retries, no cooldown", () => {
		expect(decideHealDispatch(input({})).kind).toBe("dispatch");
	});

	test("skips with disabled when the project hasn't opted in", () => {
		expect(decideHealDispatch(input({ settings: { ...SETTINGS, enabled: false } }))).toEqual({
			kind: "skip",
			reason: "disabled",
		});
	});

	test("skips with max_retries when attempts reach the cap", () => {
		expect(decideHealDispatch(input({ history: { attempts: 3, lastAttemptAt: null } }))).toEqual({
			kind: "skip",
			reason: "max_retries",
		});
	});

	test("skips with cooldown when last heal is within the window", () => {
		const lastAttemptAt = new Date(NOW.getTime() - 10 * 60_000).toISOString();
		expect(decideHealDispatch(input({ history: { attempts: 1, lastAttemptAt } }))).toEqual({
			kind: "skip",
			reason: "cooldown",
		});
	});

	test("dispatches once the cooldown window has elapsed", () => {
		const lastAttemptAt = new Date(NOW.getTime() - 40 * 60_000).toISOString();
		expect(decideHealDispatch(input({ history: { attempts: 1, lastAttemptAt } })).kind).toBe(
			"dispatch",
		);
	});

	test("zero cooldown disables the gate", () => {
		const lastAttemptAt = new Date(NOW.getTime() - 1_000).toISOString();
		const settings = { ...SETTINGS, cooldownMinutes: 0 };
		expect(
			decideHealDispatch(input({ settings, history: { attempts: 1, lastAttemptAt } })).kind,
		).toBe("dispatch");
	});

	test("max_retries takes precedence over cooldown", () => {
		const lastAttemptAt = new Date(NOW.getTime() - 1_000).toISOString();
		expect(decideHealDispatch(input({ history: { attempts: 3, lastAttemptAt } }))).toEqual({
			kind: "skip",
			reason: "max_retries",
		});
	});

	test("a corrupt lastAttemptAt is treated as no prior attempt (never strands)", () => {
		expect(
			decideHealDispatch(input({ history: { attempts: 1, lastAttemptAt: "not-a-date" } })).kind,
		).toBe("dispatch");
	});
});

describe("buildHealPrompt", () => {
	const alert: HealAlert = {
		fingerprint: "issue-99",
		title: "TypeError in finalize",
		culprit: "src/runs/reap.ts",
		detail: "TypeError: undefined is not a function",
		links: ["https://sentry.io/issues/99"],
		source: "sentry",
		repo: "jayminwest/warren",
	};

	test("includes title, culprit, fingerprint, detail block, and links", () => {
		const prompt = buildHealPrompt(alert);
		expect(prompt).toContain("from sentry");
		expect(prompt).toContain("Alert: TypeError in finalize");
		expect(prompt).toContain("Culprit: src/runs/reap.ts");
		expect(prompt).toContain("Fingerprint: issue-99");
		expect(prompt).toContain("```");
		expect(prompt).toContain("TypeError: undefined is not a function");
		expect(prompt).toContain("- https://sentry.io/issues/99");
		expect(prompt).toContain("Open a normal pull request");
	});

	test("omits the culprit / detail / links sections when absent", () => {
		const prompt = buildHealPrompt({
			...alert,
			culprit: null,
			detail: null,
			links: [],
		});
		expect(prompt).not.toContain("Culprit:");
		expect(prompt).not.toContain("```");
		expect(prompt).not.toContain("Links:");
	});
});
