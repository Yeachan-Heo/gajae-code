#!/usr/bin/env bash
# Send a prompt to an existing interactive GJC tmux session.
# Usage: prompt.sh <session-name> "<prompt-text>" OR prompt.sh <session-name> @/path/to/prompt.md

set -euo pipefail
SESSION="${1:?Usage: $0 <session-name> <text|@file>}"
TEXT_ARG="${2:?Usage: $0 <session-name> <text|@file>}"
TMUX_BIN="${GJC_SESSION_TMUX_BIN:-tmux}"
TMUX_CMD=("$TMUX_BIN")
TURN_EVIDENCE_PATTERN="${GJC_SESSION_TURN_EVIDENCE_PATTERN:-Working|Tool|Running|Executing|function call|tool call}"
PROMPT_EVIDENCE_ATTEMPTS="${GJC_SESSION_PROMPT_EVIDENCE_ATTEMPTS:-10}"
case "$PROMPT_EVIDENCE_ATTEMPTS" in
  ''|*[!0-9]*) PROMPT_EVIDENCE_ATTEMPTS=10 ;;
esac
if [[ "$PROMPT_EVIDENCE_ATTEMPTS" -lt 1 ]]; then
  PROMPT_EVIDENCE_ATTEMPTS=1
fi

find_durable_pane_logs() {
  if [[ -n "${GJC_SESSION_STATE_DIR:-}" && -f "$GJC_SESSION_STATE_DIR/pane.log" ]]; then
    printf '%s\n' "$GJC_SESSION_STATE_DIR/pane.log"
  else
    find "${GJC_SESSION_LOG_SEARCH_ROOT:-$HOME/Workspace}" \( -path "*/.gjc-session-state/$SESSION/pane.log" -o -path "*/$SESSION/pane.log" \) -type f 2>/dev/null | sort
  fi
}

has_turn_evidence() {
  local pane_text="$1"
  if printf '%s\n' "$pane_text" | grep -Eiq "$TURN_EVIDENCE_PATTERN"; then
    return 0
  fi
  local candidates=()
  mapfile -t candidates < <(find_durable_pane_logs)
  if [[ "${#candidates[@]}" -gt 0 ]] && grep -Eiq "$TURN_EVIDENCE_PATTERN" "${candidates[0]}"; then
    return 0
  fi
  return 1
}

show_missing_session_diagnostics() {
  local log_path="$1"
  local state_dir
  state_dir="$(dirname "$log_path")"
  if [[ -f "$state_dir/metadata.json" ]]; then
    echo "durable metadata: $state_dir/metadata.json" >&2
  fi
  echo "refusing to paste prompt: tmux session $SESSION is not readable; durable pane log exists at $log_path" >&2
  if [[ -f "$state_dir/final.json" ]]; then
    echo "durable final status: $state_dir/final.json" >&2
  fi
  if [[ -f "$state_dir/events.log" ]]; then
    echo "durable events: $state_dir/events.log" >&2
  fi
  echo "--- durable pane log tail ---" >&2
  tail -40 "$log_path" >&2
}

if [[ "$TEXT_ARG" == @* ]]; then
  FILE="${TEXT_ARG#@}"
  [[ -f "$FILE" ]] || { echo "prompt file not found: $FILE" >&2; exit 1; }
  TEXT="$(cat "$FILE")"
else
  TEXT="$TEXT_ARG"
fi

PANE_TEXT="$(${TMUX_CMD[@]} capture-pane -t "$SESSION":0.0 -p -S -80 2>/dev/null || true)"
if [[ -z "$PANE_TEXT" ]]; then
  mapfile -t candidates < <(find_durable_pane_logs)
  if [[ "${#candidates[@]}" -gt 0 ]]; then
    show_missing_session_diagnostics "${candidates[0]}"
  else
    echo "refusing to paste prompt: tmux session $SESSION is not readable and no durable pane log was found" >&2
  fi
  exit 1
fi
if ! printf '%s\n' "$PANE_TEXT" | grep -qE 'Gajae forge|Type your message|> Type your message|Working'; then
  echo "refusing to paste prompt: GJC TUI is not ready in session $SESSION" >&2
  echo "--- pane tail ---" >&2
  printf '%s\n' "$PANE_TEXT" | tail -40 >&2
  exit 1
fi

"${TMUX_CMD[@]}" send-keys -t "$SESSION" -l "$TEXT"
sleep 0.5
# Multiple Enters work around terminal focus/submission edge cases. Prompt visibility is not acceptance;
# verify Working/tool activity afterwards.
"${TMUX_CMD[@]}" send-keys -t "$SESSION" Enter
sleep 1
"${TMUX_CMD[@]}" send-keys -t "$SESSION" Enter
sleep 1
"${TMUX_CMD[@]}" send-keys -t "$SESSION" Enter

for _ in $(seq 1 "$PROMPT_EVIDENCE_ATTEMPTS"); do
  sleep 1
  PANE_TEXT="$(${TMUX_CMD[@]} capture-pane -t "$SESSION":0.0 -p -S -120 2>/dev/null || true)"
  if [[ -z "$PANE_TEXT" ]]; then
    mapfile -t candidates < <(find_durable_pane_logs)
    if [[ "${#candidates[@]}" -gt 0 ]]; then
      show_missing_session_diagnostics "${candidates[0]}"
    else
      echo "prompt acceptance failed: tmux session $SESSION vanished before durable turn evidence" >&2
    fi
    exit 1
  fi
  if has_turn_evidence "$PANE_TEXT"; then
    echo "sent to $SESSION with durable turn evidence: ${TEXT:0:80}..."
    exit 0
  fi
done

echo "prompt acceptance failed: no durable turn evidence appeared in session $SESSION" >&2
echo "--- pane tail ---" >&2
printf '%s\n' "$PANE_TEXT" | tail -40 >&2
exit 1
