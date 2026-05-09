/**
 * Install a `git insteadOf` rewrite that injects `GITHUB_TOKEN` into HTTPS
 * fetches/pushes against github.com (warren-dcf3).
 *
 * The container has no credential helper configured; without this rule
 * `git push` from the reap step (and `git clone` / `git fetch` from project
 * management) prompts for a password and fails non-interactively. The
 * supervisor runs this once at boot — before spawning burrow + warren — so
 * the rewrite is in place by the time any child process shells out to git.
 *
 * `git config --global` writes `$HOME/.gitconfig`. Inside the container
 * `HOME=/root`, so the rule lives at `/root/.gitconfig`. Idempotent:
 * re-invoking on container restart overwrites the existing value.
 *
 * No-op when `GITHUB_TOKEN` is unset — only agents that hit github.com over
 * HTTPS need it, so a token-less env (e.g. a doctor smoke test, an agent
 * that never touches GitHub) shouldn't refuse to boot.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SupervisorLogger } from "./main.ts";

const execFileAsync = promisify(execFile);

export type GitCredentialsRun = (
	cmd: string,
	args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface GitCredentialsDeps {
	readonly run: GitCredentialsRun;
	readonly logger: SupervisorLogger;
}

export interface GitCredentialsOpts {
	readonly githubToken: string | undefined;
	/** Override the git binary on PATH. Default: "git". */
	readonly gitBinary?: string;
}

export interface GitCredentialsResult {
	readonly installed: boolean;
}

/**
 * Resolves to `{installed: true}` when the rule was written. Throws if git
 * config exits non-zero — the supervisor surfaces that as a startup failure
 * rather than silently booting without a working credential rewrite.
 */
export async function installGitCredentials(
	deps: GitCredentialsDeps,
	opts: GitCredentialsOpts,
): Promise<GitCredentialsResult> {
	const token = opts.githubToken;
	if (token === undefined || token === "") {
		deps.logger.info(
			{},
			"supervisor: GITHUB_TOKEN unset, skipping git insteadOf install (github.com over https will require a credential helper)",
		);
		return { installed: false };
	}

	const git = opts.gitBinary ?? "git";
	const rewriteUrl = `https://x-access-token:${token}@github.com/`;
	const result = await deps.run(git, [
		"config",
		"--global",
		`url.${rewriteUrl}.insteadOf`,
		"https://github.com/",
	]);
	if (result.exitCode !== 0) {
		throw new Error(
			`git config --global failed (exit ${result.exitCode}): ${result.stderr.trim() || "no stderr"}`,
		);
	}
	deps.logger.info(
		{},
		"supervisor: installed git insteadOf rule for github.com (using GITHUB_TOKEN)",
	);
	return { installed: true };
}

export const defaultGitCredentialsRun: GitCredentialsRun = async (cmd, args) => {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, [...args]);
		return { exitCode: 0, stdout, stderr };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		const exitCode = typeof e.code === "number" ? e.code : 1;
		return {
			exitCode,
			stdout: typeof e.stdout === "string" ? e.stdout : "",
			stderr: typeof e.stderr === "string" ? e.stderr : (e.message ?? ""),
		};
	}
};
