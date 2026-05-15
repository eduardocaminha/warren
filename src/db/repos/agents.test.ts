import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`AgentsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const repo = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			return { handle, repo, projects };
		};

		const seedProject = async (
			projects: ProjectsRepo,
			gitUrl = "https://github.com/x/y.git",
			localPath = "/data/projects/x/y",
		) => {
			const p = await projects.create({
				gitUrl,
				localPath,
				defaultBranch: "main",
			});
			return p.id;
		};

		test("upsert inserts a new row with both timestamps equal", async () => {
			const { handle, repo } = await open();
			try {
				const now = new Date("2026-05-08T12:00:00.000Z");
				const row = await repo.upsert({
					name: "refactor-bot",
					renderedJson: { sections: { system: "..." } },
					now,
				});
				expect(row.name).toBe("refactor-bot");
				expect(row.projectId).toBeNull();
				expect(row.registeredAt).toBe(now.toISOString());
				expect(row.lastRefreshed).toBe(now.toISOString());
				expect(row.renderedJson).toEqual({ sections: { system: "..." } });
			} finally {
				await handle.close();
			}
		});

		test("upsert on an existing row preserves registeredAt and bumps lastRefreshed", async () => {
			const { handle, repo } = await open();
			try {
				const t0 = new Date("2026-05-08T12:00:00.000Z");
				const t1 = new Date("2026-05-09T12:00:00.000Z");
				await repo.upsert({ name: "refactor-bot", renderedJson: { v: 1 }, now: t0 });
				const row = await repo.upsert({ name: "refactor-bot", renderedJson: { v: 2 }, now: t1 });
				expect(row.registeredAt).toBe(t0.toISOString());
				expect(row.lastRefreshed).toBe(t1.toISOString());
				expect(row.renderedJson).toEqual({ v: 2 });
			} finally {
				await handle.close();
			}
		});

		test("get returns null for unknown names; require throws NotFoundError", async () => {
			const { handle, repo } = await open();
			try {
				expect(await repo.get("missing")).toBeNull();
				expect(repo.require("missing")).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("listAll returns rows alphabetically by name", async () => {
			const { handle, repo } = await open();
			try {
				await repo.upsert({ name: "zebra", renderedJson: {} });
				await repo.upsert({ name: "alpha", renderedJson: {} });
				await repo.upsert({ name: "mango", renderedJson: {} });
				expect((await repo.listAll()).map((r) => r.name)).toEqual(["alpha", "mango", "zebra"]);
			} finally {
				await handle.close();
			}
		});

		test("delete removes the row", async () => {
			const { handle, repo } = await open();
			try {
				await repo.upsert({ name: "refactor-bot", renderedJson: {} });
				await repo.delete("refactor-bot");
				expect(await repo.get("refactor-bot")).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("project-tier upsert is independent of the global-tier row of the same name", async () => {
			const { handle, repo, projects } = await open();
			try {
				const projectId = await seedProject(projects);
				await repo.upsert({ name: "claude-code", renderedJson: { tier: "global" } });
				const projectRow = await repo.upsert({
					name: "claude-code",
					projectId,
					renderedJson: { tier: "project" },
				});
				expect(projectRow.projectId).toBe(projectId);
				const global = await repo.get("claude-code");
				expect(global?.projectId).toBeNull();
				expect(global?.renderedJson).toEqual({ tier: "global" });
				const project = await repo.get("claude-code", { projectId });
				expect(project?.projectId).toBe(projectId);
				expect(project?.renderedJson).toEqual({ tier: "project" });
				// Distinct rowid PKs.
				expect(project?.id).not.toBe(global?.id);
			} finally {
				await handle.close();
			}
		});

		test("project-tier upsert is idempotent: preserves registeredAt on the project row only", async () => {
			const { handle, repo, projects } = await open();
			try {
				const projectId = await seedProject(projects);
				const t0 = new Date("2026-05-08T12:00:00.000Z");
				const t1 = new Date("2026-05-09T12:00:00.000Z");
				await repo.upsert({ name: "claude-code", renderedJson: { v: 0 }, now: t0 });
				await repo.upsert({
					name: "claude-code",
					projectId,
					renderedJson: { v: 1 },
					now: t0,
				});
				const refreshed = await repo.upsert({
					name: "claude-code",
					projectId,
					renderedJson: { v: 2 },
					now: t1,
				});
				expect(refreshed.registeredAt).toBe(t0.toISOString());
				expect(refreshed.lastRefreshed).toBe(t1.toISOString());
				const global = await repo.get("claude-code");
				expect(global?.lastRefreshed).toBe(t0.toISOString());
			} finally {
				await handle.close();
			}
		});

		test("get with projectId is exact-match (no global fallback)", async () => {
			const { handle, repo, projects } = await open();
			try {
				const projectId = await seedProject(projects);
				await repo.upsert({ name: "claude-code", renderedJson: { tier: "global" } });
				expect(await repo.get("claude-code", { projectId })).toBeNull();
				expect(repo.require("claude-code", { projectId })).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("resolve prefers project tier and falls back to global", async () => {
			const { handle, repo, projects } = await open();
			try {
				const projectId = await seedProject(projects);
				// No project row: resolve(name, {projectId}) falls back to global.
				await repo.upsert({ name: "claude-code", renderedJson: { tier: "global" } });
				const fallback = await repo.resolve("claude-code", { projectId });
				expect(fallback?.projectId).toBeNull();
				expect(fallback?.renderedJson).toEqual({ tier: "global" });
				// Add a project-tier row: resolve now prefers it.
				await repo.upsert({
					name: "claude-code",
					projectId,
					renderedJson: { tier: "project" },
				});
				const preferred = await repo.resolve("claude-code", { projectId });
				expect(preferred?.projectId).toBe(projectId);
				expect(preferred?.renderedJson).toEqual({ tier: "project" });
				// Without projectId, resolve is just the global lookup.
				expect((await repo.resolve("claude-code"))?.projectId).toBeNull();
				// Missing in both tiers → null.
				expect(await repo.resolve("nope", { projectId })).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("listAll() default returns global-tier only", async () => {
			const { handle, repo, projects } = await open();
			try {
				const projectId = await seedProject(projects);
				await repo.upsert({ name: "alpha", renderedJson: {} });
				await repo.upsert({ name: "beta", projectId, renderedJson: {} });
				const rows = await repo.listAll();
				expect(rows.map((r) => r.name)).toEqual(["alpha"]);
				expect(rows[0]?.projectId).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("listAll({projectId}) returns global ∪ project rows", async () => {
			const { handle, repo, projects } = await open();
			try {
				const projectId = await seedProject(projects);
				const otherProject = await seedProject(
					projects,
					"https://github.com/a/b.git",
					"/data/projects/a/b",
				);
				await repo.upsert({ name: "alpha", renderedJson: { t: "global" } });
				await repo.upsert({ name: "beta", projectId, renderedJson: { t: "p1" } });
				await repo.upsert({
					name: "claude-code",
					renderedJson: { t: "global" },
				});
				await repo.upsert({
					name: "claude-code",
					projectId,
					renderedJson: { t: "p1" },
				});
				// Other project's rows are excluded.
				await repo.upsert({
					name: "gamma",
					projectId: otherProject,
					renderedJson: { t: "p2" },
				});

				const rows = await repo.listAll({ projectId });
				// Ordered by name; duplicate `claude-code` rows both appear.
				expect(rows.map((r) => r.name)).toEqual(["alpha", "beta", "claude-code", "claude-code"]);
				const beta = rows.find((r) => r.name === "beta");
				expect(beta?.projectId).toBe(projectId);
				const tiers = rows.filter((r) => r.name === "claude-code").map((r) => r.projectId);
				expect(tiers).toContain(null);
				expect(tiers).toContain(projectId);
			} finally {
				await handle.close();
			}
		});

		test("listForProject returns only that project's tier", async () => {
			const { handle, repo, projects } = await open();
			try {
				const projectId = await seedProject(projects);
				const otherProject = await seedProject(
					projects,
					"https://github.com/a/b.git",
					"/data/projects/a/b",
				);
				await repo.upsert({ name: "alpha", renderedJson: {} });
				await repo.upsert({ name: "beta", projectId, renderedJson: {} });
				await repo.upsert({ name: "delta", projectId, renderedJson: {} });
				await repo.upsert({ name: "zeta", projectId: otherProject, renderedJson: {} });
				const rows = await repo.listForProject(projectId);
				expect(rows.map((r) => r.name)).toEqual(["beta", "delta"]);
				expect(rows.every((r) => r.projectId === projectId)).toBe(true);
			} finally {
				await handle.close();
			}
		});

		test("delete is scoped: deleting the global row leaves the project row", async () => {
			const { handle, repo, projects } = await open();
			try {
				const projectId = await seedProject(projects);
				await repo.upsert({ name: "claude-code", renderedJson: { tier: "global" } });
				await repo.upsert({
					name: "claude-code",
					projectId,
					renderedJson: { tier: "project" },
				});
				await repo.delete("claude-code");
				expect(await repo.get("claude-code")).toBeNull();
				expect((await repo.get("claude-code", { projectId }))?.projectId).toBe(projectId);
				await repo.delete("claude-code", { projectId });
				expect(await repo.get("claude-code", { projectId })).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("deleting a project cascades its agents rows", async () => {
			const { handle, repo, projects } = await open();
			try {
				const projectId = await seedProject(projects);
				await repo.upsert({ name: "claude-code", renderedJson: { tier: "global" } });
				await repo.upsert({
					name: "claude-code",
					projectId,
					renderedJson: { tier: "project" },
				});
				await projects.delete(projectId);
				// Project-tier row gone via ON DELETE CASCADE; global row stays.
				expect(await repo.get("claude-code", { projectId })).toBeNull();
				expect((await repo.get("claude-code"))?.projectId).toBeNull();
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
