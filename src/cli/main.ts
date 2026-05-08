#!/usr/bin/env bun
/**
 * `warren` / `wr` CLI entry. Subcommands (register-agent, add-project, run,
 * doctor, serve) are registered in later phases — this file is the wiring
 * point referenced by package.json `bin`. See SPEC §8.2.
 */

import { Command } from "commander";
import { VERSION } from "../index.ts";

const program = new Command();

program
	.name("warren")
	.description("Control plane and UI for cloud-based custom agents")
	.version(VERSION);

program.parse();
