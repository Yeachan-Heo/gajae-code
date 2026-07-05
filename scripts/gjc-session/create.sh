#!/usr/bin/env bash
# Create a durable, operator-visible GJC tmux session and optionally register it with a router.
#
# Usage:
#   create.sh <session-name> <worktree-path> [channel-id] [mention]
#
# Optional env:
#   GJC_BIN                       path to gjc (default: command -v gjc)
#   GJC_SESSION_FLAGS             extra flags passed to interactive gjc
#   GJC_SESSION_STALE_MINUTES     router stale window (default: 60)
#   GJC_SESSION_KEYWORDS          comma-separated router watch keywords
#   GJC_SESSION_ROUTER            router binary (default: clawhip, if present)
#   GJC_SESSION_SKIP_ROUTER=1     skip router watch registration
#   GJC_SESSION_STATE_DIR         durable metadata/log root (default: <worktree>/.gjc-session-state/<session>)
#   GJC_SESSION_TMUX_BIN          tmux-compatible binary (default: tmux)
#   GJC_SESSION_MONITOR_INTERVAL  seconds between vanished-session checks (default: 5)
#   GJC_SESSION_MONITOR_DISABLE=1 disable external vanished-session monitor

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postmortem.sh
source "$SCRIPT_DIR/postmortem.sh"

SESSION="${1:?Usage: $0 <session-name> <worktree-path> [channel-id] [mention]}"
WORKDIR="${2:?Usage: $0 <session-name> <worktree-path> [channel-id] [mention]}"
CHANNEL="${3:-}"
MENTION="${4:-}"
GJC_BIN="${GJC_BIN:-$(command -v gjc || true)}"
GJC_FLAGS="${GJC_SESSION_FLAGS:-}"
ROUTER_BIN="${GJC_SESSION_ROUTER:-$(command -v clawhip || true)}"
TMUX_BIN="${GJC_SESSION_TMUX_BIN:-tmux}"
TMUX_CMD=("$TMUX_BIN")
TURN_EVIDENCE_PATTERN="${GJC_SESSION_TURN_EVIDENCE_PATTERN:-Working|Tool|Running|Executing|function call|tool call}"

has_turn_evidence() {
  [[ -s "$STATE_DIR/pane.log" ]] && grep -Eiq "$TURN_EVIDENCE_PATTERN" "$STATE_DIR/pane.log"
}


json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

shell_join() {
  printf '%q ' "$@"
}

show_recovery_hint() {
  echo "durable metadata: $STATE_DIR/metadata.json" >&2
  echo "durable pane log: $STATE_DIR/pane.log" >&2
  echo "durable events: $STATE_DIR/events.log" >&2
  echo "durable final status: $STATE_DIR/final.json" >&2
  echo "durable vanished status: $STATE_DIR/vanished.json" >&2
  echo "durable runtime state: $RUNTIME_STATE_JSON" >&2
  if [[ -s "$STATE_DIR/pane.log" ]]; then
    echo "--- durable pane log tail ---" >&2
    tail -40 "$STATE_DIR/pane.log" >&2
  fi
}

if [[ -z "$GJC_BIN" ]]; then
  echo "gjc not found in PATH; set GJC_BIN" >&2
  exit 1
fi
if [[ ! -d "$WORKDIR" ]]; then
  echo "directory not found: $WORKDIR" >&2
  exit 1
fi
if ! git -C "$WORKDIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git worktree: $WORKDIR" >&2
  exit 1
fi

BRANCH="$(git -C "$WORKDIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
  echo "could not determine branch/worktree name for: $WORKDIR" >&2
  exit 1
fi

STATE_DIR="${GJC_SESSION_STATE_DIR:-$WORKDIR/.gjc-session-state/$SESSION}"
RUNTIME_STATE_JSON="$STATE_DIR/runtime-state.json"
mkdir -p "$STATE_DIR"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '{\n'
  printf '  "session": "%s",\n' "$(printf '%s' "$SESSION" | json_escape)"
  printf '  "workdir": "%s",\n' "$(printf '%s' "$WORKDIR" | json_escape)"
  printf '  "branch": "%s",\n' "$(printf '%s' "$BRANCH" | json_escape)"
  printf '  "createdAt": "%s",\n' "$CREATED_AT"
  printf '  "gjcBin": "%s",\n' "$(printf '%s' "$GJC_BIN" | json_escape)"
  printf '  "stateDir": "%s",\n' "$(printf '%s' "$STATE_DIR" | json_escape)"
  printf '  "paneLog": "%s",\n' "$(printf '%s' "$STATE_DIR/pane.log" | json_escape)"
  printf '  "eventsLog": "%s",\n' "$(printf '%s' "$STATE_DIR/events.log" | json_escape)"
  printf '  "finalStatus": "%s",\n' "$(printf '%s' "$STATE_DIR/final.json" | json_escape)"
  printf '  "runtimeState": "%s",\n' "$(printf '%s' "$RUNTIME_STATE_JSON" | json_escape)"
  printf '  "vanishedStatus": "%s",\n' "$(printf '%s' "$STATE_DIR/vanished.json" | json_escape)"
  printf '  "promptAcceptedStatus": "%s"\n' "$(printf '%s' "$STATE_DIR/prompt-accepted.json" | json_escape)"
  printf '}\n'
} >"$STATE_DIR/metadata.json"
: >"$STATE_DIR/pane.log"
: >"$STATE_DIR/events.log"
printf '[%s] create requested session=%s workdir=%s branch=%s\n' "$CREATED_AT" "$SESSION" "$WORKDIR" "$BRANCH" >>"$STATE_DIR/events.log"
cat >"$STATE_DIR/runner.sh" <<'RUNNER'
#!/usr/bin/env bash
set +e
cd "$GJC_SESSION_WORKDIR" || exit 127
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '[%s] runner started session=%s branch=%s cwd=%s\n' "$started_at" "$GJC_SESSION_NAME" "$GJC_SESSION_BRANCH" "$GJC_SESSION_WORKDIR" >>"$GJC_SESSION_EVENTS_LOG"
echo "[gjc-session] session=$GJC_SESSION_NAME branch=$GJC_SESSION_BRANCH cwd=$GJC_SESSION_WORKDIR"
echo "[gjc-session] durable state=$GJC_SESSION_STATE_DIR"
echo "[gjc-session] durable pane log=$GJC_SESSION_PANE_LOG"
echo "[gjc-session] durable runtime state=$GJC_COORDINATOR_SESSION_STATE_FILE"
"$GJC_SESSION_GJC_BIN" $GJC_SESSION_FLAGS
rc=$?
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '[%s] gjc exited status=%s\n' "$finished_at" "$rc" >>"$GJC_SESSION_EVENTS_LOG"
turn_evidence=false
if [[ -s "$GJC_SESSION_PANE_LOG" ]] && grep -Eiq "$GJC_SESSION_TURN_EVIDENCE_PATTERN" "$GJC_SESSION_PANE_LOG"; then
  turn_evidence=true
fi
owner_exit_reason="normal_exit"
owner_exit_severity="normal"
if [[ "$turn_evidence" != "true" ]]; then
  owner_exit_reason="owner_exited_before_turn_evidence"
  owner_exit_severity="failure"
fi
python3 - "$GJC_SESSION_FINAL_JSON" "$GJC_SESSION_NAME" "$rc" "$started_at" "$finished_at" "$GJC_SESSION_PANE_LOG" "$GJC_COORDINATOR_SESSION_STATE_FILE" "$turn_evidence" "$owner_exit_reason" "$owner_exit_severity" <<'PY'
import json
import sys

path, session, status, started_at, finished_at, pane_log, runtime_state, turn_evidence, owner_exit_reason, owner_exit_severity = sys.argv[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "session": session,
            "status": int(status),
            "startedAt": started_at,
            "finishedAt": finished_at,
            "paneLog": pane_log,
            "runtimeState": runtime_state,
            "turnEvidencePresent": turn_evidence == "true",
            "ownerExitReason": owner_exit_reason,
            "severity": owner_exit_severity,
        },
        handle,
        indent=2,
    )
    handle.write("\n")
PY
echo
echo "[gjc-session] GJC exited with status $rc"
echo "[gjc-session] final status: $GJC_SESSION_FINAL_JSON"
echo "[gjc-session] pane preserved for postmortem; press Ctrl-D to close"
exec bash -l
RUNNER
chmod +x "$STATE_DIR/runner.sh"
cat >"$STATE_DIR/monitor.sh" <<'MONITOR'
#!/usr/bin/env bash
set +e
# shellcheck source=postmortem.sh
source "${GJC_SESSION_POSTMORTEM_SH:?}"
interval="${GJC_SESSION_MONITOR_INTERVAL:-5}"
case "$interval" in
  ''|*[!0-9]*) interval=5 ;;
esac
if [[ "$interval" -lt 1 ]]; then
  interval=1
fi
printf '[%s] monitor started session=%s interval=%ss\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$GJC_SESSION_NAME" "$interval" >>"$GJC_SESSION_EVENTS_LOG"
while true; do
  sleep "$interval"
  if "$GJC_SESSION_TMUX_BIN" has-session -t "$GJC_SESSION_NAME" >/dev/null 2>&1; then
    continue
  fi
  detected_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  final_present=false
  [[ -s "$GJC_SESSION_FINAL_JSON" ]] && final_present=true
  if [[ "$final_present" == "true" ]]; then
    printf '[%s] tmux session closed after final status; no vanished failure marker written\n' "$detected_at" >>"$GJC_SESSION_EVENTS_LOG"
    exit 0
  fi
  prompt_accepted=false
  [[ -s "${GJC_SESSION_PROMPT_ACCEPTED_JSON:-}" ]] && prompt_accepted=true
  tui_ready=false
  if [[ -s "$GJC_SESSION_PANE_LOG" ]] && grep -Eq 'Gajae forge|Type your message|> Type your message|Working' "$GJC_SESSION_PANE_LOG"; then
    tui_ready=true
  fi
  vanish_phase="before_tui_readiness"
  vanish_reason="tmux_session_missing_before_tui_readiness"
  if [[ "$prompt_accepted" == "true" ]]; then
    vanish_phase="after_prompt_acceptance"
    vanish_reason="tmux_session_missing_after_prompt_acceptance"
  elif [[ "$tui_ready" == "true" ]]; then
    vanish_phase="before_prompt_acceptance"
    vanish_reason="tmux_session_missing_before_prompt_acceptance"
  fi
  severity="failure"
  printf '[%s] tmux session vanished final_present=%s prompt_accepted=%s tui_ready=%s phase=%s severity=%s reason=%s\n' "$detected_at" "$final_present" "$prompt_accepted" "$tui_ready" "$vanish_phase" "$severity" "$vanish_reason" >>"$GJC_SESSION_EVENTS_LOG"
  gjc_session_write_vanished_json \
    "$GJC_SESSION_VANISHED_JSON" \
    "$GJC_SESSION_NAME" \
    "$GJC_SESSION_WORKDIR" \
    "$vanish_reason" \
    "$vanish_phase" \
    "$severity" \
    "$prompt_accepted" \
    false \
    "$tui_ready" \
    "$GJC_SESSION_PANE_LOG" \
    "$GJC_SESSION_EVENTS_LOG" \
    "$GJC_SESSION_FINAL_JSON" \
    "$GJC_COORDINATOR_SESSION_STATE_FILE" \
    "${GJC_SESSION_PROMPT_ACCEPTED_JSON:-}"
  if [[ "$severity" == "failure" && -n "${GJC_SESSION_ROUTER_BIN:-}" && -n "${GJC_SESSION_CHANNEL:-}" ]]; then
    "$GJC_SESSION_ROUTER_BIN" tmux stale \
      --session "$GJC_SESSION_NAME" \
      --pane "missing" \
      --minutes 0 \
      --last-line "GJC tmux session vanished before final status; see $GJC_SESSION_VANISHED_JSON" \
      --channel "$GJC_SESSION_CHANNEL" >/dev/null 2>&1 || true
  fi
  exit 0
done
MONITOR
chmod +x "$STATE_DIR/monitor.sh"

if "${TMUX_CMD[@]}" has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session already exists: $SESSION" >&2
  exit 1
fi

LAUNCH_CMD=(
  env
  "GJC_SESSION_NAME=$SESSION"
  "GJC_SESSION_WORKDIR=$WORKDIR"
  "GJC_SESSION_BRANCH=$BRANCH"
  "GJC_SESSION_STATE_DIR=$STATE_DIR"
  "GJC_SESSION_PANE_LOG=$STATE_DIR/pane.log"
  "GJC_SESSION_EVENTS_LOG=$STATE_DIR/events.log"
  "GJC_SESSION_FINAL_JSON=$STATE_DIR/final.json"
  "GJC_SESSION_VANISHED_JSON=$STATE_DIR/vanished.json"
  "GJC_COORDINATOR_SESSION_ID=$SESSION"
  "GJC_COORDINATOR_SESSION_STATE_FILE=$RUNTIME_STATE_JSON"
  "GJC_COORDINATOR_SESSION_BRANCH=$BRANCH"
  "GJC_SESSION_TURN_EVIDENCE_PATTERN=$TURN_EVIDENCE_PATTERN"
  "GJC_SESSION_GJC_BIN=$GJC_BIN"
  "GJC_SESSION_FLAGS=$GJC_FLAGS"
  bash "$STATE_DIR/runner.sh"
)
LAUNCH_SHELL="$(shell_join "${LAUNCH_CMD[@]}")"
# Keep a shell after GJC exits so crashes/completions remain inspectable. The runner
# writes normal-exit finalization; pane.log/events.log remain useful if tmux vanishes.
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -c "$WORKDIR" -n gjc "$LAUNCH_SHELL"

"${TMUX_CMD[@]}" set-option -t "$SESSION" remain-on-exit on >/dev/null 2>&1 || true
# Mirror pane output to a durable log so a tmux server/session vanish still leaves recoverable evidence.
"${TMUX_CMD[@]}" pipe-pane -o -t "$SESSION":0.0 "cat >> '$STATE_DIR/pane.log'" >/dev/null 2>&1 || {
  echo "warning: failed to attach durable pane log at $STATE_DIR/pane.log" >&2
}
"${TMUX_CMD[@]}" capture-pane -t "$SESSION":0.0 -p -S -200 >>"$STATE_DIR/pane.log" 2>/dev/null || true
printf '[%s] tmux session launched and pipe attached\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$STATE_DIR/events.log"

if [[ "${GJC_SESSION_MONITOR_DISABLE:-0}" != "1" ]]; then
  MONITOR_CMD=(
    env
    "GJC_SESSION_NAME=$SESSION"
    "GJC_SESSION_WORKDIR=$WORKDIR"
    "GJC_SESSION_BRANCH=$BRANCH"
    "GJC_SESSION_PANE_LOG=$STATE_DIR/pane.log"
    "GJC_SESSION_EVENTS_LOG=$STATE_DIR/events.log"
    "GJC_SESSION_FINAL_JSON=$STATE_DIR/final.json"
    "GJC_SESSION_VANISHED_JSON=$STATE_DIR/vanished.json"
    "GJC_SESSION_PROMPT_ACCEPTED_JSON=$STATE_DIR/prompt-accepted.json"
    "GJC_COORDINATOR_SESSION_STATE_FILE=$RUNTIME_STATE_JSON"
    "GJC_SESSION_TMUX_BIN=$TMUX_BIN"
    "GJC_SESSION_POSTMORTEM_SH=$SCRIPT_DIR/postmortem.sh"
    "GJC_SESSION_MONITOR_INTERVAL=${GJC_SESSION_MONITOR_INTERVAL:-5}"
    "GJC_SESSION_ROUTER_BIN=$ROUTER_BIN"
    "GJC_SESSION_CHANNEL=$CHANNEL"
    "GJC_SESSION_TURN_EVIDENCE_PATTERN=$TURN_EVIDENCE_PATTERN"
    bash "$STATE_DIR/monitor.sh"
  )
  nohup "${MONITOR_CMD[@]}" >>"$STATE_DIR/monitor.log" 2>&1 &
  MONITOR_PID=$!
  printf '%s\n' "$MONITOR_PID" >"$STATE_DIR/monitor.pid"
  printf '[%s] monitor launched pid=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MONITOR_PID" >>"$STATE_DIR/events.log"
fi

# Optional Clawhip-style router registration. Private channel ids/mentions stay caller-owned.
if [[ "${GJC_SESSION_SKIP_ROUTER:-0}" != "1" && -n "$ROUTER_BIN" ]]; then
  STALE_MINUTES="${GJC_SESSION_STALE_MINUTES:-60}"
  KEYWORDS="${GJC_SESSION_KEYWORDS:-/skill:deep-interview,/skill:ralplan,gjc ultragoal,gjc team,deep-interview,ralplan,ultragoal,team,Ask 1 questions,Ask questions,Deep Interview · Round,Question}"
  WATCH_ARGS=(tmux watch --session "$SESSION" --stale-minutes "$STALE_MINUTES" --format compact)
  [[ -n "$KEYWORDS" ]] && WATCH_ARGS+=(--keywords "$KEYWORDS")
  [[ -n "$CHANNEL" ]] && WATCH_ARGS+=(--channel "$CHANNEL")
  [[ -n "$MENTION" ]] && WATCH_ARGS+=(--mention "$MENTION")
  set +e
  timeout 10s "$ROUTER_BIN" "${WATCH_ARGS[@]}"
  watch_rc=$?
  set -e
  if [[ "$watch_rc" -ne 0 && "$watch_rc" -ne 124 ]]; then
    echo "router watch registration failed for $SESSION (rc=$watch_rc); tmux session is still running" >&2
  fi
fi

sleep 2
if ! "${TMUX_CMD[@]}" has-session -t "$SESSION" 2>/dev/null; then
  echo "GJC session vanished immediately after launch: $SESSION" >&2
  show_recovery_hint
  exit 1
fi
if [[ -s "$STATE_DIR/final.json" ]] && ! has_turn_evidence; then
  echo "GJC owner exited before durable turn evidence: $SESSION" >&2
  show_recovery_hint
  exit 1
fi
if ! "${TMUX_CMD[@]}" list-panes -t "$SESSION" -F '#{pane_pid} #{pane_current_command}' >"$STATE_DIR/panes.txt" 2>/dev/null; then
  echo "GJC session has no readable panes after launch: $SESSION" >&2
  show_recovery_hint
  exit 1
fi

echo "created GJC session: $SESSION"
echo "  workdir: $WORKDIR"
echo "  branch:  $BRANCH"
echo "  state:   $STATE_DIR"
echo "  log:     $STATE_DIR/pane.log"
echo "  events:  $STATE_DIR/events.log"
echo "  final:   $STATE_DIR/final.json"
echo "  runtime: $RUNTIME_STATE_JSON"
echo "  vanish:  $STATE_DIR/vanished.json"
echo "  tail:    $(dirname "$0")/tail.sh $SESSION"
echo "  prompt:  $(dirname "$0")/prompt.sh $SESSION @/path/to/prompt.md"
