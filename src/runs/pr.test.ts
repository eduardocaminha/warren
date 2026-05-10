import { describe, expect, test } from "bun:test";
import {
	buildPrContent,
	loadAutoOpenPrConfigFromEnv,
	openPullRequest,
	type PrFetcher,
} from "./pr.ts";

interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
}

function recordingFetch(responses: ReadonlyArray<Response | (() => Response)>): {
	fetch: typeof fetch;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	let i = 0;
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headersInit = init?.headers as Record<string, string> | undefined;
		calls.push({
			url,
			method: (init?.method ?? "GET").toUpperCase(),
			headers: headersInit ?? {},
			body: typeof init?.body === "string" ? init.body : null,
		});
		const next = responses[i++];
		if (next === undefined) throw new Error("recordingFetch: ran out of canned responses");
		return typeof next === "function" ? next() : next;
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const baseInput = {
	owner: "jayminwest",
	repo: "warren",
	head: "agent/refactor-bot/run-1",
	base: "main",
	title: "Test PR",
	body: "body",
	token: "ghp_xyz",
};

describe("openPullRequest", () => {
	test("returns ok with html_url on 201 created", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(201, { html_url: "https://github.com/jayminwest/warren/pull/42" }),
		]);
		const result = await openPullRequest(baseInput, { fetch });
		expect(result).toEqual({
			ok: true,
			url: "https://github.com/jayminwest/warren/pull/42",
			mode: "created",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe("https://api.github.com/repos/jayminwest/warren/pulls");
		expect(calls[0]?.headers.authorization).toBe("Bearer ghp_xyz");
		expect(calls[0]?.headers.accept).toBe("application/vnd.github+json");
		const body = JSON.parse(calls[0]?.body as string);
		expect(body).toEqual({
			title: "Test PR",
			body: "body",
			head: "agent/refactor-bot/run-1",
			base: "main",
		});
	});

	test("treats 422 'already exists' as success and returns the existing PR url", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(422, {
				message: "Validation Failed",
				errors: [{ message: "A pull request already exists for warren:foo." }],
			}),
			jsonResponse(200, [{ html_url: "https://github.com/jayminwest/warren/pull/9" }]),
		]);
		const result = await openPullRequest(baseInput, { fetch });
		expect(result).toEqual({
			ok: true,
			url: "https://github.com/jayminwest/warren/pull/9",
			mode: "exists",
		});
		expect(calls).toHaveLength(2);
		expect(calls[1]?.method).toBe("GET");
		expect(calls[1]?.url).toContain("head=jayminwest%3Aagent");
		expect(calls[1]?.url).toContain("base=main");
	});

	test("returns http_error for unrecognized 422 (e.g. no commits between)", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(422, {
				message: "Validation Failed",
				errors: [{ message: "No commits between main and feature." }],
			}),
		]);
		const result = await openPullRequest(baseInput, { fetch });
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("http_error");
		expect(calls).toHaveLength(1);
	});

	test("returns missing_token when token is empty", async () => {
		const { fetch, calls } = recordingFetch([]);
		const result = await openPullRequest({ ...baseInput, token: "" }, { fetch });
		expect(result).toEqual({
			ok: false,
			reason: "missing_token",
			message: "GITHUB_TOKEN unset; cannot open pull request",
		});
		expect(calls).toHaveLength(0);
	});

	test("returns network on fetch throw", async () => {
		const failingFetch: PrFetcher = {
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		};
		const result = await openPullRequest(baseInput, failingFetch);
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("network");
		expect((result as { message: string }).message).toContain("ECONNREFUSED");
	});

	test("returns http_error on a 500 response", async () => {
		const { fetch } = recordingFetch([
			new Response("oops", { status: 500, headers: { "content-type": "text/plain" } }),
		]);
		const result = await openPullRequest(baseInput, { fetch });
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("http_error");
		expect((result as { message: string }).message).toContain("500");
	});
});

describe("buildPrContent", () => {
	test("first non-empty prompt line becomes the title", () => {
		const c = buildPrContent({
			prompt: "\n\nFix the auth bug in login flow\n\nMore detail follows.",
			runId: "run_abc",
			agentName: "refactor-bot",
		});
		expect(c.title).toBe("Fix the auth bug in login flow");
		expect(c.body).toContain("run_abc");
		expect(c.body).toContain("refactor-bot");
		expect(c.body).toContain("Fix the auth bug in login flow");
	});

	test("title truncates at 72 chars with ellipsis", () => {
		const long = "a".repeat(120);
		const c = buildPrContent({ prompt: long, runId: "run_x", agentName: "agt" });
		expect(c.title.length).toBeLessThanOrEqual(72);
		expect(c.title.endsWith("…")).toBe(true);
	});

	test("includes warren UI link when warrenBaseUrl is set", () => {
		const c = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "refactor-bot",
			warrenBaseUrl: "https://warren.example.com/",
		});
		expect(c.body).toContain("https://warren.example.com/#/runs/run_abc");
	});

	test("falls back to a synthetic title when prompt is whitespace", () => {
		const c = buildPrContent({ prompt: "   \n\n  ", runId: "run_abc", agentName: "refactor-bot" });
		expect(c.title).toContain("run_abc");
		expect(c.title).toContain("refactor-bot");
	});
});

describe("loadAutoOpenPrConfigFromEnv", () => {
	test("defaults to enabled with empty token when env is empty", () => {
		const cfg = loadAutoOpenPrConfigFromEnv({});
		expect(cfg.enabled).toBe(true);
		expect(cfg.token).toBe("");
		expect(cfg.warrenBaseUrl).toBeNull();
	});

	test("disables on falsy WARREN_AUTO_OPEN_PR values", () => {
		for (const v of ["0", "false", "FALSE", "no", "off", " "]) {
			expect(loadAutoOpenPrConfigFromEnv({ WARREN_AUTO_OPEN_PR: v }).enabled).toBe(false);
		}
	});

	test("stays enabled for any other value", () => {
		for (const v of ["1", "true", "yes", "on", "always"]) {
			expect(loadAutoOpenPrConfigFromEnv({ WARREN_AUTO_OPEN_PR: v }).enabled).toBe(true);
		}
	});

	test("forwards GITHUB_TOKEN and WARREN_BASE_URL", () => {
		const cfg = loadAutoOpenPrConfigFromEnv({
			GITHUB_TOKEN: "ghp_x",
			WARREN_BASE_URL: "https://warren.example.com",
		});
		expect(cfg.token).toBe("ghp_x");
		expect(cfg.warrenBaseUrl).toBe("https://warren.example.com");
	});
});
