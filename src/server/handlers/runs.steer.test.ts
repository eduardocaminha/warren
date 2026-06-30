/**
 * HTTP-layer tests for `POST /runs/:id/steer` (pause-resume.ts).
 *
 * Specifically covers the `MessagePriority` validation gate added by
 * warren-463d: the handler must reject unknown priority values with 400
 * before touching burrow.
 *
 * Core steer-logic tests (empty body, terminal-state rejection, audit
 * event emission) live in `src/runs/steer.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./runs.test-helpers.ts";

function makeInboxClient(calls: { method: string; path: string; body: unknown }[]): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ method, path, body: reqBody });
			if (method === "POST" && path.match(/^\/burrows\/[^/]+\/inbox$/)) {
				const message = {
					id: "msg_aaaaaaaaaaaa",
					burrowId: "bur_steertest000",
					fromActor: "operator",
					body: (reqBody as { body?: string })?.body ?? "",
					priority: (reqBody as { priority?: string })?.priority ?? "normal",
					state: "unread",
					deliveredAtRunId: null,
					createdAt: new Date().toISOString(),
					deliveredAt: null,
				};
				return new Response(JSON.stringify(message), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({ error: { code: "not_found", message: `unmatched ${method} ${path}` } }),
				{ status: 404, headers: { "content-type": "application/json" } },
			);
		}),
	});
}

describe("POST /runs/:id/steer — MessagePriority validation", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
		await repos.burrows.create({ id: "bur_steertest000", workerId: "local" });
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_steertest000",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		await repos.runs.markRunning(run.id);
		runId = run.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("rejects an unknown priority with 400 and does not call burrow", async () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const deps = await depsFor(repos, makeInboxClient(calls));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/steer`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body: "hello", priority: "critical" }),
		});

		expect(res.status).toBe(400);
		const resBody = (await res.json()) as { error: { message: string } };
		expect(resBody.error.message).toContain("critical");
		expect(calls).toHaveLength(0);
	});

	test("accepts a valid priority and forwards it to burrow", async () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const deps = await depsFor(repos, makeInboxClient(calls));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/steer`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body: "stop and write tests", priority: "high" }),
		});

		expect(res.status).toBe(200);
		const inboxCall = calls.find((c) => c.method === "POST" && c.path.endsWith("/inbox"));
		expect(inboxCall).toBeDefined();
		expect((inboxCall?.body as { priority?: string })?.priority).toBe("high");
	});

	test("accepts a steer without priority (optional field)", async () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const deps = await depsFor(repos, makeInboxClient(calls));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/steer`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body: "nudge" }),
		});

		expect(res.status).toBe(200);
		expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/inbox"))).toBe(true);
	});
});
