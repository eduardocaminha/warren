/**
 * Convenience surface that wires every repo against a single drizzle handle.
 * Higher layers grab one Repos and pass it through.
 */

import type { WarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";
import { BurrowsRepo } from "./burrows.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { EventsRepo } from "./events.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";
import { TriggersRepo } from "./triggers.ts";
import { WorkersRepo } from "./workers.ts";

export interface Repos {
	agents: AgentsRepo;
	projects: ProjectsRepo;
	runs: RunsRepo;
	events: EventsRepo;
	triggers: TriggersRepo;
	workers: WorkersRepo;
	burrows: BurrowsRepo;
}

export function createRepos(db: WarrenDb): Repos {
	// pl-f1be migration: AgentsRepo + BurrowsRepo + ProjectsRepo + EventsRepo
	// (steps 2-3) take the dialect-polymorphic adapter; RunsRepo / TriggersRepo /
	// WorkersRepo still take the raw sqlite drizzle handle and will migrate in
	// steps 4-5. Step 7 widens this factory to AnyWarrenDb once every repo is
	// on the adapter.
	const adapter = DrizzleAdapter.for(db);
	return {
		agents: new AgentsRepo(adapter),
		projects: new ProjectsRepo(adapter),
		runs: new RunsRepo(db.drizzle),
		events: new EventsRepo(adapter),
		triggers: new TriggersRepo(db.drizzle),
		workers: new WorkersRepo(db.drizzle),
		burrows: new BurrowsRepo(adapter),
	};
}

export { AgentsRepo, BurrowsRepo, EventsRepo, ProjectsRepo, RunsRepo, TriggersRepo, WorkersRepo };
