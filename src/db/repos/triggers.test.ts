import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { TriggersRepo } from "./triggers.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`TriggersRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const repo = new TriggersRepo(adapter);
			const a = await agents.upsert({ name: "refactor-bot", renderedJson: { sections: {} } });
			const p = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			// RunsRepo is not yet on the adapter (pl-f1be step 5), so seed the
			// FK target row directly through the adapter to keep this test
			// dialect-polymorphic (matches events.test.ts).
			const runId = generateId("run");
			const db = adapter.drizzle as SqliteDrizzleDb;
			await adapter.runWrite(
				db.insert(adapter.schema.runs).values({
					id: runId,
					agentName: a.name,
					projectId: p.id,
					renderedAgentJson: { sections: {} },
					state: "queued",
					prompt: "p",
					trigger: "cron",
				}),
			);
			return { handle, adapter, projects, repo, projectId: p.id, runId };
		};

		test("upsert composes the row id from project + trigger", async () => {
			const { handle, repo, projectId } = await open();
			try {
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
			} finally {
				await handle.close();
			}
		});

		test("upsert merges existing fields without clobbering omitted ones", async () => {
			const { handle, repo, projectId, runId } = await open();
			try {
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
			} finally {
				await handle.close();
			}
		});

		test("upsert with no patch fields preserves the existing row", async () => {
			const { handle, repo, projectId } = await open();
			try {
				const initial = await repo.upsert({
					projectId,
					triggerId: "nightly",
					nextFireAt: "2026-05-11T00:00:00.000Z",
				});
				const echoed = await repo.upsert({ projectId, triggerId: "nightly" });
				expect(echoed).toEqual(initial);
			} finally {
				await handle.close();
			}
		});

		test("upsert accepts null to explicitly clear nextFireAt", async () => {
			const { handle, repo, projectId } = await open();
			try {
				await repo.upsert({
					projectId,
					triggerId: "nightly",
					nextFireAt: "2026-05-11T00:00:00.000Z",
				});
				const cleared = await repo.upsert({
					projectId,
					triggerId: "nightly",
					nextFireAt: null,
				});
				expect(cleared.nextFireAt).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("recordFire stamps lastFiredAt + lastRunId and rolls nextFireAt forward", async () => {
			const { handle, repo, projectId, runId } = await open();
			try {
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
			} finally {
				await handle.close();
			}
		});

		test("recordFire accepts null nextFireAt for one-shot triggers", async () => {
			const { handle, repo, projectId, runId } = await open();
			try {
				const fired = await repo.recordFire({
					projectId,
					triggerId: "one-off",
					firedAt: new Date("2026-05-10T00:00:00.000Z"),
					nextFireAt: null,
					runId,
				});
				expect(fired.nextFireAt).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("require throws NotFoundError for an unknown trigger", async () => {
			const { handle, repo, projectId } = await open();
			try {
				expect(repo.require({ projectId, triggerId: "missing" })).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("listByProject returns triggers in stable trigger-id order", async () => {
			const { handle, repo, projectId } = await open();
			try {
				await repo.upsert({ projectId, triggerId: "weekly" });
				await repo.upsert({ projectId, triggerId: "nightly" });
				await repo.upsert({ projectId, triggerId: "hourly" });
				expect((await repo.listByProject(projectId)).map((t) => t.triggerId)).toEqual([
					"hourly",
					"nightly",
					"weekly",
				]);
			} finally {
				await handle.close();
			}
		});

		test("listByProject scopes by project", async () => {
			const { handle, projects, repo, projectId } = await open();
			try {
				const other = await projects.create({
					gitUrl: "https://github.com/x/z.git",
					localPath: "/data/projects/x/z",
					defaultBranch: "main",
				});
				await repo.upsert({ projectId, triggerId: "nightly" });
				await repo.upsert({ projectId: other.id, triggerId: "nightly" });
				expect(await repo.listByProject(projectId)).toHaveLength(1);
				expect(await repo.listByProject(other.id)).toHaveLength(1);
			} finally {
				await handle.close();
			}
		});

		test("delete removes the row", async () => {
			const { handle, repo, projectId } = await open();
			try {
				await repo.upsert({ projectId, triggerId: "nightly" });
				await repo.delete({ projectId, triggerId: "nightly" });
				expect(await repo.get({ projectId, triggerId: "nightly" })).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("project delete cascades to triggers (FK ON DELETE CASCADE)", async () => {
			const { handle, projects, repo, projectId } = await open();
			try {
				await repo.upsert({ projectId, triggerId: "nightly" });
				await repo.upsert({ projectId, triggerId: "weekly" });
				await projects.delete(projectId);
				expect(await repo.listByProject(projectId)).toEqual([]);
			} finally {
				await handle.close();
			}
		});

		test("run delete clears lastRunId (FK ON DELETE SET NULL)", async () => {
			const { handle, adapter, repo, projectId, runId } = await open();
			try {
				await repo.upsert({ projectId, triggerId: "nightly", lastRunId: runId });
				const db = adapter.drizzle as SqliteDrizzleDb;
				await adapter.runWrite(
					db.delete(adapter.schema.runs).where(eq(adapter.schema.runs.id, runId)),
				);
				const row = await repo.require({ projectId, triggerId: "nightly" });
				expect(row.lastRunId).toBeNull();
			} finally {
				await handle.close();
			}
		});
	});
}

suite("sqlite");
if (isPostgresTestEnabled()) {
	suite("postgres");
}
