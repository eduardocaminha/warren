import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { WorkersRepo } from "./workers.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`WorkersRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const repo = new WorkersRepo(DrizzleAdapter.for(handle.db));
			return { handle, repo };
		};

		test("upsert inserts a fresh row with default state=healthy", async () => {
			const { handle, repo } = await open();
			try {
				const row = await repo.upsert({
					name: "alpha",
					url: "unix:///var/run/burrow.sock",
					now: new Date("2026-05-13T00:00:00.000Z"),
				});
				expect(row.name).toBe("alpha");
				expect(row.url).toBe("unix:///var/run/burrow.sock");
				expect(row.state).toBe("healthy");
				expect(row.addedAt).toBe("2026-05-13T00:00:00.000Z");
			} finally {
				await handle.close();
			}
		});

		test("upsert honors an explicit initial state", async () => {
			const { handle, repo } = await open();
			try {
				const row = await repo.upsert({
					name: "alpha",
					url: "http://worker-a:6789",
					state: "draining",
				});
				expect(row.state).toBe("draining");
			} finally {
				await handle.close();
			}
		});

		test("upsert preserves addedAt across re-registration and updates url", async () => {
			const { handle, repo } = await open();
			try {
				const initial = await repo.upsert({
					name: "alpha",
					url: "http://worker-a:6789",
					now: new Date("2026-05-13T00:00:00.000Z"),
				});
				const updated = await repo.upsert({
					name: "alpha",
					url: "http://worker-a:7000",
					now: new Date("2026-05-14T00:00:00.000Z"),
				});
				expect(updated.url).toBe("http://worker-a:7000");
				expect(updated.addedAt).toBe(initial.addedAt);
			} finally {
				await handle.close();
			}
		});

		test("upsert without state preserves an existing non-healthy state", async () => {
			const { handle, repo } = await open();
			try {
				await repo.upsert({ name: "alpha", url: "http://a:1" });
				await repo.setState("alpha", "unreachable");
				const reloaded = await repo.upsert({ name: "alpha", url: "http://a:2" });
				expect(reloaded.state).toBe("unreachable");
				expect(reloaded.url).toBe("http://a:2");
			} finally {
				await handle.close();
			}
		});

		test("upsert with state overrides an existing row's state", async () => {
			const { handle, repo } = await open();
			try {
				await repo.upsert({ name: "alpha", url: "http://a:1" });
				const drained = await repo.upsert({ name: "alpha", url: "http://a:1", state: "draining" });
				expect(drained.state).toBe("draining");
			} finally {
				await handle.close();
			}
		});

		test("setState flips the state machine", async () => {
			const { handle, repo } = await open();
			try {
				await repo.upsert({ name: "alpha", url: "http://a:1" });
				expect((await repo.setState("alpha", "draining")).state).toBe("draining");
				expect((await repo.setState("alpha", "unreachable")).state).toBe("unreachable");
				expect((await repo.setState("alpha", "healthy")).state).toBe("healthy");
			} finally {
				await handle.close();
			}
		});

		test("require throws NotFoundError for an unknown worker", async () => {
			const { handle, repo } = await open();
			try {
				expect(repo.require("missing")).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("listAll returns workers in alphabetical name order", async () => {
			const { handle, repo } = await open();
			try {
				await repo.upsert({ name: "gamma", url: "http://g:1" });
				await repo.upsert({ name: "alpha", url: "http://a:1" });
				await repo.upsert({ name: "beta", url: "http://b:1" });
				expect((await repo.listAll()).map((w) => w.name)).toEqual(["alpha", "beta", "gamma"]);
			} finally {
				await handle.close();
			}
		});

		test("listAll on an empty table returns []", async () => {
			const { handle, repo } = await open();
			try {
				expect(await repo.listAll()).toEqual([]);
			} finally {
				await handle.close();
			}
		});

		test("delete removes the row", async () => {
			const { handle, repo } = await open();
			try {
				await repo.upsert({ name: "alpha", url: "http://a:1" });
				await repo.delete("alpha");
				expect(await repo.get("alpha")).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("name is the primary key (re-insert of same name does not duplicate)", async () => {
			const { handle, repo } = await open();
			try {
				await repo.upsert({ name: "alpha", url: "http://a:1" });
				await repo.upsert({ name: "alpha", url: "http://a:2" });
				expect(await repo.listAll()).toHaveLength(1);
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
