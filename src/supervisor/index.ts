/**
 * Public re-exports for the supervisor module. The container ENTRYPOINT
 * exec's `src/supervisor/main.ts` directly; this barrel exists so callers
 * (tests, the CLI, or future programmatic consumers) can import the typed
 * `runSupervisor` without depending on the file layout.
 */

export { backoffMs, RestartBudget } from "./budget.ts";
export {
	defaultGitCredentialsRun,
	type GitCredentialsDeps,
	type GitCredentialsOpts,
	type GitCredentialsResult,
	type GitCredentialsRun,
	installGitCredentials,
} from "./git-credentials.ts";
export {
	DEFAULT_BURROW_RESTART_BUDGET,
	DEFAULT_BURROW_RESTART_WINDOW_MS,
	DEFAULT_BURROW_SOCKET,
	DEFAULT_SIGNAL_GRACE_MS,
	type InstallSignalHandler,
	type ProductionDepsOptions,
	productionDeps,
	type ResolvedCommand,
	resolveCommandFromEnv,
	runSupervisor,
	type SignalName,
	type SpawnFn,
	type SupervisedChild,
	type SupervisorDeps,
	type SupervisorLogger,
	type SupervisorOpts,
	type SupervisorResult,
} from "./main.ts";
export { type WaitForSocketOptions, waitForSocket } from "./socket.ts";
