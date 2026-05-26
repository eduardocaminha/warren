import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Burrow, NotFoundError } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { LaunchPreviewInput, LaunchPreviewResult } from "../preview/launch.ts";
import { PreviewPortAllocator } from "../preview/port-allocator.ts";
import type { ServerPreviewConfig } from "../warren-config/index.ts";
import { RunEventBroker } from "./events.ts";
import type { OpenPullRequestInput, OpenPullRequestResult } from "./pr.ts";
import type { AnnotatePrPreviewInput, AnnotatePrPreviewResult } from "./pr-annotate.ts";
import {
	mergeMulchFile,
	mergePlotEventsFile,
	mergePlotJsonFile,
	type ReapExec,
	type ReapFs,
	reapRun,
} from "./reap.ts";

/**
 * One-worker pool wired to a stub burrow client (warren-c0c9). Upserts a
 * `local` worker row so `pool.clientFor` resolves cleanly.
 */
async function makePool(
	client: BurrowClient,
	repos: Repos,
	workerName = "local",
): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: workerName, url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register(workerName, client);
	return pool;
}

interface FakeFs {
	readonly fs: ReapFs;
	readonly files: Map<string, string>;
	readonly dirs: Set<string>;
}

function fakeFs(seed: Record<string, string> = {}): FakeFs {
	const files = new Map<string, string>(Object.entries(seed));
	const dirs = new Set<string>();
	const fs: ReapFs = {
		mkdirp: async (path) => {
			dirs.add(path);
		},
		readFile: async (path) => files.get(path) ?? null,
		writeFile: async (path, contents) => {
			files.set(path, contents);
		},
		readdir: async (path) => {
			const prefix = path.endsWith("/") ? path : `${path}/`;
			const out = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest.includes("/")) continue;
				out.add(rest);
			}
			return [...out].sort();
		},
	};
	return { fs, files, dirs };
}

interface FakeExec {
	readonly exec: ReapExec;
	readonly calls: { cmd: string; args: readonly string[]; cwd: string }[];
	readonly fail: { reason: string } | null;
}

interface FakeExecOpts {
	/** Throw on every git push call (default: succeed). */
	fail?: string;
	/** Throw on git rev-list calls (default: succeed). */
	failRevList?: string;
	/**
	 * Stdout for `git rev-list --count <ref>..HEAD`. Default `"1"` so
	 * existing tests with `branchPushed: true` see commitsAhead=1 (real
	 * work shipped) rather than the empty-push shape (warren-f3bb).
	 */
	revListCount?: string;
	/**
	 * When `true`, `git diff --cached --quiet …` throws (exit non-zero =
	 * staged changes present). Default `false` — exits zero = no staged
	 * delta. Used by warren-343a plot-commit tests to flip the
	 * has-staged-delta branch under stagePlotForCommit.
	 */
	stagedDelta?: boolean;
}

function fakeExec(opts: FakeExecOpts = {}): FakeExec {
	const calls: { cmd: string; args: readonly string[]; cwd: string }[] = [];
	const fail = opts.fail !== undefined ? { reason: opts.fail } : null;
	const failRevList = opts.failRevList ?? null;
	const revListCount = opts.revListCount ?? "1";
	const stagedDelta = opts.stagedDelta === true;
	const exec: ReapExec = {
		run: async (cmd, args, opt) => {
			calls.push({ cmd, args, cwd: opt.cwd });
			const isRevList = cmd === "git" && args[0] === "rev-list";
			if (isRevList) {
				if (failRevList !== null) throw new Error(failRevList);
				return { stdout: `${revListCount}\n`, stderr: "" };
			}
			const isDiffCached =
				cmd === "git" &&
				args[0] === "diff" &&
				args.includes("--cached") &&
				args.includes("--quiet");
			if (isDiffCached) {
				if (stagedDelta) throw new Error("staged changes present");
				return { stdout: "", stderr: "" };
			}
			if (fail !== null) throw new Error(fail.reason);
			return { stdout: "", stderr: "" };
		},
	};
	return { exec, calls, fail };
}

interface FakeBurrowClientOpts {
	/**
	 * Body the workspace-side seeds file (`.seeds/issues.jsonl`) returns
	 * over `client.http.files.read`. `undefined` (default) makes the read
	 * throw `NotFoundError` — i.e. the agent never created the file —
	 * mirroring the no-op path. Pass a string to exercise the mirror code.
	 */
	seedsIssuesBody?: string;
	/** Override `client.http.files.read` end-to-end (advanced). */
	filesRead?: (burrowId: string, path: string) => Promise<{ contents: string }>;
}

function fakeBurrowClient(burrow: Burrow, opts: FakeBurrowClientOpts = {}): BurrowClient {
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: (async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch,
	});
	(client.http.burrows as unknown as { get: (id: string) => Promise<Burrow> }).get = async () =>
		burrow;
	const filesRead =
		opts.filesRead ??
		(async (_burrowId: string, path: string) => {
			if (path === ".seeds/issues.jsonl" && opts.seedsIssuesBody !== undefined) {
				return { contents: opts.seedsIssuesBody };
			}
			throw new NotFoundError(`file not found: ${path}`);
		});
	(
		client.http.files as unknown as {
			read: (burrowId: string, path: string) => Promise<{ contents: string }>;
		}
	).read = filesRead;
	return client;
}

function makeBurrow(overrides: Partial<Burrow> = {}): Burrow {
	const now = new Date(2026, 4, 8, 12, 0, 0);
	return {
		id: "bur_aaaaaaaaaaaa",
		state: "active",
		projectRoot: "/data/projects/x/y",
		workspacePath: "/data/burrow/ws",
		branch: "agent/refactor-bot/run-1",
		baseBranch: "main",
		network: "restricted",
		createdAt: now,
		updatedAt: now,
		destroyedAt: null,
		...overrides,
	} as unknown as Burrow;
}

interface Ctx {
	db: WarrenDb;
	repos: Repos;
	broker: RunEventBroker;
	runId: string;
	projectPath: string;
	workspacePath: string;
}

async function setup(): Promise<Ctx> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: { sections: { system: "x" } } });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const run = await repos.runs.create({
		agentName: "refactor-bot",
		projectId: project.id,
		prompt: "p",
		renderedAgentJson: {},
		trigger: "manual",
		burrowId: "bur_aaaaaaaaaaaa",
		burrowRunId: "run_zzzzzzzzzzzz",
	});
	await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
	await repos.runs.markRunning(run.id);
	return {
		db,
		repos,
		broker: new RunEventBroker(),
		runId: run.id,
		projectPath: project.localPath,
		workspacePath: "/data/burrow/ws",
	};
}

/* ----------------------------------------------------------------------- */
/* Pure mergeMulchFile cases                                                */
/* ----------------------------------------------------------------------- */

describe("mergeMulchFile (pure)", () => {
	test("appends incoming records into an empty existing file", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = async (kind: string, payload: unknown) => {
			events.push({ kind, payload });
			return {} as never;
		};
		const incoming =
			'{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"a"}\n' +
			'{"id":"mx-2","recorded_at":"2026-05-08T20:01:00Z","content":"b"}\n';
		const result = await mergeMulchFile("build", "", incoming, emit);
		expect(result.appended).toBe(2);
		expect(result.updated).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.merged.split("\n").filter(Boolean)).toHaveLength(2);
		expect(events.filter((e) => e.kind === "mulch.record.added")).toHaveLength(2);
	});

	test("replaces existing record when incoming recorded_at is newer", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = async (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const existing = '{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"old"}\n';
		const incoming = '{"id":"mx-1","recorded_at":"2026-05-08T21:00:00Z","content":"new"}\n';
		const result = await mergeMulchFile("build", existing, incoming, emit);
		expect(result.updated).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.appended).toBe(0);
		expect(result.merged).toContain('"content":"new"');
		expect(result.merged).not.toContain('"content":"old"');
		expect(events.find((e) => e.kind === "mulch.record.updated")).toBeDefined();
	});

	test("drops incoming when ts <= existing ts and emits skipped", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = async (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const existing = '{"id":"mx-1","recorded_at":"2026-05-08T21:00:00Z","content":"new"}\n';
		const incoming = '{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"old"}\n';
		const result = await mergeMulchFile("build", existing, incoming, emit);
		expect(result.skipped).toBe(1);
		expect(result.updated).toBe(0);
		expect(result.merged).toContain('"content":"new"');
		expect(events.find((e) => e.kind === "mulch.record.skipped")).toBeDefined();
	});

	test("appends anonymous (no-id) records without conflict", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = async (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const existing = '{"recorded_at":"2026-05-08T20:00:00Z","content":"already"}\n';
		const incoming =
			'{"recorded_at":"2026-05-08T20:01:00Z","content":"another"}\n' +
			'{"recorded_at":"2026-05-08T20:02:00Z","content":"and again"}\n';
		const result = await mergeMulchFile("build", existing, incoming, emit);
		expect(result.appended).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.merged.split("\n").filter(Boolean)).toHaveLength(3);
	});

	test("emits reap_failed for malformed incoming JSON without aborting", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = async (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const incoming =
			"this is not json\n" + '{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"ok"}\n';
		const result = await mergeMulchFile("build", "", incoming, emit);
		expect(result.appended).toBe(1);
		expect(events.find((e) => e.kind === "reap_failed")).toBeDefined();
	});
});

/* ----------------------------------------------------------------------- */
/* Pure mergePlotEventsFile / mergePlotJsonFile cases                       */
/* ----------------------------------------------------------------------- */

describe("mergePlotEventsFile (pure)", () => {
	test("appends incoming lines absent from the existing body", () => {
		const existing =
			'{"type":"plot_created","actor":"user:op","at":"2026-05-17T10:00:00.000Z","data":{"name":"x"}}\n';
		const incoming =
			'{"type":"plot_created","actor":"user:op","at":"2026-05-17T10:00:00.000Z","data":{"name":"x"}}\n' +
			'{"type":"decision_made","actor":"agent:bot:r1","at":"2026-05-17T10:05:00.000Z","data":{"summary":"x"}}\n';
		const result = mergePlotEventsFile(existing, incoming);
		expect(result.appended).toBe(1);
		expect(result.newEvents).toHaveLength(1);
		expect(result.newEvents[0]?.type).toBe("decision_made");
		expect(result.merged.split("\n").filter(Boolean)).toHaveLength(2);
	});

	test("re-running against an unchanged workspace appends nothing (idempotent)", () => {
		const body =
			'{"type":"decision_made","actor":"agent:bot:r1","at":"2026-05-17T10:05:00.000Z","data":{"summary":"x"}}\n';
		const result = mergePlotEventsFile(body, body);
		expect(result.appended).toBe(0);
		expect(result.changed).toBe(false);
	});

	test("malformed JSON lines still dedup by exact-line content but are not parsed", () => {
		const incoming = "not json at all\nalso-not-json\n";
		const result = mergePlotEventsFile("", incoming);
		expect(result.appended).toBe(2);
		expect(result.newEvents).toHaveLength(0);
	});
});

describe("mergePlotJsonFile (pure)", () => {
	test("takes incoming when project copy is absent", () => {
		const result = mergePlotJsonFile(null, '{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z"}');
		expect(result.changed).toBe(true);
		expect(result.conflict).toBeNull();
	});

	test("LWW on updated_at — newer incoming wins", () => {
		const result = mergePlotJsonFile(
			'{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z"}',
			'{"id":"pl-1","updated_at":"2026-05-17T11:00:00Z"}',
		);
		expect(result.changed).toBe(true);
		expect(result.merged).toContain('"updated_at":"2026-05-17T11:00:00Z"');
	});

	test("older incoming is dropped", () => {
		const result = mergePlotJsonFile(
			'{"id":"pl-1","updated_at":"2026-05-17T11:00:00Z"}',
			'{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z"}',
		);
		expect(result.changed).toBe(false);
		expect(result.conflict).toBeNull();
	});

	test("equal updated_at with different contents emits a content conflict", () => {
		const result = mergePlotJsonFile(
			'{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z","name":"a"}',
			'{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z","name":"b"}',
		);
		expect(result.changed).toBe(false);
		expect(result.conflict).toContain("updated_at");
	});

	test("identical bodies are a no-op", () => {
		const body = '{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z"}';
		const result = mergePlotJsonFile(body, body);
		expect(result.changed).toBe(false);
		expect(result.conflict).toBeNull();
	});
});

/* ----------------------------------------------------------------------- */
/* End-to-end reapRun cases                                                 */
/* ----------------------------------------------------------------------- */

describe("reapRun", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("merges burrow .mulch into project .mulch and pushes the workspace branch", async () => {
		const f = fakeFs({
			"/data/burrow/ws/.mulch/expertise/build.jsonl":
				'{"id":"mx-1","recorded_at":"2026-05-08T21:00:00Z","content":"new"}\n',
			"/data/projects/x/y/.mulch/expertise/build.jsonl":
				'{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"old"}\n',
		});
		const e = fakeExec();

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.state).toBe("succeeded");
		expect(result.mulchUpdated).toBe(1);
		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBe(1);
		expect(result.errors).toEqual([]);
		expect(f.files.get("/data/projects/x/y/.mulch/expertise/build.jsonl")).toContain(
			'"content":"new"',
		);
		// Reap runs `git push` then `git rev-list --count <base>..HEAD`
		// (warren-f3bb).
		expect(e.calls).toHaveLength(2);
		expect(e.calls[0]?.cmd).toBe("git");
		expect(e.calls[0]?.args).toEqual(["push", "origin", "HEAD:agent/refactor-bot/run-1"]);
		expect(e.calls[0]?.cwd).toBe("/data/burrow/ws");
		expect(e.calls[1]?.cmd).toBe("git");
		expect(e.calls[1]?.args).toEqual(["rev-list", "--count", "main..HEAD"]);
	});

	test("emits reap.empty_push when push lands zero commits (warren-f3bb)", async () => {
		const f = fakeFs();
		const e = fakeExec({ revListCount: "0" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBe(0);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const empty = events.find((ev) => ev.kind === "reap.empty_push");
		expect(empty).toBeDefined();
		expect(empty?.payloadJson).toMatchObject({
			branch: "agent/refactor-bot/run-1",
			baseBranch: "main",
		});
		const completed = events.find((ev) => ev.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({ branchPushed: true, commitsAhead: 0 });
	});

	test("does not emit reap.empty_push when push lands real commits", async () => {
		const e = fakeExec({ revListCount: "3" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.commitsAhead).toBe(3);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
	});

	test("rev-list failure degrades commitsAhead to null without failing reap", async () => {
		const e = fakeExec({ failRevList: "fatal: bad revision 'main..HEAD'" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBeNull();
		// Non-fatal: not a reap_failed step.
		expect(result.errors.map((x) => x.step)).not.toContain("branch_push");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
	});

	test("uses project.defaultBranch as the rev-list base", async () => {
		// Override the project's defaultBranch to verify reap reads it
		// (not a hardcoded `main`) when computing the empty-push count.
		const customDb = await openDatabase({ path: ":memory:" });
		const customRepos = createRepos(customDb);
		await customRepos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await customRepos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "develop",
		});
		const run = await customRepos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		await customRepos.runs.markRunning(run.id);

		const e = fakeExec({ revListCount: "2" });
		const result = await reapRun({
			runId: run.id,
			outcome: "succeeded",
			repos: customRepos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.commitsAhead).toBe(2);
		const revList = e.calls.find((c) => c.args[0] === "rev-list");
		expect(revList?.args).toEqual(["rev-list", "--count", "develop..HEAD"]);
		await customDb.close();
	});

	test("transitions warren run state to the supplied terminal outcome", async () => {
		await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.state).toBe("failed");
		expect(row.endedAt).not.toBeNull();
	});

	test("queued → succeeded transition is bridged via markRunning first", async () => {
		// Reset the run back to queued for this case.
		await ctx.repos.runs.finalize(ctx.runId, "cancelled"); // park previous state
		const repos = ctx.repos;
		const project = (await repos.projects.listAll())[0];
		expect(project).toBeDefined();
		const fresh = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: (project as { id: string }).id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_freshfreshfr",
		});
		await reapRun({
			runId: fresh.id,
			outcome: "succeeded",
			repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		const row = await repos.runs.require(fresh.id);
		expect(row.state).toBe("succeeded");
		expect(row.startedAt).not.toBeNull();
	});

	test("logs reap_failed but does not throw when the branch push fails", async () => {
		const f = fakeFs();
		const e = fakeExec({ fail: "remote rejected: not allowed" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.branchPushed).toBe(false);
		expect(result.errors.map((x) => x.step)).toContain("branch_push");
		expect(result.state).toBe("succeeded");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.some((ev) => ev.kind === "reap_failed")).toBe(true);
	});

	test("logs reap_failed when burrow lookup fails and skips file work", async () => {
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: (async () =>
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch,
		});
		(client.http.burrows as unknown as { get: () => Promise<Burrow> }).get = async () => {
			throw new Error("burrow gone");
		};
		const e = fakeExec();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(client, ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});
		expect(result.errors.map((x) => x.step)).toContain("workspace_lookup");
		expect(result.branchPushed).toBe(false);
		expect(e.calls).toHaveLength(0);
		expect(result.state).toBe("succeeded");
	});

	test("is idempotent against runs already in a terminal state", async () => {
		await ctx.repos.runs.finalize(ctx.runId, "succeeded");
		const e = fakeExec();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});
		expect(result.alreadyTerminal).toBe(true);
		expect(e.calls).toHaveLength(0);
		expect(await ctx.repos.events.countByRun(ctx.runId)).toBe(0);
	});

	test("mirrors closed seeds into the project's .seeds/issues.jsonl via HttpClient.files.read", async () => {
		const f = fakeFs({
			"/data/projects/x/y/.seeds/issues.jsonl":
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(
				fakeBurrowClient(makeBurrow(), {
					seedsIssuesBody:
						'{"id":"sd-1","status":"closed","updatedAt":"2026-05-08T22:00:00Z","title":"x"}\n' +
						'{"id":"sd-2","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"y"}\n',
				}),
				ctx.repos,
			),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(1);
		expect(result.seedsCreated).toBe(1);
		const merged = f.files.get("/data/projects/x/y/.seeds/issues.jsonl") ?? "";
		expect(merged).toContain('"status":"closed"');
		expect(merged).toContain('"id":"sd-2"');
	});

	test("mirrors newly-created open seeds from planner runs into the project clone", async () => {
		const f = fakeFs({
			"/data/projects/x/y/.seeds/issues.jsonl":
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(
				fakeBurrowClient(makeBurrow(), {
					seedsIssuesBody:
						'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n' +
						'{"id":"sd-new1","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"planned-a"}\n' +
						'{"id":"sd-new2","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"planned-b"}\n',
				}),
				ctx.repos,
			),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(0);
		expect(result.seedsCreated).toBe(2);
		const merged = f.files.get("/data/projects/x/y/.seeds/issues.jsonl") ?? "";
		expect(merged).toContain('"id":"sd-new1"');
		expect(merged).toContain('"id":"sd-new2"');
		expect(merged).toContain('"id":"sd-1"');
	});

	test("does not overwrite existing open seeds with workspace copies", async () => {
		const f = fakeFs({
			"/data/projects/x/y/.seeds/issues.jsonl":
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"original"}\n',
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(
				fakeBurrowClient(makeBurrow(), {
					seedsIssuesBody:
						'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"modified"}\n',
				}),
				ctx.repos,
			),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(0);
		expect(result.seedsCreated).toBe(0);
		const merged = f.files.get("/data/projects/x/y/.seeds/issues.jsonl") ?? "";
		expect(merged).toContain('"title":"original"');
		expect(merged).not.toContain('"title":"modified"');
	});

	test("seeds_close treats NotFoundError from files.read as 'no seeds file' (no error, no mirror)", async () => {
		// Default fakeBurrowClient throws NotFoundError from files.read —
		// the workspace-side seeds file does not exist, which is the
		// agent-never-created-it shape. seeds_close should be a no-op,
		// not a reap_failed.
		const f = fakeFs({
			"/data/projects/x/y/.seeds/issues.jsonl":
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(0);
		expect(result.errors.map((x) => x.step)).not.toContain("seeds_close");
		// Project-side file untouched.
		expect(f.files.get("/data/projects/x/y/.seeds/issues.jsonl")).toBe(
			'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		);
	});

	test("seeds_close surfaces non-NotFound errors from files.read as reap_failed", async () => {
		const f = fakeFs();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(
				fakeBurrowClient(makeBurrow(), {
					filesRead: async () => {
						throw new Error("boom");
					},
				}),
				ctx.repos,
			),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(0);
		expect(result.errors.map((x) => x.step)).toContain("seeds_close");
	});

	test("publishes reap-emitted events to the broker for live tailers", async () => {
		const f = fakeFs({
			"/data/burrow/ws/.mulch/expertise/build.jsonl":
				'{"id":"mx-1","recorded_at":"2026-05-08T21:00:00Z","content":"new"}\n',
		});
		const sub = ctx.broker.subscribe(ctx.runId);
		const consumed: string[] = [];
		const consumer = (async () => {
			for await (const row of sub) {
				consumed.push(row.kind);
				if (row.kind === "reap.completed") break;
			}
		})();

		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: f.fs,
			exec: fakeExec().exec,
		});
		await consumer;
		expect(consumed).toContain("mulch.record.added");
		expect(consumed).toContain("reap.completed");
	});

	test("classifies a queued-on-entry failure as never_started (warren-3c40)", async () => {
		// New run is created in `queued`; no bridge event ever fired, so it
		// stays `queued` — that's the "burrow accepted dispatch but never
		// started the run" shape.
		const repos = ctx.repos;
		const project = (await repos.projects.listAll())[0];
		expect(project).toBeDefined();
		const stuck = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: (project as { id: string }).id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_neverstarted",
		});

		const result = await reapRun({
			runId: stuck.id,
			outcome: "failed",
			repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("never_started");
		const row = await repos.runs.require(stuck.id);
		expect(row.state).toBe("failed");
		expect(row.failureReason).toBe("never_started");

		const events = await repos.events.listByRun(stuck.id);
		const completed = events.find((e) => e.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({ failureReason: "never_started" });
	});

	test("classifies running-on-entry with model output as crashed (warren-3c40)", async () => {
		// ctx.runId was already markRunning'd in setup(). Seed an assistant
		// text event so the discriminator sees a real model turn — that's
		// the "agent ran and crashed mid-conversation" shape, distinct from
		// the warren-5165 no-output shape.
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "I'll start by reading the file." },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("crashed");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("crashed");
	});

	test("classifies running-on-entry with no model output as no_model_response (warren-5165)", async () => {
		// Bridge claimed the run on a non-model-turn event (e.g. the
		// claude-code init system event), then the agent exited before
		// producing any assistant turn — the "Not logged in / credential"
		// shape from run_hkkm35bcckc4. Seed a state_change/system event
		// to simulate the init, but no text/thinking/tool_use stdout
		// events.
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "system", subtype: "init", apiKeySource: "/login managed key" },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("no_model_response");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("no_model_response");
	});

	test("thinking and tool_use events also count as model-turn output (warren-5165)", async () => {
		// burrow's jsonl-claude parser maps assistant content blocks into
		// kind=text, kind=thinking, or kind=tool_use. Any one of them is
		// proof the run reached at least one assistant turn → crashed,
		// not no_model_response.
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "tool_use",
			stream: "stdout",
			payload: { type: "tool_use", name: "Read", input: { path: "/x" } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("crashed");
	});

	test("succeeded runs carry no failureReason", async () => {
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(result.failureReason).toBeNull();
		expect((await ctx.repos.runs.require(ctx.runId)).failureReason).toBeNull();
	});

	test("explicit failureReason override wins over inference (warren-3c40)", async () => {
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			failureReason: "timed_out",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(result.failureReason).toBe("timed_out");
		expect((await ctx.repos.runs.require(ctx.runId)).failureReason).toBe("timed_out");
	});

	test("idempotent reap surfaces the previously-stored failureReason", async () => {
		// Seed a model-turn event so the first reap classifies as crashed
		// (warren-5165 discriminator: bare running-on-entry with no model
		// output would now classify as no_model_response).
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "ok" },
		});
		// First reap: classify as crashed and persist.
		await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		// Second reap on the now-terminal row should report the same reason
		// (idempotency for restart-recovery sweeps).
		const second = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(second.alreadyTerminal).toBe(true);
		expect(second.failureReason).toBe("crashed");
	});

	/* --------------------------------------------------------------- */
	/* pr_open sub-step (warren-f6af)                                   */
	/* --------------------------------------------------------------- */

	function fakeOpenPr(
		responses: ReadonlyArray<OpenPullRequestResult | (() => OpenPullRequestResult)>,
	): {
		openPr: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
		calls: OpenPullRequestInput[];
	} {
		const calls: OpenPullRequestInput[] = [];
		let i = 0;
		const openPr = async (input: OpenPullRequestInput): Promise<OpenPullRequestResult> => {
			calls.push(input);
			const r = responses[i++];
			if (r === undefined) throw new Error("fakeOpenPr: out of responses");
			return typeof r === "function" ? r() : r;
		};
		return { openPr, calls };
	}

	test("opens PR after a successful push with real commits and persists prUrl", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBe("https://github.com/x/y/pull/77");
		expect(pr.calls).toHaveLength(1);
		expect(pr.calls[0]?.owner).toBe("x");
		expect(pr.calls[0]?.repo).toBe("y");
		expect(pr.calls[0]?.head).toBe("agent/refactor-bot/run-1");
		expect(pr.calls[0]?.base).toBe("main");
		expect((await ctx.repos.runs.require(ctx.runId)).prUrl).toBe("https://github.com/x/y/pull/77");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const opened = events.find((ev) => ev.kind === "reap.pr_opened");
		expect(opened?.payloadJson).toMatchObject({
			prUrl: "https://github.com/x/y/pull/77",
			mode: "created",
		});
		const completed = events.find((ev) => ev.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({ prUrl: "https://github.com/x/y/pull/77" });
	});

	test("skips pr_open when autoOpenPr is omitted (default off in tests)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")).toBeUndefined();
	});

	test("skips pr_open when autoOpenPr is disabled", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: false, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
	});

	test("skips pr_open when outcome is failed (conservative V1)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
	});

	test("skips pr_open when push lands no commits (commitsAhead === 0)", async () => {
		const e = fakeExec({ revListCount: "0" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
	});

	test("skips pr_open when branch matches project.defaultBranch", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow({ branch: "main" })), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
	});

	test("skips pr_open when push failed", async () => {
		const e = fakeExec({ fail: "remote rejected" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.branchPushed).toBe(false);
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
	});

	test("emits reap_failed step=pr_open when token is missing but auto-open enabled", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(pr.calls).toHaveLength(0);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const failed = events.find(
			(ev) =>
				ev.kind === "reap_failed" &&
				typeof ev.payloadJson === "object" &&
				ev.payloadJson !== null &&
				(ev.payloadJson as { step?: string }).step === "pr_open",
		);
		expect(failed).toBeDefined();
	});

	test("treats 'pr already exists' (mode=exists) as success and persists the existing url", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/3", mode: "exists" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBe("https://github.com/x/y/pull/3");
		expect(result.errors.map((x) => x.step)).not.toContain("pr_open");
		expect((await ctx.repos.runs.require(ctx.runId)).prUrl).toBe("https://github.com/x/y/pull/3");
	});

	test("emits reap_failed step=pr_open when openPr returns network error", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: false, reason: "network", message: "ECONNREFUSED" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(result.state).toBe("succeeded");
	});

	/* --------------------------------------------------------------- */
	/* preview_launch + pr_annotate_preview sub-steps (warren-f156)     */
	/* --------------------------------------------------------------- */

	const SERVER_PREVIEW: ServerPreviewConfig = {
		type: "server",
		command: "bun run dev",
		port: 3000,
	};

	function fakeLaunch(
		responses: ReadonlyArray<LaunchPreviewResult | (() => LaunchPreviewResult)>,
	): {
		launch: (input: LaunchPreviewInput) => Promise<LaunchPreviewResult>;
		calls: LaunchPreviewInput[];
	} {
		const calls: LaunchPreviewInput[] = [];
		let i = 0;
		const launch = async (input: LaunchPreviewInput): Promise<LaunchPreviewResult> => {
			calls.push(input);
			const r = responses[i++];
			if (r === undefined) throw new Error("fakeLaunch: out of responses");
			return typeof r === "function" ? r() : r;
		};
		return { launch, calls };
	}

	function fakeAnnotate(
		responses: ReadonlyArray<AnnotatePrPreviewResult | (() => AnnotatePrPreviewResult)>,
	): {
		annotate: (input: AnnotatePrPreviewInput) => Promise<AnnotatePrPreviewResult>;
		calls: AnnotatePrPreviewInput[];
	} {
		const calls: AnnotatePrPreviewInput[] = [];
		let i = 0;
		const annotate = async (input: AnnotatePrPreviewInput): Promise<AnnotatePrPreviewResult> => {
			calls.push(input);
			const r = responses[i++];
			if (r === undefined) throw new Error("fakeAnnotate: out of responses");
			return typeof r === "function" ? r() : r;
		};
		return { annotate, calls };
	}

	test("launches preview when outcome=succeeded and project opted in, surfaces live state", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(result.previewState).toBe("live");
		expect(result.previewPort).toBe(40000);
		expect(launch.calls).toHaveLength(1);
		expect(launch.calls[0]?.previewConfig.command).toBe("bun run dev");
		// warren-0928: no per-project override → reap omits readinessTimeoutMs
		// so the launcher uses DEFAULT_READINESS_TIMEOUT_MS.
		expect(launch.calls[0]?.readinessTimeoutMs).toBeUndefined();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "preview_launched")).toBeDefined();
	});

	// warren-0928: per-project readiness_timeout flows from .warren/preview.yaml
	// through reap into the launcher as milliseconds. The schema validated the
	// string at load time, so reap parses with parseDurationMs unconditionally.
	test("forwards previewConfig.readiness_timeout as launcher readinessTimeoutMs", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: { ...SERVER_PREVIEW, readiness_timeout: "10m" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls).toHaveLength(1);
		expect(launch.calls[0]?.readinessTimeoutMs).toBe(600_000);
	});

	// warren-d9e7: per-project setup + setup_timeout flow through reap the
	// same way readiness_timeout does — schema validates the duration shape
	// at load time, reap parses to ms before handing off to the launcher.
	test("forwards previewConfig.setup_timeout as launcher setupTimeoutMs", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: { ...SERVER_PREVIEW, setup: "pnpm install", setup_timeout: "10m" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls).toHaveLength(1);
		expect(launch.calls[0]?.previewConfig.setup).toBe("pnpm install");
		expect(launch.calls[0]?.setupTimeoutMs).toBe(600_000);
	});

	test("omits launcher setupTimeoutMs when previewConfig.setup_timeout absent", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: { ...SERVER_PREVIEW, setup: "pnpm install" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls[0]?.setupTimeoutMs).toBeUndefined();
	});

	// warren-9b15: per-project connect_timeout follows the same plumb-through
	// pattern. Phase-1 budget covers sidecar startup + port bind; phase-2
	// budget (readiness_timeout) covers bundler first-compile. Both default
	// when unset so existing projects see no behavior change.
	test("forwards previewConfig.connect_timeout as launcher connectTimeoutMs", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: { ...SERVER_PREVIEW, connect_timeout: "2m" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls).toHaveLength(1);
		expect(launch.calls[0]?.connectTimeoutMs).toBe(120_000);
	});

	test("omits launcher connectTimeoutMs when previewConfig.connect_timeout absent", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls[0]?.connectTimeoutMs).toBeUndefined();
	});

	test("skips preview launch when project did not opt in (no previewConfig)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			launchPreview: launch.launch,
		});
		expect(result.previewState).toBeNull();
		expect(launch.calls).toHaveLength(0);
	});

	test("skips preview launch when outcome=failed (mirrors pr_open conservative gate)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(result.previewState).toBeNull();
		expect(launch.calls).toHaveLength(0);
	});

	test("emits reap_failed step=preview_launch when launcher returns failure", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([
			{
				ok: false,
				reason: "readiness_timeout",
				message: "no 2xx after 60s",
				failureTail: "TypeError",
				port: 40000,
			},
		]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		// The launcher (real) writes preview_state="failed" before returning;
		// the stub doesn't, but reap captures the state for the result envelope.
		expect(result.previewState).toBe("failed");
		expect(result.previewPort).toBe(40000);
		expect(result.errors.map((e) => e.step)).toContain("preview_launch");
		// reap never fails the run on preview launch failure.
		expect(result.state).toBe("succeeded");
	});

	test("preview launch failure does not block reap.completed transition", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([
			() => {
				throw new Error("burrow client exploded");
			},
		]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(result.state).toBe("succeeded");
		expect(result.previewState).toBe("failed");
		expect(result.errors.map((e) => e.step)).toContain("preview_launch");
	});

	test("skips preview launch and emits reap_failed when worker is non-local (R-12 deferral)", async () => {
		// Re-tag the burrow + run to a non-local worker so the gate fires.
		await ctx.repos.workers.upsert({ name: "remote", url: "http://remote:8080" });
		await ctx.repos.burrows.delete("bur_aaaaaaaaaaaa");
		await ctx.repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "remote" });
		await ctx.repos.runs.attachBurrow(ctx.runId, { workerId: "remote" });
		const pool = new BurrowClientPool({ repos: ctx.repos });
		pool.register("remote", fakeBurrowClient(makeBurrow()));
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: pool,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls).toHaveLength(0);
		expect(result.previewState).toBe("failed");
		expect(result.errors.map((e) => e.step)).toContain("preview_launch");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.previewFailureMessage).toContain("R-12");
	});

	test("annotates the PR body with the live preview URL after launch and pr_open succeed", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const annotate = fakeAnnotate([{ ok: true, mode: "patched" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "subdomain" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		expect(result.prUrl).toBe("https://github.com/x/y/pull/77");
		expect(result.previewState).toBe("live");
		expect(annotate.calls).toHaveLength(1);
		expect(annotate.calls[0]?.preview).toEqual({
			state: "live",
			url: `https://run-${ctx.runId}.warren.example.com`,
		});
		expect(result.previewUrl).toBe(`https://run-${ctx.runId}.warren.example.com`);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "preview_annotated")).toBeDefined();
	});

	test("annotates the PR body with the path-mode preview URL when mode=path (warren-c3c4)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const annotate = fakeAnnotate([{ ok: true, mode: "patched" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "path" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		expect(annotate.calls).toHaveLength(1);
		expect(annotate.calls[0]?.preview).toEqual({
			state: "live",
			url: `https://warren.example.com/p/${ctx.runId}/`,
		});
		expect(result.previewUrl).toBe(`https://warren.example.com/p/${ctx.runId}/`);
	});

	test("pr_annotate_preview is skipped when no PR was opened", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const annotate = fakeAnnotate([]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "subdomain" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		expect(annotate.calls).toHaveLength(0);
	});

	test("pr_annotate_preview is skipped (and reap_failed) when WARREN_PREVIEW_HOST is unset", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const annotate = fakeAnnotate([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: null, mode: "subdomain" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		expect(annotate.calls).toHaveLength(0);
		expect(result.errors.map((e) => e.step)).toContain("pr_annotate_preview");
		expect(result.state).toBe("succeeded");
	});

	test("pr_annotate_preview still patches a failure tail even with WARREN_PREVIEW_HOST unset", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const launch = fakeLaunch([
			{
				ok: false,
				reason: "readiness_timeout",
				message: "no 2xx after 60s",
				failureTail: "TypeError",
				port: 40000,
			},
		]);
		// reap reads previewFailureMessage from the row; the real launcher
		// writes it but our stub doesn't. Pre-seed the row so the
		// annotation step sees the tail.
		await ctx.repos.runs.attachPreview(ctx.runId, {
			previewFailureMessage: "TypeError: cannot read X",
		});
		const annotate = fakeAnnotate([{ ok: true, mode: "patched" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: null, mode: "subdomain" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		expect(annotate.calls).toHaveLength(1);
		expect(annotate.calls[0]?.preview).toMatchObject({
			state: "failed",
			failureTail: "TypeError: cannot read X",
		});
		expect(result.previewUrl).toBeNull();
	});

	test("pr_open includes the preview placeholder fragment when project opted in", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const annotate = fakeAnnotate([{ ok: true, mode: "patched" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "subdomain" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		const body = pr.calls[0]?.body ?? "";
		expect(body).toContain("<!-- warren:preview-start -->");
		expect(body).toContain("<!-- warren:preview-end -->");
		expect(body).toContain("## Preview");
	});

	/* --------------------------------------------------------------- */
	/* plot_merge sub-step (warren-7e0f / pl-2047 step 6)               */
	/* --------------------------------------------------------------- */

	test("merges burrow .plot events into project .plot and mirrors agent events tagged with plot_id", async () => {
		const burrowEvents =
			'{"type":"plot_created","actor":"user:op","at":"2026-05-17T10:00:00.000Z","data":{"name":"x"}}\n' +
			'{"type":"run_dispatched","actor":"user:op","at":"2026-05-17T10:00:01.000Z","data":{"run_id":"r1"}}\n' +
			'{"type":"decision_made","actor":"agent:refactor-bot:r1","at":"2026-05-17T10:05:00.000Z","data":{"summary":"use Bun"}}\n' +
			'{"type":"question_posed","actor":"agent:refactor-bot:r1","at":"2026-05-17T10:06:00.000Z","data":{"text":"which db?","blocking":true}}\n' +
			'{"type":"artifact_produced","actor":"agent:refactor-bot:r1","at":"2026-05-17T10:07:00.000Z","data":{"type":"file","ref":"src/x.ts"}}\n' +
			'{"type":"note","actor":"agent:refactor-bot:r1","at":"2026-05-17T10:08:00.000Z","data":{"text":"fyi"}}\n';
		const projectEvents =
			'{"type":"plot_created","actor":"user:op","at":"2026-05-17T10:00:00.000Z","data":{"name":"x"}}\n' +
			'{"type":"run_dispatched","actor":"user:op","at":"2026-05-17T10:00:01.000Z","data":{"run_id":"r1"}}\n';
		const f = fakeFs({
			"/data/burrow/ws/.plot/plot-abc12345.events.jsonl": burrowEvents,
			"/data/projects/x/y/.plot/plot-abc12345.events.jsonl": projectEvents,
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: f.fs,
			exec: fakeExec().exec,
		});

		expect(result.plotEventsAppended).toBe(4);
		expect(result.plotEventsMirrored).toBe(3);
		expect(result.errors).toEqual([]);
		const merged = f.files.get("/data/projects/x/y/.plot/plot-abc12345.events.jsonl") ?? "";
		// All four new events from the workspace land in the project file.
		expect(merged).toContain('"summary":"use Bun"');
		expect(merged).toContain('"text":"which db?"');
		expect(merged).toContain('"ref":"src/x.ts"');
		expect(merged).toContain('"text":"fyi"');
		// Existing project lines preserved in order.
		expect(merged.indexOf('"name":"x"')).toBeLessThan(merged.indexOf('"summary":"use Bun"'));

		const events = await ctx.repos.events.listByRun(ctx.runId);
		const mirrored = events.filter((ev) => ev.kind.startsWith("plot."));
		const kinds = mirrored.map((ev) => ev.kind).sort();
		expect(kinds).toEqual(["plot.artifact_produced", "plot.decision_made", "plot.question_posed"]);
		const decision = mirrored.find((ev) => ev.kind === "plot.decision_made");
		expect(decision?.payloadJson).toMatchObject({
			plotId: "plot-abc12345",
			actor: "agent:refactor-bot:r1",
			at: "2026-05-17T10:05:00.000Z",
		});
		// note and run_dispatched are NOT mirrored even though they appended.
		expect(events.find((ev) => ev.kind === "plot.note")).toBeUndefined();
		expect(events.find((ev) => ev.kind === "plot.run_dispatched")).toBeUndefined();
	});

	test("plot_merge is idempotent — second reap against an already-merged workspace appends nothing", async () => {
		const burrowEvents =
			'{"type":"decision_made","actor":"agent:refactor-bot:r1","at":"2026-05-17T10:05:00.000Z","data":{"summary":"use Bun"}}\n';
		const f = fakeFs({
			"/data/burrow/ws/.plot/plot-abc12345.events.jsonl": burrowEvents,
		});

		const first = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(first.plotEventsAppended).toBe(1);
		expect(first.plotEventsMirrored).toBe(1);

		// Spawn a sibling run pointing at the same project + workspace and reap
		// it; the project's .plot/ already has the event so the merge dedups.
		const fresh = await ctx.repos.runs.create({
			agentName: "refactor-bot",
			projectId: ((await ctx.repos.projects.listAll())[0] as { id: string }).id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_idempotent",
		});
		await ctx.repos.runs.markRunning(fresh.id);

		const second = await reapRun({
			runId: fresh.id,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(second.plotEventsAppended).toBe(0);
		expect(second.plotEventsMirrored).toBe(0);
	});

	test("plot_merge writes through pl-id.json by last-write-wins on updated_at", async () => {
		const projectJson = JSON.stringify({
			schema_version: 1,
			id: "plot-abc12345",
			name: "x",
			status: "active",
			created_at: "2026-05-17T10:00:00.000Z",
			updated_at: "2026-05-17T10:00:00.000Z",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [],
		});
		const workspaceJson = JSON.stringify({
			schema_version: 1,
			id: "plot-abc12345",
			name: "x",
			status: "active",
			created_at: "2026-05-17T10:00:00.000Z",
			updated_at: "2026-05-17T11:00:00.000Z",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [{ id: "att-001", type: "file", ref: "x.ts", role: "tracks" }],
		});
		const f = fakeFs({
			"/data/burrow/ws/.plot/plot-abc12345.json": workspaceJson,
			"/data/projects/x/y/.plot/plot-abc12345.json": projectJson,
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});

		expect(result.plotsUpdated).toBe(1);
		const merged = f.files.get("/data/projects/x/y/.plot/plot-abc12345.json") ?? "";
		expect(merged).toContain('"att-001"');
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "plot.updated")?.payloadJson).toMatchObject({
			plotId: "plot-abc12345",
		});
	});

	test("plot_merge emits plot.conflict when updated_at matches but contents differ", async () => {
		const ts = "2026-05-17T10:00:00.000Z";
		const projectJson = JSON.stringify({ id: "plot-abc12345", updated_at: ts, name: "a" });
		const workspaceJson = JSON.stringify({ id: "plot-abc12345", updated_at: ts, name: "b" });
		const f = fakeFs({
			"/data/burrow/ws/.plot/plot-abc12345.json": workspaceJson,
			"/data/projects/x/y/.plot/plot-abc12345.json": projectJson,
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});

		expect(result.plotsUpdated).toBe(0);
		// Project copy stays put on a content conflict.
		expect(f.files.get("/data/projects/x/y/.plot/plot-abc12345.json")).toBe(projectJson);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const conflict = events.find((ev) => ev.kind === "plot.conflict");
		expect(conflict?.payloadJson).toMatchObject({ plotId: "plot-abc12345" });
	});

	test("plot_merge is a no-op when the workspace has no .plot/ directory", async () => {
		const f = fakeFs();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.plotEventsAppended).toBe(0);
		expect(result.plotsUpdated).toBe(0);
		expect(result.plotEventsMirrored).toBe(0);
		expect(result.errors.map((e) => e.step)).not.toContain("plot_merge");
	});

	test("plot_merge does not mirror user-actor decision/question/artifact events", async () => {
		// A human-authored decision should land in the merged events file but
		// must NOT appear in warren's event stream — the mirror is keyed on
		// agent-emitted entries per the seed wording.
		const burrowEvents =
			'{"type":"decision_made","actor":"user:operator","at":"2026-05-17T10:05:00.000Z","data":{"summary":"use Bun"}}\n';
		const f = fakeFs({
			"/data/burrow/ws/.plot/plot-abc12345.events.jsonl": burrowEvents,
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});

		expect(result.plotEventsAppended).toBe(1);
		expect(result.plotEventsMirrored).toBe(0);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "plot.decision_made")).toBeUndefined();
	});

	test("assigns burrow_event_seq above MAX(seq) so reap events sort after stream events", async () => {
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 7,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: {},
		});
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		const seqs = (await ctx.repos.events.listByRun(ctx.runId)).map((e) => e.burrowEventSeq);
		expect(seqs[0]).toBe(7);
		for (let i = 1; i < seqs.length; i++) {
			const a = seqs[i - 1] ?? 0;
			const b = seqs[i] ?? 0;
			expect(b).toBeGreaterThan(a);
		}
	});

	/* ------------------------------------------------------------------ */
	/* warren-343a: commit-through-reap for .plot/                         */
	/* ------------------------------------------------------------------ */

	async function setupWithPlot(): Promise<Ctx> {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
			hasPlot: true,
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		await repos.runs.markRunning(run.id);
		return {
			db,
			repos,
			broker: new RunEventBroker(),
			runId: run.id,
			projectPath: project.localPath,
			workspacePath: "/data/burrow/ws",
		};
	}

	test("authors a warren commit when project .plot/ has a delta the agent never committed (warren-343a)", async () => {
		const plotCtx = await setupWithPlot();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl":
					'{"type":"run_dispatched","actor":"user:operator","at":"2026-05-18T10:00:00Z","data":{}}\n',
				"/data/projects/x/y/.plot/plot-abc.json":
					'{"id":"plot-abc","status":"active","updated_at":"2026-05-18T10:00:00Z"}',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: plotCtx.runId,
				outcome: "succeeded",
				repos: plotCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), plotCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.plotCommitted).toBe(true);
			expect(f.files.get("/data/burrow/ws/.plot/plot-abc.events.jsonl")).toContain(
				"run_dispatched",
			);
			expect(f.files.get("/data/burrow/ws/.plot/plot-abc.json")).toContain('"status":"active"');
			const gitArgs = e.calls.filter((c) => c.cmd === "git").map((c) => c.args);
			expect(gitArgs).toContainEqual(["add", "--", ".plot/"]);
			expect(gitArgs).toContainEqual(["diff", "--cached", "--quiet", "--", ".plot/"]);
			const commit = gitArgs.find((a) => a[0] === "-c" && a.includes("commit"));
			expect(commit).toEqual([
				"-c",
				"user.name=warren",
				"-c",
				"user.email=warren@os-eco.dev",
				"commit",
				"-m",
				"chore(warren): plot state",
			]);
			const events = await plotCtx.repos.events.listByRun(plotCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.plot_committed")).toBeDefined();
		} finally {
			await plotCtx.db.close();
		}
	});

	test("does not commit when the agent already committed every .plot/ delta", async () => {
		const plotCtx = await setupWithPlot();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl":
					'{"type":"run_dispatched","actor":"user:operator","at":"2026-05-18T10:00:00Z","data":{}}\n',
			});
			const e = fakeExec({ stagedDelta: false });

			const result = await reapRun({
				runId: plotCtx.runId,
				outcome: "succeeded",
				repos: plotCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), plotCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.plotCommitted).toBe(false);
			const commit = e.calls.find((c) => c.cmd === "git" && c.args.includes("commit"));
			expect(commit).toBeUndefined();
			const events = await plotCtx.repos.events.listByRun(plotCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.plot_committed")).toBeUndefined();
		} finally {
			await plotCtx.db.close();
		}
	});

	test("skips .plot/.index.db* and non-plot-* entries when copying into the workspace", async () => {
		const plotCtx = await setupWithPlot();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl": '{"type":"note"}\n',
				"/data/projects/x/y/.plot/.index.db": "binary-sqlite",
				"/data/projects/x/y/.plot/.index.db-wal": "wal",
				"/data/projects/x/y/.plot/README.md": "# docs",
			});
			const e = fakeExec({ stagedDelta: true });

			await reapRun({
				runId: plotCtx.runId,
				outcome: "succeeded",
				repos: plotCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), plotCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(f.files.get("/data/burrow/ws/.plot/plot-abc.events.jsonl")).toBeDefined();
			expect(f.files.get("/data/burrow/ws/.plot/.index.db")).toBeUndefined();
			expect(f.files.get("/data/burrow/ws/.plot/.index.db-wal")).toBeUndefined();
			expect(f.files.get("/data/burrow/ws/.plot/README.md")).toBeUndefined();
		} finally {
			await plotCtx.db.close();
		}
	});

	test("trivial-merge child: warren commit keeps reap.empty_push silent", async () => {
		const plotCtx = await setupWithPlot();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl":
					'{"type":"run_dispatched","actor":"user:operator","at":"2026-05-18T10:00:00Z","data":{}}\n',
			});
			const e = fakeExec({ stagedDelta: true, revListCount: "1" });

			const result = await reapRun({
				runId: plotCtx.runId,
				outcome: "succeeded",
				repos: plotCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), plotCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.plotCommitted).toBe(true);
			expect(result.branchPushed).toBe(true);
			expect(result.commitsAhead).toBe(1);
			const events = await plotCtx.repos.events.listByRun(plotCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
		} finally {
			await plotCtx.db.close();
		}
	});

	test("project without .plot/ skips the plot_commit step entirely", async () => {
		const f = fakeFs({
			"/data/projects/x/y/.plot/plot-abc.events.jsonl": '{"type":"x"}\n',
		});
		const e = fakeExec({ stagedDelta: true });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.plotCommitted).toBe(false);
		expect(f.files.get("/data/burrow/ws/.plot/plot-abc.events.jsonl")).toBeUndefined();
		const gitArgs = e.calls.filter((c) => c.cmd === "git").map((c) => c.args);
		expect(gitArgs.find((a) => a.includes("add"))).toBeUndefined();
		expect(gitArgs.find((a) => a.includes("commit"))).toBeUndefined();
	});

	/* ------------------------------------------------------------------ */
	/* warren-7ecc: commit-through-reap for .seeds/                        */
	/* ------------------------------------------------------------------ */

	async function setupWithSeeds(): Promise<Ctx> {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
			hasSeeds: true,
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		await repos.runs.markRunning(run.id);
		return {
			db,
			repos,
			broker: new RunEventBroker(),
			runId: run.id,
			projectPath: project.localPath,
			workspacePath: "/data/burrow/ws",
		};
	}

	test("authors a warren commit when project .seeds/ has a delta the agent never committed (warren-7ecc)", async () => {
		const seedsCtx = await setupWithSeeds();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
				"/data/projects/x/y/.seeds/plans.jsonl":
					'{"id":"pl-abcd","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: seedsCtx.runId,
				outcome: "succeeded",
				repos: seedsCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), seedsCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.seedsCommitted).toBe(true);
			expect(f.files.get("/data/burrow/ws/.seeds/issues.jsonl")).toContain("warren-1234");
			expect(f.files.get("/data/burrow/ws/.seeds/plans.jsonl")).toContain("pl-abcd");
			const gitArgs = e.calls.filter((c) => c.cmd === "git").map((c) => c.args);
			expect(gitArgs).toContainEqual(["add", "--", ".seeds/"]);
			expect(gitArgs).toContainEqual(["diff", "--cached", "--quiet", "--", ".seeds/"]);
			const commit = gitArgs.find((a) => a[0] === "-c" && a.includes("commit"));
			expect(commit).toEqual([
				"-c",
				"user.name=warren",
				"-c",
				"user.email=warren@os-eco.dev",
				"commit",
				"-m",
				"chore(warren): seeds state",
			]);
			const events = await seedsCtx.repos.events.listByRun(seedsCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.seeds_committed")).toBeDefined();
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("does not commit when the agent already committed every .seeds/ delta", async () => {
		const seedsCtx = await setupWithSeeds();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
			});
			const e = fakeExec({ stagedDelta: false });

			const result = await reapRun({
				runId: seedsCtx.runId,
				outcome: "succeeded",
				repos: seedsCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), seedsCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.seedsCommitted).toBe(false);
			const commit = e.calls.find((c) => c.cmd === "git" && c.args.includes("commit"));
			expect(commit).toBeUndefined();
			const events = await seedsCtx.repos.events.listByRun(seedsCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.seeds_committed")).toBeUndefined();
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("skips .seeds/config.yaml + .seeds/templates.jsonl when copying into the workspace", async () => {
		const seedsCtx = await setupWithSeeds();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
				"/data/projects/x/y/.seeds/config.yaml": 'project: "x"\n',
				"/data/projects/x/y/.seeds/templates.jsonl": '{"id":"t1"}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			await reapRun({
				runId: seedsCtx.runId,
				outcome: "succeeded",
				repos: seedsCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), seedsCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(f.files.get("/data/burrow/ws/.seeds/issues.jsonl")).toBeDefined();
			expect(f.files.get("/data/burrow/ws/.seeds/config.yaml")).toBeUndefined();
			expect(f.files.get("/data/burrow/ws/.seeds/templates.jsonl")).toBeUndefined();
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("planner-default-prompt round trip: warren commit keeps reap.empty_push silent (warren-7ecc)", async () => {
		const seedsCtx = await setupWithSeeds();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
				"/data/projects/x/y/.seeds/plans.jsonl":
					'{"id":"pl-abcd","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
			});
			const e = fakeExec({ stagedDelta: true, revListCount: "1" });

			const result = await reapRun({
				runId: seedsCtx.runId,
				outcome: "succeeded",
				repos: seedsCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), seedsCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.seedsCommitted).toBe(true);
			expect(result.branchPushed).toBe(true);
			expect(result.commitsAhead).toBe(1);
			const events = await seedsCtx.repos.events.listByRun(seedsCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("project without .seeds/ skips the seeds_commit step entirely", async () => {
		const f = fakeFs({
			"/data/projects/x/y/.seeds/issues.jsonl": '{"id":"warren-1234","status":"open"}\n',
		});
		const e = fakeExec({ stagedDelta: true });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.seedsCommitted).toBe(false);
		expect(f.files.get("/data/burrow/ws/.seeds/issues.jsonl")).toBeUndefined();
		const gitArgs = e.calls.filter((c) => c.cmd === "git").map((c) => c.args);
		expect(gitArgs.find((a) => a.includes("add") && a.includes(".seeds/"))).toBeUndefined();
		expect(gitArgs.find((a) => a.includes("commit"))).toBeUndefined();
	});
});

/* ----------------------------------------------------------------------- */
/* Auto plan-run from reap (warren-a32a)                                    */
/* ----------------------------------------------------------------------- */

describe("auto_plan_run (warren-a32a)", () => {
	async function setupAutoPlanRun(opts: { frontmatter?: Record<string, unknown> } = {}) {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		await repos.agents.upsert({
			name: "patrol-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
			hasSeeds: true,
		});
		const run = await repos.runs.create({
			agentName: "patrol-bot",
			projectId: project.id,
			prompt: "patrol scan",
			renderedAgentJson: {
				name: "patrol-bot",
				version: 1,
				sections: { system: "you are a patrol bot" },
				resolvedFrom: [],
				frontmatter: opts.frontmatter ?? { auto_plan_run: true },
			},
			trigger: "cron",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		await repos.runs.markRunning(run.id);
		return {
			db,
			repos,
			broker: new RunEventBroker(),
			runId: run.id,
			projectPath: project.localPath,
			workspacePath: "/data/burrow/ws",
			projectId: project.id,
		};
	}

	test("auto-dispatches a plan-run when agent has auto_plan_run: true and creates a new plan", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/burrow/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1","warren-c2"]}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(true);
			expect(result.autoPlanRunPlanId).toBe("pl-new1");
			expect(result.autoPlanRunId).not.toBeNull();
			const events = await ctx.repos.events.listByRun(ctx.runId);
			expect(events.find((ev) => ev.kind === "auto_plan_run_created")).toBeDefined();
			const planRun = await ctx.repos.planRuns.require(result.autoPlanRunId as string);
			expect(planRun.planId).toBe("pl-new1");
			expect(planRun.agentName).toBe("patrol-bot");
			expect(planRun.trigger).toBe("auto_plan_run");
			const children = await ctx.repos.planRuns.listChildren(planRun.id);
			expect(children).toHaveLength(2);
			expect(children[0]?.seedId).toBe("warren-c1");
			expect(children[1]?.seedId).toBe("warren-c2");
		} finally {
			await ctx.db.close();
		}
	});

	test("uses auto_plan_run_agent override instead of parent agent name (warren-65b2)", async () => {
		const ctx = await setupAutoPlanRun({
			frontmatter: { auto_plan_run: true, auto_plan_run_agent: "pi" },
		});
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/burrow/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1","warren-c2"]}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(true);
			const planRun = await ctx.repos.planRuns.require(result.autoPlanRunId as string);
			expect(planRun.agentName).toBe("pi");
		} finally {
			await ctx.db.close();
		}
	});

	test("does not dispatch when agent lacks auto_plan_run frontmatter", async () => {
		const ctx = await setupAutoPlanRun({ frontmatter: {} });
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/burrow/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1"]}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(false);
			expect(result.autoPlanRunId).toBeNull();
		} finally {
			await ctx.db.close();
		}
	});

	test("does not dispatch when run failed", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/burrow/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1"]}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "failed",
				repos: ctx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(false);
		} finally {
			await ctx.db.close();
		}
	});

	test("does not dispatch when no new plans detected", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const existingPlan = '{"id":"pl-old1","status":"approved","children":["warren-c1"]}\n';
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": existingPlan,
				"/data/burrow/ws/.seeds/plans.jsonl": existingPlan,
			});
			const e = fakeExec({ stagedDelta: false });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(false);
		} finally {
			await ctx.db.close();
		}
	});

	test("handles multiple new plans — one plan-run per plan", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/burrow/ws/.seeds/plans.jsonl":
					'{"id":"pl-a","status":"approved","children":["warren-a1"]}\n' +
					'{"id":"pl-b","status":"approved","children":["warren-b1","warren-b2"]}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(true);
			const events = await ctx.repos.events.listByRun(ctx.runId);
			const autoPlanEvents = events.filter((ev) => ev.kind === "auto_plan_run_created");
			expect(autoPlanEvents).toHaveLength(2);
		} finally {
			await ctx.db.close();
		}
	});

	test("project without .seeds/ skips auto_plan_run gracefully", async () => {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		await repos.agents.upsert({
			name: "patrol-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
			hasSeeds: false,
		});
		const run = await repos.runs.create({
			agentName: "patrol-bot",
			projectId: project.id,
			prompt: "patrol scan",
			renderedAgentJson: {
				name: "patrol-bot",
				version: 1,
				sections: { system: "x" },
				resolvedFrom: [],
				frontmatter: { auto_plan_run: true },
			},
			trigger: "cron",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		await repos.runs.markRunning(run.id);
		try {
			const f = fakeFs({
				"/data/burrow/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1"]}\n',
			});
			const e = fakeExec();

			const result = await reapRun({
				runId: run.id,
				outcome: "succeeded",
				repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(false);
		} finally {
			await db.close();
		}
	});

	test("inherits plotId from the parent run when present", async () => {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		await repos.agents.upsert({
			name: "patrol-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
			hasSeeds: true,
			hasPlot: true,
		});
		const run = await repos.runs.create({
			agentName: "patrol-bot",
			projectId: project.id,
			prompt: "patrol scan",
			renderedAgentJson: {
				name: "patrol-bot",
				version: 1,
				sections: { system: "x" },
				resolvedFrom: [],
				frontmatter: { auto_plan_run: true },
			},
			trigger: "cron",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
			plotId: "plot-abc123",
		});
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		await repos.runs.markRunning(run.id);
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/burrow/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1"]}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: run.id,
				outcome: "succeeded",
				repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(true);
			const planRun = await repos.planRuns.require(result.autoPlanRunId as string);
			expect(planRun.plotId).toBe("plot-abc123");
		} finally {
			await db.close();
		}
	});
});
