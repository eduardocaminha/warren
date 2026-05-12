/**
 * Built-in `pi` agent definition.
 *
 * Pi (`@earendil-works/pi-coding-agent`) is the third coding-agent
 * runtime warren ships out of the box, alongside `claude-code` and
 * `sapling`. Including it as a built-in lets a fresh warren install
 * dispatch a multi-provider run without standing up a canopy library
 * first — same parity wedge sapling landed via SAPLING_BUILTIN.
 *
 * The pi-specific surfaces (multi-provider override, cost reporting,
 * `.pi/skills/` and `.pi/prompts/` materialization) layer on top in
 * follow-on steps of pl-4374; this file is the minimal parity shape.
 *
 * Operators with a custom canopy library override this by registering a
 * same-named library agent — refresh upserts on top.
 */

import type { AgentDefinition } from "../schema.ts";

const SYSTEM_BODY = `You are a helpful coding assistant. Be concise.

Workspace map:
- The project repo is mounted at the burrow workspace root.
- /workspace/.canopy/agent.json is the rendered agent definition (warren seeded it).
- /workspace/.mulch/expertise/<domain>.jsonl holds the project's expertise records.
- /workspace/.seeds/issues.jsonl holds the project's issue queue.

Operating contract:
- Edit files in place. Run tests when relevant.
- Use git as you normally would. Commit your changes; warren reaps the branch and pushes upstream.
- Do not run \`git push\` yourself — warren handles the push host-side after the run terminates.
`;

export const PI_BUILTIN: AgentDefinition = {
	name: "pi",
	version: 1,
	sections: {
		system: SYSTEM_BODY,
		burrow_config: '[sandbox]\nnetwork = "open"\n',
	},
	resolvedFrom: ["builtin:pi"],
	frontmatter: {
		source: "builtin",
		tags: ["agent"],
	},
};
