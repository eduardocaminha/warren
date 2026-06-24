/**
 * Scenario 37 — claude-code-chat spawn-per-turn conversation (warren-c985 / pl-e118 step 4).
 *
 * Verifies that a Leveret conversation backed by the `claude-code-chat`
 * runtime (spawn-per-turn) handles >=2 sequential operator turns without
 * surfacing "no live anchoring run" or killing the conversation.
 *
 * Acceptance criteria (from pl-e118):
 *   A. Two or more sequential operator turns are accepted and the second
 *      message response carries `resumedRunId` (not `steerMessageId`),
 *      confirming the spawn-per-turn delivery path.
 *   B. The anchor rotates after each turn: `anchoringRunId` advances to
 *      the new resume-run.
 *   C. Assistant turns (the claude-code-chat stub reply text) persist to
 *      the messages transcript so they're visible on conversation reload.
 *   D. The conversation stays `active` across all turns.
 *   E. The existing pi-chat path is unaffected (pi-chat steer path still
 *      returns `steerMessageId`).
 */

import { assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly mode?: string | null;
	readonly agentName: string;
}

interface ConversationRow {
	readonly id: string;
	readonly projectId: string | null;
	readonly anchoringRunId: string | null;
	readonly status: "active" | "closed";
	readonly plotId: string | null;
}

interface MessageRow {
	readonly id: string;
	readonly seq: number;
	readonly role: string;
	readonly content: string;
}

interface CreateConversationResponse {
	readonly conversation: ConversationRow;
	readonly run: RunRow;
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

interface GetConversationResponse {
	readonly conversation: ConversationRow;
	readonly messages: readonly MessageRow[];
}

interface PostMessageResponse {
	readonly conversationId: string;
	readonly message: { readonly id: string; readonly seq: number; readonly role: string };
	readonly resumedRunId?: string;
	readonly steerMessageId?: string;
}

const TERMINAL_DEADLINE_MS = 30_000;
const POLL_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunTerminal(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<RunRow> {
	const deadline = Date.now() + timeoutMs;
	let last: RunRow | undefined;
	while (Date.now() < deadline) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row;
		if (row.state === "succeeded" || row.state === "failed" || row.state === "cancelled") {
			return row;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`run ${runId} did not reach terminal state within ${timeoutMs}ms (last state: ${JSON.stringify(last?.state)})`,
	);
}

export const scenario: Scenario = {
	id: "37",
	title:
		"claude-code-chat spawn-per-turn conversation — >=2 sequential turns, resumedRunId, anchor rotation, assistant turns persist",
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		await http.expectStatus("POST", "/agents/refresh", 200);

		// Ensure sample project is registered.
		const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

		// =====================================================================
		// A. Create conversation with runtime_override:claude-code-chat
		// =====================================================================
		const created = await http.expectJson<CreateConversationResponse>(
			"POST",
			"/conversations",
			201,
			{
				body: {
					project_id: project.id,
					message: "scenario-37 first turn: hello claude-code-chat",
					runtime_override: "claude-code-chat",
				},
			},
		);

		const conversationId = created.conversation.id;
		const firstRunId = created.run.id;
		const firstAnchoringRunId = created.conversation.anchoringRunId;

		assertEqual(
			firstAnchoringRunId,
			firstRunId,
			"initial anchoringRunId equals the first run's id",
		);
		assertEqual(created.run.mode, "conversation", "initial run is mode='conversation'");
		assertEqual(created.conversation.status, "active", "fresh conversation is active");

		// =====================================================================
		// B. Wait for the initial (spawn-per-turn) run to terminate.
		//    Unlike pi-chat, claude-code-chat runs terminate after each turn.
		// =====================================================================
		const firstTerminal = await waitForRunTerminal(http, firstRunId, TERMINAL_DEADLINE_MS);
		assertEqual(
			firstTerminal.state,
			"succeeded",
			`first run should succeed (stub exits 0); got ${firstTerminal.state}`,
		);

		// Conversation stays active even after the anchoring run terminates.
		const afterFirstTurn = await http.expectJson<GetConversationResponse>(
			"GET",
			`/conversations/${encodeURIComponent(conversationId)}`,
			200,
		);
		assertEqual(
			afterFirstTurn.conversation.status,
			"active",
			"conversation stays active after first run terminates",
		);

		// =====================================================================
		// C. Post second operator turn → must return resumedRunId (spawn path)
		// =====================================================================
		const secondMsgRes = await http.expectJson<PostMessageResponse>(
			"POST",
			`/conversations/${encodeURIComponent(conversationId)}/messages`,
			202,
			{ body: { message: "scenario-37 second turn: continue the conversation" } },
		);

		assertEqual(
			secondMsgRes.conversationId,
			conversationId,
			"second message echoes conversation id",
		);
		assertEqual(secondMsgRes.message.role, "user", "second message role is user");

		// Spawn-per-turn path returns resumedRunId (not steerMessageId).
		assertTrue(
			secondMsgRes.resumedRunId !== undefined && secondMsgRes.resumedRunId.length > 0,
			"second message response carries resumedRunId (spawn-per-turn path)",
		);
		assertTrue(
			secondMsgRes.steerMessageId === undefined,
			"second message response does NOT carry steerMessageId (not the pi steer path)",
		);

		const secondRunId = secondMsgRes.resumedRunId ?? "";

		// Second run is distinct from the first.
		assertTrue(
			secondRunId !== firstRunId,
			"second run is a distinct warren run (not the anchor run)",
		);

		// Anchor rotated to the second run.
		const afterSecondDispatch = await http.expectJson<GetConversationResponse>(
			"GET",
			`/conversations/${encodeURIComponent(conversationId)}`,
			200,
		);
		assertEqual(
			afterSecondDispatch.conversation.anchoringRunId,
			secondRunId,
			"anchor rotated to second run after spawn-per-turn message",
		);

		// =====================================================================
		// D. Wait for second run to terminate.
		// =====================================================================
		const secondTerminal = await waitForRunTerminal(http, secondRunId, TERMINAL_DEADLINE_MS);
		assertEqual(
			secondTerminal.state,
			"succeeded",
			`second run should succeed; got ${secondTerminal.state}`,
		);

		// =====================================================================
		// E. Post third operator turn to confirm the conversation is not dead.
		// =====================================================================
		const thirdMsgRes = await http.expectJson<PostMessageResponse>(
			"POST",
			`/conversations/${encodeURIComponent(conversationId)}/messages`,
			202,
			{ body: { message: "scenario-37 third turn: still alive?" } },
		);

		assertTrue(
			thirdMsgRes.resumedRunId !== undefined && thirdMsgRes.resumedRunId.length > 0,
			"third message response also carries resumedRunId",
		);
		const thirdRunId = thirdMsgRes.resumedRunId ?? "";
		assertTrue(thirdRunId !== secondRunId, "third run is distinct from the second");

		// Anchor rotated again.
		const afterThirdDispatch = await http.expectJson<GetConversationResponse>(
			"GET",
			`/conversations/${encodeURIComponent(conversationId)}`,
			200,
		);
		assertEqual(
			afterThirdDispatch.conversation.anchoringRunId,
			thirdRunId,
			"anchor rotated to third run",
		);

		// Wait for third run to terminate.
		const thirdTerminal = await waitForRunTerminal(http, thirdRunId, TERMINAL_DEADLINE_MS);
		assertEqual(
			thirdTerminal.state,
			"succeeded",
			`third run should succeed; got ${thirdTerminal.state}`,
		);

		// =====================================================================
		// F. Verify transcript: operator messages persisted, assistant turns
		//    flushed by the bridge's persistAssistantTurn on each agent_end.
		// =====================================================================
		const finalConv = await http.expectJson<GetConversationResponse>(
			"GET",
			`/conversations/${encodeURIComponent(conversationId)}`,
			200,
		);

		const userMessages = finalConv.messages.filter((m) => m.role === "user");
		const assistantMessages = finalConv.messages.filter((m) => m.role === "assistant");

		// 3 operator turns (opening message + 2 subsequent).
		assertEqual(userMessages.length, 3, "transcript contains all 3 operator turns");

		assertTrue(
			userMessages.some((m) => m.content.includes("first turn")),
			"first operator message in transcript",
		);
		assertTrue(
			userMessages.some((m) => m.content.includes("second turn")),
			"second operator message in transcript",
		);
		assertTrue(
			userMessages.some((m) => m.content.includes("third turn")),
			"third operator message in transcript",
		);

		// At least 1 assistant turn flushed per conversation run (3 runs total,
		// so at minimum 3 assistant messages). One for each spawned run.
		assertTrue(
			assistantMessages.length >= 3,
			`at least 3 assistant turns should be flushed (one per run); got ${assistantMessages.length}`,
		);
		assertTrue(
			assistantMessages.every((m) => m.content.includes("claude-code-chat stub reply")),
			"all assistant turns contain the stub reply text",
		);

		// Conversation is still active after all three turns.
		assertEqual(
			finalConv.conversation.status,
			"active",
			"conversation still active after three spawn-per-turn rounds",
		);

		ctx.logger.info(
			`scenario-37: verified ${userMessages.length} user turns + ${assistantMessages.length} assistant turns in claude-code-chat conversation`,
		);
	},
};

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const existing = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const found = existing.projects.find((p) => p.gitUrl === gitUrl);
	if (found !== undefined) return found;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}
