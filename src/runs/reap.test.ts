import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Burrow } from "@os-eco/burrow-cli";
import { BurrowClient } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "./events.ts";
import type { OpenPullRequestInput, OpenPullRequestResult } from "./pr.ts";
import { mergeMulchFile, type ReapExec, type ReapFs, reapRun } from "./reap.ts";

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
}

function fakeExec(opts: FakeExecOpts = {}): FakeExec {
	const calls: { cmd: string; args: readonly string[]; cwd: string }[] = [];
	const fail = opts.fail !== undefined ? { reason: opts.fail } : null;
	const failRevList = opts.failRevList ?? null;
	const revListCount = opts.revListCount ?? "1";
	const exec: ReapExec = {
		run: async (cmd, args, opt) => {
			calls.push({ cmd, args, cwd: opt.cwd });
			const isRevList = cmd === "git" && args[0] === "rev-list";
			if (isRevList) {
				if (failRevList !== null) throw new Error(failRevList);
				return { stdout: `${revListCount}\n`, stderr: "" };
			}
			if (fail !== null) throw new Error(fail.reason);
			return { stdout: "", stderr: "" };
		},
	};
	return { exec, calls, fail };
}

function fakeBurrowClient(burrow: Burrow): BurrowClient {
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
	repos.agents.upsert({ name: "refactor-bot", renderedJson: { sections: { system: "x" } } });
	const project = repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const run = repos.runs.create({
		agentName: "refactor-bot",
		projectId: project.id,
		prompt: "p",
		renderedAgentJson: {},
		trigger: "manual",
		burrowId: "bur_aaaaaaaaaaaa",
		burrowRunId: "run_zzzzzzzzzzzz",
	});
	repos.runs.markRunning(run.id);
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
	test("appends incoming records into an empty existing file", () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = (kind: string, payload: unknown) => {
			events.push({ kind, payload });
			return {} as never;
		};
		const incoming =
			'{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"a"}\n' +
			'{"id":"mx-2","recorded_at":"2026-05-08T20:01:00Z","content":"b"}\n';
		const result = mergeMulchFile("build", "", incoming, emit);
		expect(result.appended).toBe(2);
		expect(result.updated).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.merged.split("\n").filter(Boolean)).toHaveLength(2);
		expect(events.filter((e) => e.kind === "mulch.record.added")).toHaveLength(2);
	});

	test("replaces existing record when incoming recorded_at is newer", () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const existing = '{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"old"}\n';
		const incoming = '{"id":"mx-1","recorded_at":"2026-05-08T21:00:00Z","content":"new"}\n';
		const result = mergeMulchFile("build", existing, incoming, emit);
		expect(result.updated).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.appended).toBe(0);
		expect(result.merged).toContain('"content":"new"');
		expect(result.merged).not.toContain('"content":"old"');
		expect(events.find((e) => e.kind === "mulch.record.updated")).toBeDefined();
	});

	test("drops incoming when ts <= existing ts and emits skipped", () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const existing = '{"id":"mx-1","recorded_at":"2026-05-08T21:00:00Z","content":"new"}\n';
		const incoming = '{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"old"}\n';
		const result = mergeMulchFile("build", existing, incoming, emit);
		expect(result.skipped).toBe(1);
		expect(result.updated).toBe(0);
		expect(result.merged).toContain('"content":"new"');
		expect(events.find((e) => e.kind === "mulch.record.skipped")).toBeDefined();
	});

	test("appends anonymous (no-id) records without conflict", () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const existing = '{"recorded_at":"2026-05-08T20:00:00Z","content":"already"}\n';
		const incoming =
			'{"recorded_at":"2026-05-08T20:01:00Z","content":"another"}\n' +
			'{"recorded_at":"2026-05-08T20:02:00Z","content":"and again"}\n';
		const result = mergeMulchFile("build", existing, incoming, emit);
		expect(result.appended).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.merged.split("\n").filter(Boolean)).toHaveLength(3);
	});

	test("emits reap_failed for malformed incoming JSON without aborting", () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const incoming =
			"this is not json\n" + '{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"ok"}\n';
		const result = mergeMulchFile("build", "", incoming, emit);
		expect(result.appended).toBe(1);
		expect(events.find((e) => e.kind === "reap_failed")).toBeDefined();
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

	afterEach(() => {
		ctx.db.close();
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
			burrowClient: fakeBurrowClient(makeBurrow()),
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBe(0);
		const events = ctx.repos.events.listByRun(ctx.runId);
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.commitsAhead).toBe(3);
		const events = ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
	});

	test("rev-list failure degrades commitsAhead to null without failing reap", async () => {
		const e = fakeExec({ failRevList: "fatal: bad revision 'main..HEAD'" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBeNull();
		// Non-fatal: not a reap_failed step.
		expect(result.errors.map((x) => x.step)).not.toContain("branch_push");
		const events = ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
	});

	test("uses project.defaultBranch as the rev-list base", async () => {
		// Override the project's defaultBranch to verify reap reads it
		// (not a hardcoded `main`) when computing the empty-push count.
		const customDb = await openDatabase({ path: ":memory:" });
		const customRepos = createRepos(customDb);
		customRepos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = customRepos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "develop",
		});
		const run = customRepos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		customRepos.runs.markRunning(run.id);

		const e = fakeExec({ revListCount: "2" });
		const result = await reapRun({
			runId: run.id,
			outcome: "succeeded",
			repos: customRepos,
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.commitsAhead).toBe(2);
		const revList = e.calls.find((c) => c.args[0] === "rev-list");
		expect(revList?.args).toEqual(["rev-list", "--count", "develop..HEAD"]);
		customDb.close();
	});

	test("transitions warren run state to the supplied terminal outcome", async () => {
		await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		const row = ctx.repos.runs.require(ctx.runId);
		expect(row.state).toBe("failed");
		expect(row.endedAt).not.toBeNull();
	});

	test("queued → succeeded transition is bridged via markRunning first", async () => {
		// Reset the run back to queued for this case.
		ctx.repos.runs.finalize(ctx.runId, "cancelled"); // park previous state
		const repos = ctx.repos;
		const project = repos.projects.listAll()[0];
		expect(project).toBeDefined();
		const fresh = repos.runs.create({
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		const row = repos.runs.require(fresh.id);
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.branchPushed).toBe(false);
		expect(result.errors.map((x) => x.step)).toContain("branch_push");
		expect(result.state).toBe("succeeded");
		const events = ctx.repos.events.listByRun(ctx.runId);
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
			burrowClient: client,
			fs: fakeFs().fs,
			exec: e.exec,
		});
		expect(result.errors.map((x) => x.step)).toContain("workspace_lookup");
		expect(result.branchPushed).toBe(false);
		expect(e.calls).toHaveLength(0);
		expect(result.state).toBe("succeeded");
	});

	test("is idempotent against runs already in a terminal state", async () => {
		ctx.repos.runs.finalize(ctx.runId, "succeeded");
		const e = fakeExec();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: e.exec,
		});
		expect(result.alreadyTerminal).toBe(true);
		expect(e.calls).toHaveLength(0);
		expect(ctx.repos.events.countByRun(ctx.runId)).toBe(0);
	});

	test("mirrors closed seeds into the project's .seeds/issues.jsonl", async () => {
		const f = fakeFs({
			"/data/burrow/ws/.seeds/issues.jsonl":
				'{"id":"sd-1","status":"closed","updatedAt":"2026-05-08T22:00:00Z","title":"x"}\n' +
				'{"id":"sd-2","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"y"}\n',
			"/data/projects/x/y/.seeds/issues.jsonl":
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(1);
		const merged = f.files.get("/data/projects/x/y/.seeds/issues.jsonl") ?? "";
		expect(merged).toContain('"status":"closed"');
		expect(merged).not.toContain('"status":"open","updatedAt":"2026-05-08T19:00:00Z"');
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
			burrowClient: fakeBurrowClient(makeBurrow()),
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
		const project = repos.projects.listAll()[0];
		expect(project).toBeDefined();
		const stuck = repos.runs.create({
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("never_started");
		const row = repos.runs.require(stuck.id);
		expect(row.state).toBe("failed");
		expect(row.failureReason).toBe("never_started");

		const events = repos.events.listByRun(stuck.id);
		const completed = events.find((e) => e.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({ failureReason: "never_started" });
	});

	test("classifies running-on-entry with model output as crashed (warren-3c40)", async () => {
		// ctx.runId was already markRunning'd in setup(). Seed an assistant
		// text event so the discriminator sees a real model turn — that's
		// the "agent ran and crashed mid-conversation" shape, distinct from
		// the warren-5165 no-output shape.
		ctx.repos.events.append({
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("crashed");
		const row = ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("crashed");
	});

	test("classifies running-on-entry with no model output as no_model_response (warren-5165)", async () => {
		// Bridge claimed the run on a non-model-turn event (e.g. the
		// claude-code init system event), then the agent exited before
		// producing any assistant turn — the "Not logged in / credential"
		// shape from run_hkkm35bcckc4. Seed a state_change/system event
		// to simulate the init, but no text/thinking/tool_use stdout
		// events.
		ctx.repos.events.append({
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("no_model_response");
		const row = ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("no_model_response");
	});

	test("thinking and tool_use events also count as model-turn output (warren-5165)", async () => {
		// burrow's jsonl-claude parser maps assistant content blocks into
		// kind=text, kind=thinking, or kind=tool_use. Any one of them is
		// proof the run reached at least one assistant turn → crashed,
		// not no_model_response.
		ctx.repos.events.append({
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
			burrowClient: fakeBurrowClient(makeBurrow()),
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(result.failureReason).toBeNull();
		expect(ctx.repos.runs.require(ctx.runId).failureReason).toBeNull();
	});

	test("explicit failureReason override wins over inference (warren-3c40)", async () => {
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			failureReason: "timed_out",
			repos: ctx.repos,
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(result.failureReason).toBe("timed_out");
		expect(ctx.repos.runs.require(ctx.runId).failureReason).toBe("timed_out");
	});

	test("idempotent reap surfaces the previously-stored failureReason", async () => {
		// Seed a model-turn event so the first reap classifies as crashed
		// (warren-5165 discriminator: bare running-on-entry with no model
		// output would now classify as no_model_response).
		ctx.repos.events.append({
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		// Second reap on the now-terminal row should report the same reason
		// (idempotency for restart-recovery sweeps).
		const second = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClient: fakeBurrowClient(makeBurrow()),
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
			burrowClient: fakeBurrowClient(makeBurrow()),
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
		expect(ctx.repos.runs.require(ctx.runId).prUrl).toBe("https://github.com/x/y/pull/77");
		const events = ctx.repos.events.listByRun(ctx.runId);
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: e.exec,
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(pr.calls).toHaveLength(0);
		const events = ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.pr_opened")).toBeUndefined();
	});

	test("skips pr_open when autoOpenPr is disabled", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClient: fakeBurrowClient(makeBurrow()),
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
			burrowClient: fakeBurrowClient(makeBurrow()),
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
			burrowClient: fakeBurrowClient(makeBurrow()),
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
			burrowClient: fakeBurrowClient(makeBurrow({ branch: "main" })),
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
			burrowClient: fakeBurrowClient(makeBurrow()),
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(pr.calls).toHaveLength(0);
		const events = ctx.repos.events.listByRun(ctx.runId);
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBe("https://github.com/x/y/pull/3");
		expect(result.errors.map((x) => x.step)).not.toContain("pr_open");
		expect(ctx.repos.runs.require(ctx.runId).prUrl).toBe("https://github.com/x/y/pull/3");
	});

	test("emits reap_failed step=pr_open when openPr returns network error", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: false, reason: "network", message: "ECONNREFUSED" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});
		expect(result.prUrl).toBeNull();
		expect(result.errors.map((x) => x.step)).toContain("pr_open");
		expect(result.state).toBe("succeeded");
	});

	test("assigns burrow_event_seq above MAX(seq) so reap events sort after stream events", async () => {
		ctx.repos.events.append({
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
			burrowClient: fakeBurrowClient(makeBurrow()),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		const seqs = ctx.repos.events.listByRun(ctx.runId).map((e) => e.burrowEventSeq);
		expect(seqs[0]).toBe(7);
		for (let i = 1; i < seqs.length; i++) {
			const a = seqs[i - 1] ?? 0;
			const b = seqs[i] ?? 0;
			expect(b).toBeGreaterThan(a);
		}
	});
});
