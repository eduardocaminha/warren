import { describe, expect, it } from "bun:test";
import { VERSION } from "./index.ts";

describe("VERSION", () => {
	it("is a non-empty semver-shaped string", () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
	});
});
