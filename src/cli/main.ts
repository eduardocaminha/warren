#!/usr/bin/env bun
/**
 * `warren` / `wr` CLI entry (SPEC §8.2).
 *
 * Five subcommands, all dispatching into pure functions in `./commands/`.
 * The dispatch is intentionally thin: commander handles argv parsing and
 * help text, then each command function takes a `CliContext` (env +
 * stdio + spawn) plus parsed args and returns an `exitCode`. That shape
 * keeps the per-command logic unit-testable without spinning up a real
 * subprocess.
 */

import { Command } from "commander";
import { BurrowClient } from "../burrow-client/client.ts";
import { VERSION } from "../index.ts";
import { loadProjectsConfigFromEnv } from "../projects/config.ts";
import { seedBuiltinAgents } from "../registry/builtins/index.ts";
import { requireCanopyRegistryConfigFromEnv } from "../registry/config.ts";
import { runAddProject } from "./commands/add-project.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runRegisterAgent } from "./commands/register-agent.ts";
import { runRun } from "./commands/run.ts";
import { runServe } from "./commands/serve.ts";
import { withCliDb } from "./context.ts";
import { type CliContext, defaultSpawn, formatError, PROCESS_STDIO } from "./output.ts";

export function buildProgram(context: CliContext): Command {
	const program = new Command();
	program
		.name("warren")
		.description("Control plane and UI for cloud-based custom agents")
		.version(VERSION)
		.exitOverride((err) => {
			// Let commander handle --help / --version exits, but never let it
			// kill the process from inside a test harness. Re-throwing here
			// surfaces the error to the caller.
			throw err;
		});

	program
		.command("register-agent")
		.description("refresh canopy and register one agent into warren's cache")
		.argument("<name>", "canopy prompt name (must be tagged 'agent')")
		.action(async (name: string) => {
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				// register-agent only makes sense against a configured library —
				// built-ins are seeded automatically and can't be 'registered'
				// from canopy. requireCanopyRegistryConfigFromEnv throws a
				// ValidationError with a friendly hint when CANOPY_REPO_URL is
				// unset; main's catch surfaces it.
				const canopyConfig = requireCanopyRegistryConfigFromEnv(context.env);
				const result = await runRegisterAgent(
					context,
					{ agents: repos.agents, canopyConfig },
					{ name },
				);
				return result.exitCode;
			});
			process.exit(exitCode);
		});

	program
		.command("add-project")
		.description("clone a GitHub repo into the projects root and persist it")
		.argument("<git-url>", "GitHub URL (https or git@)")
		.option("--default-branch <name>", "override the auto-detected default branch")
		.action(async (gitUrl: string, opts: { defaultBranch?: string }) => {
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				const projectsConfig = loadProjectsConfigFromEnv(context.env);
				const result = await runAddProject(
					context,
					{ projects: repos.projects, projectsConfig },
					{
						gitUrl,
						...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
					},
				);
				return result.exitCode;
			});
			process.exit(exitCode);
		});

	program
		.command("run")
		.description("spawn a one-shot run, tail events as NDJSON, and exit")
		.argument("<agent>", "registered agent name")
		.argument("<project>", "project id (prj_xxx)")
		.requiredOption("-p, --prompt <text>", "prompt text the agent receives")
		.option("--trigger <label>", "run trigger label", "cli")
		.action(async (agent: string, project: string, opts: { prompt: string; trigger?: string }) => {
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				// Seed built-ins so `warren run claude-code <prj> -p ...` works
				// against a fresh DB without first registering the agent from
				// a canopy library (warren-d3e9). Idempotent against existing
				// rows.
				seedBuiltinAgents(repos.agents, undefined, context.now);
				const burrowClient = BurrowClient.fromEnv(context.env);
				try {
					const result = await runRun(
						context,
						{ repos, burrowClient },
						{
							agent,
							project,
							prompt: opts.prompt,
							...(opts.trigger !== undefined ? { trigger: opts.trigger } : {}),
						},
					);
					return result.exitCode;
				} finally {
					await burrowClient.close().catch(() => undefined);
				}
			});
			process.exit(exitCode);
		});

	program
		.command("doctor")
		.description("check warren's environment: env vars, burrow socket, canopy clone")
		.option("--no-auth", "skip the WARREN_API_TOKEN check (loopback dev mode)")
		.action(async (opts: { auth?: boolean }) => {
			// commander turns `--no-auth` into `opts.auth === false`.
			const result = await runDoctor(context, {}, { noAuth: opts.auth === false });
			process.exit(result.exitCode);
		});

	program
		.command("serve")
		.description("start the HTTP server (default in docker entrypoint)")
		.option("--no-auth", "boot without bearer-token auth (loopback only)")
		.action(async (opts: { auth?: boolean }) => {
			const result = await runServe(context, {}, { noAuth: opts.auth === false });
			process.exit(result.exitCode);
		});

	return program;
}

if (import.meta.main) {
	const context: CliContext = {
		env: process.env,
		stdio: PROCESS_STDIO,
		spawn: defaultSpawn,
	};
	const program = buildProgram(context);
	program.parseAsync(process.argv).catch((err) => {
		// Commander throws for unknown commands / missing required args;
		// it has already printed a usage hint to stderr.
		const code = (err as { exitCode?: unknown }).exitCode;
		if (typeof code === "number") {
			process.exit(code);
		}
		process.stderr.write(`warren: ${formatError(err)}\n`);
		process.exit(1);
	});
}
