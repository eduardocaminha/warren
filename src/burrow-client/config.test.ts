import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { DEFAULT_BURROW_SOCKET, loadBurrowClientConfigFromEnv } from "./config.ts";

describe("loadBurrowClientConfigFromEnv", () => {
	test("defaults to the canonical unix socket when nothing is set", () => {
		const cfg = loadBurrowClientConfigFromEnv({});
		expect(cfg.transport).toEqual({ kind: "unix", path: DEFAULT_BURROW_SOCKET });
		expect(cfg.token).toBeUndefined();
	});

	test("uses WARREN_BURROW_SOCKET when present", () => {
		const cfg = loadBurrowClientConfigFromEnv({ WARREN_BURROW_SOCKET: "/tmp/burrow.sock" });
		expect(cfg.transport).toEqual({ kind: "unix", path: "/tmp/burrow.sock" });
	});

	test("rejects an empty WARREN_BURROW_SOCKET", () => {
		expect(() => loadBurrowClientConfigFromEnv({ WARREN_BURROW_SOCKET: "" })).toThrow(
			ValidationError,
		);
	});

	test("flips to TCP when WARREN_BURROW_HOST is set with a valid port", () => {
		const cfg = loadBurrowClientConfigFromEnv({
			WARREN_BURROW_HOST: "burrow.local",
			WARREN_BURROW_PORT: "9410",
		});
		expect(cfg.transport).toEqual({ kind: "tcp", hostname: "burrow.local", port: 9410 });
	});

	test("WARREN_BURROW_HOST wins over WARREN_BURROW_SOCKET", () => {
		const cfg = loadBurrowClientConfigFromEnv({
			WARREN_BURROW_SOCKET: "/tmp/burrow.sock",
			WARREN_BURROW_HOST: "burrow.local",
			WARREN_BURROW_PORT: "9410",
		});
		expect(cfg.transport.kind).toBe("tcp");
	});

	test("rejects WARREN_BURROW_HOST without a port", () => {
		expect(() => loadBurrowClientConfigFromEnv({ WARREN_BURROW_HOST: "burrow.local" })).toThrow(
			ValidationError,
		);
	});

	test("rejects a non-numeric port", () => {
		expect(() =>
			loadBurrowClientConfigFromEnv({
				WARREN_BURROW_HOST: "burrow.local",
				WARREN_BURROW_PORT: "abc",
			}),
		).toThrow(ValidationError);
	});

	test("rejects an out-of-range port", () => {
		expect(() =>
			loadBurrowClientConfigFromEnv({
				WARREN_BURROW_HOST: "burrow.local",
				WARREN_BURROW_PORT: "70000",
			}),
		).toThrow(ValidationError);
	});

	test("captures WARREN_BURROW_TOKEN when set", () => {
		const cfg = loadBurrowClientConfigFromEnv({ WARREN_BURROW_TOKEN: "secret" });
		expect(cfg.token).toBe("secret");
	});

	test("treats an empty WARREN_BURROW_TOKEN as absent", () => {
		const cfg = loadBurrowClientConfigFromEnv({ WARREN_BURROW_TOKEN: "" });
		expect(cfg.token).toBeUndefined();
	});
});
