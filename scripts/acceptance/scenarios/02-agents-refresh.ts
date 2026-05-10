/**
 * Scenario 02 — POST /agents/refresh + GET /agents.
 *
 * Acceptance criterion #2:
 *   "POST /agents/refresh clones the configured canopy repo and registers
 *   every prompt tagged agent: true; GET /agents lists them."
 *
 * Verifies the URL-rewrite path: warren reads CANOPY_REPO_URL from env,
 * git clones it (insteadOf rewrites the fake URL to the local fixture),
 * shells `cn list --tag agent` against the clone, and renders each.
 */

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface AgentRow {
	readonly name: string;
	readonly source?: "builtin" | "library";
	readonly registeredAt?: string;
	readonly lastRefreshed?: string;
}

export const scenario: Scenario = {
	id: "02",
	title: "POST /agents/refresh clones canopy + GET /agents lists stub-shell",
	modes: ["in-proc", "container"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// Initial /agents — only the boot-seeded built-ins (claude-code, sapling)
		// are registered; no library-sourced agents until the first refresh.
		const before = await http.expectJson<{ agents: AgentRow[] }>("GET", "/agents", 200);
		const beforeLibrary = before.agents.filter((a) => a.source !== "builtin");
		assertEqual(
			beforeLibrary.length,
			0,
			"no library-sourced agents are registered before first refresh",
		);

		// Trigger refresh. Warren clones the canopy repo (via insteadOf
		// redirect), enumerates `agent: true` prompts, renders each.
		const refresh = await http.expectJson<{ registered: AgentRow[]; skipped?: unknown[] }>(
			"POST",
			"/agents/refresh",
			200,
		);
		assertTrue(Array.isArray(refresh.registered), "refresh response is missing 'registered' array");
		const registeredNames = refresh.registered.map((a) => a.name);
		if (!registeredNames.includes(ctx.fixtures.stubAgentName)) {
			throw new AcceptanceError(
				`refresh did not register ${JSON.stringify(ctx.fixtures.stubAgentName)} (got ${JSON.stringify(registeredNames)})`,
			);
		}

		// Listing now returns the stub agent.
		const after = await http.expectJson<{ agents: AgentRow[] }>("GET", "/agents", 200);
		const found = after.agents.find((a) => a.name === ctx.fixtures.stubAgentName);
		assertTrue(
			found !== undefined,
			`${ctx.fixtures.stubAgentName} missing from /agents after refresh`,
		);

		// Detail route returns the AgentRow ({name, renderedJson, ...}).
		// `renderedJson` carries the parsed AgentDefinition with sections.
		const detail = await http.expectJson<{
			name: string;
			renderedJson: { sections: Record<string, string> };
		}>("GET", `/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}`, 200);
		assertEqual(detail.name, ctx.fixtures.stubAgentName, "agent detail name");
		const sections = detail.renderedJson?.sections;
		assertTrue(
			typeof sections === "object" && sections !== null,
			"agent detail is missing renderedJson.sections",
		);
		assertTrue(
			typeof sections.system === "string" && sections.system.length > 0,
			"agent detail is missing 'system' section",
		);
	},
};
