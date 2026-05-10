/**
 * Handlers for warren's HTTP API (SPEC §8.1).
 *
 * Each handler is a thin envelope around a function in `runs/`,
 * `registry/`, `projects/`, or `db/repos/` — the modules already do
 * validation, state machines, and burrow shell-out, so handlers only
 * shape the wire IO.
 *
 * Streaming surface (`GET /runs/:id/events?follow=1`) bridges
 * `tailRunEvents` onto NDJSON. Cleanup follows the same pattern burrow
 * uses (mx-b3423b): `request.signal` propagates to a per-stream
 * AbortController; the source generator returns cleanly on abort;
 * `ReadableStream.cancel` aborts back into the generator if the consumer
 * cancels first. The events generator already tears down its broker
 * subscription in a `finally`, so no broker entries leak.
 *
 * Spawn (`POST /runs`) registers a fresh bridge against the run via
 * `deps.bridges.start()` so the live tail has events to read. Without
 * this hook the run dispatches into burrow but warren never persists
 * any of its events — a regression Phase 6 would otherwise re-introduce.
 *
 * `POST /agents/refresh` is sync from the wire's POV (the canopy clone +
 * per-prompt render runs to completion before responding). We don't
 * stream progress events; if a refresh starts taking minutes the right
 * answer is to add a Phase 13-style readyz/doctor signal, not to bolt a
 * progress channel onto this route.
 */

import type { MessagePriority } from "@os-eco/burrow-cli";
import { ValidationError } from "../core/errors.ts";
import type { AgentRow } from "../db/schema.ts";
import {
	checkBurrowReachable,
	checkBwrap,
	checkCanopyClean,
	checkCanopyClone,
	type DiagnosticCheck,
} from "../diagnostics/checks.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../projects/clone.ts";
import { addProject, deleteProject, listProjects, refreshProject } from "../projects/index.ts";
import { type AgentSource, readAgentSource } from "../registry/builtins/index.ts";
import { CanopyClient } from "../registry/canopy.ts";
import { refreshAgentRegistry } from "../registry/refresh.ts";
import { cancelRun, spawnRun, steerRun, tailRunEvents } from "../runs/index.ts";
import { jsonResponse, ndjsonResponse } from "./response.ts";
import type { Route, RouteContext, RouteHandler, ServerDeps } from "./types.ts";

/**
 * Run a command via `Bun.spawn` and return the SpawnResult shape the
 * registry/projects modules expect. Non-zero exit codes are surfaced to
 * the caller; transport-level failures (binary missing, timeout) bubble
 * as the underlying Error so the call-site error mapper can wrap them.
 */
const defaultSpawn: SpawnFn = async (
	cmd: readonly string[],
	opts: SpawnOptions,
): Promise<SpawnResult> => {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer =
		opts.timeoutMs !== undefined && opts.timeoutMs > 0
			? setTimeout(() => proc.kill(), opts.timeoutMs)
			: null;
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (timer !== null) clearTimeout(timer);
	return { stdout, stderr, exitCode: exitCode ?? 0 };
};

/* ----------------------------------------------------------------------- */
/* Body / param parsing                                                     */
/* ----------------------------------------------------------------------- */

async function readJsonBody(ctx: RouteContext): Promise<Record<string, unknown>> {
	const raw = await ctx.request.text();
	if (raw.length === 0) {
		throw new ValidationError("request body is empty; expected a JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ValidationError(
			`request body must be JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

async function readJsonBodyOrEmpty(ctx: RouteContext): Promise<Record<string, unknown> | null> {
	const raw = await ctx.request.text();
	if (raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ValidationError(
			`request body must be JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new ValidationError(`field '${key}' is required and must be a non-empty string`);
	}
	return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new ValidationError(`field '${key}' must be a string`);
	}
	return value;
}

function requireParam(ctx: RouteContext, key: string): string {
	const value = ctx.params[key];
	if (value === undefined || value.length === 0) {
		throw new ValidationError(`route param '${key}' is missing`);
	}
	return value;
}

function parseBoolean(raw: string | null, label: string): boolean | undefined {
	if (raw === null) return undefined;
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	throw new ValidationError(`${label} must be 'true'/'1' or 'false'/'0'; got '${raw}'`);
}

function parseNonNegativeInt(raw: string | null, label: string): number | undefined {
	if (raw === null) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || String(n) !== raw) {
		throw new ValidationError(`${label} must be a non-negative integer; got '${raw}'`);
	}
	return n;
}

/* ----------------------------------------------------------------------- */
/* Agents (§8.1)                                                            */
/* ----------------------------------------------------------------------- */

/**
 * Decorate an `AgentRow` with the `source` provenance so `GET /agents`
 * consumers can distinguish built-ins from library-loaded agents.
 */
function withAgentSource(row: AgentRow): AgentRow & { source: AgentSource } {
	return { ...row, source: readAgentSource(row.renderedJson) };
}

function listAgents(deps: ServerDeps): RouteHandler {
	return () =>
		jsonResponse(200, {
			agents: deps.repos.agents.listAll().map(withAgentSource),
		});
}

function getAgent(deps: ServerDeps): RouteHandler {
	return (ctx) => {
		const name = requireParam(ctx, "name");
		return jsonResponse(200, withAgentSource(deps.repos.agents.require(name)));
	};
}

function refreshAgents(deps: ServerDeps): RouteHandler {
	return async () => {
		// No canopy library configured (warren-d3e9): refresh has nothing
		// to refresh against. 400 with a friendly hint is more useful than
		// 200-with-empty-arrays — the operator's mental model is "I asked
		// for a refresh, why didn't anything happen".
		if (deps.canopyConfig === undefined) {
			throw new ValidationError("CANOPY_REPO_URL is not set; nothing to refresh", {
				recoveryHint:
					"set CANOPY_REPO_URL to a canopy agent library to enable refresh — built-in agents are always available without one",
			});
		}
		const canopyConfig = deps.canopyConfig;
		const client = new CanopyClient({ config: canopyConfig, spawn: defaultSpawn });
		const result = await refreshAgentRegistry({
			client,
			agents: deps.repos.agents,
			cloneOptions: {
				config: canopyConfig,
				spawn: defaultSpawn,
			},
		});
		return jsonResponse(200, {
			clone: result.clone,
			registered: result.registered,
			skipped: result.skipped,
			removed: result.removed,
		});
	};
}

/* ----------------------------------------------------------------------- */
/* Projects (§8.1)                                                          */
/* ----------------------------------------------------------------------- */

function listProjectsHandler(deps: ServerDeps): RouteHandler {
	return () => jsonResponse(200, { projects: listProjects(deps.repos.projects) });
}

function createProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const gitUrl = requireString(body, "gitUrl");
		const defaultBranch = optionalString(body, "defaultBranch");
		const project = await addProject({
			repo: deps.repos.projects,
			config: deps.projectsConfig,
			gitUrl,
			...(defaultBranch !== undefined ? { defaultBranch } : {}),
			spawn: defaultSpawn,
		});
		return jsonResponse(201, project);
	};
}

function deleteProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const row = await deleteProject({
			repo: deps.repos.projects,
			config: deps.projectsConfig,
			id,
		});
		return jsonResponse(200, row);
	};
}

function refreshProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);
		const ref = body !== null ? optionalString(body, "ref") : undefined;
		const result = await refreshProject({
			repo: deps.repos.projects,
			config: deps.projectsConfig,
			id,
			...(ref !== undefined ? { ref } : {}),
			spawn: deps.spawn ?? defaultSpawn,
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
		return jsonResponse(200, {
			project: result.project,
			headSha: result.headSha,
			ref: result.ref,
		});
	};
}

/* ----------------------------------------------------------------------- */
/* Runs (§8.1)                                                              */
/* ----------------------------------------------------------------------- */

function listRunsHandler(deps: ServerDeps): RouteHandler {
	return (ctx) => {
		const project = ctx.url.searchParams.get("project");
		const agent = ctx.url.searchParams.get("agent");
		if (project !== null && agent !== null) {
			throw new ValidationError("filter by either ?project=... or ?agent=..., not both");
		}
		if (project !== null) {
			return jsonResponse(200, { runs: deps.repos.runs.listByProject(project) });
		}
		if (agent !== null) {
			return jsonResponse(200, { runs: deps.repos.runs.listByAgent(agent) });
		}
		return jsonResponse(200, { runs: deps.repos.runs.listAll() });
	};
}

function getRunHandler(deps: ServerDeps): RouteHandler {
	return (ctx) => {
		const id = requireParam(ctx, "id");
		return jsonResponse(200, deps.repos.runs.require(id));
	};
}

function createRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const ref = optionalString(body, "ref");
		const result = await spawnRun({
			repos: deps.repos,
			burrowClient: deps.burrowClient,
			agentName: requireString(body, "agent"),
			projectId: requireString(body, "project"),
			prompt: requireString(body, "prompt"),
			...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			...(ref !== undefined ? { ref } : {}),
		});
		// Hand off to the bridge so events start flowing into warren.events
		// — without this the dispatched run would emit events into burrow
		// but the warren wire would never see them.
		deps.bridges.start(result.run.id, result.burrowRun.id);
		return jsonResponse(201, {
			run: result.run,
			burrow: { id: result.burrow.id, workspacePath: result.burrow.workspacePath },
		});
	};
}

function steerRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const result = await steerRun({
			runId: id,
			body: requireString(body, "body"),
			repos: deps.repos,
			burrowClient: deps.burrowClient,
			broker: deps.broker,
			...(optionalString(body, "priority") !== undefined
				? { priority: optionalString(body, "priority") as MessagePriority }
				: {}),
			...(optionalString(body, "fromActor") !== undefined
				? { fromActor: optionalString(body, "fromActor") as string }
				: {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
		return jsonResponse(200, { message: result.message });
	};
}

function cancelRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);
		const reason = body !== null ? optionalString(body, "reason") : undefined;
		const result = await cancelRun({
			runId: id,
			repos: deps.repos,
			burrowClient: deps.burrowClient,
			broker: deps.broker,
			...(reason !== undefined ? { reason } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
		return jsonResponse(200, {
			state: result.state,
			alreadyTerminal: result.alreadyTerminal,
			burrowRun: result.burrowRun,
		});
	};
}

function streamRunEventsHandler(deps: ServerDeps): RouteHandler {
	return (ctx) => {
		const id = requireParam(ctx, "id");
		// 404 fast if the run isn't known — without this we'd happily
		// stream an empty NDJSON forever for a typo'd id.
		deps.repos.runs.require(id);

		const follow = parseBoolean(ctx.url.searchParams.get("follow"), "follow") ?? false;
		const sinceSeq = parseNonNegativeInt(ctx.url.searchParams.get("since"), "since");

		const ctrl = bridgeAbort(ctx.request.signal);
		const source = tailRunEvents({
			runId: id,
			repos: { events: deps.repos.events },
			broker: deps.broker,
			follow,
			...(sinceSeq !== undefined ? { sinceSeq } : {}),
			signal: ctrl.signal,
		});
		return ndjsonResponse(asNdjsonStream(source, eventToNdjson, ctrl));
	};
}

/* ----------------------------------------------------------------------- */
/* Streaming plumbing                                                       */
/* ----------------------------------------------------------------------- */

function bridgeAbort(reqSignal: AbortSignal): AbortController {
	const ctrl = new AbortController();
	if (reqSignal.aborted) {
		ctrl.abort();
		return ctrl;
	}
	reqSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
	return ctrl;
}

function asNdjsonStream<T>(
	source: AsyncIterable<T>,
	encode: (value: T) => string,
	ctrl: AbortController,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(encode(value)));
			} catch (err) {
				if (ctrl.signal.aborted) {
					controller.close();
					return;
				}
				controller.error(err);
			}
		},
		async cancel() {
			ctrl.abort();
			try {
				await iterator.return?.(undefined);
			} catch {
				// ignore — generator's finally is the source of truth
			}
		},
	});
}

function eventToNdjson(row: {
	id: number;
	runId: string;
	burrowEventSeq: number;
	ts: string;
	kind: string;
	stream: string | null;
	payloadJson: unknown;
}): string {
	return `${JSON.stringify({
		id: row.id,
		runId: row.runId,
		seq: row.burrowEventSeq,
		ts: row.ts,
		kind: row.kind,
		stream: row.stream,
		payload: row.payloadJson,
	})}\n`;
}

/* ----------------------------------------------------------------------- */
/* Meta (/healthz, /readyz)                                                 */
/* ----------------------------------------------------------------------- */

function healthz(): RouteHandler {
	return () => jsonResponse(200, { ok: true });
}

function readyz(deps: ServerDeps): RouteHandler {
	return async () => {
		// SpawnFn is required for the bwrap + canopy_clean probes; main.ts
		// always wires `defaultSpawn`, but the type system keeps it
		// optional so tests don't have to populate it. Fall back to the
		// handler-local `defaultSpawn` to keep the contract live in tests
		// that don't override.
		const spawn: SpawnFn = deps.spawn ?? defaultSpawn;
		// Canopy probes are gated on `CANOPY_REPO_URL` being configured
		// (warren-d3e9). With no library, both probes return informational
		// `ok: true` rather than failing — built-in agents cover the
		// "no library" case and there's no clone to inspect.
		const env: Readonly<Record<string, string | undefined>> =
			deps.canopyConfig !== undefined
				? {
						CANOPY_REPO_URL: deps.canopyConfig.repoUrl,
						WARREN_CANOPY_DIR: deps.canopyConfig.localDir,
						WARREN_GIT_BINARY: deps.canopyConfig.gitBinary,
					}
				: {};

		const checks: DiagnosticCheck[] = [];
		checks.push(await checkBurrowReachable({ burrowClient: deps.burrowClient }));
		checks.push(checkAgentsRegistered(deps));
		checks.push(checkCanopyClone({ env }));
		checks.push(await checkCanopyClean({ env, spawn }));
		checks.push(await checkBwrap({ spawn }));

		const allOk = checks.every((c) => c.ok);
		return jsonResponse(allOk ? 200 : 503, {
			ok: allOk,
			checks,
		});
	};
}

function checkAgentsRegistered(deps: ServerDeps): DiagnosticCheck {
	const count = deps.repos.agents.listAll().length;
	if (count === 0) {
		// Built-ins seed on boot (warren-d3e9), so an empty registry here
		// means seeding itself failed — an internal problem, not an
		// operator one. Keep the failure but reword the hint accordingly.
		return {
			name: "agents",
			ok: false,
			message: "no agents registered",
			hint:
				deps.canopyConfig !== undefined
					? "POST /agents/refresh against your canopy library, or check the warren server logs for built-in seed errors"
					: "check the warren server logs for built-in seed errors",
		};
	}
	return { name: "agents", ok: true };
}

/* ----------------------------------------------------------------------- */
/* Public API                                                               */
/* ----------------------------------------------------------------------- */

interface RouteEntry {
	readonly method: Route["method"];
	readonly pattern: string;
	readonly build: (deps: ServerDeps) => RouteHandler;
}

const ROUTE_TABLE: readonly RouteEntry[] = [
	{ method: "GET", pattern: "/healthz", build: () => healthz() },
	{ method: "GET", pattern: "/readyz", build: readyz },

	{ method: "GET", pattern: "/agents", build: listAgents },
	{ method: "POST", pattern: "/agents/refresh", build: refreshAgents },
	{ method: "GET", pattern: "/agents/:name", build: getAgent },

	{ method: "GET", pattern: "/projects", build: listProjectsHandler },
	{ method: "POST", pattern: "/projects", build: createProjectHandler },
	{ method: "POST", pattern: "/projects/:id/refresh", build: refreshProjectHandler },
	{ method: "DELETE", pattern: "/projects/:id", build: deleteProjectHandler },

	{ method: "GET", pattern: "/runs", build: listRunsHandler },
	{ method: "POST", pattern: "/runs", build: createRunHandler },
	{ method: "GET", pattern: "/runs/:id", build: getRunHandler },
	{ method: "GET", pattern: "/runs/:id/events", build: streamRunEventsHandler },
	{ method: "POST", pattern: "/runs/:id/steer", build: steerRunHandler },
	{ method: "POST", pattern: "/runs/:id/cancel", build: cancelRunHandler },
];

export function buildApiRoutes(deps: ServerDeps): Route[] {
	return ROUTE_TABLE.map((entry) => ({
		method: entry.method,
		pattern: entry.pattern,
		handler: entry.build(deps),
	}));
}

/**
 * Top-level prefixes the API claims. Any pathname under one of these is
 * an API request: it requires auth (except `/healthz`, see
 * `isAuthExempt`) and the SPA fallback in `ui.ts` refuses to serve
 * `index.html` for it. Kept in sync with `ROUTE_TABLE` by hand — the
 * router patterns are richer than prefixes (`/agents/:name`,
 * `/runs/:id/events`) so we can't derive these without either parsing
 * the patterns or duplicating the policy.
 */
export const API_PREFIXES: readonly string[] = [
	"/agents",
	"/projects",
	"/runs",
	"/healthz",
	"/readyz",
];

/**
 * True iff `pathname` is one of the API surfaces above. Cheap prefix
 * scan — five entries, no allocations on the hot path.
 */
export function isApiPath(pathname: string): boolean {
	for (const prefix of API_PREFIXES) {
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

/**
 * Auth predicate for the request gate (server.ts).
 *
 * Exempt:
 *   - `/healthz` — liveness probes can't carry a token and the response
 *     is non-sensitive (`{ok: true}`).
 *   - Every non-API path — the SPA shell (`/`), its static assets
 *     (`/assets/<hash>`), and React Router deep links must be reachable
 *     from a fresh browser. Otherwise the user can't load `Login.tsx`
 *     to enter their bearer token (chicken-and-egg, warren-d2a5).
 *
 * Auth-required:
 *   - Every API path other than `/healthz`. `/readyz` stays gated
 *     because its body reveals which checks failed (sensitive in a
 *     misconfigured deploy).
 */
export function isAuthExempt(pathname: string): boolean {
	if (pathname === "/healthz") return true;
	return !isApiPath(pathname);
}

export const API_ROUTE_PATTERNS: readonly { method: Route["method"]; pattern: string }[] =
	ROUTE_TABLE.map((e) => ({ method: e.method, pattern: e.pattern }));
