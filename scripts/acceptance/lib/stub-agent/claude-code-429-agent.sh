#!/usr/bin/env bash
# 429-rate-limit stub agent for warren's acceptance harness (warren-016a).
#
# First invocation (no flag file): emits a claude-code result with
# api_error_status=429 and a past resetsAt so the scheduler treats the
# run as rate-limited and queues an immediate retry.
#
# Second invocation (flag file present): removes the flag and emits a
# normal success result, completing the pause→resume cycle.
#
# The flag file path is based on WARREN_ACCEPT_38_FLAG, defaulting to
# /tmp/warren-accept-38-ran-once, so test runs don't collide.
#
# Registered as the `claude-code-429` runtime in burrow-with-stub.ts
# with parseJsonlClaude as the parser (same as the claude-code stub).

set -euo pipefail

FLAG_FILE="${WARREN_ACCEPT_38_FLAG:-/tmp/warren-accept-38-ran-once}"

emit() {
  printf '%s\n' "$1"
}

# Minimal claude-code preamble so the parser has an init line.
emit '{"type":"system","subtype":"init","session_id":"sess_429_stub","model":"claude-stub","tools":[]}'
emit '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"429-stub: checking rate-limit state"}]}}'

if [ ! -f "$FLAG_FILE" ]; then
  # First run: emit 429. resetsAt is in the past so the scheduler retries
  # immediately on the next tick without waiting.
  touch "$FLAG_FILE"
  emit '{"type":"result","subtype":"error","is_error":true,"api_error_status":429,"rate_limit_event":{"status":"rejected","resetsAt":"2020-01-01T00:00:00.000Z"}}'
  echo "429-stub: emitted 429 (first run)" >&2
else
  # Retry run: clean up flag and succeed.
  rm -f "$FLAG_FILE"
  emit '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.0001,"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'
  echo "429-stub: emitted success (retry run)" >&2
fi

exit 0
