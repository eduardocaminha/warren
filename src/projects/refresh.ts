/**
 * Refresh a project clone — fetch from origin and hard-reset to a ref.
 *
 * Project clones are working trees agents will run against, but the row
 * is registered once and re-used for every run (operators don't want a
 * new project per PR). Without this module, /data/projects/<id>/ stays
 * frozen at registration-time forever and every run sees stale code
 * (warren-1bb6).
 *
 * The semantics mirror src/registry/clone.ts's "fast-forward to remote"
 * contract: `git fetch --prune origin`, then `git checkout <ref>` (so
 * branch HEAD moves with the working tree), then `git reset --hard
 * origin/<ref>`. Any local mutations from a previous run get thrown
 * away — warren never preserves agent-side state across runs; that's
 * burrow's job.
 *
 * The default ref is the project's tracked default branch
 * (`projects.default_branch`). Callers can pass a branch name, tag, or
 * SHA via `ref` to point a run at something specific.
 *
 * Returns the post-reset HEAD sha so the caller can stamp it onto the
 * row alongside the fetch timestamp. Spawn + filesystem are injected so
 * tests don't shell out to git or touch disk.
 */

import { existsSync } from "node:fs";
import type { SpawnFn, SpawnOptions, SpawnResult } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export interface RefreshProjectCloneInput {
	readonly config: ProjectsConfig;
	readonly localPath: string;
	/** Branch, tag, or SHA. Defaults to the project's tracked default branch. */
	readonly ref: string;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
	readonly exists?: (path: string) => boolean;
}

export interface RefreshProjectCloneResult {
	readonly headSha: string;
	/** Echo of the resolved ref the caller asked for. */
	readonly ref: string;
}

export async function refreshProjectClone(
	input: RefreshProjectCloneInput,
): Promise<RefreshProjectCloneResult> {
	const { config, localPath, ref, spawn } = input;
	const timeoutMs = input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const exists = input.exists ?? existsSync;

	if (!exists(localPath)) {
		// A registered project whose on-disk clone vanished is a data-integrity
		// issue, not something a refresh should silently re-clone. Surface a
		// clear error and let the operator delete + re-add.
		throw new ProjectUnavailableError(`project clone missing on disk: ${localPath}`, {
			recoveryHint: "DELETE /projects/:id and POST /projects to re-clone",
		});
	}

	await runGit(spawn, [config.gitBinary, "fetch", "--prune", "origin"], {
		cwd: localPath,
		timeoutMs,
	});

	// `git checkout <ref>` moves HEAD onto the named ref (creating a
	// tracking branch when ref is a remote branch name). Without this,
	// `reset --hard origin/<ref>` would only move whatever branch we
	// happened to already be on — which on a fresh clone is the default
	// branch, but on a prior run might be something else entirely.
	await runGit(spawn, [config.gitBinary, "checkout", "--force", ref], {
		cwd: localPath,
		timeoutMs,
	});

	// Hard-reset to origin/<ref> so any uncommitted detritus from a
	// prior run is wiped and the working tree matches what's on the
	// remote. If `ref` is a SHA or tag, `origin/<ref>` won't resolve;
	// fall back to a plain `reset --hard <ref>` in that case.
	const resetToRemote = await trySpawn(
		spawn,
		[config.gitBinary, "reset", "--hard", `origin/${ref}`],
		{ cwd: localPath, timeoutMs },
	);
	if (resetToRemote.exitCode !== 0) {
		await runGit(spawn, [config.gitBinary, "reset", "--hard", ref], {
			cwd: localPath,
			timeoutMs,
		});
	}

	const headSha = await readHead(spawn, config.gitBinary, localPath, timeoutMs);
	return { headSha, ref };
}

async function readHead(
	spawn: SpawnFn,
	gitBinary: string,
	cwd: string,
	timeoutMs: number,
): Promise<string> {
	const result = await runGit(spawn, [gitBinary, "rev-parse", "HEAD"], { cwd, timeoutMs });
	const sha = result.stdout.trim();
	if (sha.length === 0) {
		throw new ProjectUnavailableError("git rev-parse HEAD returned empty output");
	}
	return sha;
}

async function runGit(
	spawn: SpawnFn,
	cmd: readonly string[],
	opts: SpawnOptions & { timeoutMs: number },
): Promise<SpawnResult> {
	const result = await trySpawn(spawn, cmd, opts);
	if (result.exitCode !== 0) {
		throw new ProjectUnavailableError(
			`${cmd.join(" ")} exited ${result.exitCode}: ${formatStderr(result)}`,
		);
	}
	return result;
}

async function trySpawn(
	spawn: SpawnFn,
	cmd: readonly string[],
	opts: SpawnOptions,
): Promise<SpawnResult> {
	try {
		return await spawn(cmd, opts);
	} catch (err) {
		throw new ProjectUnavailableError(
			`failed to spawn ${cmd.join(" ")}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
}

function formatStderr(result: SpawnResult): string {
	const trimmed = result.stderr.trim();
	if (trimmed !== "") return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
	return "<no stderr>";
}
