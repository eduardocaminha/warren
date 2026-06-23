/**
 * Error hierarchy with stable codes and recovery hints (SPEC §7).
 *
 * Higher layers (HTTP server, CLI) format errors as `[<code>] <message>` plus
 * an optional recovery hint. Library callers can catch by class or switch on
 * `code`. Modeled after burrow's BurrowError so the two stay legible together.
 */

export abstract class WarrenError extends Error {
	abstract readonly code: string;
	readonly recoveryHint?: string;

	constructor(message: string, options?: { cause?: unknown; recoveryHint?: string }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = this.constructor.name;
		if (options?.recoveryHint !== undefined) {
			this.recoveryHint = options.recoveryHint;
		}
	}
}

export class NotFoundError extends WarrenError {
	readonly code = "not_found";
}

export class ValidationError extends WarrenError {
	readonly code = "validation_error";
}

export class StateTransitionError extends WarrenError {
	readonly code = "state_transition_error";
}

export function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
