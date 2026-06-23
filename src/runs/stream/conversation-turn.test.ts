import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunEvent } from "@os-eco/burrow-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { EditPlotIntentRequest, PlotIntentEditor } from "../../plots/index.ts";
import {
	createConversationTurnHandler,
	extractAssistantText,
	extractClaudeIntentPatch,
	extractIntentPatch,
	LEVERET_PLOT_ACTOR,
} from "./conversation-turn.ts";
import { evt } from "./test-helpers.ts";

describe("extractAssistantText", () => {
	test("returns text for an assistant text block on stdout", () => {
		expect(extractAssistantText(evt("r", 1, { kind: "text", payload: { text: "hi" } }))).toBe("hi");
	});

	test("returns null for empty text, non-text kinds, and system streams", () => {
		expect(extractAssistantText(evt("r", 1, { kind: "text", payload: { text: "" } }))).toBeNull();
		expect(
			extractAssistantText(evt("r", 1, { kind: "thinking", payload: { text: "x" } })),
		).toBeNull();
		expect(
			extractAssistantText(evt("r", 1, { kind: "text", stream: "system", payload: { text: "x" } })),
		).toBeNull();
	});
});

describe("extractIntentPatch", () => {
	function toolEnd(details: unknown): RunEvent {
		return evt("r", 1, {
			kind: "state_change",
			stream: "system",
			payload: {
				type: "tool_execution_end",
				toolName: "propose_intent",
				toolCallId: "tc_1",
				result: { content: [], details },
			},
		});
	}

	test("pulls a well-formed patch off result.details.intent_patch", () => {
		const patch = extractIntentPatch(
			toolEnd({
				intent_patch: {
					goal: "ship",
					non_goals: ["a"],
					constraints: ["b"],
					success_criteria: ["c"],
				},
			}),
		);
		expect(patch).toEqual({
			goal: "ship",
			non_goals: ["a"],
			constraints: ["b"],
			success_criteria: ["c"],
		});
	});

	test("keeps only the fields present", () => {
		expect(extractIntentPatch(toolEnd({ intent_patch: { goal: "g" } }))).toEqual({ goal: "g" });
	});

	test("returns null when there is no intent_patch or no usable field", () => {
		expect(extractIntentPatch(toolEnd({}))).toBeNull();
		expect(extractIntentPatch(toolEnd({ intent_patch: {} }))).toBeNull();
		expect(extractIntentPatch(toolEnd({ intent_patch: { goal: 5 } }))).toBeNull();
	});

	test("returns null for non tool_execution_end events", () => {
		expect(
			extractIntentPatch(
				evt("r", 1, { kind: "state_change", stream: "system", payload: { type: "agent_end" } }),
			),
		).toBeNull();
	});

	test("rejects arrays of mixed types", () => {
		expect(extractIntentPatch(toolEnd({ intent_patch: { non_goals: ["ok", 3] } }))).toBeNull();
	});
});

describe("extractClaudeIntentPatch", () => {
	function toolUse(name: string, input: unknown): RunEvent {
		return evt("r", 1, {
			kind: "tool_use",
			stream: "stdout",
			payload: { name, input },
		});
	}

	test("pulls all four intent fields from a namespaced __propose_intent tool_use", () => {
		const patch = extractClaudeIntentPatch(
			toolUse("mcp__warren__propose_intent", {
				goal: "ship it",
				non_goals: ["a"],
				constraints: ["b"],
				success_criteria: ["c"],
			}),
		);
		expect(patch).toEqual({
			goal: "ship it",
			non_goals: ["a"],
			constraints: ["b"],
			success_criteria: ["c"],
		});
	});

	test("matches the suffix only — bare 'propose_intent' without __ prefix returns null", () => {
		expect(extractClaudeIntentPatch(toolUse("propose_intent", { goal: "x" }))).toBeNull();
	});

	test("returns null for an unrelated tool_use", () => {
		expect(extractClaudeIntentPatch(toolUse("mcp__warren__bash", { command: "ls" }))).toBeNull();
	});

	test("returns null when input has no recognized intent fields", () => {
		expect(extractClaudeIntentPatch(toolUse("mcp__warren__propose_intent", {}))).toBeNull();
	});

	test("returns null when input is not an object", () => {
		expect(extractClaudeIntentPatch(toolUse("mcp__warren__propose_intent", null))).toBeNull();
		expect(extractClaudeIntentPatch(toolUse("mcp__warren__propose_intent", "str"))).toBeNull();
		expect(extractClaudeIntentPatch(toolUse("mcp__warren__propose_intent", []))).toBeNull();
	});

	test("returns null for non-tool_use events and wrong streams", () => {
		expect(
			extractClaudeIntentPatch(
				evt("r", 1, {
					kind: "state_change",
					stream: "stdout",
					payload: { name: "mcp__warren__propose_intent", input: { goal: "x" } },
				}),
			),
		).toBeNull();
		expect(
			extractClaudeIntentPatch(
				evt("r", 1, {
					kind: "tool_use",
					stream: "system",
					payload: { name: "mcp__warren__propose_intent", input: { goal: "x" } },
				}),
			),
		).toBeNull();
	});

	test("keeps only the fields present (partial patch)", () => {
		expect(extractClaudeIntentPatch(toolUse("mcp__warren__propose_intent", { goal: "g" }))).toEqual(
			{ goal: "g" },
		);
	});

	test("rejects mixed-type arrays in intent fields", () => {
		expect(
			extractClaudeIntentPatch(toolUse("mcp__warren__propose_intent", { non_goals: ["ok", 3] })),
		).toBeNull();
	});
});

describe("createConversationTurnHandler", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		await db.close();
	});

	async function seedConversationRun(plotId: string | null): Promise<string> {
		await repos.agents.upsert({ name: "leveret", renderedJson: {} });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "leveret",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "conversation",
			mode: "conversation",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
			...(plotId !== null ? { plotId } : {}),
		});
		await repos.conversations.create({
			projectId: project.id,
			plotId,
			anchoringRunId: run.id,
		});
		return run.id;
	}

	test("persistAssistantTurn appends a role:assistant message to the transcript", async () => {
		const runId = await seedConversationRun(null);
		const handler = createConversationTurnHandler({ repos });
		await handler.persistAssistantTurn({ runId, text: "the assistant reply" });

		const conversation = await repos.conversations.getByAnchoringRunId(runId);
		expect(conversation).not.toBeNull();
		const messages = await repos.messages.listByConversation((conversation as { id: string }).id);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("assistant");
		expect(messages[0]?.content).toBe("the assistant reply");
	});

	test("persistAssistantTurn is a no-op when no conversation anchors the run", async () => {
		const handler = createConversationTurnHandler({ repos });
		await handler.persistAssistantTurn({ runId: "run_unknown", text: "x" });
		// no throw == success
	});

	test("applyIntentPatch routes through the editor with the leveret actor", async () => {
		const plotId = "pt_abcabcab";
		const runId = await seedConversationRun(plotId);
		const calls: EditPlotIntentRequest[] = [];
		const editor: PlotIntentEditor = {
			async edit(input) {
				calls.push(input);
				return {
					id: input.plotId,
					name: "P",
					status: "drafting",
					intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
					attachments: [],
					event_log: [],
				};
			},
		};
		const handler = createConversationTurnHandler({ repos, plotIntentEditor: editor });
		await handler.applyIntentPatch({ runId, patch: { goal: "ship it" } });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.plotId).toBe(plotId);
		expect(calls[0]?.handle).toBe(LEVERET_PLOT_ACTOR);
		expect(calls[0]?.patch).toEqual({ goal: "ship it" });
		expect(calls[0]?.plotDir).toBe("/data/projects/x/y/.plot");
	});

	test("applyIntentPatch is a no-op when the run has no Plot bound", async () => {
		const runId = await seedConversationRun(null);
		let called = false;
		const editor: PlotIntentEditor = {
			async edit(input) {
				called = true;
				return {
					id: input.plotId,
					name: "P",
					status: "drafting",
					intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
					attachments: [],
					event_log: [],
				};
			},
		};
		const handler = createConversationTurnHandler({ repos, plotIntentEditor: editor });
		await handler.applyIntentPatch({ runId, patch: { goal: "x" } });
		expect(called).toBe(false);
	});
});
