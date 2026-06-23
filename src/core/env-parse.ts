import { parseDurationMs } from "../preview/duration.ts";
import { ValidationError } from "./errors.ts";

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function parseEnvDuration(env: EnvLike, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	try {
		return parseDurationMs(raw);
	} catch (err) {
		const message = err instanceof ValidationError ? err.message : String(err);
		throw new ValidationError(`${name}: ${message}`);
	}
}

export function parseEnvPositiveInt(env: EnvLike, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
		throw new ValidationError(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
	}
	return parsed;
}

export function isTruthy(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const lower = raw.trim().toLowerCase();
	return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}
