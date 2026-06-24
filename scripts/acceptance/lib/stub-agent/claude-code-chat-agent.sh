#!/usr/bin/env bash
# Claude-code-chat stub agent for warren's acceptance harness (warren-c985 / pl-e118 step 4).
#
# Emits claude-code-chat stream-json stdout (matching the envelope shape
# parsed by burrow's `src/runtime/parsers/jsonl-claude-chat.ts`). The
# acceptance harness registers this as the `claude-code-chat` runtime in
# burrow-with-stub.ts so scenarios can drive spawn-per-turn conversations
# without a real Anthropic API key.
#
# Key differences from claude-code-stub-agent.sh:
#   - terminal is `result` (NOT `state_change`) → jsonl-claude-chat parser
#     maps it to `agent_end` (the turn boundary, not a session terminal)
#   - `session_id` is embedded in both system/init AND result so the chat
#     parser captures it for `extractMetadata` → burrow stores it →
#     the next turn's `buildResumeCommand` passes `--resume <session_id>`
#   - The fixed session_id is intentional: the stub always emits the same
#     id so the resume path is exercised end-to-end without branching on
#     turn number

set -euo pipefail

_prompt="${1:-<no-prompt>}"
echo "claude-code-chat-stub: started turn with prompt=\"${_prompt}\"" >&2

emit() {
  printf '%s\n' "$1"
}

# system/init with session_id — captured by the jsonl-claude-chat parser's
# stateful closure so the result envelope inherits it.
emit '{"type":"system","subtype":"init","session_id":"sess_chat_stub","model":"claude-stub"}'

# assistant text — produces a text event on stream=stdout via mapAssistantBlock.
emit '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I understand your request. This is the claude-code-chat stub reply."}]}}'

# result (terminal marker for this turn). The jsonl-claude-chat parser maps
# this to an `agent_end` event (kind="agent_end", stream="system") so the
# warren bridge (isClaudeAgentEnd) flushes the accumulated assistant text and
# breaks the bridge loop on detectRuntimeTerminal.
emit '{"type":"result","subtype":"success","is_error":false,"session_id":"sess_chat_stub","total_cost_usd":0.0005,"usage":{"input_tokens":50,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'

exit 0
