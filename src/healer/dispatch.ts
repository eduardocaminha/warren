/**
 * Healer dispatch decision + prompt (warren-3db0, Phase 2).
 *
 * Pure guard-rail logic, separated from the I/O-heavy handler so the
 * eligibility rules are exhaustively testable. Mirrors the CI-fixer's
 * `decideDispatch` (src/ci-fixer/dispatch.ts) minus the check-runs
 * verdict — the alert webhook *is* the failing signal, so there is no
 * "not_failing" reason. Given the project's resolved `healer` settings
 * and the prior heal-attempt history for an alert fingerprint,
 * `decideHealDispatch` returns one of:
 *
 *   - `dispatch`              — eligible: enabled, not in cooldown, under
 *                              the per-fingerprint retry cap.
 *   - `skip` (reason …)       — not eligible. Reasons:
 *                               * `disabled`    — project hasn't opted in.
 *                               * `cooldown`    — last heal ran too recently.
 *                               * `max_retries` — per-fingerprint cap hit.
 *
 * The handler composes the prompt and writes the `heal.dispatched`
 * event; this module only decides.
 */

import type { HealAlert } from "./alert.ts";

export interface HealerSettings {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly cooldownMinutes: number;
}

export interface HealAttemptHistory {
	/** How many healer runs warren has already dispatched for this fingerprint. */
	readonly attempts: number;
	/** ISO timestamp of the most recent heal dispatch, or null when none. */
	readonly lastAttemptAt: string | null;
}

export type HealSkipReason = "disabled" | "cooldown" | "max_retries";

export type HealDispatchDecision =
	| { readonly kind: "dispatch" }
	| { readonly kind: "skip"; readonly reason: HealSkipReason };

export interface DecideHealDispatchInput {
	readonly settings: HealerSettings;
	readonly history: HealAttemptHistory;
	/** Current wall clock; injected for deterministic tests. */
	readonly now: Date;
}

const MS_PER_MINUTE = 60_000;

export function decideHealDispatch(input: DecideHealDispatchInput): HealDispatchDecision {
	const { settings, history, now } = input;

	if (!settings.enabled) return { kind: "skip", reason: "disabled" };
	if (history.attempts >= settings.maxRetries) return { kind: "skip", reason: "max_retries" };
	if (withinCooldown(history.lastAttemptAt, settings.cooldownMinutes, now)) {
		return { kind: "skip", reason: "cooldown" };
	}
	return { kind: "dispatch" };
}

/**
 * True when a previous heal ran within `cooldownMinutes` of `now`. A null
 * `lastAttemptAt` (no prior heal) is never in cooldown; a zero cooldown
 * disables the gate; an unparseable timestamp is treated as "no prior
 * attempt" so a corrupt event row never strands a fingerprint forever.
 */
function withinCooldown(lastAttemptAt: string | null, cooldownMinutes: number, now: Date): boolean {
	if (lastAttemptAt === null || cooldownMinutes <= 0) return false;
	const last = Date.parse(lastAttemptAt);
	if (Number.isNaN(last)) return false;
	return now.getTime() - last < cooldownMinutes * MS_PER_MINUTE;
}

/**
 * Build the dispatch prompt for a `healer` run. Splices the normalized
 * alert context (title, culprit, detail, links) into a fenced block so
 * the agent can diagnose without re-querying the alerting stack.
 */
export function buildHealPrompt(alert: HealAlert): string {
	const lines: string[] = [
		`A production alert fired from ${alert.source}. The codebase is failing in production; find the fault and fix it.`,
		"",
		`Alert: ${alert.title}`,
	];
	if (alert.culprit !== null) lines.push(`Culprit: ${alert.culprit}`);
	lines.push(`Fingerprint: ${alert.fingerprint}`);
	lines.push("");
	if (alert.detail !== null && alert.detail.trim() !== "") {
		lines.push("Alert detail:", "```", alert.detail.trim(), "```", "");
	}
	if (alert.links.length > 0) {
		lines.push("Links:");
		for (const link of alert.links) lines.push(`- ${link}`);
		lines.push("");
	}
	lines.push(
		"Diagnose the root cause from the codebase, apply the smallest correct fix, run the project's quality gate until it is green, and commit. Open a normal pull request — warren pushes your branch.",
	);
	return lines.join("\n");
}
