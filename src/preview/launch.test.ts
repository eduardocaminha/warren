import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ServerPreviewConfig } from "../warren-config/index.ts";
import {
	DEFAULT_READINESS_TIMEOUT_MS,
	formatPreviewUrl,
	launchPreview,
	loadPreviewLaunchConfigFromEnv,
	PROBE_PER_CALL_TIMEOUT_MS,
	type PreviewSidecarsClient,
} from "./launch.ts";
import { PreviewPortAllocator } from "./port-allocator.ts";

const PREVIEW_CONFIG: ServerPreviewConfig = {
	type: "server",
	command: "bun run dev",
	port: 3000,
};

interface FakeSidecar {
	client: PreviewSidecarsClient;
	readonly creates: Array<{
		burrowId: string;
		command: readonly string[];
		env?: Record<string, string>;
		inboundPortForward?: { hostPort: number; sandboxPort: number };
		readinessPath?: string;
	}>;
	readonly deletes: Array<{ burrowId: string; sidecarId: string }>;
	logs: { stdout: string; stderr: string };
	createImpl?: () => Promise<{ id: string; state: string }>;
}

type CreateInput = Parameters<PreviewSidecarsClient["create"]>[0];

function fakeSidecars(
	initialLogs: { stdout: string; stderr: string } = { stdout: "", stderr: "" },
): FakeSidecar {
	const creates: FakeSidecar["creates"] = [];
	const deletes: FakeSidecar["deletes"] = [];
	const state: FakeSidecar = {
		client: {} as PreviewSidecarsClient,
		creates,
		deletes,
		logs: { ...initialLogs },
	};
	const client: PreviewSidecarsClient = {
		async create(input: CreateInput) {
			creates.push({
				burrowId: input.burrowId,
				command: [...input.command],
				...(input.env !== undefined ? { env: { ...input.env } } : {}),
				...(input.inboundPortForward !== undefined
					? { inboundPortForward: input.inboundPortForward }
					: {}),
				...(input.readinessPath !== undefined ? { readinessPath: input.readinessPath } : {}),
			});
			if (state.createImpl !== undefined) return state.createImpl();
			return { id: "sc_test_1", state: "live" };
		},
		async logs() {
			return { stdout: state.logs.stdout, stderr: state.logs.stderr };
		},
		async delete(burrowId: string, sidecarId: string) {
			deletes.push({ burrowId, sidecarId });
		},
	};
	state.client = client;
	return state;
}

function fakeFetch(responses: Array<Response | (() => Response)>): {
	fetch: typeof fetch;
	calls: string[];
} {
	const calls: string[] = [];
	let i = 0;
	const fn = (async (input: URL | RequestInfo): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);
		const next = responses[i++];
		if (next === undefined) throw new Error("fakeFetch: out of responses");
		return typeof next === "function" ? next() : next;
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

describe("launchPreview", () => {
	let db: WarrenDb;
	let repos: Repos;
	let allocator: PreviewPortAllocator;
	let runId: string;
	let burrowId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "agent",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaa",
		});
		runId = run.id;
		burrowId = "bur_aaaa";
		allocator = new PreviewPortAllocator(DrizzleAdapter.for(db), { start: 40000, end: 40002 });
	});

	afterEach(async () => {
		await db.close();
	});

	test("allocates a port, spawns the sidecar, marks live on 2xx readiness", async () => {
		const sidecars = fakeSidecars();
		const { fetch, calls } = fakeFetch([new Response("ok", { status: 200 })]);
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			sleep: async () => {},
			now: () => new Date("2026-05-14T18:00:00.000Z"),
		});
		expect(result).toEqual({ ok: true, port: 40000, sidecarId: "sc_test_1" });
		expect(sidecars.creates).toHaveLength(1);
		const created = sidecars.creates[0];
		expect(created?.command).toEqual(["sh", "-c", "bun run dev"]);
		expect(created?.env).toEqual({ HOST: "0.0.0.0", HOSTNAME: "0.0.0.0", PORT: "3000" });
		expect(created?.inboundPortForward).toEqual({ hostPort: 40000, sandboxPort: 3000 });
		expect(calls[0]).toBe("http://127.0.0.1:40000/");
		const row = await repos.runs.require(runId);
		expect(row.previewState).toBe("live");
		expect(row.previewPort).toBe(40000);
		expect(row.previewFailureMessage).toBeNull();
	});

	// warren-79b2: dev servers (Next.js 13.5+, http.createServer() defaults)
	// that bind to 127.0.0.1 only are unreachable from burrow's inbound
	// forwarder. Inject HOST/HOSTNAME=0.0.0.0 + PORT=<sandbox port> on every
	// preview sidecar so CRA / Express-style servers default to "reachable",
	// and so frameworks that read process.env.PORT don't need the operator to
	// duplicate the port number in their command.
	test("injects HOST/HOSTNAME/PORT into the sidecar env, PORT matches previewConfig.port", async () => {
		const sidecars = fakeSidecars();
		const { fetch } = fakeFetch([new Response("ok", { status: 200 })]);
		const config: ServerPreviewConfig = { ...PREVIEW_CONFIG, port: 5173 };
		await launchPreview({
			runId,
			burrowId,
			previewConfig: config,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			sleep: async () => {},
		});
		expect(sidecars.creates[0]?.env).toEqual({
			HOST: "0.0.0.0",
			HOSTNAME: "0.0.0.0",
			PORT: "5173",
		});
	});

	test("honors readiness_path when supplied", async () => {
		const sidecars = fakeSidecars();
		const { fetch, calls } = fakeFetch([new Response("ok", { status: 200 })]);
		const config: ServerPreviewConfig = { ...PREVIEW_CONFIG, readiness_path: "/healthz" };
		await launchPreview({
			runId,
			burrowId,
			previewConfig: config,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			sleep: async () => {},
		});
		expect(calls[0]).toBe("http://127.0.0.1:40000/healthz");
		expect(sidecars.creates[0]?.readinessPath).toBe("/healthz");
	});

	test("treats 3xx as ready (dev servers redirect / to /index)", async () => {
		const sidecars = fakeSidecars();
		const { fetch } = fakeFetch([new Response(null, { status: 302 })]);
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			sleep: async () => {},
		});
		expect(result.ok).toBe(true);
	});

	test("returns port_exhausted when the allocator has no free ports", async () => {
		// Pre-fill both ports in the tiny 40000-40001 range.
		const tinyAllocator = new PreviewPortAllocator(DrizzleAdapter.for(db), {
			start: 40000,
			end: 40001,
		});
		const occupant1 = await repos.runs.create({
			agentName: "agent",
			projectId: (await repos.projects.listAll())[0]?.id as string,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		const occupant2 = await repos.runs.create({
			agentName: "agent",
			projectId: (await repos.projects.listAll())[0]?.id as string,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		await repos.runs.attachPreview(occupant1.id, { previewState: "live", previewPort: 40000 });
		await repos.runs.attachPreview(occupant2.id, { previewState: "live", previewPort: 40001 });

		const sidecars = fakeSidecars();
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator: tinyAllocator,
			sidecars: sidecars.client,
			fetch: (async () => new Response("never", { status: 200 })) as unknown as typeof fetch,
			sleep: async () => {},
		});
		expect(result).toEqual({
			ok: false,
			reason: "port_exhausted",
			message: expect.stringContaining("port_exhausted"),
			failureTail: "",
			port: null,
		});
		expect(sidecars.creates).toHaveLength(0);
		const row = await repos.runs.require(runId);
		expect(row.previewState).toBe("failed");
		expect(row.previewFailureMessage).toContain("port_exhausted");
	});

	test("returns create_failed when burrow sidecar spawn throws", async () => {
		const sidecars = fakeSidecars();
		sidecars.createImpl = async () => {
			throw new Error("sandbox spawn refused");
		};
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch: (async () => new Response("never", { status: 200 })) as unknown as typeof fetch,
			sleep: async () => {},
		});
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("create_failed");
		const row = await repos.runs.require(runId);
		expect(row.previewState).toBe("failed");
		expect(row.previewPort).toBeNull();
		expect(row.previewFailureMessage).toContain("sandbox spawn refused");
	});

	test("returns readiness_timeout, captures stderr tail, deletes the sidecar", async () => {
		const sidecars = fakeSidecars({ stdout: "compiling…\n", stderr: "TypeError: cannot read X\n" });
		// Step the clock so we can fire the timeout deterministically.
		const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
		let ticks = 0;
		const now = (): Date => new Date(t0 + ticks * 1000);
		const { fetch } = fakeFetch([
			new Response("502", { status: 502 }),
			new Response("502", { status: 502 }),
			new Response("502", { status: 502 }),
		]);
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			sleep: async () => {
				ticks += 5;
			},
			now,
			readinessTimeoutMs: 2_000,
			readinessPollMs: 100,
		});
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("readiness_timeout");
		expect((result as { failureTail: string }).failureTail).toContain("TypeError");
		expect(sidecars.deletes).toHaveLength(1);
		const row = await repos.runs.require(runId);
		expect(row.previewState).toBe("failed");
		expect(row.previewPort).toBeNull();
		expect(row.previewFailureMessage).toContain("readiness probe");
		expect(row.previewFailureMessage).toContain("TypeError");
	});

	// warren-0928: cold pnpm/npm installs commonly exceed 60s; the new default
	// covers the install + bind window so happy-path startup doesn't fail on
	// first-time runs.
	test("DEFAULT_READINESS_TIMEOUT_MS is 5 minutes", () => {
		expect(DEFAULT_READINESS_TIMEOUT_MS).toBe(300_000);
	});

	test("respects injected readinessTimeoutMs over the default deadline", async () => {
		// Hold the clock fixed and feed enough 502s to exhaust the override
		// (10ms / 100ms poll = 1 attempt, no further attempts before deadline).
		// The 5m default would mean ~3000 attempts — any non-default ceiling
		// pulled from the input must actually shorten the loop.
		const sidecars = fakeSidecars({ stdout: "", stderr: "compile error\n" });
		const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
		let ticks = 0;
		const now = (): Date => new Date(t0 + ticks);
		const { fetch, calls } = fakeFetch([
			new Response("502", { status: 502 }),
			new Response("502", { status: 502 }),
		]);
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			sleep: async (ms) => {
				ticks += ms * 10; // advance fast so the loop exits in O(1) probes
			},
			now,
			readinessTimeoutMs: 50,
			readinessPollMs: 100,
		});
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("readiness_timeout");
		expect(calls.length).toBeLessThan(5);
	});

	// warren-33eb: a fetch that never resolves on its own must not block the
	// readiness deadline. The per-call AbortController fires before each probe
	// returns, the loop ticks past the wall-clock deadline, and we end in
	// `readiness_timeout` rather than hanging until the upstream fetch unblocks.
	test("aborts hung fetches via per-call timeout and still hits the wall-clock deadline", async () => {
		const sidecars = fakeSidecars({ stdout: "", stderr: "compiling…\n" });
		const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
		let ticks = 0;
		const now = (): Date => new Date(t0 + ticks);

		// Fetch that ignores the response and only resolves (as a rejection) when
		// the AbortController fires. Without the per-call timeout this would hang
		// forever and the deadline check would never run.
		let probeCalls = 0;
		const hangingFetch = (async (
			_input: URL | RequestInfo,
			init?: RequestInit,
		): Promise<Response> => {
			probeCalls++;
			const signal = init?.signal;
			if (signal === undefined || signal === null) {
				throw new Error("expected per-call AbortSignal");
			}
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		}) as unknown as typeof fetch;

		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch: hangingFetch,
			sleep: async () => {
				// Advance the wall clock past the deadline once a probe has aborted.
				ticks += 1_000;
			},
			now,
			readinessTimeoutMs: 200,
			readinessPollMs: 50,
			probePerCallTimeoutMs: 10,
		});

		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("readiness_timeout");
		// Loop must have iterated at least once and bounded — not a single 10s hang.
		expect(probeCalls).toBeGreaterThanOrEqual(1);
		expect(probeCalls).toBeLessThan(20);
		const row = await repos.runs.require(runId);
		expect(row.previewState).toBe("failed");
		expect(row.previewPort).toBeNull();
	});

	test("PROBE_PER_CALL_TIMEOUT_MS is 2 seconds (warren-33eb)", () => {
		expect(PROBE_PER_CALL_TIMEOUT_MS).toBe(2_000);
	});

	test("falls back to stdout tail when stderr is empty", async () => {
		const sidecars = fakeSidecars({ stdout: "noisy stdout output\n", stderr: "" });
		let ticks = 0;
		const now = (): Date => new Date(new Date("2026-05-14T18:00:00.000Z").getTime() + ticks * 1000);
		const { fetch } = fakeFetch([new Response("nope", { status: 500 })]);
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			sleep: async () => {
				ticks += 10;
			},
			now,
			readinessTimeoutMs: 5_000,
			readinessPollMs: 100,
		});
		expect((result as { failureTail: string }).failureTail).toContain("stdout output");
	});
});

describe("loadPreviewLaunchConfigFromEnv", () => {
	test("returns host=null when WARREN_PREVIEW_HOST is unset", () => {
		expect(loadPreviewLaunchConfigFromEnv({})).toEqual({ host: null, mode: "path" });
	});

	test("returns host=null on whitespace-only value", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_HOST: "   " })).toEqual({
			host: null,
			mode: "path",
		});
	});

	test("returns the trimmed host suffix", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_HOST: " warren.example.com " })).toEqual(
			{ host: "warren.example.com", mode: "path" },
		);
	});

	test("defaults mode to 'path' when WARREN_PREVIEW_MODE is unset (warren-fcb7)", () => {
		expect(loadPreviewLaunchConfigFromEnv({}).mode).toBe("path");
	});

	test("accepts WARREN_PREVIEW_MODE=subdomain (case-insensitive, trimmed)", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "subdomain" }).mode).toBe(
			"subdomain",
		);
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: " SUBDOMAIN " }).mode).toBe(
			"subdomain",
		);
	});

	test("accepts WARREN_PREVIEW_MODE=path (explicit opt-in matches default)", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "path" }).mode).toBe("path");
	});

	test("invalid WARREN_PREVIEW_MODE silently falls back to 'path' default", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "wildcard" }).mode).toBe("path");
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "" }).mode).toBe("path");
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "   " }).mode).toBe("path");
	});
});

describe("formatPreviewUrl", () => {
	test("subdomain mode renders https URL with run id sub-host (no trailing slash)", () => {
		expect(formatPreviewUrl("run_abc123", "warren.example.com", "subdomain")).toBe(
			"https://run-run_abc123.warren.example.com",
		);
	});

	test("path mode renders https URL under /p/<id>/ with trailing slash (warren-c3c4)", () => {
		expect(formatPreviewUrl("run_abc123", "warren.example.com", "path")).toBe(
			"https://warren.example.com/p/run_abc123/",
		);
	});
});
