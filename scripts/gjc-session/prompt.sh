#!/usr/bin/env bash
# Send a prompt to an existing interactive GJC tmux session.
# Usage: prompt.sh <session-name> "<prompt-text>" OR prompt.sh <session-name> @/path/to/prompt.md

set -euo pipefail
SESSION="${1:?Usage: $0 <session-name> <text|@file>}"
TEXT_ARG="${2:?Usage: $0 <session-name> <text|@file>}"
TMUX_CMD=(tmux)

if [[ "$TEXT_ARG" == @* ]]; then
  FILE="${TEXT_ARG#@}"
  [[ -f "$FILE" ]] || { echo "prompt file not found: $FILE" >&2; exit 1; }
  TEXT="$(cat "$FILE")"
else
  TEXT="$TEXT_ARG"
fi

PANE_TEXT="$("${TMUX_CMD[@]}" capture-pane -t "$SESSION":0.0 -p -S -80 2>/dev/null || true)"
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
