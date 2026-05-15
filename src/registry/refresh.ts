/**
 * `refreshAgentRegistry` — the operation behind `POST /agents/refresh`
 * (SPEC §8.1) and `warren register-agent` (SPEC §8.2).
 *
 * Pipeline:
 *   1. Clone or fast-forward the canopy library repo on disk.
 *   2. List prompts tagged `agent` via `cn list --tag agent --json`.
 *   3. For each, render via `cn render <name> --format json`, validate
 *      against warren's semantic schema, and upsert into the agents
 *      table.
 *   4. Optionally prune agents that are no longer in the canopy repo
 *      (off by default — operators may not want a missed `git fetch`
 *      to nuke their registry).
 *
 * Per-agent failures are *collected*, not thrown: one bad prompt
 * shouldn't block the operator from seeing the other 19 register
 * cleanly. The caller decides whether to surface skipped entries as a
 * warning (UI) or as a non-zero CLI exit (`warren register-agent`).
 *
 * Transport-level failures (canopy unreachable, `cn` binary missing)
 * abort the whole refresh — there's nothing useful to partially register
 * if the registry is unreadable.
 */

import type { AgentsRepo } from "../db/repos/agents.ts";
import type { AgentRow } from "../db/schema.ts";
import { makeProjectAgentSource, stampAgentSource } from "./builtins/index.ts";
import type { AgentSummary, CanopyClient } from "./canopy.ts";
import { type CloneOptions, type CloneResult, cloneOrUpdateCanopyRepo } from "./clone.ts";
import { AgentSchemaError, CanopyUnavailableError } from "./errors.ts";
import { type AgentDefinition, parseRenderedAgent } from "./schema.ts";

export interface RefreshSkipped {
	readonly name: string;
	readonly reason: string;
	readonly code: string;
}

export interface RefreshResult {
	readonly clone: CloneResult;
	readonly registered: AgentRow[];
	readonly skipped: RefreshSkipped[];
	readonly removed: string[];
}

export interface RefreshOptions {
	readonly client: CanopyClient;
	readonly agents: AgentsRepo;
	/** Inject the cloner; defaults to the live `cloneOrUpdateCanopyRepo`. */
	readonly clone?: (
		opts: Omit<CloneOptions, "spawn"> & { spawn: CloneOptions["spawn"] },
	) => Promise<CloneResult>;
	readonly cloneOptions: Omit<CloneOptions, "spawn"> & Pick<CloneOptions, "spawn">;
	/**
	 * If true, delete agents that exist in warren's table but are no longer
	 * in the canopy repo. Off by default — see file header.
	 */
	readonly prune?: boolean;
	readonly now?: () => Date;
}

export async function refreshAgentRegistry(opts: RefreshOptions): Promise<RefreshResult> {
	const cloneFn = opts.clone ?? cloneOrUpdateCanopyRepo;
	const clone = await cloneFn(opts.cloneOptions);

	const summaries = await opts.client.listAgents();
	const seen = new Set<string>();
	const registered: AgentRow[] = [];
	const skipped: RefreshSkipped[] = [];

	for (const summary of summaries) {
		seen.add(summary.name);
		const outcome = await registerOne(opts, summary);
		if (outcome.kind === "registered") {
			registered.push(outcome.row);
		} else {
			skipped.push(outcome.skipped);
		}
	}

	const removed: string[] = [];
	if (opts.prune === true) {
		for (const existing of await opts.agents.listAll()) {
			if (!seen.has(existing.name)) {
				await opts.agents.delete(existing.name);
				removed.push(existing.name);
			}
		}
	}

	return { clone, registered, skipped, removed };
}

type RegisterOutcome =
	| { kind: "registered"; row: AgentRow }
	| { kind: "skipped"; skipped: RefreshSkipped };

async function registerOne(opts: RefreshOptions, summary: AgentSummary): Promise<RegisterOutcome> {
	const rendered = await renderAndParse(opts.client, summary);
	if (rendered.kind === "skipped") return rendered;
	const row = await opts.agents.upsert({
		name: rendered.definition.name,
		renderedJson: rendered.definition,
		now: opts.now?.(),
	});
	return { kind: "registered", row };
}

export interface RefreshProjectOptions {
	readonly client: CanopyClient;
	readonly agents: AgentsRepo;
	/** Project whose `.canopy/` is being scanned. Stamped onto each row's source. */
	readonly projectId: string;
	readonly now?: () => Date;
}

export interface RefreshProjectResult {
	readonly projectId: string;
	readonly registered: AgentRow[];
	readonly skipped: RefreshSkipped[];
	readonly removed: string[];
}

/**
 * Project-tier counterpart to `refreshAgentRegistry`. Scans the project's
 * `.canopy/` (via a `CanopyClient.forProjectPath(...)` the caller wires up),
 * renders each agent, stamps `frontmatter.source = "project:<projectId>"`,
 * and upserts at the project scope so global rows of the same name are
 * untouched.
 *
 * Per-agent failures are collected into `skipped` rather than thrown — one
 * malformed `.canopy/` prompt must not take down the whole project refresh
 * (and step 6's all-projects loop relies on this).
 *
 * Transport-level failures (cn binary missing, `.canopy/` unreadable) abort
 * the whole refresh; the caller (`POST /agents/refresh`'s all-projects loop)
 * is responsible for catching them so one bad project doesn't poison the
 * batch.
 *
 * Pruning is always-on for the project tier: the project's `.canopy/` is
 * the authoritative source for that tier, so any project-scoped row whose
 * name disappears from the listing is removed. The library refresh defaults
 * prune=off because a missed git fetch could nuke the registry; the project
 * tier has no equivalent race.
 */
export async function refreshProjectAgents(
	opts: RefreshProjectOptions,
): Promise<RefreshProjectResult> {
	const summaries = await opts.client.listAgents();
	const seen = new Set<string>();
	const registered: AgentRow[] = [];
	const skipped: RefreshSkipped[] = [];

	for (const summary of summaries) {
		seen.add(summary.name);
		const outcome = await registerOneProject(opts, summary);
		if (outcome.kind === "registered") {
			registered.push(outcome.row);
		} else {
			skipped.push(outcome.skipped);
		}
	}

	const removed: string[] = [];
	for (const existing of await opts.agents.listForProject(opts.projectId)) {
		if (!seen.has(existing.name)) {
			await opts.agents.delete(existing.name, { projectId: opts.projectId });
			removed.push(existing.name);
		}
	}

	return { projectId: opts.projectId, registered, skipped, removed };
}

async function registerOneProject(
	opts: RefreshProjectOptions,
	summary: AgentSummary,
): Promise<RegisterOutcome> {
	const rendered = await renderAndParse(opts.client, summary);
	if (rendered.kind === "skipped") return rendered;
	const stamped = stampAgentSource(rendered.definition, makeProjectAgentSource(opts.projectId));
	const row = await opts.agents.upsert({
		name: stamped.name,
		projectId: opts.projectId,
		renderedJson: stamped,
		now: opts.now?.(),
	});
	return { kind: "registered", row };
}

type RenderedOutcome =
	| { kind: "rendered"; definition: AgentDefinition }
	| { kind: "skipped"; skipped: RefreshSkipped };

async function renderAndParse(
	client: CanopyClient,
	summary: AgentSummary,
): Promise<RenderedOutcome> {
	let raw: unknown;
	try {
		raw = await client.renderAgent(summary.name);
	} catch (err) {
		if (err instanceof CanopyUnavailableError) {
			// A render-time canopy error for one prompt (e.g. "Prompt not found"
			// after a race with `cn archive`) is per-prompt, not catastrophic.
			return {
				kind: "skipped",
				skipped: { name: summary.name, code: err.code, reason: err.message },
			};
		}
		throw err;
	}
	try {
		return { kind: "rendered", definition: parseRenderedAgent(raw, summary.name) };
	} catch (err) {
		if (err instanceof AgentSchemaError) {
			return {
				kind: "skipped",
				skipped: { name: summary.name, code: err.code, reason: err.message },
			};
		}
		throw err;
	}
}
