import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { isId } from "../../core/ids.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`ProjectsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const repo = new ProjectsRepo(DrizzleAdapter.for(handle.db));
			return { handle, repo };
		};

		test("create assigns a prj_ id and stamps addedAt", async () => {
			const { handle, repo } = await open();
			try {
				const now = new Date("2026-05-08T12:00:00.000Z");
				const row = await repo.create({
					gitUrl: "https://github.com/jayminwest/warren.git",
					localPath: "/data/projects/jayminwest/warren",
					defaultBranch: "main",
					now,
				});
				expect(isId("project", row.id)).toBe(true);
				expect(row.addedAt).toBe(now.toISOString());
			} finally {
				await handle.close();
			}
		});

		test("create accepts a caller-supplied id", async () => {
			const { handle, repo } = await open();
			try {
				const row = await repo.create({
					id: "prj_fixedfixed00",
					gitUrl: "https://github.com/x/y.git",
					localPath: "/data/projects/x/y",
					defaultBranch: "main",
				});
				expect(row.id).toBe("prj_fixedfixed00");
			} finally {
				await handle.close();
			}
		});

		test("require throws NotFoundError for unknown id", async () => {
			const { handle, repo } = await open();
			try {
				expect(repo.require("prj_doesnotexist")).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("findByGitUrl returns a matching row or null", async () => {
			const { handle, repo } = await open();
			try {
				await repo.create({
					gitUrl: "https://github.com/x/y.git",
					localPath: "/data/projects/x/y",
					defaultBranch: "main",
				});
				expect((await repo.findByGitUrl("https://github.com/x/y.git"))?.gitUrl).toBe(
					"https://github.com/x/y.git",
				);
				expect(await repo.findByGitUrl("https://github.com/no/match.git")).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("listAll returns rows in insertion order", async () => {
			const { handle, repo } = await open();
			try {
				const a = await repo.create({
					gitUrl: "https://github.com/x/a.git",
					localPath: "/data/projects/x/a",
					defaultBranch: "main",
					now: new Date("2026-05-08T12:00:00.000Z"),
				});
				const b = await repo.create({
					gitUrl: "https://github.com/x/b.git",
					localPath: "/data/projects/x/b",
					defaultBranch: "main",
					now: new Date("2026-05-08T13:00:00.000Z"),
				});
				expect((await repo.listAll()).map((r) => r.id)).toEqual([a.id, b.id]);
			} finally {
				await handle.close();
			}
		});

		test("delete removes the row", async () => {
			const { handle, repo } = await open();
			try {
				const row = await repo.create({
					gitUrl: "https://github.com/x/y.git",
					localPath: "/data/projects/x/y",
					defaultBranch: "main",
				});
				await repo.delete(row.id);
				expect(await repo.get(row.id)).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("recordRefresh updates lastFetchedAt and lastHeadSha", async () => {
			const { handle, repo } = await open();
			try {
				const created = await repo.create({
					gitUrl: "https://github.com/x/y.git",
					localPath: "/data/projects/x/y",
					defaultBranch: "main",
				});
				const refreshedAt = new Date("2026-05-09T00:00:00.000Z");
				const row = await repo.recordRefresh({
					id: created.id,
					headSha: "deadbeef",
					now: refreshedAt,
				});
				expect(row.lastFetchedAt).toBe(refreshedAt.toISOString());
				expect(row.lastHeadSha).toBe("deadbeef");
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
