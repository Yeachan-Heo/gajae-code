#!/usr/bin/env bash
# Show the last N lines of a GJC tmux session pane.
# Usage: tail.sh <session-name> [lines]

set -euo pipefail
SESSION="${1:?Usage: $0 <session-name> [lines]}"
LINES="${2:-40}"
TMUX_CMD=(tmux)

show_durable_state() {
  local log_path="$1"
  local state_dir
  state_dir="$(dirname "$log_path")"
  if [[ -f "$state_dir/metadata.json" ]]; then
    echo "[gjc-session] durable metadata: $state_dir/metadata.json" >&2
  fi
  echo "[gjc-session] tmux session '$SESSION' is not readable; showing durable pane log: $log_path" >&2
  if [[ -f "$state_dir/final.json" ]]; then
    echo "[gjc-session] durable final status: $state_dir/final.json" >&2
  fi
  if [[ -f "$state_dir/events.log" ]]; then
    echo "[gjc-session] durable events: $state_dir/events.log" >&2
  fi
  tail -n "$LINES" "$log_path"
}

if "${TMUX_CMD[@]}" capture-pane -t "${SESSION}:0.0" -p -S -"$LINES" 2>/dev/null; then
  exit 0
fi

# tmux history is volatile. If the server/session vanished, fall back to the durable pane log
# created by create.sh in the task worktree. Search common worktree roots without exposing
# private routing values or requiring a live tmux server.
if [[ -n "${GJC_SESSION_STATE_DIR:-}" && -f "$GJC_SESSION_STATE_DIR/pane.log" ]]; then
  show_durable_state "$GJC_SESSION_STATE_DIR/pane.log"
  exit 0
fi
mapfile -t candidates < <(find "${GJC_SESSION_LOG_SEARCH_ROOT:-$HOME/Workspace}" \( -path "*/.gjc-session-state/$SESSION/pane.log" -o -path "*/$SESSION/pane.log" \) -type f 2>/dev/null | sort)
if [[ "${#candidates[@]}" -gt 0 ]]; then
  show_durable_state "${candidates[0]}"
  exit 0
fi

echo "gjc-session tail failed: tmux session '$SESSION' is not readable and no durable pane log was found" >&2
exit 1
