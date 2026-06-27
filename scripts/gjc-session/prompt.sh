#!/usr/bin/env bash
# Send a prompt to an existing interactive GJC tmux session.
# Usage: prompt.sh <session-name> "<prompt-text>" OR prompt.sh <session-name> @/path/to/prompt.md

set -euo pipefail
SESSION="${1:?Usage: $0 <session-name> <text|@file>}"
TEXT_ARG="${2:?Usage: $0 <session-name> <text|@file>}"
TMUX_CMD=(tmux)

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
  if [[ -n "${GJC_SESSION_STATE_DIR:-}" && -f "$GJC_SESSION_STATE_DIR/pane.log" ]]; then
    candidates=("$GJC_SESSION_STATE_DIR/pane.log")
  else
    mapfile -t candidates < <(find "${GJC_SESSION_LOG_SEARCH_ROOT:-$HOME/Workspace}" \( -path "*/.gjc-session-state/$SESSION/pane.log" -o -path "*/$SESSION/pane.log" \) -type f 2>/dev/null | sort)
  fi
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

echo "sent to $SESSION: ${TEXT:0:80}..."
