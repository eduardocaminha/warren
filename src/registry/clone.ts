/**
 * Clone (or update) the operator's canopy library repo into the local
 * canopy directory.
 *
 * The contract is "fast-forward to the remote default branch on every
 * call". First refresh: `git clone <repoUrl> <localDir>`. Subsequent
 * refreshes: `git fetch && git reset --hard origin/<HEAD>` to throw
 * away any local mutations and converge on the operator's source of
 * truth. Operators don't edit the warren-side clone — `cn create` /
 * `cn update` happen in their own checkout, push to GitHub, then
 * warren refreshes.
 *
 * Why hard-reset and not pull/merge: a regular `git pull` can fail with
 * conflicts if anything stray landed in the warren-side clone (a half-
 * finished `cn` write, file-mode drift, etc.). Warren's clone is a
 * cache, not a working tree. Hard-reset is the right semantics.
 *
 * Spawn is injected so tests can stub `git` without a network and
 * without touching the filesystem.
 */

import { existsSync } from "node:fs";
import { formatError } from "../core/errors.ts";
import type { SpawnFn, SpawnResult } from "./canopy.ts";
import type { CanopyRegistryConfig } from "./config.ts";
import { CanopyUnavailableError } from "./errors.ts";

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export interface CloneResult {
	/** True if the directory was newly cloned this call; false if it existed and was fast-forwarded. */
	readonly cloned: boolean;
	readonly localDir: string;
}

export interface CloneOptions {
	readonly config: CanopyRegistryConfig;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
	/** Default branch to track. Defaults to whatever `origin/HEAD` points at. */
	readonly defaultBranch?: string;
	/** Filesystem probe override for tests. */
	readonly exists?: (path: string) => boolean;
}

export async function cloneOrUpdateCanopyRepo(opts: CloneOptions): Promise<CloneResult> {
	const { config, spawn } = opts;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const exists = opts.exists ?? existsSync;

	if (!exists(config.localDir)) {
		await runGit(spawn, [config.gitBinary, "clone", config.repoUrl, config.localDir], {
			cwd: ".",
			timeoutMs,
		});
		return { cloned: true, localDir: config.localDir };
	}

	// Already on disk: fetch and hard-reset to origin's HEAD.
	await runGit(spawn, [config.gitBinary, "fetch", "--prune", "origin"], {
		cwd: config.localDir,
		timeoutMs,
	});
	const branch = opts.defaultBranch ?? (await resolveOriginHead(spawn, config, timeoutMs));
	await runGit(spawn, [config.gitBinary, "reset", "--hard", `origin/${branch}`], {
		cwd: config.localDir,
		timeoutMs,
	});
	return { cloned: false, localDir: config.localDir };
}

async function resolveOriginHead(
	spawn: SpawnFn,
	config: CanopyRegistryConfig,
	timeoutMs: number,
): Promise<string> {
	const result = await trySpawn(
		spawn,
		[config.gitBinary, "symbolic-ref", "refs/remotes/origin/HEAD"],
		{ cwd: config.localDir, timeoutMs },
	);
	if (result.exitCode === 0) {
		// e.g. "refs/remotes/origin/main"
		const ref = result.stdout.trim();
		const slash = ref.lastIndexOf("/");
		if (slash !== -1 && slash + 1 < ref.length) {
			return ref.slice(slash + 1);
		}
	}
	// Fallback: ask remote-set-head to compute it. If that also fails, give up
	// on auto-detection and surface a clear error rather than guessing "main".
	const setHead = await trySpawn(
		spawn,
		[config.gitBinary, "remote", "set-head", "origin", "--auto"],
		{
			cwd: config.localDir,
			timeoutMs,
		},
	);
	if (setHead.exitCode !== 0) {
		throw new CanopyUnavailableError(
			`could not determine origin's default branch: ${formatStderr(setHead)}`,
			{ recoveryHint: "set CANOPY_DEFAULT_BRANCH or pass defaultBranch to refresh" },
		);
	}
	const retry = await trySpawn(
		spawn,
		[config.gitBinary, "symbolic-ref", "refs/remotes/origin/HEAD"],
		{
			cwd: config.localDir,
			timeoutMs,
		},
	);
	if (retry.exitCode === 0) {
		const ref = retry.stdout.trim();
		const slash = ref.lastIndexOf("/");
		if (slash !== -1 && slash + 1 < ref.length) {
			return ref.slice(slash + 1);
		}
	}
	throw new CanopyUnavailableError("could not determine origin's default branch after set-head");
}

async function runGit(
	spawn: SpawnFn,
	cmd: readonly string[],
	opts: { cwd: string; timeoutMs: number },
): Promise<SpawnResult> {
	const result = await trySpawn(spawn, cmd, opts);
	if (result.exitCode !== 0) {
		throw new CanopyUnavailableError(
			`${cmd.join(" ")} exited ${result.exitCode}: ${formatStderr(result)}`,
		);
	}
	return result;
}

async function trySpawn(
	spawn: SpawnFn,
	cmd: readonly string[],
	opts: { cwd: string; timeoutMs: number },
): Promise<SpawnResult> {
	try {
		return await spawn(cmd, opts);
	} catch (err) {
		throw new CanopyUnavailableError(`failed to spawn ${cmd.join(" ")}: ${formatError(err)}`, {
			cause: err,
		});
	}
}

function formatStderr(result: SpawnResult): string {
	const trimmed = result.stderr.trim();
	if (trimmed !== "") return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
	return "<no stderr>";
}
