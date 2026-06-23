#!/usr/bin/env bash
# Show the last N lines of a GJC tmux session pane.
# Usage: tail.sh <session-name> [lines]

set -euo pipefail
SESSION="${1:?Usage: $0 <session-name> [lines]}"
LINES="${2:-40}"
TMUX_CMD=(tmux)

"${TMUX_CMD[@]}" capture-pane -t "${SESSION}:0.0" -p -S -"$LINES" 2>/dev/null
