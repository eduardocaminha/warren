/**
 * Shared dispatch-time project refresh (warren-6d60).
 *
 * Both `POST /plan-runs` and `POST /plot-plan-runs` read seeds/plan state
 * off the project's host clone before they dispatch. Without an
 * intrinsic refresh a plan submitted + pushed moments earlier is walked
 * against stale on-disk state and the operator has to manually refresh
 * the project first. The single-run path already refreshes inside
 * `spawnRun` (warren-1bb6); this helper gives the plan-run handlers the
 * same posture from one place.
 *
 * Gated on the git `spawn` seam being wired: production wires
 * `defaultSpawn`, so the refresh fires; tests leave `spawn` unset and
 * read off their stubbed seeds CLI without a real fetch. Refresh failure
 * propagates so the caller aborts before creating any `plan_runs` row —
 * a stale walk is worse than a clean error (mirrors `spawnRun`).
 *
 * Returns the post-refresh project row (its `localPath` is unchanged but
 * `hasPlot`/`hasSeeds`/`headSha` may move) so callers read subsequent
 * on-disk state through it; returns the input row untouched when the
 * seam is unwired.
 */

import type { ProjectRow } from "../../db/schema.ts";
import { refreshProject } from "../../projects/index.ts";
import type { ServerDeps } from "../types.ts";

export async function refreshDispatchProject(
	deps: ServerDeps,
	project: ProjectRow,
	ref: string | undefined,
): Promise<ProjectRow> {
	if (deps.spawn === undefined) return project;
	const refreshed = await (deps.refreshProjectFn ?? refreshProject)({
		repo: deps.repos.projects,
		config: deps.projectsConfig,
		id: project.id,
		spawn: deps.spawn,
		...(ref !== undefined ? { ref } : {}),
		...(deps.now !== undefined ? { now: deps.now } : {}),
		...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
	});
	return refreshed.project;
}
