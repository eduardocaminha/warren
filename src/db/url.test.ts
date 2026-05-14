import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { parseDatabaseUrl, sqliteUrlForPath } from "./url.ts";

describe("parseDatabaseUrl", () => {
	test(":memory: sentinel maps to sqlite in-memory", () => {
		expect(parseDatabaseUrl(":memory:")).toEqual({ dialect: "sqlite", path: ":memory:" });
	});

	test("sqlite:/// triple-slash form preserves the absolute path", () => {
		expect(parseDatabaseUrl("sqlite:///data/warren.db")).toEqual({
			dialect: "sqlite",
			path: "/data/warren.db",
		});
	});

	test("file:/// alias parses identically to sqlite:///", () => {
		expect(parseDatabaseUrl("file:///data/warren.db")).toEqual({
			dialect: "sqlite",
			path: "/data/warren.db",
		});
	});

	test("sqlite://./relative parses as a relative path", () => {
		expect(parseDatabaseUrl("sqlite://./warren.db")).toEqual({
			dialect: "sqlite",
			path: "./warren.db",
		});
	});

	test("sqlite::memory: (no host slashes) maps to in-memory", () => {
		expect(parseDatabaseUrl("sqlite::memory:")).toEqual({ dialect: "sqlite", path: ":memory:" });
	});

	test("postgres:// passes the full connection string through", () => {
		expect(parseDatabaseUrl("postgres://user:pass@host:5432/db")).toEqual({
			dialect: "postgres",
			connectionString: "postgres://user:pass@host:5432/db",
		});
	});

	test("postgresql:// alias parses identically", () => {
		expect(parseDatabaseUrl("postgresql://u:p@h/db")).toEqual({
			dialect: "postgres",
			connectionString: "postgresql://u:p@h/db",
		});
	});

	test("scheme detection is case-insensitive", () => {
		expect(parseDatabaseUrl("POSTGRES://u:p@h/db")).toEqual({
			dialect: "postgres",
			connectionString: "POSTGRES://u:p@h/db",
		});
		expect(parseDatabaseUrl("SQLite:///data/warren.db")).toEqual({
			dialect: "sqlite",
			path: "/data/warren.db",
		});
	});

	test("bare absolute path is treated as sqlite (WARREN_DB_PATH back-compat)", () => {
		expect(parseDatabaseUrl("/data/warren.db")).toEqual({
			dialect: "sqlite",
			path: "/data/warren.db",
		});
	});

	test("bare relative path is treated as sqlite", () => {
		expect(parseDatabaseUrl("./warren.db")).toEqual({ dialect: "sqlite", path: "./warren.db" });
		expect(parseDatabaseUrl("warren.db")).toEqual({ dialect: "sqlite", path: "warren.db" });
	});

	test("leading/trailing whitespace is trimmed", () => {
		expect(parseDatabaseUrl("  postgres://h/db  ")).toEqual({
			dialect: "postgres",
			connectionString: "postgres://h/db",
		});
	});

	test("empty input throws ValidationError", () => {
		expect(() => parseDatabaseUrl("")).toThrow(ValidationError);
		expect(() => parseDatabaseUrl("   ")).toThrow(ValidationError);
	});

	test("sqlite:// with no path throws", () => {
		expect(() => parseDatabaseUrl("sqlite://")).toThrow(ValidationError);
		expect(() => parseDatabaseUrl("sqlite:///")).toThrow(ValidationError);
	});
});

describe("sqliteUrlForPath", () => {
	test(":memory: round-trips as :memory:", () => {
		expect(sqliteUrlForPath(":memory:")).toBe(":memory:");
		expect(parseDatabaseUrl(sqliteUrlForPath(":memory:"))).toEqual({
			dialect: "sqlite",
			path: ":memory:",
		});
	});

	test("absolute path round-trips through parseDatabaseUrl", () => {
		const url = sqliteUrlForPath("/data/warren.db");
		expect(parseDatabaseUrl(url)).toEqual({ dialect: "sqlite", path: "/data/warren.db" });
	});

	test("relative path round-trips", () => {
		const url = sqliteUrlForPath("./warren.db");
		expect(parseDatabaseUrl(url)).toEqual({ dialect: "sqlite", path: "./warren.db" });
	});
});
