import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	makePool,
	PROJECT_PATH,
	setup,
	setupWithFeatures,
	WORKSPACE_PATH,
} from "./test-helpers.ts";

describe("reapRun plot-direct-push (warren-1312)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("commits plot directly to main (not run branch) when project .plot/ has a delta (warren-1312)", async () => {
		const plotCtx = await setupWithFeatures({ hasPlot: true });
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
			expect(f.files.has("/data/burrow/ws/.plot/plot-abc.events.jsonl")).toBe(false);
			expect(f.files.has("/data/burrow/ws/.plot/plot-abc.json")).toBe(false);

			const gitCalls = e.calls.filter((c) => c.cmd === "git");
			const paths = [".plot/plot-abc.events.jsonl", ".plot/plot-abc.json"];

			const addCall = gitCalls.find(
				(c) => c.args[0] === "add" && paths.every((p) => c.args.includes(p)),
			);
			expect(addCall?.cwd).toBe(PROJECT_PATH);

			const commit = gitCalls
				.map((c) => c.args)
				.find((a) => a[0] === "-c" && a.includes("commit") && a.includes("--only"));
			expect(commit).toEqual([
				"-c",
				"user.name=warren",
				"-c",
				"user.email=warren@os-eco.dev",
				"commit",
				"--no-verify",
				"--only",
				"-m",
				"chore(warren): plot state",
				"--",
				...paths,
			]);
			const commitCall = gitCalls.find(
				(c) => c.args[0] === "-c" && c.args.includes("commit") && c.args.includes("--only"),
			);
			expect(commitCall?.cwd).toBe(PROJECT_PATH);

			expect(gitCalls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(true);
			expect(gitCalls.some((c) => c.args[0] === "push" && c.args.includes("HEAD:main"))).toBe(true);

			const events = await plotCtx.repos.events.listByRun(plotCtx.runId);
			const plotEvent = events.find((ev) => ev.kind === "reap.plot_committed");
			expect(plotEvent).toBeDefined();
			expect((plotEvent?.payloadJson as { directPush?: boolean })?.directPush).toBe(true);
		} finally {
			await plotCtx.db.close();
		}
	});

	test("workspace .plot/ is cleaned up (restore+clean) before the run branch push (warren-1312)", async () => {
		const plotCtx = await setupWithFeatures({ hasPlot: true });
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl":
					'{"type":"run_dispatched","actor":"user:operator","at":"2026-05-18T10:00:00Z","data":{}}\n',
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

			const wsGitCalls = e.calls.filter((c) => c.cmd === "git" && c.cwd === WORKSPACE_PATH);
			expect(
				wsGitCalls.some(
					(c) =>
						c.args[0] === "restore" && c.args.includes("--staged") && c.args.includes(".plot/"),
				),
			).toBe(true);
			expect(
				wsGitCalls.some(
					(c) =>
						c.args[0] === "restore" && !c.args.includes("--staged") && c.args.includes(".plot/"),
				),
			).toBe(true);
			expect(
				wsGitCalls.some(
					(c) => c.args[0] === "clean" && c.args.includes("-f") && c.args.includes(".plot/"),
				),
			).toBe(true);
		} finally {
			await plotCtx.db.close();
		}
	});

	test("path-limits the project-clone commit to the plot carriers (warren-be12/warren-1312)", async () => {
		const plotCtx = await setupWithFeatures({ hasPlot: true });
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl":
					'{"type":"run_dispatched","actor":"user:operator","at":"2026-05-18T10:00:00Z","data":{}}\n',
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

			const commit = e.calls
				.filter((c) => c.cmd === "git")
				.map((c) => c.args)
				.find((a) => a[0] === "-c" && a.includes("commit") && a.includes("--only"));
			expect(commit).toContain("--only");
			const dashDash = commit?.indexOf("--") ?? -1;
			expect(dashDash).toBeGreaterThan(-1);
			expect(commit?.slice(dashDash + 1)).toEqual([".plot/plot-abc.events.jsonl"]);
			const commitCall = e.calls.find(
				(c) => c.cmd === "git" && c.args[0] === "-c" && c.args.includes("commit"),
			);
			expect(commitCall?.cwd).toBe(PROJECT_PATH);
		} finally {
			await plotCtx.db.close();
		}
	});

	test("does not commit when the agent already committed every .plot/ delta", async () => {
		const plotCtx = await setupWithFeatures({ hasPlot: true });
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
			const commitCall = e.calls.find(
				(c) => c.cmd === "git" && c.args.includes("commit") && c.args.includes("--only"),
			);
			expect(commitCall).toBeUndefined();
			const events = await plotCtx.repos.events.listByRun(plotCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.plot_committed")).toBeUndefined();
		} finally {
			await plotCtx.db.close();
		}
	});

	test("skips .index.db* and non-plot-* entries from staging in the project clone (warren-1312)", async () => {
		const plotCtx = await setupWithFeatures({ hasPlot: true });
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

			const addCall = e.calls
				.filter((c) => c.cmd === "git" && c.cwd === PROJECT_PATH)
				.find((c) => c.args[0] === "add");
			expect(addCall).toBeDefined();
			expect(addCall?.args).toContain(".plot/plot-abc.events.jsonl");
			expect(addCall?.args).not.toContain(".plot/.index.db");
			expect(addCall?.args).not.toContain(".plot/.index.db-wal");
			expect(addCall?.args).not.toContain(".plot/README.md");
		} finally {
			await plotCtx.db.close();
		}
	});

	test("plot-only run: workspace is clean after cleanup so droppedCommit stays false (warren-1312)", async () => {
		const plotCtx = await setupWithFeatures({ hasPlot: true });
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl":
					'{"type":"run_dispatched","actor":"user:operator","at":"2026-05-18T10:00:00Z","data":{}}\n',
			});
			const e = fakeExec({ stagedDelta: true, gitStatus: "", revListCount: "0" });

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
			expect(result.commitsAhead).toBe(0);
			const events = await plotCtx.repos.events.listByRun(plotCtx.runId);
			const emptyPushEvent = events.find((ev) => ev.kind === "reap.empty_push");
			expect(emptyPushEvent).toBeDefined();
			expect((emptyPushEvent?.payloadJson as { droppedCommit?: boolean })?.droppedCommit).toBe(
				false,
			);
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
		expect(f.files.has("/data/burrow/ws/.plot/plot-abc.events.jsonl")).toBe(false);
		const gitCalls = e.calls.filter((c) => c.cmd === "git");
		expect(
			gitCalls.find(
				(c) => c.args.includes("add") && c.args.includes(".plot/") && c.cwd === PROJECT_PATH,
			),
		).toBeUndefined();
		expect(
			gitCalls.find((c) => c.args.includes("commit") && c.args.includes("--only")),
		).toBeUndefined();
	});
});

describe("reapRun seeds-direct-push (warren-2501)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("commits seeds directly to main (not run branch) when project .seeds/ has a delta (warren-2501)", async () => {
		const seedsCtx = await setupWithFeatures({ hasSeeds: true });
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
			expect(f.files.has("/data/burrow/ws/.seeds/issues.jsonl")).toBe(false);
			expect(f.files.has("/data/burrow/ws/.seeds/plans.jsonl")).toBe(false);

			const gitCalls = e.calls.filter((c) => c.cmd === "git");

			const addCall = gitCalls.find((c) => c.args[0] === "add" && c.args.includes(".seeds/"));
			expect(addCall?.cwd).toBe(PROJECT_PATH);

			const commit = gitCalls
				.map((c) => c.args)
				.find((a) => a[0] === "-c" && a.includes("commit") && a.includes("--only"));
			expect(commit).toEqual([
				"-c",
				"user.name=warren",
				"-c",
				"user.email=warren@os-eco.dev",
				"commit",
				"--no-verify",
				"--only",
				"-m",
				"chore(warren): seeds state",
				"--",
				".seeds/issues.jsonl",
				".seeds/plans.jsonl",
			]);
			const commitCall = gitCalls.find(
				(c) => c.args[0] === "-c" && c.args.includes("commit") && c.args.includes("--only"),
			);
			expect(commitCall?.cwd).toBe(PROJECT_PATH);

			expect(gitCalls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(true);
			expect(gitCalls.some((c) => c.args[0] === "push" && c.args.includes("HEAD:main"))).toBe(true);

			const events = await seedsCtx.repos.events.listByRun(seedsCtx.runId);
			const seedsEvent = events.find((ev) => ev.kind === "reap.seeds_committed");
			expect(seedsEvent).toBeDefined();
			expect((seedsEvent?.payloadJson as { directPush?: boolean })?.directPush).toBe(true);
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("workspace seeds are cleaned up (restore+clean) before the run branch push (warren-2501)", async () => {
		const seedsCtx = await setupWithFeatures({ hasSeeds: true });
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
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

			const wsGitCalls = e.calls.filter((c) => c.cmd === "git" && c.cwd === WORKSPACE_PATH);
			expect(
				wsGitCalls.some(
					(c) =>
						c.args[0] === "restore" && c.args.includes("--staged") && c.args.includes(".seeds/"),
				),
			).toBe(true);
			expect(
				wsGitCalls.some(
					(c) =>
						c.args[0] === "restore" && !c.args.includes("--staged") && c.args.includes(".seeds/"),
				),
			).toBe(true);
			expect(
				wsGitCalls.some(
					(c) => c.args[0] === "clean" && c.args.includes("-f") && c.args.includes(".seeds/"),
				),
			).toBe(true);
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("path-limits the project-clone commit to the two seeds carriers (warren-be12)", async () => {
		const seedsCtx = await setupWithFeatures({ hasSeeds: true });
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
				"/data/projects/x/y/.seeds/plans.jsonl":
					'{"id":"pl-abcd","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
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

			const commit = e.calls
				.filter((c) => c.cmd === "git")
				.map((c) => c.args)
				.find((a) => a[0] === "-c" && a.includes("commit") && a.includes("--only"));
			expect(commit).toContain("--only");
			const dashDash = commit?.indexOf("--") ?? -1;
			expect(dashDash).toBeGreaterThan(-1);
			expect(commit?.slice(dashDash + 1)).toEqual([".seeds/issues.jsonl", ".seeds/plans.jsonl"]);
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("does not commit when the agent already committed every .seeds/ delta", async () => {
		const seedsCtx = await setupWithFeatures({ hasSeeds: true });
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
			const commitCall = e.calls.find(
				(c) => c.cmd === "git" && c.args.includes("commit") && c.args.includes("--only"),
			);
			expect(commitCall).toBeUndefined();
			const events = await seedsCtx.repos.events.listByRun(seedsCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.seeds_committed")).toBeUndefined();
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("seeds-only run: workspace is clean after cleanup so droppedCommit stays false (warren-2501)", async () => {
		const seedsCtx = await setupWithFeatures({ hasSeeds: true });
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
			});
			const e = fakeExec({ stagedDelta: true, gitStatus: "", revListCount: "0" });

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
			expect(result.commitsAhead).toBe(0);
			const events = await seedsCtx.repos.events.listByRun(seedsCtx.runId);
			const emptyPushEvent = events.find((ev) => ev.kind === "reap.empty_push");
			expect(emptyPushEvent).toBeDefined();
			expect((emptyPushEvent?.payloadJson as { droppedCommit?: boolean })?.droppedCommit).toBe(
				false,
			);
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
		expect(f.files.has("/data/burrow/ws/.seeds/issues.jsonl")).toBe(false);
		const gitCalls = e.calls.filter((c) => c.cmd === "git");
		expect(
			gitCalls.find(
				(c) => c.args.includes("add") && c.args.includes(".seeds/") && c.cwd === PROJECT_PATH,
			),
		).toBeUndefined();
		expect(
			gitCalls.find((c) => c.args.includes("commit") && c.args.includes("--only")),
		).toBeUndefined();
	});
});
