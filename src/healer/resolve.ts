/**
 * Alert→project routing for the healer (warren-3db0, Phase 2).
 *
 * Two strategies, tried in order (per the design review decision —
 * "static mapping WITH payload fallback"):
 *
 *   1. Static mapping — a healer-enabled project's
 *      `healer.projectMapping` lists routing keys. A key matches when it
 *      equals the alert fingerprint, or is a case-insensitive substring
 *      of the culprit / title. The first enabled project with a hit wins.
 *   2. Payload fallback — the alert's inferred `owner/repo` is matched
 *      against each enabled project's git URL. Used only when no mapping
 *      key matched, so an explicit mapping always takes precedence.
 *
 * Only projects whose resolved `healer.enabled` is true are candidates;
 * a matching but disabled project is reported as `not_enabled` so the
 * handler can return a meaningful skip reason instead of a bare 404.
 */

import type { HealAlert } from "./alert.ts";
import { inferRepoSlug } from "./alert.ts";
import type { HealerSettings } from "./dispatch.ts";

export interface HealProjectCandidate {
	readonly projectId: string;
	readonly gitUrl: string;
	readonly localPath: string;
	/** Resolved healer settings, or undefined when the project has no block. */
	readonly settings: HealerSettings | undefined;
	/** Healer agent name to dispatch (`healer.role`); default when unset. */
	readonly role: string;
	readonly projectMapping: readonly string[];
}

export type HealResolveResult =
	| { readonly kind: "matched"; readonly candidate: HealProjectCandidate }
	| { readonly kind: "no_match" }
	| { readonly kind: "not_enabled" };

function mappingMatches(alert: HealAlert, mapping: readonly string[]): boolean {
	if (mapping.length === 0) return false;
	const haystacks = [alert.culprit ?? "", alert.title].map((s) => s.toLowerCase());
	for (const key of mapping) {
		if (key === alert.fingerprint) return true;
		const lower = key.toLowerCase();
		if (haystacks.some((h) => h.includes(lower))) return true;
	}
	return false;
}

function repoMatches(alert: HealAlert, gitUrl: string): boolean {
	if (alert.repo === null) return false;
	const projectSlug = inferRepoSlug(gitUrl);
	return projectSlug !== null && projectSlug.toLowerCase() === alert.repo.toLowerCase();
}

export function resolveHealProject(
	alert: HealAlert,
	candidates: readonly HealProjectCandidate[],
): HealResolveResult {
	const enabled = candidates.filter((c) => c.settings?.enabled === true);

	const byMapping = enabled.find((c) => mappingMatches(alert, c.projectMapping));
	if (byMapping !== undefined) return { kind: "matched", candidate: byMapping };

	const byRepo = enabled.find((c) => repoMatches(alert, c.gitUrl));
	if (byRepo !== undefined) return { kind: "matched", candidate: byRepo };

	// Distinguish "a project would have matched but isn't opted in" from
	// "nothing matched at all" so the handler's skip reason is precise.
	const disabledHit = candidates.some(
		(c) =>
			c.settings?.enabled !== true &&
			(mappingMatches(alert, c.projectMapping) || repoMatches(alert, c.gitUrl)),
	);
	return disabledHit ? { kind: "not_enabled" } : { kind: "no_match" };
}
