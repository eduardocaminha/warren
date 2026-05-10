/**
 * Zod schemas for the per-project `.warren/` config files (R-02).
 *
 * Two files matter in this seed:
 *   triggers.yaml   array of trigger entries (YAML for cron readability)
 *   defaults.json   per-project defaults (JSON for symmetry)
 *
 * Triggers carry a `kind: 'cron'` discriminator even though only cron is
 * implemented today. Per pl-5d74 risk #1, this leaves room for future
 * webhook-style triggers (R-06+) to be added as another `kind:` without a
 * breaking schema rev.
 *
 * Triggers are parsed and exposed by this module but NOT dispatched here —
 * R-06 (cron scheduler) is the consumer. Defaults are parsed; the NewRun
 * UI consumes `defaultRole` (warren-fd14) by auto-filling its agent picker
 * and `defaultPrompt` (warren-af38) by pre-filling its prompt textarea
 * when the project declares one. CLI `warren run` consumption of
 * `defaultRole`, scheduled-run prompt fallback for `defaultPrompt`, and
 * any template substitution are deferred to R-04 / R-06.
 *
 * `parseTriggersConfig` and `parseDefaultsConfig` return discriminated
 * results — the loader collects `{ ok: false }` shapes into the per-file
 * errors envelope so a malformed sibling never throws.
 */

import { z } from "zod";

const TriggerIdSchema = z
	.string()
	.min(1, "id must be non-empty")
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/,
		"id must be kebab/snake-case (lowercase, digits, dots, dashes, underscores)",
	);

const SeedRefSchema = z.string().min(1, "seed must be non-empty");

const RoleNameSchema = z
	.string()
	.min(1, "role must be non-empty")
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/,
		"role must be a canopy agent name (lowercase, digits, dots, dashes, underscores)",
	);

const CronExpressionSchema = z
	.string()
	.min(1, "cron must be non-empty")
	// Loose parse: warren validates the structural shape (5 or 6 whitespace-
	// separated tokens). R-06 owns full cron validation when it wires up the
	// scheduler — duplicating croner's grammar here would lock the version.
	.refine(
		(value) => {
			const tokens = value.trim().split(/\s+/);
			return tokens.length === 5 || tokens.length === 6;
		},
		{ message: "cron must have 5 or 6 whitespace-separated fields" },
	);

const TimezoneSchema = z.string().min(1, "timezone must be non-empty if provided");

const PromptSchema = z.string().min(1, "prompt must be non-empty if provided");

const CronTriggerSchema = z
	.object({
		id: TriggerIdSchema,
		kind: z.literal("cron"),
		cron: CronExpressionSchema,
		seed: SeedRefSchema,
		role: RoleNameSchema,
		timezone: TimezoneSchema.optional(),
		prompt: PromptSchema.optional(),
	})
	.strict();

export const TriggerSchema = z.discriminatedUnion("kind", [CronTriggerSchema]);

export const TriggersConfigSchema = z.array(TriggerSchema).superRefine((list, ctx) => {
	const seen = new Set<string>();
	list.forEach((entry, index) => {
		if (seen.has(entry.id)) {
			ctx.addIssue({
				code: "custom",
				path: [index, "id"],
				message: `duplicate trigger id "${entry.id}"`,
			});
		}
		seen.add(entry.id);
	});
});

export type CronTrigger = z.infer<typeof CronTriggerSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggersConfig = z.infer<typeof TriggersConfigSchema>;

export const DefaultsConfigSchema = z
	.object({
		defaultRole: RoleNameSchema.optional(),
		defaultBranch: z.string().min(1, "defaultBranch must be non-empty if provided").optional(),
		defaultPrompt: PromptSchema.optional(),
	})
	.strict();

export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>;

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly message: string };

export function parseTriggersConfig(raw: unknown): ParseResult<TriggersConfig> {
	// Empty file (yaml.load returns undefined) is the same as "no triggers"
	// — operators should be able to scaffold the file without forcing an
	// explicit empty list literal.
	if (raw === undefined || raw === null) {
		return { ok: true, value: [] };
	}
	const parsed = TriggersConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}
	return { ok: false, message: parsed.error.issues.map(formatZodIssue).join("; ") };
}

export function parseDefaultsConfig(raw: unknown): ParseResult<DefaultsConfig> {
	// Empty file (`{}` or undefined) is valid — operators may keep the file
	// around as documentation even when no overrides are set.
	if (raw === undefined || raw === null) {
		return { ok: true, value: {} };
	}
	const parsed = DefaultsConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}
	return { ok: false, message: parsed.error.issues.map(formatZodIssue).join("; ") };
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
	const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
	return `${path}: ${issue.message}`;
}
