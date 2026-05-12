/**
 * Built-in agent definitions shipped with warren.
 *
 * Warren seeds these into the agents registry on every server boot so a
 * fresh install can dispatch a run without `CANOPY_REPO_URL` being set.
 * Library agents loaded from a configured canopy repo are additive: a
 * same-named library agent overrides the built-in via `agents.upsert`.
 *
 * Provenance is encoded in `frontmatter.source = "builtin"` on each
 * built-in's rendered JSON. The HTTP layer reads that field to surface
 * `source: "builtin" | "library"` on `GET /agents` responses.
 */

import type { AgentsRepo } from "../../db/repos/agents.ts";
import type { AgentDefinition } from "../schema.ts";
import { CLAUDE_CODE_BUILTIN } from "./claude-code.ts";
import { PI_BUILTIN } from "./pi.ts";
import { SAPLING_BUILTIN } from "./sapling.ts";

export const BUILTIN_AGENT_SOURCE = "builtin" as const;
export const LIBRARY_AGENT_SOURCE = "library" as const;
export type AgentSource = typeof BUILTIN_AGENT_SOURCE | typeof LIBRARY_AGENT_SOURCE;

export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
	CLAUDE_CODE_BUILTIN,
	SAPLING_BUILTIN,
	PI_BUILTIN,
];

export const BUILTIN_AGENT_NAMES: ReadonlySet<string> = new Set(BUILTIN_AGENTS.map((a) => a.name));

export interface SeedBuiltinAgentsResult {
	readonly seeded: readonly string[];
	readonly skipped: readonly string[];
}

/**
 * Insert each built-in into the agents table only if a row with the
 * same name does not already exist. Pre-existing rows (whether seeded
 * by an earlier boot or upserted by a refresh of a same-named library
 * agent) are preserved.
 */
export function seedBuiltinAgents(
	repo: AgentsRepo,
	builtins: readonly AgentDefinition[] = BUILTIN_AGENTS,
	now?: () => Date,
): SeedBuiltinAgentsResult {
	const seeded: string[] = [];
	const skipped: string[] = [];
	for (const builtin of builtins) {
		if (repo.get(builtin.name) !== null) {
			skipped.push(builtin.name);
			continue;
		}
		repo.upsert({
			name: builtin.name,
			renderedJson: builtin,
			...(now !== undefined ? { now: now() } : {}),
		});
		seeded.push(builtin.name);
	}
	return { seeded, skipped };
}

/**
 * Read the `source` provenance from a row's renderedJson. Built-in seeds
 * carry `frontmatter.source = "builtin"`; library refreshes don't set
 * the field (canopy doesn't emit it), so anything else falls back to
 * "library". This is the source of truth for the `source` field on
 * `GET /agents` responses.
 */
export function readAgentSource(renderedJson: unknown): AgentSource {
	if (typeof renderedJson === "object" && renderedJson !== null) {
		const fm = (renderedJson as { frontmatter?: unknown }).frontmatter;
		if (typeof fm === "object" && fm !== null) {
			const source = (fm as { source?: unknown }).source;
			if (source === BUILTIN_AGENT_SOURCE) return BUILTIN_AGENT_SOURCE;
		}
	}
	return LIBRARY_AGENT_SOURCE;
}

export { CLAUDE_CODE_BUILTIN, PI_BUILTIN, SAPLING_BUILTIN };
