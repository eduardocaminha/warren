/**
 * Built-in `claude-code` agent definition.
 *
 * Mirrors the canonical canopy `claude-code` prompt (canopy-daf3) so a
 * fresh warren install can dispatch a run without an external library.
 * The shape matches what `cn render` would emit; `parseRenderedAgent`
 * round-trips through warren's schema validation in the test suite.
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

export const CLAUDE_CODE_BUILTIN: AgentDefinition = {
	name: "claude-code",
	version: 1,
	sections: {
		system: SYSTEM_BODY,
		burrow_config: '[sandbox]\nnetwork = "open"\n',
	},
	resolvedFrom: ["builtin:claude-code"],
	frontmatter: {
		source: "builtin",
		tags: ["agent"],
	},
};
