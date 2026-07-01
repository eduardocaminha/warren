import type { MessagePriority } from "@os-eco/burrow-cli";
import { ValidationError } from "../../../core/errors.ts";
import { cancelRun, steerRun } from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import {
	optionalString,
	readJsonBody,
	readJsonBodyOrEmpty,
	requireParam,
	requireString,
} from "../index.ts";

const MESSAGE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

function parseMessagePriority(raw: string | undefined): MessagePriority | undefined {
	if (raw === undefined) return undefined;
	if (!(MESSAGE_PRIORITIES as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`priority must be one of ${MESSAGE_PRIORITIES.join(", ")}; got '${raw}'`,
		);
	}
	return raw as MessagePriority;
}

export function steerRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const priority = parseMessagePriority(optionalString(body, "priority"));
		const fromActor = optionalString(body, "fromActor");
		const result = await steerRun({
			runId: id,
			body: requireString(body, "body"),
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			...(priority !== undefined ? { priority } : {}),
			...(fromActor !== undefined ? { fromActor } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
		return jsonResponse(200, { message: result.message });
	};
}

export function cancelRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);
		const reason = body !== null ? optionalString(body, "reason") : undefined;
		const result = await cancelRun({
			runId: id,
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			...(reason !== undefined ? { reason } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
		});
		return jsonResponse(200, {
			state: result.state,
			alreadyTerminal: result.alreadyTerminal,
			burrowRun: result.burrowRun,
		});
	};
}
