import { describe, expect, test } from "bun:test";
import { resolveDbUrl } from "./context.ts";

describe("resolveDbUrl", () => {
	test("defaults to sqlite under WARREN_DATA_DIR when neither env var is set", () => {
		expect(resolveDbUrl({})).toEqual({ url: "sqlite:///data/warren.db", conflict: null });
		expect(resolveDbUrl({ WARREN_DATA_DIR: "/var/lib/warren" })).toEqual({
			url: "sqlite:///var/lib/warren/warren.db",
			conflict: null,
		});
	});

	test("synthesizes a sqlite URL from WARREN_DB_PATH (back-compat)", () => {
		expect(resolveDbUrl({ WARREN_DB_PATH: "/srv/warren.sqlite" })).toEqual({
			url: "sqlite:///srv/warren.sqlite",
			conflict: null,
		});
	});

	test("WARREN_DB_URL wins over WARREN_DB_PATH and WARREN_DATA_DIR", () => {
		expect(
			resolveDbUrl({
				WARREN_DB_URL: "postgres://u:p@h/db",
				WARREN_DB_PATH: "/srv/legacy.sqlite",
				WARREN_DATA_DIR: "/var/lib/warren",
			}),
		).toEqual({ url: "postgres://u:p@h/db", conflict: "/srv/legacy.sqlite" });
	});

	test("WARREN_DB_PATH that agrees with WARREN_DB_URL records no conflict", () => {
		expect(
			resolveDbUrl({
				WARREN_DB_URL: "sqlite:///srv/warren.sqlite",
				WARREN_DB_PATH: "/srv/warren.sqlite",
			}),
		).toEqual({ url: "sqlite:///srv/warren.sqlite", conflict: null });
	});
});
