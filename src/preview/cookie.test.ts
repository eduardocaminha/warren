import { describe, expect, test } from "bun:test";
import {
	COOKIE_NAME,
	COOKIE_VERSION,
	createPreviewAuth,
	DEFAULT_COOKIE_TTL_MS,
	extractCookieValue,
} from "./cookie.ts";

const TOKEN = "test-token-very-secret-1234567890abcdef";

describe("createPreviewAuth.verifyLoginToken", () => {
	test("constant-time accepts the configured token", () => {
		const auth = createPreviewAuth(TOKEN);
		expect(auth.verifyLoginToken(TOKEN)).toBe(true);
	});

	test("rejects mismatched + empty + null", () => {
		const auth = createPreviewAuth(TOKEN);
		expect(auth.verifyLoginToken("")).toBe(false);
		expect(auth.verifyLoginToken(null)).toBe(false);
		expect(auth.verifyLoginToken(undefined)).toBe(false);
		expect(auth.verifyLoginToken(`${TOKEN}-extra`)).toBe(false);
		expect(auth.verifyLoginToken(TOKEN.slice(0, -1))).toBe(false);
	});

	test("empty-token construction throws", () => {
		expect(() => createPreviewAuth("")).toThrow();
	});
});

describe("createPreviewAuth.signCookie / verifyCookie", () => {
	test("round-trips a fresh cookie", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date("2026-01-01T00:00:00Z");
		const cookie = auth.signCookie("run_abc", now);
		expect(cookie.name).toBe(COOKIE_NAME);
		expect(cookie.value.startsWith(`${COOKIE_VERSION}.run_abc.`)).toBe(true);
		expect(auth.verifyCookie(`${COOKIE_NAME}=${cookie.value}`, "run_abc", now)).toBe(true);
	});

	test("Set-Cookie header includes scoped attributes when domain is provided", () => {
		const auth = createPreviewAuth(TOKEN, { cookieDomain: ".preview.example.com" });
		const cookie = auth.signCookie("run_abc", new Date());
		expect(cookie.setCookieHeader).toContain(`${COOKIE_NAME}=`);
		expect(cookie.setCookieHeader).toContain("Path=/");
		expect(cookie.setCookieHeader).toContain("HttpOnly");
		expect(cookie.setCookieHeader).toContain("SameSite=Lax");
		expect(cookie.setCookieHeader).toContain("Secure");
		expect(cookie.setCookieHeader).toContain("Domain=.preview.example.com");
		expect(cookie.setCookieHeader).toContain("Max-Age=");
	});

	test("Secure attribute can be disabled for local http loopback tests", () => {
		const auth = createPreviewAuth(TOKEN, { secure: false });
		const cookie = auth.signCookie("run_abc", new Date());
		expect(cookie.setCookieHeader).not.toContain("Secure");
	});

	test("expired cookie fails verification", () => {
		const auth = createPreviewAuth(TOKEN);
		const issuedAt = new Date("2026-01-01T00:00:00Z");
		const cookie = auth.signCookie("run_abc", issuedAt, 60_000);
		const later = new Date(issuedAt.getTime() + 120_000);
		expect(auth.verifyCookie(`${COOKIE_NAME}=${cookie.value}`, "run_abc", later)).toBe(false);
	});

	test("verifying with the wrong runId fails", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date();
		const cookie = auth.signCookie("run_abc", now);
		expect(auth.verifyCookie(`${COOKIE_NAME}=${cookie.value}`, "run_xyz", now)).toBe(false);
	});

	test("a tampered signature fails", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date();
		const cookie = auth.signCookie("run_abc", now);
		const tampered = `${cookie.value.slice(0, -1)}X`;
		expect(auth.verifyCookie(`${COOKIE_NAME}=${tampered}`, "run_abc", now)).toBe(false);
	});

	test("a tampered runId in payload fails (sig won't match)", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date();
		const cookie = auth.signCookie("run_abc", now);
		const parts = cookie.value.split(".");
		parts[1] = "run_xyz";
		const forged = parts.join(".");
		expect(auth.verifyCookie(`${COOKIE_NAME}=${forged}`, "run_xyz", now)).toBe(false);
	});

	test("missing or absent cookie header fails", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date();
		expect(auth.verifyCookie(null, "run_abc", now)).toBe(false);
		expect(auth.verifyCookie("", "run_abc", now)).toBe(false);
		expect(auth.verifyCookie("session=other", "run_abc", now)).toBe(false);
	});

	test("two PreviewAuth instances built from different tokens reject each other's cookies", () => {
		const auth1 = createPreviewAuth(TOKEN);
		const auth2 = createPreviewAuth(`${TOKEN}-other`);
		const now = new Date();
		const cookie = auth1.signCookie("run_abc", now);
		expect(auth2.verifyCookie(`${COOKIE_NAME}=${cookie.value}`, "run_abc", now)).toBe(false);
	});

	test("ttlMs default is 24h", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date("2026-01-01T00:00:00Z");
		const cookie = auth.signCookie("run_abc", now);
		expect(cookie.expiresAt.getTime()).toBe(now.getTime() + DEFAULT_COOKIE_TTL_MS);
	});

	test("rejects non-positive ttl", () => {
		const auth = createPreviewAuth(TOKEN);
		expect(() => auth.signCookie("run_abc", new Date(), 0)).toThrow();
		expect(() => auth.signCookie("run_abc", new Date(), -1)).toThrow();
		expect(() => auth.signCookie("", new Date())).toThrow();
	});
});

describe("extractCookieValue", () => {
	test("extracts a single cookie", () => {
		expect(extractCookieValue("warren_preview=abc", "warren_preview")).toBe("abc");
	});

	test("extracts from a multi-cookie header tolerating whitespace", () => {
		expect(extractCookieValue("a=1; warren_preview=abc; b=2", "warren_preview")).toBe("abc");
		expect(extractCookieValue("a=1;warren_preview=abc;b=2", "warren_preview")).toBe("abc");
	});

	test("returns null when absent", () => {
		expect(extractCookieValue("a=1", "warren_preview")).toBe(null);
		expect(extractCookieValue("", "warren_preview")).toBe(null);
	});
});
