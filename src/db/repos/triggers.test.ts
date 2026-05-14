import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { openDatabase, type WarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";
import { TriggersRepo } from "./triggers.ts";

describe("TriggersRepo", () => {
	let db: WarrenDb;
	let projects: ProjectsRepo;
	let runs: RunsRepo;
	let repo: TriggersRepo;
	let projectId: string;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		const agents = new AgentsRepo(DrizzleAdapter.for(db));
		projects = new ProjectsRepo(DrizzleAdapter.for(db));
		runs = new RunsRepo(db.drizzle);
		repo = new TriggersRepo(db.drizzle);
		const a = await agents.upsert({ name: "refactor-bot", renderedJson: { sections: {} } });
		const p = await projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = p.id;
		const r = await runs.create({
			agentName: a.name,
			projectId,
			prompt: "p",
			renderedAgentJson: { sections: {} },
			trigger: "cron",
		});
		runId = r.id;
	});

	afterEach(async () => {
		await db.close();
	});

	test("upsert composes the row id from project + trigger", async () => {
		const row = await repo.upsert({
			projectId,
			triggerId: "nightly",
			nextFireAt: "2026-05-11T00:00:00.000Z",
		});
		expect(row.id).toBe(`${projectId}:nightly`);
		expect(row.projectId).toBe(projectId);
		expect(row.triggerId).toBe("nightly");
		expect(row.lastFiredAt).toBeNull();
		expect(row.nextFireAt).toBe("2026-05-11T00:00:00.000Z");
		expect(row.lastRunId).toBeNull();
	});

	test("upsert merges existing fields without clobbering omitted ones", async () => {
		await repo.upsert({
			projectId,
			triggerId: "nightly",
			lastFiredAt: "2026-05-10T00:00:00.000Z",
			lastRunId: runId,
		});
		const merged = await repo.upsert({
			projectId,
			triggerId: "nightly",
			nextFireAt: "2026-05-11T00:00:00.000Z",
		});
		expect(merged.lastFiredAt).toBe("2026-05-10T00:00:00.000Z");
		expect(merged.lastRunId).toBe(runId);
		expect(merged.nextFireAt).toBe("2026-05-11T00:00:00.000Z");
	});

	test("upsert with no patch fields preserves the existing row", async () => {
		const initial = await repo.upsert({
			projectId,
			triggerId: "nightly",
			nextFireAt: "2026-05-11T00:00:00.000Z",
		});
		const echoed = await repo.upsert({ projectId, triggerId: "nightly" });
		expect(echoed).toEqual(initial);
	});

	test("upsert accepts null to explicitly clear nextFireAt", async () => {
		await repo.upsert({
			projectId,
			triggerId: "nightly",
			nextFireAt: "2026-05-11T00:00:00.000Z",
		});
		const cleared = await repo.upsert({ projectId, triggerId: "nightly", nextFireAt: null });
		expect(cleared.nextFireAt).toBeNull();
	});

	test("recordFire stamps lastFiredAt + lastRunId and rolls nextFireAt forward", async () => {
		const fired = await repo.recordFire({
			projectId,
			triggerId: "nightly",
			firedAt: new Date("2026-05-10T00:00:00.000Z"),
			nextFireAt: new Date("2026-05-11T00:00:00.000Z"),
			runId,
		});
		expect(fired.lastFiredAt).toBe("2026-05-10T00:00:00.000Z");
		expect(fired.nextFireAt).toBe("2026-05-11T00:00:00.000Z");
		expect(fired.lastRunId).toBe(runId);
	});

	test("recordFire accepts null nextFireAt for one-shot triggers", async () => {
		const fired = await repo.recordFire({
			projectId,
			triggerId: "one-off",
			firedAt: new Date("2026-05-10T00:00:00.000Z"),
			nextFireAt: null,
			runId,
		});
		expect(fired.nextFireAt).toBeNull();
	});

	test("require throws NotFoundError for an unknown trigger", async () => {
		expect(repo.require({ projectId, triggerId: "missing" })).rejects.toThrow(NotFoundError);
	});

	test("listByProject returns triggers in stable trigger-id order", async () => {
		await repo.upsert({ projectId, triggerId: "weekly" });
		await repo.upsert({ projectId, triggerId: "nightly" });
		await repo.upsert({ projectId, triggerId: "hourly" });
		expect((await repo.listByProject(projectId)).map((t) => t.triggerId)).toEqual([
			"hourly",
			"nightly",
			"weekly",
		]);
	});

	test("listByProject scopes by project", async () => {
		const other = await projects.create({
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
		});
		await repo.upsert({ projectId, triggerId: "nightly" });
		await repo.upsert({ projectId: other.id, triggerId: "nightly" });
		expect(await repo.listByProject(projectId)).toHaveLength(1);
		expect(await repo.listByProject(other.id)).toHaveLength(1);
	});

	test("delete removes the row", async () => {
		await repo.upsert({ projectId, triggerId: "nightly" });
		await repo.delete({ projectId, triggerId: "nightly" });
		expect(await repo.get({ projectId, triggerId: "nightly" })).toBeNull();
	});

	test("project delete cascades to triggers (FK ON DELETE CASCADE)", async () => {
		await repo.upsert({ projectId, triggerId: "nightly" });
		await repo.upsert({ projectId, triggerId: "weekly" });
		await projects.delete(projectId);
		expect(await repo.listByProject(projectId)).toEqual([]);
	});

	test("run delete clears lastRunId (FK ON DELETE SET NULL)", async () => {
		await repo.upsert({ projectId, triggerId: "nightly", lastRunId: runId });
		db.raw.exec(`DELETE FROM runs WHERE id = '${runId}'`);
		const row = await repo.require({ projectId, triggerId: "nightly" });
		expect(row.lastRunId).toBeNull();
	});
});
