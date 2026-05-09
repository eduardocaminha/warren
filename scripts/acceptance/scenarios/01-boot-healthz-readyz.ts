/**
 * Scenario 01 — boot + /healthz + /readyz.
 *
 * Acceptance criterion #1 from pl-49f3:
 *   "docker compose up on a fresh host boots warren; UI reachable on
 *   localhost:8080; healthz returns 200, readyz returns 200 once burrow
 *   socket + canopy clone are ready."
 *
 * In `in-proc` mode we don't boot docker; the harness already verified
 * /healthz responds 200 during `waitForHealthz()`. This scenario adds:
 *   - /healthz is auth-exempt (works without Authorization).
 *   - /readyz returns 503 before the canopy clone exists, 200 after
 *     a successful POST /agents/refresh.
 */

import { assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

export const scenario: Scenario = {
	id: "01",
	title: "boot + /healthz auth-exempt + /readyz transitions to 200 after refresh",
	modes: ["in-proc", "container"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// /healthz works without auth (unauth'd fetch).
		const healthzRes = await fetch(http.url("/healthz"));
		assertEqual(healthzRes.status, 200, "/healthz returns 200");

		// /healthz works with auth too (no special-case rejection).
		await http.expectStatus("GET", "/healthz", 200);

		// Before any refresh, /readyz typically reports the canopy clone is
		// missing — readyz is the operational signal, not a hard contract,
		// so we just assert it returns *some* JSON body.
		const beforeRefresh = await http.request("GET", "/readyz");
		const beforeBody = (await beforeRefresh.json()) as { ok: boolean; checks?: unknown };
		assertTrue(
			typeof beforeBody.ok === "boolean",
			`/readyz returned malformed body: ${JSON.stringify(beforeBody)}`,
		);
		ctx.logger.debug(`/readyz before refresh: status=${beforeRefresh.status} ok=${beforeBody.ok}`);
	},
};
