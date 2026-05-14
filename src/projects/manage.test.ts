import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { isId } from "../core/ids.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { RunsRepo } from "../db/repos/runs.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { CloneProjectResult, SpawnFn } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { addProject, deleteProject, listProjects, refreshProject } from "./manage.ts";

const CFG: ProjectsConfig = {
	root: "/data/projects",
	gitBinary: "git",
};

const NOOP_SPAWN: SpawnFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });

interface RecordingCache extends WarrenConfigCache {
	readonly invalidations: readonly string[];
}

function recordingCache(): RecordingCache {
	const invalidations: string[] = [];
	return {
		get invalidations() {
			return invalidations;
		},
		get: async () => ({
			triggers: null,
			defaults: null,
			prTemplate: null,
			errors: [],
			warnings: [],
		}),
		invalidate: (id: string) => {
			invalidations.push(id);
		},
		clear: () => {
			invalidations.length = 0;
		},
		size: () => 0,
	};
}

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
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
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
		expect(await repo.listAll()).toHaveLength(1);
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
		expect(await repo.listAll()).toHaveLength(0);
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
		expect(await repo.listAll()).toHaveLength(0);
	});
});

describe("listProjects", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
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
		expect((await listProjects(repo)).map((r) => r.id)).toEqual([a.id, b.id]);
	});
});

describe("deleteProject", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
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
		expect(await repo.get(row.id)).toBeNull();
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
		expect(await repo.get(row.id)).toBeNull();
	});

	test("removes the row even when rmrf throws and surfaces a logger warning", async () => {
		// Reordered behaviour (warren-5f19): the row delete is the
		// transactional fix that orphans referencing runs via ON DELETE
		// SET NULL; a stranded clone on disk is a recoverable
		// inconvenience, not a blocker. The prior contract ("rm fails →
		// row remains registered") left the system in 'row exists, disk
		// gone' if the operator hit `delete` again, which then wedged
		// every subsequent dispatch.
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const warnings: { obj: object; msg?: string }[] = [];
		const result = await deleteProject({
			repo,
			config: CFG,
			id: row.id,
			exists: () => true,
			rmrf: async () => {
				throw new Error("EBUSY");
			},
			logger: {
				warn: (obj, msg) => {
					warnings.push({ obj, msg });
				},
			},
		});
		expect(result.id).toBe(row.id);
		expect(await repo.get(row.id)).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.msg).toContain("stranded clone");
	});

	test("orphans referencing runs via ON DELETE SET NULL instead of failing the FK", async () => {
		// SPEC §11.E + warren-5f19: deleting a project with run history
		// must succeed and keep the runs as orphans (project_id null), so
		// the UI can still render the historical runs and operators can
		// re-register the same gitUrl without an FK conflict.
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const runsRepo = new RunsRepo(db.drizzle);
		// Seed a referencing agent + run before the delete.
		db.raw.exec(
			"INSERT INTO agents (name, rendered_json, registered_at, last_refreshed) VALUES ('claude-code', '{}', '2026-05-09T00:00:00.000Z', '2026-05-09T00:00:00.000Z')",
		);
		const created = await runsRepo.create({
			agentName: "claude-code",
			projectId: row.id,
			prompt: "test",
			renderedAgentJson: { name: "claude-code" },
			trigger: "manual",
		});

		await deleteProject({
			repo,
			config: CFG,
			id: row.id,
			exists: () => false,
			rmrf: async () => undefined,
		});

		expect(await repo.get(row.id)).toBeNull();
		const orphan = await runsRepo.require(created.id);
		expect(orphan.projectId).toBeNull();
	});

	test("refuses to delete a project whose localPath escaped the configured root", async () => {
		// Forge a row by writing directly with the repo (defense-in-depth: bad data
		// in the db should not let warren rm an arbitrary path).
		const stranded = await repo.create({
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
		expect(await repo.get(stranded.id)).not.toBeNull();
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

	test("invalidates the warren-config cache after the row delete", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const cache = recordingCache();
		await deleteProject({
			repo,
			config: CFG,
			id: row.id,
			exists: () => false,
			rmrf: async () => undefined,
			warrenConfigs: cache,
		});

		expect(cache.invalidations).toEqual([row.id]);
	});
});

describe("refreshProject", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("calls refresh with the row's localPath + default branch and stamps lastFetchedAt + lastHeadSha", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone({ defaultBranch: "trunk" }),
		});

		let receivedRef: string | undefined;
		let receivedPath: string | undefined;
		const result = await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			spawn: NOOP_SPAWN,
			refresh: async (input) => {
				receivedRef = input.ref;
				receivedPath = input.localPath;
				return { headSha: "abcd1234abcd1234abcd1234abcd1234abcd1234", ref: input.ref };
			},
			now: () => new Date("2026-05-09T19:00:00.000Z"),
		});

		expect(receivedRef).toBe("trunk");
		expect(receivedPath).toBe(row.localPath);
		expect(result.headSha).toBe("abcd1234abcd1234abcd1234abcd1234abcd1234");
		expect(result.project.lastFetchedAt).toBe("2026-05-09T19:00:00.000Z");
		expect(result.project.lastHeadSha).toBe("abcd1234abcd1234abcd1234abcd1234abcd1234");

		const persisted = await repo.require(row.id);
		expect(persisted.lastFetchedAt).toBe("2026-05-09T19:00:00.000Z");
		expect(persisted.lastHeadSha).toBe("abcd1234abcd1234abcd1234abcd1234abcd1234");
	});

	test("forwards an explicit ref override", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone({ defaultBranch: "main" }),
		});

		let receivedRef: string | undefined;
		await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			ref: "feature/123",
			spawn: NOOP_SPAWN,
			refresh: async (input) => {
				receivedRef = input.ref;
				return { headSha: "deadbeef".repeat(5), ref: input.ref };
			},
		});

		expect(receivedRef).toBe("feature/123");
	});

	test("does not stamp the row when refresh throws", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		await expect(
			refreshProject({
				repo,
				config: CFG,
				id: row.id,
				spawn: NOOP_SPAWN,
				refresh: async () => {
					throw new ProjectUnavailableError("git fetch failed");
				},
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);

		const persisted = await repo.require(row.id);
		expect(persisted.lastFetchedAt).toBeNull();
		expect(persisted.lastHeadSha).toBeNull();
	});

	test("rejects an empty ref override with ValidationError", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		await expect(
			refreshProject({
				repo,
				config: CFG,
				id: row.id,
				ref: "",
				spawn: NOOP_SPAWN,
				refresh: async () => ({ headSha: "x", ref: "" }),
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("throws NotFoundError when the project id is unknown", async () => {
		await expect(
			refreshProject({
				repo,
				config: CFG,
				id: "prj_nope",
				spawn: NOOP_SPAWN,
				refresh: async () => ({ headSha: "x", ref: "main" }),
			}),
		).rejects.toMatchObject({ code: "not_found" });
	});

	test("invalidates the warren-config cache BEFORE refresh runs (pl-5d74 risk #4)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const cache = recordingCache();
		const order: string[] = [];
		await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			spawn: NOOP_SPAWN,
			warrenConfigs: {
				...cache,
				invalidate: (id) => {
					order.push(`invalidate:${id}`);
					cache.invalidate(id);
				},
			},
			refresh: async (input) => {
				order.push("refresh");
				return { headSha: "deadbeef".repeat(5), ref: input.ref };
			},
		});

		expect(order).toEqual([`invalidate:${row.id}`, "refresh"]);
		expect(cache.invalidations).toEqual([row.id]);
	});

	test("invalidates even when refresh throws (cache stays empty)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const cache = recordingCache();
		await expect(
			refreshProject({
				repo,
				config: CFG,
				id: row.id,
				spawn: NOOP_SPAWN,
				warrenConfigs: cache,
				refresh: async () => {
					throw new ProjectUnavailableError("git fetch failed");
				},
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);

		expect(cache.invalidations).toEqual([row.id]);
	});
});
