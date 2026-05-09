/**
 * `spawnRun` — the §4.3 composition flow.
 *
 * One call drives the four-step ritual that turns "the operator picked
 * an agent + project + prompt" into "burrow has a queued run":
 *
 *   1. Resolve the cached agent definition (registry refresh seeded it
 *      via `cn render`). The rendered envelope is what gets frozen onto
 *      `runs.rendered_agent_json` — re-rendering at run time is
 *      deliberately not done here. Operators trigger a fresh render via
 *      `POST /agents/refresh` if they want one.
 *
 *   2. Provision a burrow via `POST /burrows`, deriving the request body
 *      from the project clone (`projectRoot`, `originUrl`) and the
 *      agent's `burrow_config` (`network`).
 *
 *   3. Seed `.canopy/`, `.mulch/expertise/<domain>.jsonl`, and
 *      `.seeds/` inside the burrow workspace (see `./seed.ts`).
 *
 *   4. Dispatch via `POST /burrows/:id/runs`.
 *
 * The warren run row is created BEFORE any burrow call, with both
 * burrow IDs nulled — `attachBurrow` writes them back as each call
 * succeeds. That lets us carry the warren `run_xxx` id through the
 * flow (so log lines, error messages, and event payloads can reference
 * it) without a chicken-and-egg between the two systems' IDs.
 *
 * Failure handling:
 *   - Anything before step 2 (agent/project lookup, agent JSON
 *     re-validation) just throws — no warren row was created.
 *   - Failures from step 2 onward are caught: the warren row is
 *     transitioned `queued → cancelled` (allowed by the runs state
 *     machine), and if a burrow was provisioned we best-effort destroy
 *     it so it doesn't sit as a stranded sandbox. The original error
 *     is rethrown so the caller (HTTP route, CLI) can surface it.
 *
 * Burrow client + seedWorkspace + clock are all injectable; default
 * paths use the live HTTP client and the disk filesystem.
 */

import type { Burrow, Run as BurrowRun, NetworkPolicy } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../burrow-client/client.ts";
import { withTransportMapping } from "../burrow-client/client.ts";
import { ValidationError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import type { SpawnFn as ProjectSpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { refreshProject } from "../projects/manage.ts";
import {
	type AgentDefinition,
	parseRenderedAgent,
	RenderResponseSchema,
} from "../registry/schema.ts";
import { parseBurrowConfig } from "./burrow_config.ts";
import { RunSpawnError } from "./errors.ts";
import { type SeedBurrowWorkspaceInput, seedBurrowWorkspace } from "./seed.ts";

export interface SpawnRunInput {
	readonly repos: Repos;
	readonly burrowClient: BurrowClient;
	readonly agentName: string;
	readonly projectId: string;
	readonly prompt: string;
	readonly trigger?: string;
	readonly metadata?: unknown;
	/** Override the workspace seeder; defaults to `seedBurrowWorkspace`. */
	readonly seedWorkspace?: (input: SeedBurrowWorkspaceInput) => Promise<unknown>;
	readonly now?: () => Date;
	/**
	 * Refresh the project's on-disk clone before provisioning burrow.
	 * Without this, every run reuses the registration-time commit
	 * forever (warren-1bb6). Required for spawnRun to pick up new
	 * commits without DELETE + POST /projects.
	 *
	 * Skipped if `projectsConfig` and `projectSpawn` aren't both wired.
	 * Tests that don't care about refresh can leave them off; the HTTP
	 * server passes both.
	 */
	readonly projectsConfig?: ProjectsConfig;
	readonly projectSpawn?: ProjectSpawnFn;
	/** Branch, tag, or SHA to refresh to. Defaults to the project's tracked default branch. */
	readonly ref?: string;
	/** Override the project refresher; defaults to `refreshProject`. */
	readonly refreshProjectFn?: typeof refreshProject;
}

export interface SpawnRunResult {
	readonly run: RunRow;
	readonly burrow: Burrow;
	readonly burrowRun: BurrowRun;
	readonly agent: AgentDefinition;
}

export async function spawnRun(input: SpawnRunInput): Promise<SpawnRunResult> {
	if (input.prompt.trim() === "") {
		throw new ValidationError("prompt cannot be empty");
	}

	const agentRow = input.repos.agents.require(input.agentName);
	const project = input.repos.projects.require(input.projectId);
	const agent = readCachedAgent(agentRow.renderedJson, agentRow.name);
	const burrowConfig = parseBurrowConfig(agent.sections.burrow_config);

	// Refresh the project clone to origin/<ref> so the run sees the
	// latest commits. Skipped only when the caller didn't wire the
	// projects-config + spawn seam (tests that pre-stage their own
	// fixtures). Refresh failure aborts the spawn before we create a
	// warren row — a stale workspace is worse than a clean error
	// (warren-1bb6).
	const refreshed =
		input.projectsConfig !== undefined && input.projectSpawn !== undefined
			? await (input.refreshProjectFn ?? refreshProject)({
					repo: input.repos.projects,
					config: input.projectsConfig,
					id: project.id,
					...(input.ref !== undefined ? { ref: input.ref } : {}),
					spawn: input.projectSpawn,
					...(input.now !== undefined ? { now: input.now } : {}),
				})
			: null;
	const projectAfterRefresh = refreshed?.project ?? project;

	const run = input.repos.runs.create({
		agentName: agent.name,
		projectId: projectAfterRefresh.id,
		prompt: input.prompt,
		renderedAgentJson: agent,
		trigger: input.trigger ?? "manual",
		now: input.now?.(),
	});

	let burrow: Burrow | null = null;
	try {
		burrow = await provisionBurrow(
			input.burrowClient,
			projectAfterRefresh.localPath,
			projectAfterRefresh.gitUrl,
			burrowConfig.network,
			agent.name,
		);
		input.repos.runs.attachBurrow(run.id, { burrowId: burrow.id });

		const seedFn = input.seedWorkspace ?? seedBurrowWorkspace;
		try {
			await seedFn({ workspacePath: burrow.workspacePath, agent });
		} catch (err) {
			throw err instanceof RunSpawnError
				? err
				: new RunSpawnError(`failed to seed burrow workspace: ${formatError(err)}`, {
						cause: err,
					});
		}

		const burrowRun = await dispatchRun(
			input.burrowClient,
			burrow.id,
			agent.name,
			input.prompt,
			input.metadata,
		);
		const updated = input.repos.runs.attachBurrow(run.id, { burrowRunId: burrowRun.id });
		return { run: updated, burrow, burrowRun, agent };
	} catch (err) {
		await rollback(input, run.id, burrow);
		throw err;
	}
}

async function provisionBurrow(
	client: BurrowClient,
	projectRoot: string,
	originUrl: string,
	network: NetworkPolicy | undefined,
	agentId: string,
): Promise<Burrow> {
	// Warren's canopy agent name is the burrow runtime id by convention
	// (claude-code → claude-code). Forwarding it as a `[[agents]]` patch row
	// at up-time lets burrow mount the runtime's binary into the sandbox
	// even when the project clone has no burrow.toml — without this,
	// collectToolchainPaths returns [] and bwrap fails `execvp claude`
	// (warren-8526 / burrow-55e3).
	return withTransportMapping(client.config, () =>
		client.http.burrows.up({
			projectRoot,
			originUrl,
			agents: [agentId],
			...(network !== undefined ? { network } : {}),
		}),
	);
}

async function dispatchRun(
	client: BurrowClient,
	burrowId: string,
	agentId: string,
	prompt: string,
	metadata: unknown,
): Promise<BurrowRun> {
	return withTransportMapping(client.config, () =>
		client.http.runs.create({
			burrowId,
			agentId,
			prompt,
			...(metadata !== undefined ? { metadata } : {}),
		}),
	);
}

async function rollback(input: SpawnRunInput, runId: string, burrow: Burrow | null): Promise<void> {
	try {
		input.repos.runs.finalize(runId, "cancelled", input.now?.());
	} catch {
		// Either the row was already terminal (shouldn't happen on this path)
		// or the db handle is gone — either way, nothing to recover here.
	}
	if (burrow !== null) {
		try {
			await withTransportMapping(input.burrowClient.config, () =>
				input.burrowClient.http.burrows.destroy(burrow.id, { archive: false }),
			);
		} catch {
			// Best-effort cleanup. The operator can list stranded burrows via
			// burrow's own UI / CLI; we don't want a cleanup failure to mask
			// the original error the caller is about to see rethrown.
		}
	}
}

/**
 * Re-validate the cached row's renderedJson before use. Refresh.ts stores
 * a parsed `AgentDefinition` directly, so the column shape is normally
 * exactly that — but the column type is `unknown`, and a corrupted row
 * shouldn't crash the spawn flow with a TypeError. If the cache holds the
 * raw `cn render` envelope (older registry refresh path), fall back to
 * parsing it.
 */
function readCachedAgent(raw: unknown, name: string): AgentDefinition {
	if (typeof raw !== "object" || raw === null) {
		throw new RunSpawnError(`cached agent "${name}" has malformed renderedJson`);
	}
	const candidate = raw as Record<string, unknown>;
	if (
		typeof candidate.name === "string" &&
		typeof candidate.version === "number" &&
		typeof candidate.sections === "object" &&
		candidate.sections !== null &&
		!Array.isArray(candidate.sections)
	) {
		const sections = candidate.sections as Record<string, unknown>;
		for (const [key, value] of Object.entries(sections)) {
			if (typeof value !== "string") {
				throw new RunSpawnError(`cached agent "${name}" has non-string section "${key}"`);
			}
		}
		return {
			name: candidate.name,
			version: candidate.version,
			sections: sections as Record<string, string>,
			resolvedFrom: Array.isArray(candidate.resolvedFrom)
				? candidate.resolvedFrom.filter((s): s is string => typeof s === "string")
				: [],
			frontmatter:
				typeof candidate.frontmatter === "object" &&
				candidate.frontmatter !== null &&
				!Array.isArray(candidate.frontmatter)
					? (candidate.frontmatter as Record<string, unknown>)
					: {},
		};
	}
	if (RenderResponseSchema.safeParse(raw).success) {
		return parseRenderedAgent(raw, name);
	}
	throw new RunSpawnError(`cached agent "${name}" does not match AgentDefinition shape`);
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
