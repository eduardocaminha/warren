/**
 * Public re-exports for the project-management module. Internal modules
 * import from here so file layout under `projects/` can shift without
 * rippling out to call sites.
 */

export {
	type CloneProjectInput,
	type CloneProjectResult,
	cloneProjectRepo,
	DEFAULT_GIT_TIMEOUT_MS,
	type SpawnFn,
	type SpawnOptions,
	type SpawnResult,
} from "./clone.ts";
export {
	DEFAULT_PROJECTS_DIR,
	type EnvLike,
	loadProjectsConfigFromEnv,
	type ProjectsConfig,
} from "./config.ts";
export { ProjectUnavailableError } from "./errors.ts";
export {
	type AddProjectInput,
	addProject,
	type DeleteProjectInput,
	deleteProject,
	listProjects,
} from "./manage.ts";
export { type ParsedGitHubUrl, parseGitHubUrl } from "./url.ts";
