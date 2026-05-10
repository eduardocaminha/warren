import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import {
	DEFAULT_CANOPY_DIR,
	loadCanopyRegistryConfigFromEnv,
	requireCanopyRegistryConfigFromEnv,
} from "./config.ts";

describe("loadCanopyRegistryConfigFromEnv", () => {
	test("returns null when CANOPY_REPO_URL is unset (warren-d3e9)", () => {
		expect(loadCanopyRegistryConfigFromEnv({})).toBeNull();
		expect(loadCanopyRegistryConfigFromEnv({ CANOPY_REPO_URL: "" })).toBeNull();
	});

	test("uses defaults when only repo URL is set", () => {
		const cfg = loadCanopyRegistryConfigFromEnv({
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		expect(cfg).toEqual({
			repoUrl: "https://example.com/agents.git",
			localDir: DEFAULT_CANOPY_DIR,
			cnBinary: "cn",
			gitBinary: "git",
		});
	});

	test("rejects empty WARREN_CANOPY_DIR (caller likely meant 'unset')", () => {
		expect(() =>
			loadCanopyRegistryConfigFromEnv({
				CANOPY_REPO_URL: "https://example.com/agents.git",
				WARREN_CANOPY_DIR: "",
			}),
		).toThrow(ValidationError);
	});

	test("honors all overrides", () => {
		const cfg = loadCanopyRegistryConfigFromEnv({
			CANOPY_REPO_URL: "git@github.com:me/agents.git",
			WARREN_CANOPY_DIR: "/srv/canopy",
			WARREN_CN_BINARY: "/opt/bun/bin/cn",
			WARREN_GIT_BINARY: "/usr/local/bin/git",
		});
		expect(cfg).toEqual({
			repoUrl: "git@github.com:me/agents.git",
			localDir: "/srv/canopy",
			cnBinary: "/opt/bun/bin/cn",
			gitBinary: "/usr/local/bin/git",
		});
	});
});

describe("requireCanopyRegistryConfigFromEnv", () => {
	test("throws ValidationError when CANOPY_REPO_URL is unset", () => {
		expect(() => requireCanopyRegistryConfigFromEnv({})).toThrow(ValidationError);
		expect(() => requireCanopyRegistryConfigFromEnv({ CANOPY_REPO_URL: "" })).toThrow(
			ValidationError,
		);
	});

	test("returns the config when CANOPY_REPO_URL is set", () => {
		const cfg = requireCanopyRegistryConfigFromEnv({
			CANOPY_REPO_URL: "https://example.com/agents.git",
		});
		expect(cfg.repoUrl).toBe("https://example.com/agents.git");
	});
});
