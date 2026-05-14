/**
 * Public re-exports for the burrow-client facade. Internal modules import
 * from here so the file layout under `burrow-client/` can move without
 * touching call sites.
 */

export {
	BurrowClient,
	type BurrowClientOptions,
	DEFAULT_PROBE_TIMEOUT_MS,
	isTransportError,
	withTransportMapping,
} from "./client.ts";
export {
	type BurrowClientConfig,
	DEFAULT_BURROW_SOCKET,
	type EnvLike,
	loadBurrowClientConfigFromEnv,
} from "./config.ts";
export { BurrowUnreachableError } from "./errors.ts";
export {
	type FanOutLogger,
	type FanOutOptions,
	type FanOutResult,
	fanOutAcrossWorkers,
} from "./fanout.ts";
export {
	BurrowClientPool,
	type BurrowClientPoolDeps,
	type BurrowClientPoolFromEnvOptions,
	LOCAL_WORKER_NAME,
	type PlacementResult,
	type ProbeResult,
	WorkerClientUnregisteredError,
} from "./pool.ts";
