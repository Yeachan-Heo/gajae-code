#!/usr/bin/env bash
# Send a prompt to an existing interactive GJC tmux session.
# Usage: prompt.sh <session-name> "<prompt-text>" OR prompt.sh <session-name> @/path/to/prompt.md

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postmortem.sh
source "$SCRIPT_DIR/postmortem.sh"
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
  if [[ -n "${GJC_SESSION_STATE_DIR:-}" && -z "${GJC_SESSION_LOG_SEARCH_ROOT:-}" && -f "$GJC_SESSION_STATE_DIR/pane.log" ]]; then
    printf '%s\n' "$GJC_SESSION_STATE_DIR/pane.log"
  else
    find "${GJC_SESSION_LOG_SEARCH_ROOT:-$HOME/Workspace}" \( -path "*/.gjc-session-state/$SESSION/pane.log" -o -path "*/$SESSION/pane.log" \) -type f 2>/dev/null | sort
  fi
}

prompt_accepted_path() {
  if [[ -n "${GJC_SESSION_STATE_DIR:-}" && -z "${GJC_SESSION_LOG_SEARCH_ROOT:-}" ]]; then
    printf '%s\n' "$GJC_SESSION_STATE_DIR/prompt-accepted.json"
    return 0
  fi
  local candidates=()
  mapfile -t candidates < <(find_durable_pane_logs)
  if [[ "${#candidates[@]}" -gt 0 ]]; then
    printf '%s\n' "$(dirname "${candidates[0]}")/prompt-accepted.json"
  fi
}

record_prompt_accepted() {
  local accepted_path
  accepted_path="$(prompt_accepted_path)"
  if [[ -z "$accepted_path" ]]; then
    return 0
  fi
  local accepted_at
  accepted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$(dirname "$accepted_path")"
  local accepted_dir
  accepted_dir="$(dirname "$accepted_path")"
  python3 - "$accepted_path" "$SESSION" "$accepted_at" "$accepted_dir/pane.log" <<'PY'
import json
import sys

path, session, accepted_at, pane_log = sys.argv[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "session": session,
            "acceptedAt": accepted_at,
            "evidence": "durable_turn_evidence",
            "paneLog": pane_log,
        },
        handle,
        indent=2,
    )
    handle.write("\n")
PY
}

file_size_bytes() {
  local file_path="${1:-}"
  python3 - "$file_path" <<'PY'
import os
import sys

try:
    print(os.path.getsize(sys.argv[1]))
except OSError:
    print(0)
PY
}

wait_for_evidence_log_quiet() {
  local previous_size="-1"
  local current_size="0"
  for _ in $(seq 1 20); do
    current_size="$(file_size_bytes "$EVIDENCE_LOG")"
    if [[ "$current_size" == "$previous_size" ]]; then
      printf '%s\n' "$current_size"
      return 0
    fi
    previous_size="$current_size"
    sleep 0.1
  done
  printf '%s\n' "$(file_size_bytes "$EVIDENCE_LOG")"
}

has_turn_evidence() {
  local log_path="${1:-}"
  local log_offset="${2:-0}"
  local prompt_text="${3:-}"
  if [[ -n "$log_path" && -f "$log_path" ]]; then
    python3 - "$log_path" "$log_offset" "$TURN_EVIDENCE_PATTERN" "$prompt_text" <<'PY'
import re
import sys

log_path, offset_raw, pattern, prompt_text = sys.argv[1:]
try:
    offset = int(offset_raw)
except ValueError:
    offset = 0
try:
    with open(log_path, "rb") as handle:
        handle.seek(max(offset, 0))
        data = handle.read()
except OSError:
    sys.exit(1)

text = data.decode("utf-8", errors="replace")
if prompt_text:
    text = text.replace(prompt_text, "")
if re.search(pattern, text, re.IGNORECASE):
    sys.exit(0)
sys.exit(1)
PY
    return $?
  fi
  return 1
}

print_redacted_tail() {
  local prompt_text="${TEXT:-}"
  python3 - "$prompt_text" <<'PY'
import sys

prompt = sys.argv[1]
text = sys.stdin.read()
if prompt:
    text = text.replace(prompt, "[prompt redacted]")
for line in text.splitlines()[-40:]:
    print(line)
PY
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
  tail -40 "$log_path" | print_redacted_tail >&2
}


state_dir_from_log() {
  local log_path="${1:-}"
  [[ -n "$log_path" ]] && dirname "$log_path"
}

write_pre_prompt_vanished() {
  local reason="${1:?reason required}"
  local phase="${2:?phase required}"
  local tui_ready="${3:-false}"
  local log_path="${4:-}"
  local state_dir=""
  state_dir="$(state_dir_from_log "$log_path")"
  if [[ -z "$state_dir" && -n "${GJC_SESSION_STATE_DIR:-}" ]]; then
    state_dir="$GJC_SESSION_STATE_DIR"
    log_path="$state_dir/pane.log"
  fi
  [[ -n "$state_dir" ]] || return 0
  mkdir -p "$state_dir"
  local workdir=""
  if [[ -f "$state_dir/metadata.json" ]]; then
    workdir="$(python3 - "$state_dir/metadata.json" <<'PYMETA'
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        print(json.load(handle).get("workdir") or "")
except Exception:
    print("")
PYMETA
)"
  fi
  if [[ -z "$workdir" ]]; then
    workdir="$state_dir"
  fi
  printf '[%s] prompt preflight vanished phase=%s reason=%s tui_ready=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$phase" "$reason" "$tui_ready" >>"$state_dir/events.log"
  gjc_session_write_vanished_json \
    "$state_dir/vanished.json" \
    "$SESSION" \
    "$workdir" \
    "$reason" \
    "$phase" \
    failure \
    false \
    false \
    "$tui_ready" \
    "$log_path" \
    "$state_dir/events.log" \
    "$state_dir/final.json" \
    "$state_dir/runtime-state.json" \
    "$state_dir/prompt-accepted.json"
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
    write_pre_prompt_vanished "tmux_session_missing_before_prompt_injection" "before_prompt_injection" false "${candidates[0]}"
    show_missing_session_diagnostics "${candidates[0]}"
  else
    write_pre_prompt_vanished "tmux_session_missing_before_prompt_injection" "before_prompt_injection" false ""
    echo "refusing to paste prompt: tmux session $SESSION is not readable and no durable pane log was found" >&2
  fi
  exit 1
fi
if ! printf '%s\n' "$PANE_TEXT" | grep -qE 'Gajae forge|Type your message|> Type your message|Working'; then
  mapfile -t candidates < <(find_durable_pane_logs)
  if [[ "${#candidates[@]}" -gt 0 ]]; then
    write_pre_prompt_vanished "tmux_session_unready_before_prompt_injection" "before_prompt_injection" false "${candidates[0]}"
  else
    write_pre_prompt_vanished "tmux_session_unready_before_prompt_injection" "before_prompt_injection" false ""
  fi
  echo "refusing to paste prompt: GJC TUI is not ready in session $SESSION" >&2
  echo "--- pane tail ---" >&2
  printf '%s\n' "$PANE_TEXT" | print_redacted_tail >&2
  exit 1
fi

# Establish freshness before submission. Prompt acceptance must come from bytes
# captured after the local paste echo has drained, but before Enter submits the
# turn. Prefer the durable pane log when session state provides one so this
# script does not replace an existing tmux pipe-pane logger.
EVIDENCE_LOG=""
EVIDENCE_LOG_IS_TEMP=0
if [[ -n "${GJC_SESSION_STATE_DIR:-}" && -z "${GJC_SESSION_LOG_SEARCH_ROOT:-}" && -f "$GJC_SESSION_STATE_DIR/pane.log" ]]; then
  EVIDENCE_LOG="$GJC_SESSION_STATE_DIR/pane.log"
else
  durable_log_candidates=()
  mapfile -t durable_log_candidates < <(find_durable_pane_logs)
  if [[ "${#durable_log_candidates[@]}" -gt 0 ]]; then
    EVIDENCE_LOG="${durable_log_candidates[0]}"
  else
    EVIDENCE_LOG="$(mktemp "${TMPDIR:-/tmp}/gjc-session-prompt-evidence.XXXXXX")"
    EVIDENCE_LOG_IS_TEMP=1
  fi
fi
EVIDENCE_LOG_OFFSET=0
cleanup_evidence_log() {
  if [[ "$EVIDENCE_LOG_IS_TEMP" == "1" ]]; then
    "${TMUX_CMD[@]}" pipe-pane -t "$SESSION":0.0 2>/dev/null || true
    rm -f "$EVIDENCE_LOG"
  fi
}
trap cleanup_evidence_log EXIT
if [[ "$EVIDENCE_LOG_IS_TEMP" == "1" ]]; then
  "${TMUX_CMD[@]}" pipe-pane -t "$SESSION":0.0 "cat >> '$EVIDENCE_LOG'"
fi

"${TMUX_CMD[@]}" send-keys -t "$SESSION" -l "$TEXT"
sleep 0.5
EVIDENCE_LOG_OFFSET="$(wait_for_evidence_log_quiet)"
# Multiple Enters work around terminal focus/submission edge cases. Prompt visibility is not acceptance;
# verify Working/tool activity afterwards.
"${TMUX_CMD[@]}" send-keys -t "$SESSION" Enter
sleep 1
if has_turn_evidence "$EVIDENCE_LOG" "$EVIDENCE_LOG_OFFSET" "$TEXT"; then
  record_prompt_accepted
  echo "sent to $SESSION with durable turn evidence"
  exit 0
fi
"${TMUX_CMD[@]}" send-keys -t "$SESSION" Enter 2>/dev/null || true
sleep 1
"${TMUX_CMD[@]}" send-keys -t "$SESSION" Enter 2>/dev/null || true

for _ in $(seq 1 "$PROMPT_EVIDENCE_ATTEMPTS"); do
  sleep 1
  if has_turn_evidence "$EVIDENCE_LOG" "$EVIDENCE_LOG_OFFSET" "$TEXT"; then
    record_prompt_accepted
    echo "sent to $SESSION with durable turn evidence"
    exit 0
  fi
  PANE_TEXT="$(${TMUX_CMD[@]} capture-pane -t "$SESSION":0.0 -p -S -120 2>/dev/null || true)"
  if [[ -z "$PANE_TEXT" ]]; then
    mapfile -t candidates < <(find_durable_pane_logs)
    if [[ "${#candidates[@]}" -gt 0 ]]; then
      write_pre_prompt_vanished "tmux_session_missing_before_prompt_acceptance" "before_prompt_acceptance" true "${candidates[0]}"
      show_missing_session_diagnostics "${candidates[0]}"
    else
      write_pre_prompt_vanished "tmux_session_missing_before_prompt_acceptance" "before_prompt_acceptance" true ""
      echo "prompt acceptance failed: tmux session $SESSION vanished before durable turn evidence" >&2
    fi
    exit 1
  fi
  if has_turn_evidence "$EVIDENCE_LOG" "$EVIDENCE_LOG_OFFSET" "$TEXT"; then
    record_prompt_accepted
    echo "sent to $SESSION with durable turn evidence"
    exit 0
  fi
done

echo "prompt acceptance failed: no durable turn evidence appeared in session $SESSION" >&2
echo "--- pane tail ---" >&2
printf '%s\n' "$PANE_TEXT" | print_redacted_tail >&2
exit 1
