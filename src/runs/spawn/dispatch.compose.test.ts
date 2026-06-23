import { describe, expect, test } from "bun:test";
import { composeDispatchPrompt } from "./index.ts";

describe("composeDispatchPrompt", () => {
	test("prepends the system body with a horizontal-rule delimiter", () => {
		expect(composeDispatchPrompt("be a refactor agent", "fix it")).toBe(
			"be a refactor agent\n\n---\n\nfix it",
		);
	});

	test("trims trailing whitespace on the system body before joining", () => {
		expect(composeDispatchPrompt("system\n\n\n", "task")).toBe("system\n\n---\n\ntask");
	});

	test("returns the user prompt verbatim when system is empty or whitespace", () => {
		expect(composeDispatchPrompt("", "task")).toBe("task");
		expect(composeDispatchPrompt("   \n\t", "task")).toBe("task");
		expect(composeDispatchPrompt(undefined, "task")).toBe("task");
	});
});
