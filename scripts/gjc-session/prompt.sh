#!/usr/bin/env bash
# Submit a prompt to an existing isolated GJC tmux owner without reading pane data.
# Usage: prompt.sh <session-name> "<prompt-text>" OR prompt.sh <session-name> @/path/to/prompt.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postmortem.sh
source "$SCRIPT_DIR/postmortem.sh"

SESSION="${1:?Usage: $0 <session-name> <text|@file>}"
TEXT_ARG="${2:?Usage: $0 <session-name> <text|@file>}"
TMUX_BIN="${GJC_SESSION_TMUX_BIN:-tmux}"
STATE_DIR="${GJC_SESSION_STATE_DIR:-}"
if [[ -z "$STATE_DIR" && -n "${GJC_SESSION_WORKDIR:-}" ]]; then
  STATE_DIR="$GJC_SESSION_WORKDIR/.gjc-session-state/$SESSION"
fi
if [[ -z "$STATE_DIR" || ! -s "$STATE_DIR/started.json" ]]; then
  echo "refusing to submit prompt: session $SESSION has no public started marker" >&2
  exit 1
fi
TMUX_SOCKET_OVERRIDE="${GJC_SESSION_TMUX_SOCKET:-}"
TMUX_SOCKET="$(python3 - "$STATE_DIR/metadata.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle: value = json.load(handle).get("socket_key")
    if not isinstance(value, str) or not value: raise ValueError()
    print(value)
except Exception: raise SystemExit(1)
PY
)" || { echo "refusing to submit prompt: metadata has no private tmux socket" >&2; exit 1; }
if [[ -n "$TMUX_SOCKET_OVERRIDE" && "$TMUX_SOCKET_OVERRIDE" != "$TMUX_SOCKET" ]]; then
  echo "refusing to submit prompt: socket override does not match metadata" >&2
  exit 1
fi
TMUX_CMD=("$TMUX_BIN" -L "$TMUX_SOCKET")


if [[ "$TEXT_ARG" == @* ]]; then
  FILE="${TEXT_ARG#@}"
  [[ -f "$FILE" ]] || { echo "prompt file not found: $FILE" >&2; exit 1; }
  TEXT="$(<"$FILE")"
else
  TEXT="$TEXT_ARG"
fi


STARTED_JSON="$STATE_DIR/started.json"
ACCEPTED_JSON="$STATE_DIR/prompt-accepted.json"
METADATA_JSON="$STATE_DIR/metadata.json"
GENERATION_JSON="$STATE_DIR/$SESSION/owner-lifecycle/generation.json"
exec 9>"${GENERATION_JSON%.json}.transition.lock"
flock -x 9
GJC_SESSION_TRANSITION_LOCK_HELD=1
if [[ ! -s "$STARTED_JSON" ]]; then
  echo "refusing to submit prompt: session $SESSION has no public started marker" >&2
  exit 1
fi

if ! OWNER_GENERATION="$(python3 - "$STARTED_JSON" "$METADATA_JSON" "$GENERATION_JSON" "$SESSION" "$TMUX_SOCKET" <<'PY'
import json
import sys
started_path, metadata_path, generation_path, session, socket = sys.argv[1:]
try:
    with open(started_path, encoding="utf-8") as handle: started = json.load(handle)
    with open(metadata_path, encoding="utf-8") as handle: metadata = json.load(handle)
    with open(generation_path, encoding="utf-8") as handle: current = json.load(handle)
    generation = started.get("owner_generation")
    valid = (isinstance(generation, str) and generation and started.get("schema_version") == 1 and started.get("kind") == "started" and started.get("session_id") == session and metadata.get("schema_version") == 1 and metadata.get("session_id") == session and metadata.get("owner_generation") == generation and metadata.get("socket_key") == socket and current.get("schema_version") == 1 and current.get("session_id") == session and current.get("generation") == generation)
    if not valid: raise ValueError()
    print(generation)
except Exception: raise SystemExit(1)
PY
)"; then
  echo "refusing to submit prompt: session $SESSION has invalid current generation metadata" >&2
  exit 1
fi


if ! "${TMUX_CMD[@]}" has-session -t "=$SESSION" >/dev/null 2>&1; then
  echo "refusing to submit prompt: tmux session $SESSION is not available" >&2
  exit 1
fi
for option_value in "@gjc-owner-generation=$OWNER_GENERATION" "@gjc-owner-server-key=$TMUX_SOCKET"; do
  option="${option_value%%=*}"; expected="${option_value#*=}"
  actual="$("${TMUX_CMD[@]}" show-options -t "=$SESSION:" -v "$option" 2>/dev/null || true)"
  [[ "$actual" == "$expected" ]] || { echo "refusing to submit prompt: isolated owner proof failed" >&2; exit 1; }
done


worktree_baseline_dirty="${GJC_SESSION_PROMPT_WORKTREE_BASELINE_DIRTY:-null}"
if [[ "$worktree_baseline_dirty" != true && "$worktree_baseline_dirty" != false && -f "$STATE_DIR/metadata.json" ]]; then
  workdir="$(python3 - "$STATE_DIR/metadata.json" <<'PY'
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        value = json.load(handle).get("workdir")
    print(value if isinstance(value, str) else "")
except Exception:
    print("")
PY
)"
  [[ -z "$workdir" ]] || worktree_baseline_dirty="$(gjc_session_git_dirty_boolean "$workdir")"
fi

# Keep prompt bytes out of tmux argv and lifecycle records. The private buffer is
# deleted immediately after a single paste; this script never reads it back.
BUFFER_NAME="gjc-prompt-${OWNER_GENERATION//[^A-Za-z0-9]/}-${BASHPID}"
BUFFER_CLEANUP_REQUIRED=1
cleanup_prompt_buffer() {
  local status=$?
  [[ "${BUFFER_CLEANUP_REQUIRED:-0}" == 1 ]] || return "$status"
  if "${TMUX_CMD[@]}" delete-buffer -b "$BUFFER_NAME" >/dev/null 2>&1; then
    return "$status"
  fi
  if "${TMUX_CMD[@]}" has-session -t "=$SESSION" >/dev/null 2>&1; then
    echo "failed to delete private prompt buffer" >&2
    return 1
  fi
  return "$status"
}
trap cleanup_prompt_buffer EXIT
printf '%s' "$TEXT" | "${TMUX_CMD[@]}" load-buffer -b "$BUFFER_NAME" -
"${TMUX_CMD[@]}" paste-buffer -d -b "$BUFFER_NAME" -t "=$SESSION":0.0
BUFFER_CLEANUP_REQUIRED=0
"${TMUX_CMD[@]}" send-keys -t "=$SESSION":0.0 Enter


accepted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$STATE_DIR"
ACCEPTED_CANONICAL="$STATE_DIR/$SESSION/owner-lifecycle/prompt-accepted-$OWNER_GENERATION.json"
python3 - "$ACCEPTED_CANONICAL" "$GENERATION_JSON" "$SESSION" "$OWNER_GENERATION" "$accepted_at" "$worktree_baseline_dirty" <<'PY'
import json, os, sys
path, generation_path, session, generation, accepted_at, baseline = sys.argv[1:]
with open(generation_path, encoding="utf-8") as handle:
    current = json.load(handle)
if current.get("schema_version") != 1 or current.get("session_id") != session or current.get("generation") != generation: raise SystemExit(1)
marker = {"schema_version": 1, "kind": "prompt_accepted", "session_id": session, "owner_generation": generation, "accepted_at": accepted_at, "worktree_baseline_dirty": None if baseline == "null" else baseline == "true"}
temporary = f"{path}.{os.getpid()}.tmp"
try:
    with open(temporary, "x", encoding="utf-8") as handle:
        json.dump(marker, handle, separators=(",", ":")); handle.write("\n")
    os.link(temporary, path)
except FileExistsError:
    with open(path, encoding="utf-8") as handle:
        if json.load(handle) != marker: raise
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY
gjc_session_publish_current_alias "$ACCEPTED_CANONICAL" "$ACCEPTED_JSON" "$GENERATION_JSON" "$SESSION" "$OWNER_GENERATION" prompt_accepted

echo "prompt submitted to $SESSION; public acceptance marker recorded"
