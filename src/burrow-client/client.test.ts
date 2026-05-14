import { describe, expect, test } from "bun:test";
import {
	NotFoundError as BurrowNotFoundError,
	ValidationError as BurrowValidationError,
	CredentialError,
	HttpClientError,
} from "@os-eco/burrow-cli";
import {
	BurrowClient,
	BurrowUnreachableError,
	DEFAULT_BURROW_SOCKET,
	isTransportError,
	withTransportMapping,
} from "./index.ts";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// `typeof fetch` requires a `preconnect` method we don't exercise in tests; cast
// each stub so callers can pass a plain async function.
function stub(impl: (input: URL | RequestInfo) => Promise<Response>): typeof fetch {
	return impl as unknown as typeof fetch;
}

describe("BurrowClient", () => {
	test("exposes the underlying HttpClient namespaces", () => {
		const c = new BurrowClient({ config: { transport: { kind: "unix", path: "/tmp/x.sock" } } });
		expect(c.http.burrows).toBeDefined();
		expect(c.http.runs).toBeDefined();
		expect(c.http.inbox).toBeDefined();
		expect(c.http.events).toBeDefined();
		expect(c.http.agents).toBeDefined();
	});

	test("fromEnv resolves transport from process env", () => {
		const c = BurrowClient.fromEnv({});
		expect(c.config.transport).toEqual({ kind: "unix", path: DEFAULT_BURROW_SOCKET });
	});

	test("fromEnv accepts a fetch override (so tests can stub the wire)", async () => {
		let calls = 0;
		const stubFetch = stub(async () => {
			calls += 1;
			return jsonResponse(200, { ok: true });
		});
		const c = BurrowClient.fromEnv({}, stubFetch);
		await c.probe();
		expect(calls).toBe(1);
	});
});

describe("BurrowClient.probe", () => {
	test("resolves when burrow returns 200 from /healthz", async () => {
		const stubFetch = stub(async (input) => {
			expect(String(input)).toContain("/healthz");
			return jsonResponse(200, { ok: true });
		});
		const c = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stubFetch,
		});
		await expect(c.probe()).resolves.toBeUndefined();
	});

	test("throws BurrowUnreachableError when fetch rejects (socket missing)", async () => {
		const stubFetch = stub(async () => {
			const err = new TypeError("fetch failed");
			(err as unknown as { cause: { code: string } }).cause = { code: "ENOENT" };
			throw err;
		});
		const c = new BurrowClient({
			config: { transport: { kind: "unix", path: "/var/run/burrow.sock" } },
			fetch: stubFetch,
		});
		const promise = c.probe();
		await expect(promise).rejects.toBeInstanceOf(BurrowUnreachableError);
		await expect(promise).rejects.toMatchObject({
			message: expect.stringContaining("/var/run/burrow.sock"),
		});
	});

	test("includes the underlying error code in the message when available", async () => {
		const stubFetch = stub(async () => {
			const err = new TypeError("fetch failed");
			(err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
			throw err;
		});
		const c = new BurrowClient({
			config: { transport: { kind: "tcp", hostname: "burrow.local", port: 9410 } },
			fetch: stubFetch,
		});
		await expect(c.probe()).rejects.toMatchObject({
			message: expect.stringContaining("ECONNREFUSED"),
		});
	});

	test("times out and throws BurrowUnreachableError when burrow hangs", async () => {
		const stubFetch = stub(() => new Promise<Response>(() => {}));
		const c = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stubFetch,
		});
		await expect(c.probe(50)).rejects.toBeInstanceOf(BurrowUnreachableError);
	});
});

describe("BurrowClient.setDrain", () => {
	test("POSTs /admin/drain with the requested drain flag and returns the echoed state", async () => {
		const calls: { url: string; method: string; body: string; auth: string | null }[] = [];
		const stubFetch = stub(async (input, init?: RequestInit) => {
			const url = String(input);
			calls.push({
				url,
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? init.body : "",
				auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
			});
			return jsonResponse(200, { drain: true });
		});
		const c = new BurrowClient({
			config: {
				transport: { kind: "tcp", hostname: "burrow.local", port: 9410 },
				token: "secret",
			},
			fetch: stubFetch,
		});
		const out = await c.setDrain(true);
		expect(out).toEqual({ drain: true });
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (!call) throw new Error("expected one call");
		expect(call.method).toBe("POST");
		expect(call.url).toBe("http://burrow.local:9410/admin/drain");
		expect(JSON.parse(call.body)).toEqual({ drain: true });
		expect(call.auth).toBe("Bearer secret");
	});

	test("forwards `unix` socket path when the transport is unix", async () => {
		let observedUnix: string | undefined;
		const stubFetch = ((_input: URL | RequestInfo, init?: RequestInit & { unix?: string }) => {
			observedUnix = init?.unix;
			return Promise.resolve(jsonResponse(200, { drain: false }));
		}) as unknown as typeof fetch;
		const c = new BurrowClient({
			config: { transport: { kind: "unix", path: "/var/run/burrow.sock" } },
			fetch: stubFetch,
		});
		await c.setDrain(false);
		expect(observedUnix).toBe("/var/run/burrow.sock");
	});

	test("converts a transport-layer fetch failure into BurrowUnreachableError", async () => {
		const stubFetch = stub(async () => {
			const err = new TypeError("fetch failed");
			(err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
			throw err;
		});
		const c = new BurrowClient({
			config: { transport: { kind: "tcp", hostname: "burrow.local", port: 9410 } },
			fetch: stubFetch,
		});
		await expect(c.setDrain(true)).rejects.toBeInstanceOf(BurrowUnreachableError);
	});

	test("rehydrates a 404 not_found envelope as BurrowNotFoundError (older burrow)", async () => {
		const stubFetch = stub(async () =>
			jsonResponse(404, {
				error: { code: "not_found", message: "no route matches /admin/drain" },
			}),
		);
		const c = new BurrowClient({
			config: { transport: { kind: "tcp", hostname: "burrow.local", port: 9410 } },
			fetch: stubFetch,
		});
		await expect(c.setDrain(true)).rejects.toBeInstanceOf(BurrowNotFoundError);
	});

	test("rehydrates a 400 validation_error envelope as BurrowValidationError", async () => {
		const stubFetch = stub(async () =>
			jsonResponse(400, {
				error: { code: "validation_error", message: "field 'drain' must be a boolean" },
			}),
		);
		const c = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stubFetch,
		});
		await expect(c.setDrain(true)).rejects.toBeInstanceOf(BurrowValidationError);
	});

	test("rehydrates a 401 credential_error envelope as CredentialError", async () => {
		const stubFetch = stub(async () =>
			jsonResponse(401, {
				error: { code: "credential_error", message: "missing bearer token" },
			}),
		);
		const c = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stubFetch,
		});
		await expect(c.setDrain(true)).rejects.toBeInstanceOf(CredentialError);
	});

	test("falls back to HttpClientError for unmapped codes", async () => {
		const stubFetch = stub(async () =>
			jsonResponse(500, {
				error: { code: "weird_unknown", message: "boom" },
			}),
		);
		const c = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stubFetch,
		});
		await expect(c.setDrain(true)).rejects.toBeInstanceOf(HttpClientError);
	});
});

describe("withTransportMapping", () => {
	const cfg = { transport: { kind: "unix" as const, path: "/tmp/x.sock" } };

	test("passes the resolved value through on success", async () => {
		const out = await withTransportMapping(cfg, async () => 42);
		expect(out).toBe(42);
	});

	test("passes BurrowError subclasses through unmodified", async () => {
		const original = new BurrowNotFoundError("burrow not found");
		await expect(
			withTransportMapping(cfg, async () => {
				throw original;
			}),
		).rejects.toBe(original);
	});

	test("converts a raw fetch failure into BurrowUnreachableError", async () => {
		await expect(
			withTransportMapping(cfg, async () => {
				const err = new TypeError("fetch failed");
				(err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
				throw err;
			}),
		).rejects.toBeInstanceOf(BurrowUnreachableError);
	});

	test("preserves the original error as `cause` for debugging", async () => {
		const original = new TypeError("fetch failed");
		(original as unknown as { cause: { code: string } }).cause = { code: "ENOENT" };
		try {
			await withTransportMapping(cfg, async () => {
				throw original;
			});
			throw new Error("expected withTransportMapping to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(BurrowUnreachableError);
			expect((err as Error).cause).toBe(original);
		}
	});

	test("does not double-wrap an already-mapped BurrowUnreachableError", async () => {
		const original = new BurrowUnreachableError("already mapped");
		await expect(
			withTransportMapping(cfg, async () => {
				throw original;
			}),
		).rejects.toBe(original);
	});
});

describe("isTransportError", () => {
	test("returns false for BurrowError subclasses", () => {
		expect(isTransportError(new BurrowNotFoundError("nope"))).toBe(false);
	});

	test("returns true for a generic TypeError fetch rejection", () => {
		expect(isTransportError(new TypeError("fetch failed"))).toBe(true);
	});

	test("returns false for non-Error values", () => {
		expect(isTransportError("string")).toBe(false);
		expect(isTransportError(null)).toBe(false);
		expect(isTransportError(undefined)).toBe(false);
	});
});
