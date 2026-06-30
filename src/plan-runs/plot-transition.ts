/**
 * Auto-transition the bound Plot from `active` → `done` when a PlanRun
 * reaches the terminal `succeeded` state (warren-b290 / pl-7937 step 5).
 *
 * Composition mirrors src/plan-runs/plot-appender.ts: a `PlotStatusSetter`
 * interface for the side-effect (default opens a `UserPlotClient` against
 * `<project>/.plot/`, reads status, calls `setStatus('done')`) and an
 * `autoTransitionPlotToDone` wrapper that fire-and-logs.
 *
 * The wrapper's outcome is surfaced two ways:
 *   - returns a discriminated `AutoTransitionResult` so callers (the
 *     coordinator) can emit a `plan_run.plot_status_skipped` /
 *     `plan_run.plot_auto_done_failed` system event onto the anchor
 *     child run's event stream when one exists;
 *   - logs at info (transitioned), warn (skipped), or warn (failed) so
 *     ops can grep for these regardless of whether an anchor run is in
 *     hand.
 *
 * The guard is `plot.status === 'active'`. Any other status — `drafting`,
 * `ready`, `done`, `archived` — yields `kind: 'skipped'` so warren never
 * trampers an operator-driven transition mid-PlanRun (pl-7937 risk #4).
 */

import { formatError } from "../core/errors.ts";
import { UserPlotClient } from "../plot-client/index.ts";
import type { Logger } from "../server/types.ts";

export type AutoTransitionResult =
	| { readonly kind: "transitioned"; readonly previousStatus: "active" }
	| { readonly kind: "skipped"; readonly currentStatus: string }
	| { readonly kind: "failed"; readonly reason: string };

export interface SetPlotStatusToDoneInput {
	readonly plotDir: string;
	readonly plotId: string;
	readonly handle: string;
}

export interface PlotStatusSetter {
	/**
	 * Read the Plot's current status; if `active`, call `setStatus('done')`
	 * and return `kind: 'transitioned'`. If not `active`, return
	 * `kind: 'skipped'` with the observed status. Any throw bubbles to the
	 * wrapper, which converts it to `kind: 'failed'`.
	 */
	setPlotStatusToDone(input: SetPlotStatusToDoneInput): Promise<AutoTransitionResult>;
}

export const defaultPlotStatusSetter: PlotStatusSetter = {
	async setPlotStatusToDone(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
		});
		try {
			const plot = client.get(input.plotId);
			const snapshot = await plot.read();
			if (snapshot.status !== "active") {
				return { kind: "skipped", currentStatus: snapshot.status };
			}
			await plot.setStatus("done");
			return { kind: "transitioned", previousStatus: "active" };
		} finally {
			client.close();
		}
	},
};

export interface AutoTransitionPlotToDoneInput {
	readonly setter: PlotStatusSetter;
	readonly logger: Logger;
	readonly plotDir: string;
	readonly plotId: string;
	readonly handle: string;
	readonly planRunId: string;
}

export async function autoTransitionPlotToDone(
	input: AutoTransitionPlotToDoneInput,
): Promise<AutoTransitionResult> {
	let result: AutoTransitionResult;
	try {
		result = await input.setter.setPlotStatusToDone({
			plotDir: input.plotDir,
			plotId: input.plotId,
			handle: input.handle,
		});
	} catch (err) {
		const reason = formatError(err);
		input.logger.warn(
			{ planRunId: input.planRunId, plotId: input.plotId, err: reason },
			"plan_run.plot_auto_done_failed",
		);
		return { kind: "failed", reason };
	}
	if (result.kind === "skipped") {
		input.logger.warn(
			{
				planRunId: input.planRunId,
				plotId: input.plotId,
				currentStatus: result.currentStatus,
			},
			"plan_run.plot_status_skipped",
		);
	} else if (result.kind === "transitioned") {
		input.logger.info(
			{ planRunId: input.planRunId, plotId: input.plotId },
			"plan_run.plot_auto_done",
		);
	}
	return result;
}
