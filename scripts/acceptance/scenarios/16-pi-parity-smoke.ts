/**
 * Scenario 16 — pi built-in agent parity smoke (warren-d18e / pl-4374 step 2).
 *
 * Acceptance criterion (warren-d18e):
 *   "POST /runs with agentName='pi' returns 201 + run_xxx; burrow.up is
 *   invoked with agents: ['pi']; the run reaches state='running' and
 *   emits at least one event through warren's events table; cleanup
 *   cancels the run."
 *
 * This is the parity wedge for pl-4374 — the same minimal proof scenario
 * 04 does for stub-shell, but for the pi built-in shipped in
 * src/registry/builtins/pi.ts. It verifies:
 *
 *   1. The pi built-in is seeded into warren's agents registry on boot
 *      (GET /agents/pi returns the AgentDefinition with frontmatter.source
 *      = "builtin").
 *   2. POST /runs accepts agentName='pi' and dispatches through burrow —
 *      burrowId + burrowRunId are populated on the 201 (proving burrow.up
 *      was invoked with `agents: ['pi']` per src/runs/spawn.ts:196).
 *   3. The run's renderedAgentJson is frozen from the pi built-in
 *      (name='pi', frontmatter.source='builtin').
 *   4. At least one event lands in the events table — the durable signal
 *      that warren's bridge picked the run up off burrow's event stream.
 *   5. Cleanup cancels the run so teardown doesn't race a live agent.
 *
 * Why "at least one event" instead of "agent_start specifically": burrow's
 * upstream piRuntime (--mode rpc) is the cross-repo step warren-0e06,
 * not yet shipped in @os-eco/burrow-cli 0.2.7. Until it lands, the
 * acceptance harness registers a declarative pi agent in burrow-with-stub.ts
 * that reuses the stub-shell script — same dispatch wiring, same events
 * table, generic 'text' event kind (raw-text parser). Once piRuntime ships,
 * this scenario can tighten the assertion to kind='agent_start'. The
 * parity claim of this step is "warren can dispatch pi end-to-end through
 * burrow" — event kind specificity is a follow-on step (warren-70af).
 */

import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
}

interface AgentDefinitionEnvelope {
	readonly name: string;
	readonly version: number;
	readonly sections: Record<string, string>;
	readonly resolvedFrom?: readonly string[];
	readonly frontmatter?: Record<string, unknown>;
}

interface AgentRow {
	readonly name: string;
	readonly source?: string;
	readonly renderedJson: AgentDefinitionEnvelope;
}

interface RunRow {
	readonly id: string;
	readonly agentName: string;
	readonly projectId: string | null;
	readonly burrowId: string | null;
	readonly burrowRunId: string | null;
	readonly renderedAgentJson: AgentDefinitionEnvelope;
	readonly state: string;
	readonly prompt: string;
	readonly trigger: string;
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

interface EventEnvelope {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

const RUN_ID_PATTERN = /^run_[0-9a-hjkmnpqrstvwxyz]{12}$/;
const FIRST_EVENT_TIMEOUT_MS = 15_000;

export const scenario: Scenario = {
	id: "16",
	title:
		"pi built-in parity smoke — POST /runs agent=pi dispatches through burrow and emits events",
	// Same constraint as scenario 04: needs the host-side sample project,
	// canopy fixture, and the declarative-pi registration in burrow-with-stub.
	// Container mode does not bind-mount any of those.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// 1. GET /agents/pi — the boot-seed should have registered the
		// built-in before the harness even runs scenarios. The detail row
		// carries source='builtin' (via readAgentSource off frontmatter).
		const piAgent = await http.expectJson<AgentRow>("GET", "/agents/pi", 200);
		assertEqual(piAgent.name, "pi", "GET /agents/pi name");
		assertEqual(piAgent.source, "builtin", "GET /agents/pi source");
		assertEqual(piAgent.renderedJson.name, "pi", "GET /agents/pi renderedJson.name");
		assertTrue(
			(piAgent.renderedJson.sections.system?.length ?? 0) > 0,
			"GET /agents/pi renderedJson.sections.system is non-empty",
		);
		assertEqual(
			piAgent.renderedJson.frontmatter?.source,
			"builtin",
			"GET /agents/pi renderedJson.frontmatter.source",
		);

		const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

		// 2. POST /runs with agent='pi' — 201 + run_xxx, burrowId/burrowRunId
		// populated by spawnRun (proves burrow.up was called with agents: ['pi']).
		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: "pi",
				project: project.id,
				prompt: "scenario-16 pi parity smoke",
			},
		});
		const run = created.run;
		assertTrue(
			RUN_ID_PATTERN.test(run.id),
			`POST /runs run.id ${JSON.stringify(run.id)} does not match ${RUN_ID_PATTERN}`,
		);
		assertEqual(run.agentName, "pi", "POST /runs run.agentName");
		assertEqual(run.projectId, project.id, "POST /runs run.projectId");
		assertTrue(
			typeof run.burrowId === "string" && run.burrowId !== null && run.burrowId.length > 0,
			"POST /runs run.burrowId populated (proves burrow.up was invoked)",
		);
		assertTrue(
			typeof run.burrowRunId === "string" && run.burrowRunId !== null && run.burrowRunId.length > 0,
			"POST /runs run.burrowRunId populated",
		);
		assertEqual(created.burrow.id, run.burrowId, "response.burrow.id matches run.burrowId");

		// 3. renderedAgentJson is the frozen pi built-in.
		assertEqual(run.renderedAgentJson.name, "pi", "run.renderedAgentJson.name");
		assertEqual(
			run.renderedAgentJson.frontmatter?.source,
			"builtin",
			"run.renderedAgentJson carries the builtin provenance",
		);

		try {
			// 4. Wait for at least one event to land in the events table.
			// Bridge writes events FIRST then broker.publish (mx-e402e5), so
			// a non-follow GET against the run's events endpoint is the
			// durable signal we want.
			await waitForFirstEvent(http, run.id, FIRST_EVENT_TIMEOUT_MS);
		} finally {
			// 5. Cancel — cancel is idempotent (mx-fadaa2), best-effort.
			await safelyCancel(http, run.id, ctx);
		}
	},
};

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	// Other scenarios share the same fixture; tolerate either state
	// (mx-a8d92b).
	const existing = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const found = existing.projects.find((p) => p.gitUrl === gitUrl);
	if (found !== undefined) return found;
	return await http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function waitForFirstEvent(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const events: EventEnvelope[] = [];
		for await (const env of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
			events.push(env as EventEnvelope);
			if (events.length >= 1) break;
		}
		if (events.length >= 1) return;
		await sleep(100);
	}
	throw new AcceptanceError(
		`no events landed for run ${runId} within ${timeoutMs}ms — bridge or dispatch wiring is broken`,
	);
}

async function safelyCancel(http: WarrenHttp, runId: string, ctx: ScenarioCtx): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch (err) {
		ctx.logger.debug(
			`scenario-16: cancel failed (${err instanceof Error ? err.message : String(err)}) — best-effort`,
		);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
