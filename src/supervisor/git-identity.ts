/**
 * Install per-deployment git identity for agent commits (warren-fe67).
 *
 * When `WARREN_GIT_AUTHOR_NAME` + `WARREN_GIT_AUTHOR_EMAIL` are both set,
 * the supervisor:
 *
 *   1. writes a `[user]` block into `$HOME/.gitconfig` via
 *      `git config --global user.name/user.email`, and
 *   2. exports `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` /
 *      `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` into the supervisor's
 *      process env so burrow + warren (and, via burrow's env passthrough,
 *      the agent inside the sandbox) inherit them.
 *
 * Burrow's default identity mode is `user`, which mirrors
 * `git config --get user.name/email` into `<workspace>/.gitconfig.burrow`
 * and the agent runtime sets `GIT_CONFIG_GLOBAL` to that path. Writing the
 * supervisor's gitconfig is therefore enough for agent-side `git commit`
 * to use the configured identity without any burrow-side change. The env
 * vars cover the committer half (gitconfig has no `[committer]` section)
 * and survive runtimes that ignore `GIT_CONFIG_GLOBAL` and read env first.
 *
 * No-op when either env var is unset or empty — falls back to today's
 * behavior (host git identity if available, otherwise unconfigured).
 *
 * Operator UX (.env.example): set
 *   WARREN_GIT_AUTHOR_NAME=Warren
 *   WARREN_GIT_AUTHOR_EMAIL=<id>+warren@users.noreply.github.com
 * The github.com noreply pattern links commits to the operator's account
 * so the contribution graph reflects agent-driven work.
 */

import { defaultGitRun, type GitRun } from "./git-runner.ts";
import type { SupervisorLogger } from "./main.ts";

export type GitIdentityRun = GitRun;

export interface GitIdentityDeps {
	readonly run: GitIdentityRun;
	readonly logger: SupervisorLogger;
	/**
	 * Env target to mutate. Defaults to `process.env`. Injectable so tests
	 * don't pollute the real process env.
	 */
	readonly env?: Record<string, string | undefined>;
}

export interface GitIdentityOpts {
	readonly authorName: string | undefined;
	readonly authorEmail: string | undefined;
	/** Override the git binary on PATH. Default: "git". */
	readonly gitBinary?: string;
}

export interface GitIdentityResult {
	readonly installed: boolean;
}

/**
 * Resolves to `{installed: true}` when the rule was written. Throws if
 * `git config` exits non-zero — the supervisor surfaces that as a startup
 * failure rather than silently booting without the configured identity.
 */
export async function installGitAuthor(
	deps: GitIdentityDeps,
	opts: GitIdentityOpts,
): Promise<GitIdentityResult> {
	const name = (opts.authorName ?? "").trim();
	const email = (opts.authorEmail ?? "").trim();
	if (name === "" || email === "") {
		deps.logger.info(
			{},
			"supervisor: WARREN_GIT_AUTHOR_NAME/EMAIL unset, agent commits will use host git identity (or be unconfigured)",
		);
		return { installed: false };
	}

	const git = opts.gitBinary ?? "git";
	const nameResult = await deps.run(git, ["config", "--global", "user.name", name]);
	if (nameResult.exitCode !== 0) {
		throw new Error(
			`git config --global user.name failed (exit ${nameResult.exitCode}): ${nameResult.stderr.trim() || "no stderr"}`,
		);
	}
	const emailResult = await deps.run(git, ["config", "--global", "user.email", email]);
	if (emailResult.exitCode !== 0) {
		throw new Error(
			`git config --global user.email failed (exit ${emailResult.exitCode}): ${emailResult.stderr.trim() || "no stderr"}`,
		);
	}

	const env = deps.env ?? process.env;
	env.GIT_AUTHOR_NAME = name;
	env.GIT_AUTHOR_EMAIL = email;
	env.GIT_COMMITTER_NAME = name;
	env.GIT_COMMITTER_EMAIL = email;

	deps.logger.info(
		{ name, email },
		"supervisor: installed git identity for agent commits (user.name/user.email + GIT_AUTHOR/COMMITTER env)",
	);
	return { installed: true };
}

export const defaultGitIdentityRun: GitIdentityRun = defaultGitRun;
