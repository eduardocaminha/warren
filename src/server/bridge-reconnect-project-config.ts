/**
 * Project-config resolvers for the bridge's terminal-detect reap path
 * (extracted from `./bridge-reconnect.ts` to keep it under the file-size
 * ratchet, warren-4553). Both run when `runWithReconnect` observes a
 * runtime-terminal event and is about to reap: they load the project's
 * `.warren/` preview block (R-19) and PR-template overrides (warren-bd49)
 * so reap can launch a preview / shape the PR body. Errors from the
 * per-project loader fall through to `undefined` so reap uses defaults;
 * operators see the underlying error via `/projects/:id/warren-config`.
 */

import type { Repos } from "../db/repos/index.ts";
import type { PreviewPortAllocator } from "../preview/port-allocator.ts";
import type { BridgeLogger } from "../runs/index.ts";
import type { PrTemplateOverrides } from "../runs/pr-template.ts";
import type { ServerPreviewConfig, WarrenConfigCache } from "../warren-config/index.ts";

/**
 * Narrow slice of `RunWithReconnectInput` these resolvers actually read.
 * Declared here (not imported from `bridge-reconnect.ts`) so the
 * extraction introduces no circular import; `RunWithReconnectInput` is
 * structurally assignable to it.
 */
export interface ProjectConfigInput {
	readonly runId: string;
	readonly repos: Repos;
	readonly warrenConfigs?: WarrenConfigCache;
	readonly portAllocator?: PreviewPortAllocator;
	readonly logger?: BridgeLogger;
}

/**
 * Resolve the project's `.warren/defaults.json` preview block (R-19) for
 * the run the bridge just observed reach terminal. Returns `undefined`
 * when the project hasn't opted in or when the warren-config seam isn't
 * wired (tests that omit `warrenConfigs`/`portAllocator`). The launcher
 * gate inside reap is what skips the actual preview spawn when this
 * function returns `undefined`.
 *
 * Errors from the per-project loader (`malformed defaults.json`, etc.)
 * surface as a `null` defaults block, so this function returns
 * `undefined` and the preview just skips. Operators see the underlying
 * error via the `/projects/:id/warren-config` route.
 */
export async function resolveProjectPreviewConfig(
	input: ProjectConfigInput,
): Promise<ServerPreviewConfig | undefined> {
	if (input.warrenConfigs === undefined || input.portAllocator === undefined) return undefined;
	const run = await input.repos.runs.get(input.runId);
	if (run === null || run.projectId === null) return undefined;
	const project = await input.repos.projects.get(run.projectId);
	if (project === null) return undefined;
	try {
		const config = await input.warrenConfigs.get(project.id, project.localPath);
		const preview = config.defaults?.preview;
		if (preview === undefined) return undefined;
		// `type: 'static'` is filed as a follow-up (per SPEC §11.L); reap
		// would reject at launch time anyway. Skip cleanly here so the
		// PR-body placeholder doesn't promise a preview that can't run.
		if (preview.type !== "server") return undefined;
		return preview;
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview config load failed; skipping preview launch",
		);
		return undefined;
	}
}

/**
 * Resolve the project's `.warren/pr-template.md` fragment overrides
 * (warren-bd49) for the run the bridge just observed reach terminal.
 * Returns `undefined` when the project ships no template, when the
 * warren-config seam isn't wired (tests), or when the parsed envelope
 * has no overrides. Errors from the per-project loader surface as
 * a `null` prTemplate in the envelope, so this just falls through to
 * `undefined` and reap uses the built-in defaults. Operators see the
 * underlying error via `/projects/:id/warren-config`.
 */
export async function resolveProjectPrTemplate(
	input: ProjectConfigInput,
): Promise<PrTemplateOverrides | undefined> {
	if (input.warrenConfigs === undefined) return undefined;
	const run = await input.repos.runs.get(input.runId);
	if (run === null || run.projectId === null) return undefined;
	const project = await input.repos.projects.get(run.projectId);
	if (project === null) return undefined;
	try {
		const config = await input.warrenConfigs.get(project.id, project.localPath);
		const overrides = config.prTemplate;
		if (overrides === null || overrides === undefined) return undefined;
		if (Object.keys(overrides).length === 0) return undefined;
		return overrides;
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"pr-template load failed; falling back to built-in defaults",
		);
		return undefined;
	}
}
