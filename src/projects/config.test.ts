import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { DEFAULT_PROJECTS_DIR, loadProjectsConfigFromEnv } from "./config.ts";

describe("loadProjectsConfigFromEnv", () => {
	test("uses defaults when no env vars are set", () => {
		expect(loadProjectsConfigFromEnv({})).toEqual({
			root: DEFAULT_PROJECTS_DIR,
			gitBinary: "git",
		});
	});

	test("rejects an empty WARREN_PROJECTS_DIR (caller likely meant 'unset')", () => {
		expect(() =>
			loadProjectsConfigFromEnv({
				WARREN_PROJECTS_DIR: "",
			}),
		).toThrow(ValidationError);
	});

	test("honors all overrides", () => {
		expect(
			loadProjectsConfigFromEnv({
				WARREN_PROJECTS_DIR: "/srv/projects",
				WARREN_GIT_BINARY: "/usr/local/bin/git",
			}),
		).toEqual({
			root: "/srv/projects",
			gitBinary: "/usr/local/bin/git",
		});
	});
});
