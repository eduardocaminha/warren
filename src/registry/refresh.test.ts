import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { AgentsRepo } from "../db/repos/agents.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { CanopyClient, type SpawnFn, type SpawnResult } from "./canopy.ts";
import type { CanopyRegistryConfig } from "./config.ts";
import { refreshAgentRegistry, refreshProjectAgents } from "./refresh.ts";

const CFG: CanopyRegistryConfig = {
	repoUrl: "https://example.com/agents.git",
	localDir: "/tmp/canopy-refresh",
	cnBinary: "cn",
	gitBinary: "git",
};

function buildSpawn(
	listResp: unknown,
	renderResponses: Record<string, { ok?: unknown; exit?: number; stderr?: string }>,
): SpawnFn {
	return async (cmd) => {
		if (cmd[1] === "list") {
			return { stdout: JSON.stringify(listResp), stderr: "", exitCode: 0 };
		}
		if (cmd[1] === "render") {
			const name = cmd[2] as string;
			const handler = renderResponses[name];
			if (!handler) {
				return { stdout: "", stderr: `unhandled render: ${name}`, exitCode: 2 };
			}
			if (handler.exit !== undefined && handler.exit !== 0) {
				return {
					stdout: handler.ok !== undefined ? JSON.stringify(handler.ok) : "",
					stderr: handler.stderr ?? "",
					exitCode: handler.exit,
				};
			}
			return { stdout: JSON.stringify(handler.ok), stderr: "", exitCode: 0 };
		}
		const result: SpawnResult = { stdout: "", stderr: "unexpected cmd", exitCode: 1 };
		return result;
	};
}

function rendered(name: string, sections: Record<string, string>, version = 1) {
	return {
		success: true,
		command: "render",
		name,
		version,
		sections: Object.entries(sections).map(([n, body]) => ({ name: n, body })),
	};
}

const FAKE_CLONE = async () => ({ cloned: false, localDir: CFG.localDir });

describe("refreshAgentRegistry", () => {
	let db: WarrenDb;
	let agents: AgentsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		agents = new AgentsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("registers every valid agent and caches its rendered definition", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "refactor-bot", version: 2, status: "active" },
					{ name: "docs-bot", version: 1, status: "active" },
				],
			},
			{
				"refactor-bot": { ok: rendered("refactor-bot", { system: "refactor" }, 2) },
				"docs-bot": { ok: rendered("docs-bot", { system: "docs", skills: "..." }) },
			},
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });

		const result = await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
		});

		expect(result.registered.map((r) => r.name).sort()).toEqual(["docs-bot", "refactor-bot"]);
		expect(result.skipped).toEqual([]);
		expect(result.removed).toEqual([]);
		const refactor = await agents.require("refactor-bot");
		expect((refactor.renderedJson as { sections: { system: string } }).sections.system).toBe(
			"refactor",
		);
	});

	test("skips a prompt whose render fails (e.g. archived between list and render) without aborting", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "good-bot", version: 1, status: "active" },
					{ name: "raced-bot", version: 1, status: "active" },
				],
			},
			{
				"good-bot": { ok: rendered("good-bot", { system: "ok" }) },
				"raced-bot": {
					exit: 1,
					ok: { success: false, command: "render", error: 'Prompt "raced-bot" not found' },
				},
			},
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });

		const result = await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
		});

		expect(result.registered.map((r) => r.name)).toEqual(["good-bot"]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]).toMatchObject({
			name: "raced-bot",
			code: "canopy_unavailable",
			reason: expect.stringContaining("not found"),
		});
	});

	test("skips a prompt that fails warren's semantic schema (missing system)", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "bad-bot", version: 1, status: "active" },
					{ name: "ok-bot", version: 1, status: "active" },
				],
			},
			{
				"bad-bot": { ok: rendered("bad-bot", { skills: "no system" }) },
				"ok-bot": { ok: rendered("ok-bot", { system: "ok" }) },
			},
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });

		const result = await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
		});

		expect(result.registered.map((r) => r.name)).toEqual(["ok-bot"]);
		expect(result.skipped[0]).toMatchObject({
			name: "bad-bot",
			code: "agent_schema_error",
			reason: expect.stringContaining("system"),
		});
	});

	test("re-running the refresh upserts (lastRefreshed bumps, registeredAt preserved)", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "refactor-bot", version: 1, status: "active" }],
			},
			{ "refactor-bot": { ok: rendered("refactor-bot", { system: "v1" }) } },
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });
		await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
			now: () => new Date("2026-05-08T12:00:00.000Z"),
		});

		// Second refresh, new render, new clock.
		const spawn2 = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "refactor-bot", version: 2, status: "active" }],
			},
			{ "refactor-bot": { ok: rendered("refactor-bot", { system: "v2" }, 2) } },
		);
		const client2 = CanopyClient.forLibrary({ config: CFG, spawn: spawn2 });
		await refreshAgentRegistry({
			client: client2,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn: spawn2 },
			now: () => new Date("2026-05-09T12:00:00.000Z"),
		});

		const row = await agents.require("refactor-bot");
		expect(row.registeredAt).toBe("2026-05-08T12:00:00.000Z");
		expect(row.lastRefreshed).toBe("2026-05-09T12:00:00.000Z");
		expect((row.renderedJson as { version: number }).version).toBe(2);
	});

	test("prune: deletes warren rows missing from the canopy listing when prune=true", async () => {
		// First populate the db with two agents.
		await agents.upsert({ name: "stale-bot", renderedJson: { sections: {} } });
		await agents.upsert({ name: "live-bot", renderedJson: { sections: { system: "x" } } });

		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "live-bot", version: 1, status: "active" }],
			},
			{ "live-bot": { ok: rendered("live-bot", { system: "x" }) } },
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });

		const result = await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
			prune: true,
		});

		expect(result.removed).toEqual(["stale-bot"]);
		expect(await agents.get("stale-bot")).toBeNull();
		expect(await agents.get("live-bot")).not.toBeNull();
	});

	test("prune defaults to off — stale rows are left alone", async () => {
		await agents.upsert({ name: "stale-bot", renderedJson: { sections: {} } });

		const spawn = buildSpawn({ success: true, command: "list", prompts: [] }, {});
		const client = CanopyClient.forLibrary({ config: CFG, spawn });

		const result = await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
		});

		expect(result.removed).toEqual([]);
		expect(await agents.get("stale-bot")).not.toBeNull();
	});
});

describe("refreshProjectAgents", () => {
	let db: WarrenDb;
	let agents: AgentsRepo;
	let projects: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		const adapter = DrizzleAdapter.for(db);
		agents = new AgentsRepo(adapter);
		projects = new ProjectsRepo(adapter);
	});

	afterEach(async () => {
		await db.close();
	});

	const seedProject = async (
		gitUrl = "https://github.com/x/y.git",
		localPath = "/data/projects/x/y",
	) => {
		const p = await projects.create({ gitUrl, localPath, defaultBranch: "main" });
		return p.id;
	};

	test("renders project agents, stamps source=project:<id>, and scopes upserts to the project tier", async () => {
		const projectId = await seedProject();
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "refactor-bot", version: 1, status: "active" },
					{ name: "docs-bot", version: 2, status: "active" },
				],
			},
			{
				"refactor-bot": { ok: rendered("refactor-bot", { system: "proj" }) },
				"docs-bot": { ok: rendered("docs-bot", { system: "docs" }, 2) },
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		const result = await refreshProjectAgents({ client, agents, projectId });

		expect(result.projectId).toBe(projectId);
		expect(result.registered.map((r) => r.name).sort()).toEqual(["docs-bot", "refactor-bot"]);
		expect(result.registered.every((r) => r.projectId === projectId)).toBe(true);
		expect(result.skipped).toEqual([]);
		expect(result.removed).toEqual([]);

		const row = await agents.require("refactor-bot", { projectId });
		const stamped = row.renderedJson as { frontmatter: { source: string } };
		expect(stamped.frontmatter.source).toBe(`project:${projectId}`);
		// Global tier untouched.
		expect(await agents.get("refactor-bot")).toBeNull();
	});

	test("does not touch a same-named global-tier row", async () => {
		const projectId = await seedProject();
		await agents.upsert({
			name: "claude-code",
			renderedJson: { frontmatter: { source: "builtin" }, tier: "global" },
		});
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "claude-code", version: 1, status: "active" }],
			},
			{ "claude-code": { ok: rendered("claude-code", { system: "proj override" }) } },
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		await refreshProjectAgents({ client, agents, projectId });

		const global = await agents.require("claude-code");
		expect(global.projectId).toBeNull();
		expect((global.renderedJson as { tier?: string }).tier).toBe("global");
		const project = await agents.require("claude-code", { projectId });
		expect(project.projectId).toBe(projectId);
		expect((project.renderedJson as { frontmatter: { source: string } }).frontmatter.source).toBe(
			`project:${projectId}`,
		);
	});

	test("skips a render-time failure without aborting the rest", async () => {
		const projectId = await seedProject();
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "good-bot", version: 1, status: "active" },
					{ name: "raced-bot", version: 1, status: "active" },
				],
			},
			{
				"good-bot": { ok: rendered("good-bot", { system: "ok" }) },
				"raced-bot": {
					exit: 1,
					ok: { success: false, command: "render", error: 'Prompt "raced-bot" not found' },
				},
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		const result = await refreshProjectAgents({ client, agents, projectId });
		expect(result.registered.map((r) => r.name)).toEqual(["good-bot"]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]).toMatchObject({
			name: "raced-bot",
			code: "canopy_unavailable",
			reason: expect.stringContaining("not found"),
		});
	});

	test("skips a prompt that fails warren's semantic schema (missing system)", async () => {
		const projectId = await seedProject();
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "bad-bot", version: 1, status: "active" },
					{ name: "ok-bot", version: 1, status: "active" },
				],
			},
			{
				"bad-bot": { ok: rendered("bad-bot", { skills: "no system" }) },
				"ok-bot": { ok: rendered("ok-bot", { system: "ok" }) },
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		const result = await refreshProjectAgents({ client, agents, projectId });
		expect(result.registered.map((r) => r.name)).toEqual(["ok-bot"]);
		expect(result.skipped[0]).toMatchObject({
			name: "bad-bot",
			code: "agent_schema_error",
			reason: expect.stringContaining("system"),
		});
	});

	test("re-running upserts (lastRefreshed bumps, registeredAt preserved)", async () => {
		const projectId = await seedProject();
		const spawnV1 = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "refactor-bot", version: 1, status: "active" }],
			},
			{ "refactor-bot": { ok: rendered("refactor-bot", { system: "v1" }) } },
		);
		await refreshProjectAgents({
			client: CanopyClient.forProjectPath({ projectPath: "/proj", spawn: spawnV1 }),
			agents,
			projectId,
			now: () => new Date("2026-05-08T12:00:00.000Z"),
		});

		const spawnV2 = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "refactor-bot", version: 2, status: "active" }],
			},
			{ "refactor-bot": { ok: rendered("refactor-bot", { system: "v2" }, 2) } },
		);
		await refreshProjectAgents({
			client: CanopyClient.forProjectPath({ projectPath: "/proj", spawn: spawnV2 }),
			agents,
			projectId,
			now: () => new Date("2026-05-09T12:00:00.000Z"),
		});

		const row = await agents.require("refactor-bot", { projectId });
		expect(row.registeredAt).toBe("2026-05-08T12:00:00.000Z");
		expect(row.lastRefreshed).toBe("2026-05-09T12:00:00.000Z");
		expect((row.renderedJson as { version: number }).version).toBe(2);
	});

	test("prune is always-on: rows missing from this project's listing are deleted; global + other-project rows untouched", async () => {
		const projectId = await seedProject();
		const otherProjectId = await seedProject("https://github.com/a/b.git", "/data/projects/a/b");
		// Pre-existing rows across all three scopes:
		await agents.upsert({ name: "stale-bot", projectId, renderedJson: { v: 0 } });
		await agents.upsert({ name: "stale-bot", renderedJson: { tier: "global" } });
		await agents.upsert({ name: "stale-bot", projectId: otherProjectId, renderedJson: { v: 0 } });

		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "live-bot", version: 1, status: "active" }],
			},
			{ "live-bot": { ok: rendered("live-bot", { system: "ok" }) } },
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		const result = await refreshProjectAgents({ client, agents, projectId });
		expect(result.removed).toEqual(["stale-bot"]);
		expect(await agents.get("stale-bot", { projectId })).toBeNull();
		// Global tier untouched.
		expect((await agents.get("stale-bot"))?.projectId).toBeNull();
		// Other project untouched.
		expect((await agents.get("stale-bot", { projectId: otherProjectId }))?.projectId).toBe(
			otherProjectId,
		);
	});

	test("empty listing with no existing rows is a no-op", async () => {
		const projectId = await seedProject();
		const spawn = buildSpawn({ success: true, command: "list", prompts: [] }, {});
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });
		const result = await refreshProjectAgents({ client, agents, projectId });
		expect(result).toEqual({ projectId, registered: [], skipped: [], removed: [] });
	});

	test("transport-layer failure on `cn list` aborts the whole refresh", async () => {
		const projectId = await seedProject();
		const spawn: SpawnFn = async () => ({
			stdout: "",
			stderr: "cn: command not found",
			exitCode: 127,
		});
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });
		await expect(refreshProjectAgents({ client, agents, projectId })).rejects.toMatchObject({
			code: "canopy_unavailable",
		});
	});
});
