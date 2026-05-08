import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { isId } from "../core/ids.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import type { CloneProjectResult, SpawnFn } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { addProject, deleteProject, listProjects } from "./manage.ts";

const CFG: ProjectsConfig = {
	root: "/data/projects",
	gitBinary: "git",
};

const NOOP_SPAWN: SpawnFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });

function fakeClone(
	result: Partial<CloneProjectResult> = {},
): typeof import("./clone.ts").cloneProjectRepo {
	return async (input) => ({
		localPath: result.localPath ?? `${input.config.root}/${input.owner}/${input.name}`,
		defaultBranch: result.defaultBranch ?? input.defaultBranch ?? "main",
	});
}

describe("addProject", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(db.drizzle);
	});

	afterEach(() => {
		db.close();
	});

	test("clones, persists a row, and returns it", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/jayminwest/warren.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			now: () => new Date("2026-05-08T12:00:00.000Z"),
		});

		expect(isId("project", row.id)).toBe(true);
		expect(row.gitUrl).toBe("https://github.com/jayminwest/warren.git");
		expect(row.localPath).toBe("/data/projects/jayminwest/warren");
		expect(row.defaultBranch).toBe("main");
		expect(row.addedAt).toBe("2026-05-08T12:00:00.000Z");
		expect(repo.listAll()).toHaveLength(1);
	});

	test("propagates an explicit defaultBranch into the cloner and the row", async () => {
		let received: string | undefined;
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			defaultBranch: "trunk",
			spawn: NOOP_SPAWN,
			clone: async (input) => {
				received = input.defaultBranch;
				return {
					localPath: `${input.config.root}/${input.owner}/${input.name}`,
					defaultBranch: input.defaultBranch ?? "main",
				};
			},
		});

		expect(received).toBe("trunk");
		expect(row.defaultBranch).toBe("trunk");
	});

	test("rejects an invalid GitHub URL with ValidationError before touching the cloner", async () => {
		let cloneCalled = false;
		await expect(
			addProject({
				repo,
				config: CFG,
				gitUrl: "not a url",
				spawn: NOOP_SPAWN,
				clone: async () => {
					cloneCalled = true;
					return { localPath: "x", defaultBranch: "main" };
				},
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(cloneCalled).toBe(false);
		expect(repo.listAll()).toHaveLength(0);
	});

	test("rejects a duplicate gitUrl with ValidationError without re-cloning", async () => {
		await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		let cloneCalls = 0;
		await expect(
			addProject({
				repo,
				config: CFG,
				gitUrl: "https://github.com/x/y.git",
				spawn: NOOP_SPAWN,
				clone: async (input) => {
					cloneCalls += 1;
					return {
						localPath: `${input.config.root}/${input.owner}/${input.name}`,
						defaultBranch: "main",
					};
				},
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(cloneCalls).toBe(0);
	});

	test("does not insert a row when the cloner throws", async () => {
		await expect(
			addProject({
				repo,
				config: CFG,
				gitUrl: "https://github.com/x/y.git",
				spawn: NOOP_SPAWN,
				clone: async () => {
					throw new ProjectUnavailableError("git clone failed: network down");
				},
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
		expect(repo.listAll()).toHaveLength(0);
	});
});

describe("listProjects", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(db.drizzle);
	});

	afterEach(() => {
		db.close();
	});

	test("returns rows in insertion order", async () => {
		const a = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/a.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			now: () => new Date("2026-05-08T12:00:00.000Z"),
		});
		const b = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/b.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			now: () => new Date("2026-05-08T13:00:00.000Z"),
		});
		expect(listProjects(repo).map((r) => r.id)).toEqual([a.id, b.id]);
	});
});

describe("deleteProject", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(db.drizzle);
	});

	afterEach(() => {
		db.close();
	});

	test("removes the on-disk clone and the row, returning the deleted row", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const rmCalls: string[] = [];
		const deleted = await deleteProject({
			repo,
			config: CFG,
			id: row.id,
			exists: () => true,
			rmrf: async (p) => {
				rmCalls.push(p);
			},
		});

		expect(deleted.id).toBe(row.id);
		expect(rmCalls).toEqual(["/data/projects/x/y"]);
		expect(repo.get(row.id)).toBeNull();
	});

	test("skips rmrf when the directory no longer exists but still removes the row", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		let rmCalled = false;
		await deleteProject({
			repo,
			config: CFG,
			id: row.id,
			exists: () => false,
			rmrf: async () => {
				rmCalled = true;
			},
		});
		expect(rmCalled).toBe(false);
		expect(repo.get(row.id)).toBeNull();
	});

	test("keeps the row registered when rmrf throws", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		await expect(
			deleteProject({
				repo,
				config: CFG,
				id: row.id,
				exists: () => true,
				rmrf: async () => {
					throw new Error("EBUSY");
				},
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
		expect(repo.get(row.id)).not.toBeNull();
	});

	test("refuses to delete a project whose localPath escaped the configured root", async () => {
		// Forge a row by writing directly with the repo (defense-in-depth: bad data
		// in the db should not let warren rm an arbitrary path).
		const stranded = repo.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/etc/passwd",
			defaultBranch: "main",
		});

		let rmCalled = false;
		await expect(
			deleteProject({
				repo,
				config: CFG,
				id: stranded.id,
				exists: () => true,
				rmrf: async () => {
					rmCalled = true;
				},
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
		expect(rmCalled).toBe(false);
		expect(repo.get(stranded.id)).not.toBeNull();
	});

	test("throws NotFoundError when the id is unknown", async () => {
		await expect(
			deleteProject({
				repo,
				config: CFG,
				id: "prj_doesnotexist",
				exists: () => false,
				rmrf: async () => undefined,
			}),
		).rejects.toMatchObject({ code: "not_found" });
	});
});
