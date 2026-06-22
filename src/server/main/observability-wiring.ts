/**
 * Observability boot wiring (warren observability Phase 1).
 *
 * Extracted from `bootServer` so the orchestrator in `index.ts` stays under
 * its per-file budget. Owns the assembly of the two opt-in sinks —
 * the `/metrics` counter registry and the Sentry error tracker — plus the
 * root logger that fans warn/error lines out to them.
 */

import {
	type ErrorTracker,
	type EnvLike as ErrorTrackingEnv,
	initErrorTracking,
} from "../../observability/error-tracking.ts";
import { MetricsRegistry } from "../../observability/metrics-registry.ts";
import type { EnvLike } from "../config.ts";
import type { Logger } from "../types.ts";
import { createWarrenLogger } from "./logging.ts";

export interface ObservabilityWiring {
	readonly logger: Logger;
	readonly metricsRegistry: MetricsRegistry;
	readonly errorTracker: ErrorTracker;
}

/**
 * Build the metrics registry + Sentry tracker (no-op unless `SENTRY_DSN` is
 * set) and the root logger wired to both sinks.
 */
export async function bootObservability(env: EnvLike): Promise<ObservabilityWiring> {
	const metricsRegistry = new MetricsRegistry();
	const { tracker: errorTracker, environment } = await initErrorTracking(env as ErrorTrackingEnv);
	const logger = createWarrenLogger(env, { metrics: metricsRegistry, tracker: errorTracker });
	if (errorTracker.enabled) {
		logger.info({ environment }, "error tracking enabled (sentry)");
	}
	return { logger, metricsRegistry, errorTracker };
}

/**
 * Best-effort capture of a fatal startup error to Sentry from the CLI entry's
 * `.catch()`, where the logger sink may not have been wired yet. Never throws —
 * Sentry must not mask the original boot failure.
 */
export async function captureBootFailure(err: unknown): Promise<void> {
	try {
		const { tracker } = await initErrorTracking(process.env as ErrorTrackingEnv);
		if (tracker.enabled) {
			tracker.captureException(err, { phase: "boot" });
			await tracker.flush(2000);
		}
	} catch {
		// swallow
	}
}
