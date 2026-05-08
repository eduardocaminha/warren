/**
 * High-level project management: add (clone + persist), list, delete
 * (rm-rf + db). These are the operations behind `POST /projects`,
 * `GET /projects`, and `DELETE /projects/:id` (SPEC §8.1) — the HTTP
 * server is a thin envelope around these calls.
 *
 * Atomicity contract:
 *   - addProject leaves the system in either "row + dir on disk" or
 *     "neither" — clone failure rolls back, db conflict short-circuits
 *     before anything touches disk, and a row is only inserted after
 *     `git clone` returns success.
 *   - deleteProject removes the on-disk clone *first* and only
 *     unregisters the row if rm succeeds. Operator gets a clear error
 *     and a still-listed project they can retry on, rather than a
 *     ghost-row pointing at half a directory.
 *
 * The `localPath` returned by the clone is re-validated against the
 * configured projects root before any rm: defense-in-depth so a
 * tampered db row can never escape the projects dir.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { ValidationError } from "../core/errors.ts";
import type { ProjectsRepo } from "../db/repos/projects.ts";
import type { ProjectRow } from "../db/schema.ts";
import {
	type CloneProjectResult,
	cloneProjectRepo,
	DEFAULT_GIT_TIMEOUT_MS,
	type SpawnFn,
} from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { parseGitHubUrl } from "./url.ts";

export interface AddProjectInput {
	readonly repo: ProjectsRepo;
	readonly config: ProjectsConfig;
	readonly gitUrl: string;
	readonly defaultBranch?: string;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
	readonly now?: () => Date;
	/** Inject the cloner; defaults to the live `cloneProjectRepo`. */
	readonly clone?: typeof cloneProjectRepo;
}

export async function addProject(input: AddProjectInput): Promise<ProjectRow> {
	const { repo, config, gitUrl } = input;
	const parsed = parseGitHubUrl(gitUrl);

	const existing = repo.findByGitUrl(gitUrl);
	if (existing) {
		throw new ValidationError(`project already exists: ${existing.id}`, {
			recoveryHint: "DELETE /projects/:id first if you want to re-clone",
		});
	}

	const cloneFn = input.clone ?? cloneProjectRepo;
	const clone: CloneProjectResult = await cloneFn({
		config,
		gitUrl,
		owner: parsed.owner,
		name: parsed.name,
		defaultBranch: input.defaultBranch,
		spawn: input.spawn,
		timeoutMs: input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
	});

	return repo.create({
		gitUrl,
		localPath: clone.localPath,
		defaultBranch: clone.defaultBranch,
		now: input.now?.(),
	});
}

export interface DeleteProjectInput {
	readonly repo: ProjectsRepo;
	readonly config: ProjectsConfig;
	readonly id: string;
	/** Filesystem probes — overrideable for tests. */
	readonly exists?: (path: string) => boolean;
	readonly rmrf?: (path: string) => Promise<void>;
}

export async function deleteProject(input: DeleteProjectInput): Promise<ProjectRow> {
	const { repo, config, id } = input;
	const exists = input.exists ?? existsSync;
	const rmrf = input.rmrf ?? defaultRmrf;

	const row = repo.require(id);
	assertPathUnderRoot(row.localPath, config.root);

	if (exists(row.localPath)) {
		try {
			await rmrf(row.localPath);
		} catch (err) {
			throw new ProjectUnavailableError(`failed to remove ${row.localPath}: ${formatError(err)}`, {
				cause: err,
				recoveryHint: "check filesystem permissions and free space; the project remains registered",
			});
		}
	}

	repo.delete(id);
	return row;
}

export function listProjects(repo: ProjectsRepo): ProjectRow[] {
	return repo.listAll();
}

function assertPathUnderRoot(localPath: string, root: string): void {
	const rootResolved = resolve(root);
	const pathResolved = resolve(localPath);
	if (pathResolved !== rootResolved && !pathResolved.startsWith(rootResolved + sep)) {
		// A project row whose localPath isn't under the configured root is a
		// data-integrity bug, not a user-facing condition. Better to error
		// loudly than to rm-rf an arbitrary path.
		throw new ProjectUnavailableError(
			`project localPath ${localPath} is not under projects root ${root}`,
			{ recoveryHint: "manually remove the project's files and the row from the db" },
		);
	}
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

const defaultRmrf = async (path: string): Promise<void> => {
	await rm(path, { recursive: true, force: true });
};
