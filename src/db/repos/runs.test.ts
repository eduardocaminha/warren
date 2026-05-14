import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import { isId } from "../../core/ids.ts";
import { openDatabase, type WarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { assertRunTransition, RunsRepo } from "./runs.ts";

describe("assertRunTransition", () => {
	test("queued → running is allowed", () => {
		expect(() => assertRunTransition("queued", "running")).not.toThrow();
	});

	test("running → succeeded|failed|cancelled is allowed", () => {
		expect(() => assertRunTransition("running", "succeeded")).not.toThrow();
		expect(() => assertRunTransition("running", "failed")).not.toThrow();
		expect(() => assertRunTransition("running", "cancelled")).not.toThrow();
	});

	test("queued → cancelled is allowed (steer-before-pickup)", () => {
		expect(() => assertRunTransition("queued", "cancelled")).not.toThrow();
	});

	test("succeeded is terminal", () => {
		expect(() => assertRunTransition("succeeded", "running")).toThrow(StateTransitionError);
		expect(() => assertRunTransition("succeeded", "failed")).toThrow(StateTransitionError);
	});

	test("queued → succeeded is rejected", () => {
		expect(() => assertRunTransition("queued", "succeeded")).toThrow(StateTransitionError);
	});
});

describe("RunsRepo", () => {
	let db: WarrenDb;
	let repo: RunsRepo;
	let agentName: string;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		const agents = new AgentsRepo(DrizzleAdapter.for(db));
		const projects = new ProjectsRepo(DrizzleAdapter.for(db));
		const a = await agents.upsert({ name: "refactor-bot", renderedJson: { sections: {} } });
		const p = await projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		agentName = a.name;
		projectId = p.id;
		repo = new RunsRepo(db.drizzle);
	});

	afterEach(async () => {
		await db.close();
	});

	function spawn(extra: Partial<Parameters<RunsRepo["create"]>[0]> = {}) {
		return repo.create({
			agentName,
			projectId,
			prompt: "fix the flaky test",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
			...extra,
		});
	}

	test("create stores a queued run with a run_ id and no timestamps", async () => {
		const row = await spawn();
		expect(isId("run", row.id)).toBe(true);
		expect(row.state).toBe("queued");
		expect(row.startedAt).toBeNull();
		expect(row.endedAt).toBeNull();
		expect(row.burrowId).toBeNull();
		expect(row.burrowRunId).toBeNull();
	});

	test("require throws NotFoundError for unknown id", async () => {
		expect(repo.require("run_doesnotexist")).rejects.toThrow(NotFoundError);
	});

	test("attachBurrow tags the row with burrow ids without changing state", async () => {
		const row = await spawn();
		const tagged = await repo.attachBurrow(row.id, {
			burrowId: "bur_xxxxxxxxxxxx",
			burrowRunId: "run_yyyyyyyyyyyy",
		});
		expect(tagged.burrowId).toBe("bur_xxxxxxxxxxxx");
		expect(tagged.burrowRunId).toBe("run_yyyyyyyyyyyy");
		expect(tagged.state).toBe("queued");
		const reread = await repo.require(row.id);
		expect(reread.burrowId).toBe("bur_xxxxxxxxxxxx");
	});

	test("create leaves cost + token columns null", async () => {
		const row = await spawn();
		expect(row.costUsd).toBeNull();
		expect(row.tokensInput).toBeNull();
		expect(row.tokensOutput).toBeNull();
		expect(row.tokensCacheRead).toBeNull();
		expect(row.tokensCacheWrite).toBeNull();
	});

	test("attachStats persists partial cost + token fields", async () => {
		const row = await spawn();
		const tagged = await repo.attachStats(row.id, {
			costUsd: 0.4567,
			tokensInput: 1200,
			tokensOutput: 340,
		});
		expect(tagged.costUsd).toBeCloseTo(0.4567);
		expect(tagged.tokensInput).toBe(1200);
		expect(tagged.tokensOutput).toBe(340);
		expect(tagged.tokensCacheRead).toBeNull();
		expect(tagged.tokensCacheWrite).toBeNull();
		const reread = await repo.require(row.id);
		expect(reread.costUsd).toBeCloseTo(0.4567);
		expect(reread.tokensInput).toBe(1200);
	});

	test("attachStats merges across calls — omitted fields preserved", async () => {
		const row = await spawn();
		await repo.attachStats(row.id, { costUsd: 0.1, tokensInput: 100 });
		const merged = await repo.attachStats(row.id, { costUsd: 0.25, tokensOutput: 50 });
		expect(merged.costUsd).toBeCloseTo(0.25);
		expect(merged.tokensInput).toBe(100);
		expect(merged.tokensOutput).toBe(50);
	});

	test("attachStats accepts explicit null to clear a field", async () => {
		const row = await spawn();
		await repo.attachStats(row.id, { costUsd: 0.5 });
		const cleared = await repo.attachStats(row.id, { costUsd: null });
		expect(cleared.costUsd).toBeNull();
	});

	test("attachStats throws when called with no fields", async () => {
		const row = await spawn();
		expect(repo.attachStats(row.id, {})).rejects.toThrow(ValidationError);
	});

	test("create leaves preview columns null", async () => {
		const row = await spawn();
		expect(row.previewState).toBeNull();
		expect(row.previewPort).toBeNull();
		expect(row.previewStartedAt).toBeNull();
		expect(row.previewLastHitAt).toBeNull();
		expect(row.previewFailureMessage).toBeNull();
	});

	test("attachPreview persists partial preview fields", async () => {
		const row = await spawn();
		const startedAt = "2026-05-14T18:00:00.000Z";
		const tagged = await repo.attachPreview(row.id, {
			previewState: "starting",
			previewPort: 48201,
			previewStartedAt: startedAt,
		});
		expect(tagged.previewState).toBe("starting");
		expect(tagged.previewPort).toBe(48201);
		expect(tagged.previewStartedAt).toBe(startedAt);
		expect(tagged.previewLastHitAt).toBeNull();
		expect(tagged.previewFailureMessage).toBeNull();
		const reread = await repo.require(row.id);
		expect(reread.previewState).toBe("starting");
		expect(reread.previewPort).toBe(48201);
	});

	test("attachPreview merges across calls — omitted fields preserved", async () => {
		const row = await spawn();
		const startedAt = "2026-05-14T18:00:00.000Z";
		await repo.attachPreview(row.id, {
			previewState: "starting",
			previewPort: 48201,
			previewStartedAt: startedAt,
		});
		const live = await repo.attachPreview(row.id, { previewState: "live" });
		expect(live.previewState).toBe("live");
		expect(live.previewPort).toBe(48201);
		expect(live.previewStartedAt).toBe(startedAt);
	});

	test("attachPreview accepts explicit null to clear a field", async () => {
		const row = await spawn();
		await repo.attachPreview(row.id, {
			previewState: "failed",
			previewFailureMessage: "boot crashed",
		});
		const cleared = await repo.attachPreview(row.id, { previewFailureMessage: null });
		expect(cleared.previewState).toBe("failed");
		expect(cleared.previewFailureMessage).toBeNull();
	});

	test("attachPreview throws when called with no fields", async () => {
		const row = await spawn();
		expect(repo.attachPreview(row.id, {})).rejects.toThrow(ValidationError);
	});

	test("attachPreview last_hit_at independent updates (proxy path)", async () => {
		const row = await spawn();
		await repo.attachPreview(row.id, { previewState: "live", previewPort: 48201 });
		const hit = "2026-05-14T18:05:00.000Z";
		const touched = await repo.attachPreview(row.id, { previewLastHitAt: hit });
		expect(touched.previewLastHitAt).toBe(hit);
		expect(touched.previewState).toBe("live");
		expect(touched.previewPort).toBe(48201);
	});

	test("markRunning sets state and startedAt", async () => {
		const row = await spawn();
		const t = new Date("2026-05-08T12:34:56.000Z");
		const running = await repo.markRunning(row.id, t);
		expect(running.state).toBe("running");
		expect(running.startedAt).toBe(t.toISOString());
	});

	test("markRunning rejects already-running rows", async () => {
		const row = await spawn();
		await repo.markRunning(row.id);
		expect(repo.markRunning(row.id)).rejects.toThrow(StateTransitionError);
	});

	test("finalize sets terminal state and endedAt", async () => {
		const row = await spawn();
		await repo.markRunning(row.id);
		const t = new Date("2026-05-08T13:00:00.000Z");
		const done = await repo.finalize(row.id, "succeeded", t);
		expect(done.state).toBe("succeeded");
		expect(done.endedAt).toBe(t.toISOString());
	});

	test("finalize rejects an invalid transition (queued → succeeded)", async () => {
		const row = await spawn();
		expect(repo.finalize(row.id, "succeeded")).rejects.toThrow(StateTransitionError);
	});

	test("claimById transitions queued → running atomically", async () => {
		const row = await spawn();
		const claimed = await repo.claimById(row.id);
		expect(claimed?.state).toBe("running");
		expect(claimed?.startedAt).not.toBeNull();
	});

	test("claimById returns null when the row is not queued", async () => {
		const row = await spawn();
		await repo.markRunning(row.id);
		expect(await repo.claimById(row.id)).toBeNull();
	});

	test("claimById returns null for an unknown id", async () => {
		expect(await repo.claimById("run_doesnotexist")).toBeNull();
	});

	test("listByProject and listByAgent filter the result set", async () => {
		const a = await spawn();
		const b = await spawn();
		expect((await repo.listByProject(projectId)).map((r) => r.id).sort()).toEqual(
			[a.id, b.id].sort(),
		);
		expect((await repo.listByAgent(agentName)).map((r) => r.id).sort()).toEqual(
			[a.id, b.id].sort(),
		);
		expect(await repo.listByProject("prj_nope")).toEqual([]);
	});

	test("listByState filters by single state and arrays", async () => {
		const a = await spawn();
		const b = await spawn();
		await repo.markRunning(a.id);
		expect((await repo.listByState("queued")).map((r) => r.id)).toEqual([b.id]);
		expect((await repo.listByState(["queued", "running"])).map((r) => r.id).sort()).toEqual(
			[a.id, b.id].sort(),
		);
	});
});
