/**
 * Structural UI test for the Leveret new conversation dialog and rewake button
 * (warren-6e94).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NEW_CONV_DIALOG_PATH = join(
	import.meta.dir,
	"..",
	"ui",
	"src",
	"pages",
	"leveret",
	"new-conversation-dialog.tsx",
);
const NEW_CONV_DIALOG_SOURCE = readFileSync(NEW_CONV_DIALOG_PATH, "utf8");

const REWAKE_BUTTON_PATH = join(
	import.meta.dir,
	"..",
	"ui",
	"src",
	"pages",
	"conversation-detail",
	"rewake-button.tsx",
);
const REWAKE_BUTTON_SOURCE = readFileSync(REWAKE_BUTTON_PATH, "utf8");

describe("NewConversationDialog (warren-ea70)", () => {
	test("registers state for project select, plot mode, and inputs", () => {
		expect(NEW_CONV_DIALOG_SOURCE).toContain('useState("")');
		expect(NEW_CONV_DIALOG_SOURCE).toMatch(/useState<"auto-create" \| "attach">\("auto-create"\)/);
	});

	test("queries projects and plots via projectsApi/plotsApi", () => {
		expect(NEW_CONV_DIALOG_SOURCE).toContain("projectsApi.list");
		expect(NEW_CONV_DIALOG_SOURCE).toContain("plotsApi.list");
	});

	test("uses useMutation over conversationsApi.create", () => {
		expect(NEW_CONV_DIALOG_SOURCE).toContain("conversationsApi.create");
		expect(NEW_CONV_DIALOG_SOURCE).toContain('queryKey: ["conversations"]');
		expect(NEW_CONV_DIALOG_SOURCE).toContain(
			"navigate(`/leveret/" + "$" + "{encodeURIComponent(data.conversation.id)}`);",
		);
	});

	test("shows a runtime select defaulting to pi-chat (warren-0727)", () => {
		expect(NEW_CONV_DIALOG_SOURCE).toMatch(/useState\("pi-chat"\)/);
		expect(NEW_CONV_DIALOG_SOURCE).toContain('value="pi-chat"');
		expect(NEW_CONV_DIALOG_SOURCE).toContain('value="claude-code-chat"');
	});

	test("passes runtimeOverride to conversationsApi.create (warren-0727)", () => {
		expect(NEW_CONV_DIALOG_SOURCE).toContain("runtimeOverride");
	});
});

describe("RewakeButton (warren-c140)", () => {
	test("only renders when conversation is active and anchoring run is terminal", () => {
		expect(REWAKE_BUTTON_SOURCE).toContain('conversation.status === "active"');
		expect(REWAKE_BUTTON_SOURCE).toMatch(/if \(!isActive \|\| !isAnchoringRunTerminal\)/);
	});

	test("uses conversationsApi.rewake mutation", () => {
		expect(REWAKE_BUTTON_SOURCE).toContain("conversationsApi.rewake");
	});

	test("invalidates conversation and conversations queries on success", () => {
		expect(REWAKE_BUTTON_SOURCE).toContain('queryKey: ["conversation", conversation.id]');
		expect(REWAKE_BUTTON_SOURCE).toContain('queryKey: ["conversations"]');
	});

	test("exposes runtime select defaulting to pi-chat before re-wake button (warren-0727)", () => {
		expect(REWAKE_BUTTON_SOURCE).toMatch(/useState\("pi-chat"\)/);
		expect(REWAKE_BUTTON_SOURCE).toContain('value="pi-chat"');
		expect(REWAKE_BUTTON_SOURCE).toContain('value="claude-code-chat"');
	});

	test("passes runtimeOverride to conversationsApi.rewake (warren-0727)", () => {
		expect(REWAKE_BUTTON_SOURCE).toContain("runtimeOverride");
		expect(REWAKE_BUTTON_SOURCE).toMatch(
			/conversationsApi\.rewake\(conversation\.id,\s*\{\s*runtimeOverride\s*\}\)/,
		);
	});
});
