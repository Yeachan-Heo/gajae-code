#!/usr/bin/env bash
# Create a public-safe GJC tmux session through the owner-isolation protocol.
# Lifecycle records contain identifiers and classifications only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postmortem.sh
source "$SCRIPT_DIR/postmortem.sh"

[[ $# -eq 2 ]] || { echo "Usage: $0 <session-name> <worktree-path>" >&2; exit 2; }
SESSION="$1"
WORKDIR="$2"
GJC_BIN="${GJC_BIN-$(command -v gjc || true)}"
TMUX_BIN="${GJC_SESSION_TMUX_BIN:-tmux}"
STATE_DIR="${GJC_SESSION_STATE_DIR:-$WORKDIR/.gjc-session-state/$SESSION}"
RUNTIME_STATE_JSON="$STATE_DIR/runtime-state.json"
SOCKET_KEY="gjc-${SESSION//[^A-Za-z0-9_.-]/_}"
MONITOR_SESSION="${SESSION}-owner-monitor"


shell_join() { printf '%q ' "$@"; }
show_recovery_hint() {
  echo "durable metadata: $STATE_DIR/metadata.json" >&2
  echo "durable final status: $STATE_DIR/final.json" >&2
  echo "durable runtime state: $RUNTIME_STATE_JSON" >&2
  echo "durable vanished status: $STATE_DIR/vanished.json" >&2
}

if [[ -z "$GJC_BIN" ]] || { [[ "$GJC_BIN" == */* ]] && [[ ! -x "$GJC_BIN" ]]; } || { [[ "$GJC_BIN" != */* ]] && ! command -v "$GJC_BIN" >/dev/null 2>&1; }; then
  echo "gjc not found in PATH; set GJC_BIN" >&2
  exit 1
fi
[[ -d "$WORKDIR" ]] || { echo "directory not found: $WORKDIR" >&2; exit 1; }
git -C "$WORKDIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git worktree: $WORKDIR" >&2; exit 1; }
BRANCH="$(git -C "$WORKDIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
[[ -n "$BRANCH" && "$BRANCH" != HEAD ]] || { echo "could not determine branch/worktree name for: $WORKDIR" >&2; exit 1; }

mkdir -p "$STATE_DIR/$SESSION/owner-lifecycle"
LIFECYCLE_DIR="$STATE_DIR/$SESSION/owner-lifecycle"
GENERATION_JSON="$LIFECYCLE_DIR/generation.json"
exec 9>"${GENERATION_JSON%.json}.transition.lock"
flock -x 9
GJC_SESSION_TRANSITION_LOCK_HELD=1
reconcile_prior_generation() {
  local prior_generation prior_generation_kind
  [[ -f "$GENERATION_JSON" ]] || return 0
  IFS=$'\t' read -r prior_generation prior_generation_kind < <(python3 - "$GENERATION_JSON" "$SESSION" <<'PY'
import json, re, sys
uuid = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
safe_generation = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
try:
    with open(sys.argv[1], encoding="utf-8") as handle: record = json.load(handle)
    value = record.get("generation")
    if (set(record) in ({"schema_version", "session_id", "generation"}, {"schema_version", "session_id", "generation", "published_at"}) and record.get("schema_version") == 1
        and record.get("session_id") == sys.argv[2] and isinstance(value, str) and safe_generation.fullmatch(value)):
        print(f"{value}\t{'uuid' if uuid.fullmatch(value) else 'interrupted'}")
except (OSError, ValueError, TypeError):
    pass
PY
)
  [[ -n "$prior_generation" ]] || return 0
  if [[ "$prior_generation_kind" == interrupted ]]; then
    if python3 - "$LIFECYCLE_DIR/started-$prior_generation.json" "$SESSION" "$prior_generation" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle: started = json.load(handle)
    valid = (set(started) == {"schema_version", "kind", "session_id", "owner_generation"}
        and started["schema_version"] == 1 and started["kind"] == "started"
        and started["session_id"] == sys.argv[2] and started["owner_generation"] == sys.argv[3])
except (KeyError, OSError, TypeError, ValueError):
    valid = False
raise SystemExit(0 if valid else 1)
PY
    then
      echo "invalid existing generation lifecycle state" >&2
      return 1
    fi
    return 0
  fi

  # An exact pending SIGTERM intent belongs to the old owner. Give its observer a
  # short, bounded chance to publish before synthesizing the public-safe loss.
  if python3 - "$LIFECYCLE_DIR/intent-$prior_generation.json" "$SESSION" "$prior_generation" "$SOCKET_KEY" <<'PY'
import datetime, json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle: intent = json.load(handle)
    now = datetime.datetime.now(datetime.timezone.utc)
    created = datetime.datetime.fromisoformat(intent["created_at"].replace("Z", "+00:00"))
    expires = datetime.datetime.fromisoformat(intent["expires_at"].replace("Z", "+00:00"))
    valid = (set(intent) == {"schema_version", "intent_id", "generation", "session_id", "server_key", "expected_terminal", "dispatch_id", "created_at", "expires_at", "state"}
        and intent["schema_version"] == 1 and isinstance(intent["intent_id"], str) and bool(intent["intent_id"])
        and intent["generation"] == sys.argv[3] and intent["session_id"] == sys.argv[2] and intent["server_key"] == sys.argv[4]
        and intent["expected_terminal"] == {"signal": "SIGTERM", "result": "owner_term_then_session_cleanup"}
        and isinstance(intent["dispatch_id"], str) and bool(intent["dispatch_id"]) and intent["state"] == "pending" and created <= now < expires)
    raise SystemExit(0 if valid else 1)
except (KeyError, OSError, TypeError, ValueError):
    raise SystemExit(1)
PY
  then
    local deadline=$((SECONDS + ${GJC_SESSION_PENDING_VERDICT_GRACE_SECONDS:-3}))
    while (( SECONDS < deadline )) && [[ ! -f "$LIFECYCLE_DIR/verdict-$prior_generation.json" ]]; do sleep 0.1; done
  fi

  local reconciliation
  reconciliation="$(python3 - "$LIFECYCLE_DIR" "$SESSION" "$prior_generation" "$SOCKET_KEY" <<'PY'
import datetime, json, os, sys
lifecycle, session, generation, server_key = sys.argv[1:]
verdict_path = os.path.join(lifecycle, f"verdict-{generation}.json")
started_path = os.path.join(lifecycle, f"started-{generation}.json")
def immutable(path, record):
    temporary = f"{path}.{os.getpid()}.tmp"
    try:
        with open(temporary, "x", encoding="utf-8") as handle:
            json.dump(record, handle, separators=(",", ":")); handle.write("\n")
        os.link(temporary, path)
        return True
    except FileExistsError:
        return False
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass
def valid_started():
    try:
        with open(started_path, encoding="utf-8") as handle: started = json.load(handle)
        return (set(started) == {"schema_version", "kind", "session_id", "owner_generation"}
            and started["schema_version"] == 1 and started["kind"] == "started"
            and started["session_id"] == session and started["owner_generation"] == generation)
    except (KeyError, OSError, ValueError, TypeError): return False
if not valid_started():
    # A generation is not an owner until its exact started receipt exists.
    # Preserve any creation-failure receipt, but never turn pre-start interruption into owner loss.
    print("interrupted_creation")
    raise SystemExit(0)
if not os.path.exists(verdict_path):
    observed_at = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    verdict = {"schema_version": 1, "generation": generation, "session_id": session, "server_key": server_key, "observed_at": observed_at, "signal": "UNKNOWN", "exit_code": None, "result": "owner_lost", "observer": "replacement_reconciler", "classification": "unexpected_owner_loss", "reason": "tmux_session_missing", "dedupe_key": f"owner-loss:{session}:{generation}"}
    immutable(verdict_path, verdict)
print("reconciled")
PY
)"
  [[ "$reconciliation" == reconciled ]] || return 0
  if ! gjc_session_validate_raw_verdict "$LIFECYCLE_DIR/verdict-$prior_generation.json" "$GENERATION_JSON" "$SESSION" "$prior_generation" "$SOCKET_KEY"; then
    echo "invalid prior owner verdict: $prior_generation" >&2
    return 1
  fi
  python3 - "$LIFECYCLE_DIR/verdict-$prior_generation.json" "$LIFECYCLE_DIR/incident-$prior_generation.json" <<'PY'
import json, os, sys
verdict_path, incident_path = sys.argv[1:]
with open(verdict_path, encoding="utf-8") as handle:
    verdict = json.load(handle)
if verdict["classification"] != "unexpected_owner_loss":
    raise SystemExit(0)
incident = {"schema_version": 1, "generation": verdict["generation"], "session_id": verdict["session_id"], "dedupe_key": verdict["dedupe_key"], "created_at": verdict["observed_at"], "classification": "unexpected_owner_loss"}
temporary = f"{incident_path}.{os.getpid()}.tmp"
try:
    with open(temporary, "x", encoding="utf-8") as handle:
        json.dump(incident, handle, separators=(",", ":")); handle.write("\n")
    try:
        os.link(temporary, incident_path)
    except FileExistsError:
        with open(incident_path, encoding="utf-8") as handle:
            if json.load(handle) != incident: raise SystemExit(1)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY
  gjc_session_publish_current_alias "$LIFECYCLE_DIR/verdict-$prior_generation.json" "$STATE_DIR/verdict.json" "$GENERATION_JSON" "$SESSION" "$prior_generation"
  if [[ -f "$LIFECYCLE_DIR/incident-$prior_generation.json" ]]; then
    gjc_session_publish_current_alias "$LIFECYCLE_DIR/incident-$prior_generation.json" "$STATE_DIR/incident.json" "$GENERATION_JSON" "$SESSION" "$prior_generation" owner_incident
  fi
  for marker in vanished terminal final; do
    if [[ -f "$LIFECYCLE_DIR/$marker-$prior_generation.json" ]]; then
      local marker_kind="$marker"
      [[ "$marker" == final ]] && marker_kind=terminal
      gjc_session_publish_current_alias "$LIFECYCLE_DIR/$marker-$prior_generation.json" "$STATE_DIR/$marker.json" "$GENERATION_JSON" "$SESSION" "$prior_generation" "$marker_kind"
    fi
  done
}
validate_current_generation() {
  [[ -f "$GENERATION_JSON" ]] || return 0
  python3 - "$GENERATION_JSON" "$SESSION" <<'PY'
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle: record = json.load(handle)
    valid = (set(record) in ({"schema_version", "session_id", "generation"}, {"schema_version", "session_id", "generation", "published_at"})
        and record["schema_version"] == 1
        and record["session_id"] == sys.argv[2]
        and isinstance(record["generation"], str)
        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", record["generation"]))
except (OSError, TypeError, ValueError):
    valid = False
raise SystemExit(0 if valid else 1)
PY
}

# A live owner always wins while the complete generation transition is locked.
if ! validate_current_generation; then
  echo "invalid existing generation lifecycle state" >&2
  exit 1
fi

if "$TMUX_BIN" -L "$SOCKET_KEY" has-session -t "=$SESSION" >/dev/null 2>&1; then
  echo "tmux session already exists: $SESSION" >&2
  exit 1
fi
reconcile_prior_generation
GENERATION_BASELINE_JSON="$(python3 - "$GENERATION_JSON" "$SESSION" <<'PY'
import json, os, sys
path, session = sys.argv[1:]
if not os.path.exists(path):
    print('{"state":"absent"}')
else:
    with open(path, encoding="utf-8") as handle: record = json.load(handle)
    if record.get("schema_version") != 1 or record.get("session_id") != session or not isinstance(record.get("generation"), str) or not isinstance(record.get("published_at"), str): raise SystemExit(1)
    print(json.dumps({"state":"current", **record}, separators=(",", ":")))
PY
)" || { echo "generation baseline capture failed" >&2; exit 1; }

OWNER_GENERATION="$(python3 -c 'import uuid; print(uuid.uuid4())')"
WORKTREE_BASELINE_DIRTY="$(gjc_session_git_dirty_boolean "$WORKDIR")"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LIFECYCLE_DIR="$STATE_DIR/$SESSION/owner-lifecycle"
GENERATION_JSON="$LIFECYCLE_DIR/generation.json"
# Arm immutable failure recording before this generation becomes current.
ROLLBACK_ARMED=0
ROLLBACK_MONITOR_CREATED=0
ROLLBACK_OWNER_NATIVE_ID=""
ROLLBACK_OWNER_SERVER_PID=""
ROLLBACK_OWNER_SERVER_START_TIME=""
ROLLBACK_OWNER_SESSION_NAME=""
ROLLBACK_MONITOR_NATIVE_ID=""
ROLLBACK_MONITOR_SERVER_PID=""
ROLLBACK_MONITOR_SERVER_START_TIME=""
ROLLBACK_MONITOR_SESSION_NAME=""
CREATION_COMPLETE=0
CREATION_BOUNDARY=publication
ROLLBACK_FAILURES=""
record_rollback_identity() {
  local label="$1" target="$2" native_var="$3" pid_var="$4" start_var="$5" name_var="$6" receipt native_id server_pid server_start_time receipt_name
  if ! receipt="$("$TMUX_BIN" -L "$SOCKET_KEY" display-message -p -t "=$target:" -F $'#{session_id}\t#{pid}\t#{session_name}' 2>/dev/null)"; then
    ROLLBACK_FAILURES="${ROLLBACK_FAILURES:+$ROLLBACK_FAILURES,}${label}_identity_unverifiable"
    return 1
  fi
  IFS=$'\t' read -r native_id server_pid receipt_name <<<"$receipt"
  if [[ ! "$native_id" =~ ^\$[0-9]+$ || ! "$server_pid" =~ ^[1-9][0-9]*$ || "$receipt_name" != "$target" ]]; then
    ROLLBACK_FAILURES="${ROLLBACK_FAILURES:+$ROLLBACK_FAILURES,}${label}_identity_unverifiable"
    return 1
  fi
  if ! server_start_time="$(python3 - "$server_pid" <<'PY'
import sys
try:
    text = open(f"/proc/{sys.argv[1]}/stat", encoding="utf-8").read().strip()
    tail = text[text.rfind(")") + 2:].split()
    value = tail[19]
    if not value.isdigit() or int(value) <= 0: raise ValueError
    print(value)
except Exception:
    raise SystemExit(1)
PY
)"; then
    ROLLBACK_FAILURES="${ROLLBACK_FAILURES:+$ROLLBACK_FAILURES,}${label}_identity_unverifiable"
    return 1
  fi
  printf -v "$native_var" '%s' "$native_id"
  printf -v "$pid_var" '%s' "$server_pid"
  printf -v "$start_var" '%s' "$server_start_time"
  printf -v "$name_var" '%s' "$receipt_name"
}
rollback_attempt_session() {
  local label="$1" native_id="$2" server_pid="$3" server_start_time="$4" session_name="$5" condition response current_start_time
  if [[ ! "$native_id" =~ ^\$[0-9]+$ || ! "$server_pid" =~ ^[1-9][0-9]*$ || ! "$server_start_time" =~ ^[1-9][0-9]*$ || -z "$session_name" ]]; then
    ROLLBACK_FAILURES="${ROLLBACK_FAILURES:+$ROLLBACK_FAILURES,}${label}_identity_unverifiable"
    return 1
  fi
  if ! current_start_time="$(python3 - "$server_pid" <<'PY'
import sys
try:
    text = open(f"/proc/{sys.argv[1]}/stat", encoding="utf-8").read().strip()
    tail = text[text.rfind(")") + 2:].split()
    value = tail[19]
    if not value.isdigit() or int(value) <= 0: raise ValueError
    print(value)
except Exception:
    raise SystemExit(1)
PY
)" || [[ "$current_start_time" != "$server_start_time" ]]; then
    ROLLBACK_FAILURES="${ROLLBACK_FAILURES:+$ROLLBACK_FAILURES,}${label}_rollback_refused"
    return 1
  fi
  condition="#{&&:#{==:#{pid},${server_pid}},#{&&:#{==:#{session_id},${native_id}},#{==:#{session_name},${session_name}}}}"
  if ! response="$("$TMUX_BIN" -L "$SOCKET_KEY" if-shell -t "$native_id" -F "$condition" "kill-session -t '$native_id' ; display-message -p __gjc_creation_rollback_ok__" "display-message -p __gjc_creation_rollback_refused__" 2>/dev/null)"; then
    ROLLBACK_FAILURES="${ROLLBACK_FAILURES:+$ROLLBACK_FAILURES,}${label}_rollback_indeterminate"
    return 1
  fi
  case "$response" in
    __gjc_creation_rollback_ok__) return 0 ;;
    __gjc_creation_rollback_refused__) ROLLBACK_FAILURES="${ROLLBACK_FAILURES:+$ROLLBACK_FAILURES,}${label}_rollback_refused" ;;
    *) ROLLBACK_FAILURES="${ROLLBACK_FAILURES:+$ROLLBACK_FAILURES,}${label}_rollback_indeterminate" ;;
  esac
  return 1
}
rollback_attempt_sessions() {
  [[ "$ROLLBACK_ARMED" == 1 ]] || return 0
  local failed=0
  rollback_attempt_session owner_session "$ROLLBACK_OWNER_NATIVE_ID" "$ROLLBACK_OWNER_SERVER_PID" "$ROLLBACK_OWNER_SERVER_START_TIME" "$ROLLBACK_OWNER_SESSION_NAME" || failed=1
  if [[ "$ROLLBACK_MONITOR_CREATED" == 1 ]]; then
    rollback_attempt_session monitor_session "$ROLLBACK_MONITOR_NATIVE_ID" "$ROLLBACK_MONITOR_SERVER_PID" "$ROLLBACK_MONITOR_SERVER_START_TIME" "$ROLLBACK_MONITOR_SESSION_NAME" || failed=1
  fi
  return "$failed"
}

generation_is_current() {
  python3 - "$GENERATION_JSON" "$SESSION" "$OWNER_GENERATION" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle: current = json.load(handle)
    valid = current.get("schema_version") == 1 and current.get("session_id") == sys.argv[2] and current.get("generation") == sys.argv[3]
except (OSError, TypeError, ValueError):
    valid = False
raise SystemExit(0 if valid else 1)
PY
}

publish_creation_failure() {
  local status="$1"
  [[ "$CREATION_COMPLETE" == 0 ]] || return 0
  python3 - "$LIFECYCLE_DIR/creation-failed-$OWNER_GENERATION.json" "$SESSION" "$OWNER_GENERATION" "$CREATION_BOUNDARY" "$status" <<'PY'
import json, os, sys
path, session, generation, boundary, status = sys.argv[1:]
record = {"schema_version": 1, "kind": "creation_failed", "session_id": session, "owner_generation": generation, "boundary": boundary, "exit_code": int(status)}
temporary = f"{path}.{os.getpid()}.tmp"
try:
    with open(temporary, "x", encoding="utf-8") as handle: json.dump(record, handle, separators=(",", ":")); handle.write("\n")
    os.link(temporary, path)
except FileExistsError:
    with open(path, encoding="utf-8") as handle:
        if json.load(handle) != record: raise
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY
  if generation_is_current; then
    gjc_session_publish_current_alias "$LIFECYCLE_DIR/creation-failed-$OWNER_GENERATION.json" "$STATE_DIR/creation-state.json" "$GENERATION_JSON" "$SESSION" "$OWNER_GENERATION" creation_failed
  fi
}
publish_creation_cleanup_failure() {
  local status="$1" publication_failed="$2" canonical="$LIFECYCLE_DIR/creation-cleanup-failure-$OWNER_GENERATION.json"
  python3 - "$canonical" "$SESSION" "$OWNER_GENERATION" "$status" "$ROLLBACK_FAILURES" "$publication_failed" <<'PY' || return 1
import json, os, sys
canonical, session, generation, status, rollback, publication = sys.argv[1:]
record = {"schema_version": 1, "kind": "creation_cleanup_failed", "session_id": session, "owner_generation": generation, "exit_code": int(status), "rollback_failures": [value for value in rollback.split(",") if value], "failure_publication_failed": publication == "true"}
temporary = f"{canonical}.{os.getpid()}.tmp"
try:
    with open(temporary, "x", encoding="utf-8") as handle: json.dump(record, handle, separators=(",", ":")); handle.write("\n")
    try:
        os.link(temporary, canonical)
    except FileExistsError:
        with open(canonical, encoding="utf-8") as handle:
            if json.load(handle) != record: raise
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY
  if generation_is_current; then
    gjc_session_publish_current_alias "$canonical" "$STATE_DIR/creation-cleanup-failure.json" "$GENERATION_JSON" "$SESSION" "$OWNER_GENERATION" creation_cleanup_failed
  fi
}
creation_exit() { local status="$?" cleanup_failed=0 publication_failed=false; if [[ "$CREATION_COMPLETE" == 0 ]]; then if ! rollback_attempt_sessions; then cleanup_failed=1; fi; if ! publish_creation_failure "$status"; then cleanup_failed=1; publication_failed=true; fi; if [[ "$cleanup_failed" == 1 ]] && ! publish_creation_cleanup_failure "$status" "$publication_failed"; then echo "creation cleanup failure receipt unavailable" >&2; fi; fi; exit "$status"; }
trap creation_exit EXIT
rm -f "$STATE_DIR/started.json" "$STATE_DIR/prompt-accepted.json" "$STATE_DIR/terminal.json" "$STATE_DIR/final.json" "$STATE_DIR/recovery.json"
METADATA_CANONICAL="$LIFECYCLE_DIR/metadata-$OWNER_GENERATION.json"
python3 - "$METADATA_CANONICAL" "$SESSION" "$WORKDIR" "$BRANCH" "$CREATED_AT" "$GJC_BIN" "$STATE_DIR" "$RUNTIME_STATE_JSON" "$WORKTREE_BASELINE_DIRTY" "$OWNER_GENERATION" "$SOCKET_KEY" <<'PY'
import json
import sys
path, session, workdir, branch, created_at, gjc_bin, state_dir, runtime_state, baseline_dirty, generation, socket_key = sys.argv[1:]
with open(path, "x", encoding="utf-8") as handle:
    json.dump({
        "schema_version": 1, "session_id": session, "workdir": workdir,
        "branch": branch, "created_at": created_at, "gjc_bin": gjc_bin,
        "state_dir": state_dir, "runtime_state": runtime_state, "socket_key": socket_key,
        "worktree_baseline_dirty": None if baseline_dirty == "null" else baseline_dirty == "true",
        "owner_generation": generation,
    }, handle, separators=(",", ":"))
    handle.write("\n")
PY
CREATION_CANONICAL="$LIFECYCLE_DIR/creation-state-$OWNER_GENERATION.json"
gjc_session_write_public_marker "$CREATION_CANONICAL" creation_started "$SESSION" "$OWNER_GENERATION"
cat >"$STATE_DIR/runner.sh" <<'RUNNER'
#!/usr/bin/env bash
set +e
source "$GJC_SESSION_POSTMORTEM_SH"
write_terminal() {
  python3 - "$GJC_SESSION_FINAL_CANONICAL_JSON" "$GJC_SESSION_TERMINAL_CANONICAL_JSON" "$GJC_SESSION_NAME" "$GJC_SESSION_OWNER_GENERATION" "$1" "$2" "$3" "$GJC_COORDINATOR_SESSION_STATE_FILE" "$GJC_SESSION_WORKDIR" "$GJC_SESSION_WORKTREE_BASELINE_DIRTY" "$GJC_SESSION_PROMPT_ACCEPTED_JSON" <<'PY'
import json
import datetime
import os
import subprocess
import sys
(final_path, terminal_path, session, generation, status, started_at, finished_at, runtime_path, workdir, baseline, prompt_path) = sys.argv[1:]
def dirty(path):
    try:
        result = subprocess.run(["git", "-C", path, "status", "--porcelain"], check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return bool(result.stdout) if result.returncode == 0 else None
    except Exception:
        return None
runtime = {"present": False, "valid": False, "state": None, "sessionMatches": True, "cwdMatches": True, "generationMatches": True, "fresh": False, "terminal": False, "terminalState": None}
if runtime_path and os.path.isfile(runtime_path) and os.path.getsize(runtime_path):
    runtime["present"] = True
    try:
        with open(runtime_path, encoding="utf-8") as handle: data = json.load(handle)
        value = data.get("state")
        owner = data.get("session_id")
        cwd = data.get("cwd")
        runtime_generation = data.get("owner_generation")
        fresh_after = os.environ.get("GJC_SESSION_RUNTIME_FRESH_AFTER", "")
        approved_states = {"running", "needs_user_input", "completed", "errored"}
        runtime["sessionMatches"] = isinstance(owner, str) and bool(owner) and owner == session
        runtime["cwdMatches"] = isinstance(cwd, str) and bool(cwd) and os.path.realpath(cwd) == os.path.realpath(workdir)
        runtime["generationMatches"] = isinstance(runtime_generation, str) and bool(runtime_generation) and runtime_generation == generation
        try:
            fresh_at = datetime.datetime.fromisoformat(fresh_after.replace("Z", "+00:00"))
            runtime["fresh"] = datetime.datetime.fromtimestamp(os.stat(runtime_path).st_mtime, datetime.timezone.utc) >= fresh_at
        except (OSError, TypeError, ValueError):
            runtime["fresh"] = False
        runtime.update({"valid": value in approved_states and runtime["sessionMatches"] and runtime["cwdMatches"] and runtime["generationMatches"] and runtime["fresh"], "state": value if value in approved_states else None})
        runtime["terminal"] = runtime["valid"] and value in {"completed", "errored"}
        runtime["terminalState"] = value if runtime["terminal"] else None
    except Exception:
        pass
baseline_value = None if baseline == "null" else baseline == "true"
prompt_accepted = False
if os.path.isfile(prompt_path) and os.path.getsize(prompt_path) > 0:
    try:
        with open(prompt_path, encoding="utf-8") as handle:
            marker = json.load(handle)
        with open(os.path.join(os.environ["GJC_SESSION_STATE_DIR"], session, "owner-lifecycle", "generation.json"), encoding="utf-8") as handle:
            current_generation = json.load(handle).get("generation")
        prompt_accepted = (
            marker.get("schema_version") == 1
            and marker.get("kind") == "prompt_accepted"
            and marker.get("session_id") == session
            and marker.get("owner_generation") == generation
            and current_generation == generation
        )
        value = marker.get("worktree_baseline_dirty", marker.get("worktreeBaselineDirty"))
        if prompt_accepted and isinstance(value, bool): baseline_value = value
    except Exception: pass
current_dirty = dirty(workdir)
changed = baseline_value is False and current_dirty is True
if runtime["terminal"]:
    reason, severity = "terminal_runtime_cleanup", "normal"
elif prompt_accepted and changed:
    reason, severity = "accepted_prompt_observed_recoverable_worktree_changes", "failure"
elif prompt_accepted and current_dirty is True:
    reason, severity = "accepted_prompt_dirty_worktree_observed_without_new_change_proof", "failure"
elif prompt_accepted:
    reason, severity = "accepted_prompt_no_useful_output", "failure"
elif runtime["valid"] and runtime["sessionMatches"] and runtime["cwdMatches"] and runtime["state"] in {"running", "needs_user_input"}:
    reason, severity = "owner_exited_after_runtime_acknowledgement_before_terminal_status", "failure"
else:
    reason, severity = "owner_exited_before_prompt_acceptance", "failure"
terminal = {"schema_version": 1, "kind": "terminal", "session_id": session, "owner_generation": generation, "exit_code": int(status), "started_at": started_at, "finished_at": finished_at}
final = {**terminal, "runtime_state": runtime_path, "prompt_accepted": prompt_accepted, "owner_exit_reason": reason, "severity": severity, "runtime_terminal": runtime["terminal"], "runtime_terminal_state": runtime["terminalState"], "worktree_baseline_dirty": baseline_value, "observed_recoverable_worktree_changes": current_dirty is True, "worktree_changed_since_baseline": changed}
for path, value in ((terminal_path, terminal), (final_path, final)):
    temporary = f"{path}.{os.getpid()}.tmp"
    try:
        with open(temporary, "x", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":")); handle.write("\n")
        os.link(temporary, path)
    except FileExistsError:
        with open(path, encoding="utf-8") as handle:
            if json.load(handle) != value: raise
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass
PY
  gjc_session_publish_current_alias "$GJC_SESSION_TERMINAL_CANONICAL_JSON" "$GJC_SESSION_TERMINAL_JSON" "$GJC_SESSION_GENERATION_JSON" "$GJC_SESSION_NAME" "$GJC_SESSION_OWNER_GENERATION" terminal
  gjc_session_publish_current_alias "$GJC_SESSION_FINAL_CANONICAL_JSON" "$GJC_SESSION_FINAL_JSON" "$GJC_SESSION_GENERATION_JSON" "$GJC_SESSION_NAME" "$GJC_SESSION_OWNER_GENERATION" terminal
}
[[ $# -eq 4 && "$1" == --finalize ]] || exit 2
write_terminal "$2" "$3" "$4"
RUNNER
chmod +x "$STATE_DIR/runner.sh"
cat >"$STATE_DIR/supervisor.py" <<'SUPERVISOR'
import datetime
import json
import os
import signal
import subprocess
import sys


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


child = None
SIGNAL_NAMES = {signal.SIGTERM: "SIGTERM", signal.SIGINT: "SIGINT", signal.SIGHUP: "SIGHUP"}

def write_immutable(path, record, inject=None):
    if inject and os.environ.get("GJC_SESSION_TEST_FAIL_RECEIPT_WRITE") in {inject, inject.removesuffix("_canonical")}:
        raise OSError("injected receipt write failure")
    temporary = f"{path}.{os.getpid()}.tmp"
    try:
        with open(temporary, "x", encoding="utf-8") as handle:
            json.dump(record, handle, separators=(",", ":")); handle.write("\n")
        os.link(temporary, path)
    except FileExistsError:
        with open(path, encoding="utf-8") as handle:
            if json.load(handle) != record: raise
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass


def record_publication_failure(boundary):
    state_dir = os.environ["GJC_SESSION_STATE_DIR"]
    session = os.environ["GJC_SESSION_NAME"]
    generation = os.environ["GJC_SESSION_OWNER_GENERATION"]
    path = os.path.join(state_dir, session, "owner-lifecycle", f"failure-publication-{generation}-{boundary}.json")
    record = {"schema_version": 1, "kind": "failure_publication_failed", "session_id": session, "owner_generation": generation, "boundary": boundary}
    try:
        write_immutable(path, record)
    except (OSError, TypeError, ValueError):
        print("failure publication status unavailable", file=sys.stderr)


def publish_current_alias(canonical_path, alias_path, kind, inject=None):
    if inject and os.environ.get("GJC_SESSION_TEST_FAIL_RECEIPT_WRITE") == inject:
        raise OSError("injected receipt write failure")
    completed = subprocess.run(
        ["bash", "-c", 'source "$1"; gjc_session_publish_current_alias "$2" "$3" "$4" "$5" "$6" "$7"', "gjc-supervisor-failure-alias", os.environ["GJC_SESSION_POSTMORTEM_SH"], canonical_path, alias_path, os.path.join(os.environ["GJC_SESSION_STATE_DIR"], os.environ["GJC_SESSION_NAME"], "owner-lifecycle", "generation.json"), os.environ["GJC_SESSION_NAME"], os.environ["GJC_SESSION_OWNER_GENERATION"], kind],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=3,
        check=False,
    )
    if completed.returncode != 0:
        raise OSError("failure alias publication failed")




def observe(signum):
    signal_name = SIGNAL_NAMES.get(signum, "UNKNOWN")
    request = {
        "schema_version": 1,
        "op": "observe_terminal",
        "session_id": os.environ["GJC_SESSION_NAME"],
        "owner_generation": os.environ["GJC_SESSION_OWNER_GENERATION"],
        "state_dir": os.environ["GJC_SESSION_STATE_DIR"],
        "socket_key": os.environ["GJC_TMUX_OWNER_SERVER_KEY"],
        "observer": "raw_monitor",
        "observed_at": now(),
        "signal": signal_name,
        "exit_code": None,
        "exit_kind": "signal",
        "reason": "owner_supervisor_signal",
    }
    if signum == signal.SIGTERM:
        intent_path = os.path.join(
            os.environ["GJC_SESSION_STATE_DIR"],
            os.environ["GJC_SESSION_NAME"],
            "owner-lifecycle",
            f'intent-{os.environ["GJC_SESSION_OWNER_GENERATION"]}.json',
        )
        try:
            with open(intent_path, encoding="utf-8") as handle:
                intent = json.load(handle)
            if not isinstance(intent, dict) or not isinstance(intent.get("created_at"), str) or not isinstance(intent.get("expires_at"), str):
                raise ValueError("invalid intent timestamp fields")
            created_at = datetime.datetime.fromisoformat(intent["created_at"].replace("Z", "+00:00"))
            expires_at = datetime.datetime.fromisoformat(intent["expires_at"].replace("Z", "+00:00"))
            valid_intent = (
                isinstance(intent, dict)
                and set(intent) == {"schema_version", "intent_id", "generation", "session_id", "server_key", "expected_terminal", "dispatch_id", "created_at", "expires_at", "state"}
                and intent["schema_version"] == 1
                and isinstance(intent["intent_id"], str) and bool(intent["intent_id"])
                and intent["session_id"] == os.environ["GJC_SESSION_NAME"]
                and intent["generation"] == os.environ["GJC_SESSION_OWNER_GENERATION"]
                and intent["server_key"] == os.environ["GJC_TMUX_OWNER_SERVER_KEY"]
                and intent["state"] == "pending"
                and intent["expected_terminal"] == {"signal": "SIGTERM", "result": "owner_term_then_session_cleanup"}
                and isinstance(intent["dispatch_id"], str) and bool(intent["dispatch_id"])
                and created_at <= datetime.datetime.now(datetime.timezone.utc) < expires_at
            )
            if valid_intent:
                request["operator_dispatch_id"] = intent["dispatch_id"]
        except (KeyError, OSError, TypeError, ValueError):
            pass
    try:
        completed = subprocess.run(
            [os.environ["GJC_SESSION_GJC_BIN"], "--internal-tmux-owner-isolation"],
            input=f"{json.dumps(request, separators=(',', ':'))}\n",
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=3,
            check=False,
        )
        if completed.returncode != 0:
            raise ValueError("terminal observer adapter failed")
        verdict = json.loads(completed.stdout)
        state_dir = os.environ["GJC_SESSION_STATE_DIR"]
        session = os.environ["GJC_SESSION_NAME"]
        generation = os.environ["GJC_SESSION_OWNER_GENERATION"]
        lifecycle_dir = os.path.join(state_dir, session, "owner-lifecycle")
        generation_path = os.path.join(lifecycle_dir, "generation.json")
        canonical_path = os.path.join(lifecycle_dir, f"verdict-{generation}.json")
        with open(canonical_path, encoding="utf-8") as handle:
            canonical = json.load(handle)
        with open(generation_path, encoding="utf-8") as handle:
            current_generation = json.load(handle).get("generation")
        if not (
            current_generation == generation
            and verdict == canonical
            and verdict.get("schema_version") == 1
            and verdict.get("generation") == generation
            and verdict.get("session_id") == session
            and isinstance(verdict.get("classification"), str)
        ):
            raise ValueError("invalid canonical verdict")
        validated = subprocess.run(["bash", "-c", 'source "$1"; gjc_session_validate_raw_verdict "$2" "$3" "$4" "$5" "$6"', "gjc-supervisor-verdict", os.environ["GJC_SESSION_POSTMORTEM_SH"], canonical_path, generation_path, session, generation, os.environ["GJC_TMUX_OWNER_SERVER_KEY"]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False)
        if validated.returncode != 0:
            raise ValueError("invalid full canonical verdict")
        subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; gjc_session_publish_current_alias "$2" "$3" "$4" "$5" "$6"',
                "gjc-supervisor-alias",
                os.environ["GJC_SESSION_POSTMORTEM_SH"],
                canonical_path,
                os.path.join(state_dir, "verdict.json"),
                generation_path,
                session,
                generation,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
            check=True,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        state_dir = os.environ["GJC_SESSION_STATE_DIR"]
        session = os.environ["GJC_SESSION_NAME"]
        generation = os.environ["GJC_SESSION_OWNER_GENERATION"]
        record = {"schema_version": 1, "kind": "supervisor_failure", "session_id": session, "owner_generation": generation, "reason": "observer_or_alias_validation_failed"}
        try:
            canonical_path = os.path.join(state_dir, session, "owner-lifecycle", f"supervisor-failure-{generation}.json")
            write_immutable(canonical_path, record, "supervisor_failure_canonical")
            publish_current_alias(canonical_path, os.path.join(state_dir, "supervisor-failure.json"), "supervisor_failure", "supervisor_failure_alias")

        except (OSError, TypeError, ValueError, subprocess.SubprocessError):


            print("supervisor failure receipt publication unavailable", file=sys.stderr)
            record_publication_failure("supervisor_failure")





def forward(signum, _frame):
    observe(signum)
    if child is None:
        return
    try:
        child.send_signal(signum)
    except ProcessLookupError:
        pass


for handled_signal in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(handled_signal, forward)

started_at = now()
command = [os.environ["GJC_SESSION_GJC_BIN"]]
try:
    child = subprocess.Popen(command, cwd=os.environ["GJC_SESSION_WORKDIR"])
    status = child.wait()
except OSError:
    status = 127
exit_code = status if status >= 0 else 128 - status
finalized = subprocess.run(
    ["bash", os.environ["GJC_SESSION_RUNNER_SH"], "--finalize", str(exit_code), started_at, now()],
    check=False,
)
if finalized.returncode != 0:
    state_dir = os.environ["GJC_SESSION_STATE_DIR"]
    session = os.environ["GJC_SESSION_NAME"]
    generation = os.environ["GJC_SESSION_OWNER_GENERATION"]
    record = {"schema_version": 1, "kind": "finalization_failed", "session_id": session, "owner_generation": generation, "owner_exit_code": exit_code, "finalizer_exit_code": finalized.returncode}
    try:
        canonical_path = os.path.join(state_dir, session, "owner-lifecycle", f"finalization-failure-{generation}.json")
        write_immutable(canonical_path, record, "finalization_failure_canonical")
        publish_current_alias(canonical_path, os.path.join(state_dir, "finalization-failure.json"), "finalization_failed", "finalization_failure_alias")
    except (OSError, TypeError, ValueError, subprocess.SubprocessError):
        print("finalization failure receipt publication unavailable", file=sys.stderr)
        record_publication_failure("finalization_failure")
raise SystemExit(exit_code)
SUPERVISOR
chmod 700 "$STATE_DIR/supervisor.py"

LAUNCH=(env "GJC_SESSION_NAME=$SESSION" "GJC_SESSION_WORKDIR=$WORKDIR" "GJC_SESSION_BRANCH=$BRANCH" "GJC_SESSION_STATE_DIR=$STATE_DIR" "GJC_SESSION_OWNER_GENERATION=$OWNER_GENERATION" "GJC_SESSION_RUNTIME_FRESH_AFTER=$CREATED_AT" "GJC_SESSION_STARTED_JSON=$STATE_DIR/started.json" "GJC_SESSION_TERMINAL_JSON=$STATE_DIR/terminal.json" "GJC_SESSION_TERMINAL_CANONICAL_JSON=$LIFECYCLE_DIR/terminal-$OWNER_GENERATION.json" "GJC_SESSION_FINAL_JSON=$STATE_DIR/final.json" "GJC_SESSION_FINAL_CANONICAL_JSON=$LIFECYCLE_DIR/final-$OWNER_GENERATION.json" "GJC_SESSION_GENERATION_JSON=$GENERATION_JSON" "GJC_COORDINATOR_SESSION_ID=$SESSION" "GJC_COORDINATOR_SESSION_BRANCH=$BRANCH" "GJC_COORDINATOR_SESSION_STATE_FILE=$RUNTIME_STATE_JSON" "GJC_TMUX_OWNER_GENERATION=$OWNER_GENERATION" "GJC_TMUX_OWNER_STATE_DIR=$STATE_DIR" "GJC_TMUX_OWNER_SERVER_KEY=$SOCKET_KEY" "GJC_SESSION_PROMPT_ACCEPTED_JSON=$STATE_DIR/prompt-accepted.json" "GJC_SESSION_WORKTREE_BASELINE_DIRTY=$WORKTREE_BASELINE_DIRTY" "GJC_SESSION_GJC_BIN=$GJC_BIN" "GJC_SESSION_RUNNER_SH=$STATE_DIR/runner.sh" "GJC_SESSION_POSTMORTEM_SH=$SCRIPT_DIR/postmortem.sh" python3 "$STATE_DIR/supervisor.py")
LAUNCH_SHELL="$(shell_join "${LAUNCH[@]}")"
TMUX_ARGV=("$TMUX_BIN" -L "$SOCKET_KEY" new-session -d -P -F '#{session_id}' -s "$SESSION" -c "$WORKDIR" -n gjc "$LAUNCH_SHELL")
PLAN_LINE="$(python3 - "$SESSION" "$OWNER_GENERATION" "$WORKDIR" "$STATE_DIR" "$SOCKET_KEY" "$GENERATION_BASELINE_JSON" "${TMUX_ARGV[@]}" <<'PY'
import json, sys
session, generation, cwd, state_dir, socket_key, baseline, *argv = sys.argv[1:]
print(json.dumps({"schema_version": 1, "op": "plan", "platform": "linux", "session_id": session, "owner_generation": generation, "cwd": cwd, "state_dir": state_dir, "socket_key": socket_key, "tmux_argv": argv, "baseline": json.loads(baseline)}, separators=(",", ":")))
PY
)"
PLAN_RESPONSE="$(printf '%s\n' "$PLAN_LINE" | "$GJC_BIN" --internal-tmux-owner-isolation)" || { echo "owner-isolation plan protocol failed" >&2; exit 1; }
PLAN_MODE="$(python3 - "$PLAN_RESPONSE" "$SESSION" "$OWNER_GENERATION" "$STATE_DIR" "$SOCKET_KEY" "$GENERATION_BASELINE_JSON" "${TMUX_ARGV[@]}" <<'PY'
import datetime, json, sys
try:
    response = json.loads(sys.argv[1]); session, generation, state_dir, socket_key, baseline_json, argv = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7:]; execution = response["execution"]
    classification = response.get("classification", {}).get("classification")
    common = response.get("schema_version") == 1 and response.get("ok") is True and execution.get("attempt_session") == session
    if execution.get("mode") == "direct":
        valid = common and response.get("code") == "not_required" and response.get("server_state") in {"safe", "absent"} and classification in {"safe", "not_applicable"} and execution.get("argv") == argv and execution.get("server_key") == socket_key and execution.get("server_absent_before") == (response.get("server_state") == "absent")
    elif execution.get("mode") == "scoped":
        attempt = execution.get("attempt"); token = attempt.get("token") if isinstance(attempt, dict) else None
        expected_scope = f"gjc-owner-{token}.scope" if isinstance(token, str) and token else None
        expires_at = attempt.get("expires_at") if isinstance(attempt, dict) else None
        baseline = attempt.get("baseline") if isinstance(attempt, dict) else None
        expected_baseline = json.loads(baseline_json)
        bootstrap = json.loads(execution.get("stdin_line"))
        scoped_argv = execution.get("argv")
        expiry_valid = isinstance(expires_at, str) and datetime.datetime.fromisoformat(expires_at.replace("Z", "+00:00")) > datetime.datetime.now(datetime.timezone.utc)
        valid = (
            common and response.get("code") == "unsafe_scope_required" and response.get("server_state") == "absent" and classification == "unsafe_service"
            and isinstance(scoped_argv, list) and scoped_argv[:6] == ["systemd-run", "--user", "--scope", "--quiet", "--unit", expected_scope] and len(scoped_argv) in {8, 9} and scoped_argv[-1] == "--internal-tmux-owner-isolation" and "bash" not in scoped_argv and "-c" not in scoped_argv
            and attempt == {"token": token, "session_name": session, "socket_key": socket_key, "server_absent_before": True, "baseline": expected_baseline, "expires_at": expires_at}
            and execution.get("server_key") == socket_key and execution.get("server_absent_before") is True
            and expiry_valid and execution.get("expected_scope") == expected_scope
            and bootstrap == {"schema_version": 1, "op": "bootstrap", "session_id": session, "owner_generation": generation, "state_dir": state_dir, "socket_key": socket_key, "expected_scope": expected_scope, "tmux_argv": argv, "attempt": attempt}
        )
    else:
        valid = False
    if not valid: raise ValueError()
    print(execution["mode"])
except Exception: raise SystemExit(1)
PY
)" || { echo "owner-isolation plan response rejected" >&2; exit 1; }
# From this point every execution path owns only this fresh socket/session attempt.
ROLLBACK_ARMED=1
CREATION_BOUNDARY=bootstrap

if [[ "$PLAN_MODE" == direct ]]; then
  "${TMUX_ARGV[@]}" 9>&- || { echo "owner-isolation direct creation failed" >&2; exit 1; }
else
  mapfile -d '' -t SCOPED_ARGV < <(python3 - "$PLAN_RESPONSE" <<'PY'
import json, sys
for item in json.loads(sys.argv[1])["execution"]["argv"]: sys.stdout.buffer.write(item.encode() + b"\0")
PY
)
  BOOTSTRAP_LINE="$(python3 - "$PLAN_RESPONSE" <<'PY'
import json, sys
print(json.loads(sys.argv[1])["execution"]["stdin_line"])
PY
)"
  BOOTSTRAP_RESPONSE="$(printf '%s\n' "$BOOTSTRAP_LINE" | "${SCOPED_ARGV[@]}" 9>&-)" || { echo "owner-isolation scoped bootstrap failed" >&2; exit 1; }
  python3 - "$BOOTSTRAP_RESPONSE" <<'PY' || { echo "owner-isolation scope proof failed" >&2; exit 1; }
import json, sys
response = json.loads(sys.argv[1])
if response.get("schema_version") != 1 or response.get("ok") is not True or response.get("code") != "bootstrapped": raise SystemExit(1)
PY
fi
"$TMUX_BIN" -L "$SOCKET_KEY" has-session -t "=$SESSION" >/dev/null 2>&1 || { echo "owner-isolation did not prove a created session" >&2; show_recovery_hint; exit 1; }
record_rollback_identity owner_session "$SESSION" ROLLBACK_OWNER_NATIVE_ID ROLLBACK_OWNER_SERVER_PID ROLLBACK_OWNER_SERVER_START_TIME ROLLBACK_OWNER_SESSION_NAME || { echo "owner-isolation rollback identity receipt failed" >&2; show_recovery_hint; exit 1; }

CREATION_BOUNDARY=postspawn

POST_SPAWN_RESPONSE="$(printf '%s\n' "$PLAN_LINE" | "$GJC_BIN" --internal-tmux-owner-isolation)" || { echo "owner-isolation post-spawn proof failed" >&2; show_recovery_hint; exit 1; }
python3 - "$POST_SPAWN_RESPONSE" "$SESSION" "$SOCKET_KEY" "$ROLLBACK_OWNER_SERVER_PID" "$ROLLBACK_OWNER_SERVER_START_TIME" <<'PY' || { echo "owner-isolation post-spawn server proof rejected" >&2; show_recovery_hint; exit 1; }
import json
import sys
try:
    response = json.loads(sys.argv[1])
    execution = response.get("execution", {})
    valid = (
        response.get("schema_version") == 1
        and response.get("ok") is True
        and response.get("server_state") == "safe"
        and response.get("classification", {}).get("classification") == "safe"
        and execution.get("mode") == "direct"
        and execution.get("attempt_session") == sys.argv[2]
        and execution.get("server_key") == sys.argv[3]
        and execution.get("server_absent_before") is False
        and execution.get("server_pid") == int(sys.argv[4])
        and execution.get("server_start_time") == sys.argv[5]
    )
except Exception:
    valid = False
raise SystemExit(0 if valid else 1)
PY
CREATION_BOUNDARY=tag
OWNER_TAG_CONDITION="#{&&:#{==:#{pid},${ROLLBACK_OWNER_SERVER_PID}},#{&&:#{==:#{session_id},${ROLLBACK_OWNER_NATIVE_ID}},#{==:#{session_name},${ROLLBACK_OWNER_SESSION_NAME}}}}"
for option_value in \
  "@gjc-profile=1" \
  "@gjc-session-id=$SESSION" \
  "@gjc-session-state-file=$RUNTIME_STATE_JSON" \
  "@gjc-owner-generation=$OWNER_GENERATION" \
  "@gjc-owner-server-key=$SOCKET_KEY"; do
  option="${option_value%%=*}"
  value="${option_value#*=}"
  current_start_time="$(python3 - "$ROLLBACK_OWNER_SERVER_PID" <<'PY'
import sys
try:
    text = open(f"/proc/{sys.argv[1]}/stat", encoding="utf-8").read().strip()
    tail = text[text.rfind(")") + 2:].split()
    value = tail[19]
    if not value.isdigit() or int(value) <= 0: raise ValueError
    print(value)
except Exception:
    raise SystemExit(1)
PY
)" || { echo "failed to revalidate isolated tmux owner server start time" >&2; show_recovery_hint; exit 1; }
  if [[ "$current_start_time" != "$ROLLBACK_OWNER_SERVER_START_TIME" ]]; then
    echo "refusing to tag replacement tmux owner server" >&2
    show_recovery_hint
    exit 1
  fi
  tag_command="$(shell_join set-option -t "$ROLLBACK_OWNER_NATIVE_ID" "$option" "$value")"
  tag_response="$("$TMUX_BIN" -L "$SOCKET_KEY" if-shell -t "$ROLLBACK_OWNER_NATIVE_ID" -F "$OWNER_TAG_CONDITION" "$tag_command" "display-message -p __gjc_owner_tag_refused__" 2>/dev/null)" || {
    echo "failed to tag isolated tmux owner session: $option" >&2
    show_recovery_hint
    exit 1
  }
  if [[ -n "$tag_response" ]]; then
    echo "refusing to tag replacement tmux owner session: $option" >&2
    show_recovery_hint
    exit 1
  fi
done
CREATION_BOUNDARY=generation
GENERATION_PUBLISH_REQUEST="$(python3 - "$SESSION" "$OWNER_GENERATION" "$STATE_DIR" "$GENERATION_BASELINE_JSON" <<'PY'
import json, sys
session, generation, state_dir, baseline = sys.argv[1:]
print(json.dumps({"schema_version":1,"op":"publish_generation","session_id":session,"owner_generation":generation,"state_dir":state_dir,"baseline":json.loads(baseline)}, separators=(",", ":")))
PY
)"
GENERATION_PUBLISH_RESPONSE="$(printf '%s\n' "$GENERATION_PUBLISH_REQUEST" | "$GJC_BIN" --internal-tmux-owner-isolation)" || { echo "generation publication protocol failed" >&2; exit 1; }
python3 - "$GENERATION_PUBLISH_RESPONSE" "$OWNER_GENERATION" <<'PY' || { echo "generation publication rejected" >&2; exit 1; }
import json, sys
try:
    response = json.loads(sys.argv[1])
    valid = response == {"schema_version":1,"ok":True,"code":"generation_published","generation":sys.argv[2]}
except (TypeError, ValueError):
    valid = False
raise SystemExit(0 if valid else 1)
PY
gjc_session_publish_current_alias "$METADATA_CANONICAL" "$STATE_DIR/metadata.json" "$GENERATION_JSON" "$SESSION" "$OWNER_GENERATION"
gjc_session_publish_current_alias "$CREATION_CANONICAL" "$STATE_DIR/creation-state.json" "$GENERATION_JSON" "$SESSION" "$OWNER_GENERATION" creation_started
STARTED_CANONICAL="$LIFECYCLE_DIR/started-$OWNER_GENERATION.json"
gjc_session_write_public_marker "$STARTED_CANONICAL" started "$SESSION" "$OWNER_GENERATION"
gjc_session_publish_current_alias "$STARTED_CANONICAL" "$STATE_DIR/started.json" "$GENERATION_JSON" "$SESSION" "$OWNER_GENERATION" started
LIFECYCLE_DIR="$STATE_DIR/$SESSION/owner-lifecycle"
GENERATION_JSON="$LIFECYCLE_DIR/generation.json"
RECOVERY_RESULT="$(python3 - "$STATE_DIR/incident.json" "$LIFECYCLE_DIR" "$LIFECYCLE_DIR/recovery-$OWNER_GENERATION.json" "$SESSION" "$OWNER_GENERATION" <<'PY'
import json, os, sys
incident_path, lifecycle_dir, recovery_path, session, generation = sys.argv[1:]
try:
    with open(incident_path, encoding="utf-8") as handle: incident = json.load(handle)
    prior_generation, dedupe = incident.get("owner_generation"), incident.get("incident_dedupe")
    with open(os.path.join(lifecycle_dir, f"incident-{prior_generation}.json"), encoding="utf-8") as handle: canonical = json.load(handle)
    valid = (incident.get("schema_version") == 1 and incident.get("kind") == "owner_incident" and incident.get("session_id") == session and isinstance(prior_generation, str) and prior_generation and prior_generation != generation and dedupe == f"{session}:{prior_generation}" and canonical.get("schema_version") == 1 and canonical.get("session_id") == session and canonical.get("generation") == prior_generation and canonical.get("dedupe_key") == f"owner-loss:{session}:{prior_generation}" and canonical.get("classification") == "unexpected_owner_loss")
except Exception:
    valid = False
if not valid:
    print("0")
    raise SystemExit(0)
for name in os.listdir(lifecycle_dir):
    if not name.startswith("recovery-") or not name.endswith(".json"):
        continue
    try:
        with open(os.path.join(lifecycle_dir, name), encoding="utf-8") as handle: recovery = json.load(handle)
        recovered = (set(recovery) == {"schema_version", "kind", "session_id", "owner_generation", "prior_owner_generation", "prior_incident_dedupe"}
            and recovery["schema_version"] == 1 and recovery["kind"] == "owner_recovered"
            and recovery["session_id"] == session and isinstance(recovery["owner_generation"], str) and recovery["owner_generation"]
            and name == f"recovery-{recovery['owner_generation']}.json"
            and recovery["prior_owner_generation"] == prior_generation and recovery["prior_incident_dedupe"] == dedupe)
        if recovered:
            os.unlink(incident_path)
            print("0")
            raise SystemExit(0)
    except (KeyError, OSError, ValueError, TypeError):
        continue
record = {"schema_version": 1, "kind": "owner_recovered", "session_id": session, "owner_generation": generation, "prior_owner_generation": prior_generation, "prior_incident_dedupe": dedupe}
temporary = f"{recovery_path}.{os.getpid()}.tmp"
try:
    with open(temporary, "x", encoding="utf-8") as handle: json.dump(record, handle, separators=(",", ":")); handle.write("\n")
    os.link(temporary, recovery_path)
except FileExistsError:
    with open(recovery_path, encoding="utf-8") as handle:
        if json.load(handle) != record: raise
    print("0")
else:
    os.unlink(incident_path)
    print(f"1:{dedupe}")
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY
)"
if [[ "$RECOVERY_RESULT" == 1:* ]]; then
  gjc_session_publish_current_alias "$LIFECYCLE_DIR/recovery-$OWNER_GENERATION.json" "$STATE_DIR/recovery.json" "$GENERATION_JSON" "$SESSION" "$OWNER_GENERATION" owner_recovered || { echo "failed to publish recovery lifecycle alias" >&2; exit 1; }
fi

cat >"$STATE_DIR/monitor.sh" <<'MONITOR'
#!/usr/bin/env bash
set -euo pipefail
source "$GJC_SESSION_POSTMORTEM_SH"
interval="${GJC_SESSION_MONITOR_INTERVAL:-5}"
case "$interval" in ''|*[!0-9]*) interval=5 ;; esac
(( interval >= 1 )) || interval=1
last_seen_ms="$(date +%s%3N)"
while true; do
  probe_started_ms="$(date +%s%3N)"
  if timeout 1s "$GJC_SESSION_TMUX_BIN" -L "$GJC_SESSION_SOCKET_KEY" has-session -t "=$GJC_SESSION_NAME" >/dev/null 2>&1; then
    last_seen_ms="$probe_started_ms"
    sleep "$interval"
    continue
  else
    probe_rc=$?
  fi
  [[ "$probe_rc" -eq 1 ]] && break
  sleep 1
done
observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
request="$(python3 - "$GJC_SESSION_NAME" "$GJC_SESSION_OWNER_GENERATION" "$GJC_SESSION_STATE_DIR" "$GJC_SESSION_SOCKET_KEY" "$observed_at" <<'PY'
import json, sys
session, generation, state_dir, socket_key, observed_at = sys.argv[1:]
print(json.dumps({"schema_version":1,"op":"observe_terminal","session_id":session,"owner_generation":generation,"state_dir":state_dir,"socket_key":socket_key,"observer":"raw_monitor","observed_at":observed_at,"signal":"UNKNOWN","exit_code":None,"exit_kind":"owner_lost","reason":"tmux_session_missing"}, separators=(",", ":")))
PY
)"
deadline_at_ms=$((last_seen_ms + 7000))
verdict=""
while true; do
  now_ms="$(date +%s%3N)"
  remaining_ms=$((deadline_at_ms - now_ms))
  (( remaining_ms > 0 )) || break
  remaining_seconds="$(printf '%d.%03d' "$((remaining_ms / 1000))" "$((remaining_ms % 1000))")"
  if verdict="$(printf '%s\n' "$request" | timeout "${remaining_seconds}s" "$GJC_SESSION_GJC_BIN" --internal-tmux-owner-isolation)"; then break; fi
  verdict=""; sleep 1
done
now_ms="$(date +%s%3N)"
if [[ -z "$verdict" || "$now_ms" -ge "$deadline_at_ms" ]]; then
  monitor_failure_canonical="$GJC_SESSION_STATE_DIR/$GJC_SESSION_NAME/owner-lifecycle/monitor-failure-$GJC_SESSION_OWNER_GENERATION.json"
  python3 - "$monitor_failure_canonical" "$GJC_SESSION_NAME" "$GJC_SESSION_OWNER_GENERATION" <<'PY'
import json, os, sys
path, session, generation = sys.argv[1:]
record = {"schema_version":1,"kind":"monitor_failure","session_id":session,"owner_generation":generation,"reason":"observer_timeout_or_failure"}
temporary = f"{path}.{os.getpid()}.tmp"
try:
    with open(temporary, "x", encoding="utf-8") as handle: json.dump(record, handle, separators=(",", ":")); handle.write("\n")
    try:
        os.link(temporary, path)
    except FileExistsError:
        with open(path, encoding="utf-8") as handle:
            if json.load(handle) != record: raise
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY
  gjc_session_publish_current_alias "$monitor_failure_canonical" "$GJC_SESSION_STATE_DIR/monitor-failure.json" "$GJC_SESSION_GENERATION_JSON" "$GJC_SESSION_NAME" "$GJC_SESSION_OWNER_GENERATION" monitor_failure || exit 1
  exit 1
fi
within_recovery_deadline() { [[ "$(date +%s%3N)" -lt "$deadline_at_ms" ]]; }

within_recovery_deadline || exit 1
gjc_session_validate_raw_verdict "$GJC_SESSION_VERDICT_CANONICAL_JSON" "$GJC_SESSION_GENERATION_JSON" "$GJC_SESSION_NAME" "$GJC_SESSION_OWNER_GENERATION" "$GJC_SESSION_SOCKET_KEY" || exit 1
within_recovery_deadline || exit 1
classification="$(python3 - "$GJC_SESSION_VERDICT_CANONICAL_JSON" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle: print(json.load(handle)["classification"])
PY
)"
within_recovery_deadline || exit 1
gjc_session_publish_current_alias "$GJC_SESSION_VERDICT_CANONICAL_JSON" "$GJC_SESSION_VERDICT_JSON" "$GJC_SESSION_GENERATION_JSON" "$GJC_SESSION_NAME" "$GJC_SESSION_OWNER_GENERATION" || exit 1
within_recovery_deadline || exit 1
if [[ "$classification" == unexpected_owner_loss ]]; then
  within_recovery_deadline || exit 1
  gjc_session_write_vanished_json "$GJC_SESSION_VANISHED_CANONICAL_JSON" "$GJC_SESSION_NAME" "$GJC_SESSION_WORKDIR" tmux_session_missing owner_lost failure false false "$GJC_SESSION_OWNER_GENERATION"
  within_recovery_deadline || exit 1
  gjc_session_publish_current_alias "$GJC_SESSION_VANISHED_CANONICAL_JSON" "$GJC_SESSION_VANISHED_JSON" "$GJC_SESSION_GENERATION_JSON" "$GJC_SESSION_NAME" "$GJC_SESSION_OWNER_GENERATION" || exit 1
  within_recovery_deadline || exit 1
  gjc_session_publish_current_alias "$GJC_SESSION_INCIDENT_CANONICAL_JSON" "$GJC_SESSION_INCIDENT_JSON" "$GJC_SESSION_GENERATION_JSON" "$GJC_SESSION_NAME" "$GJC_SESSION_OWNER_GENERATION" owner_incident || exit 1
  within_recovery_deadline || exit 1
fi
MONITOR
chmod +x "$STATE_DIR/monitor.sh"
CREATION_BOUNDARY=monitor

if [[ "${GJC_SESSION_MONITOR_DISABLE:-0}" != 1 ]]; then
  MONITOR_LAUNCH=(env "GJC_SESSION_NAME=$SESSION" "GJC_SESSION_WORKDIR=$WORKDIR" "GJC_SESSION_OWNER_GENERATION=$OWNER_GENERATION" "GJC_SESSION_STATE_DIR=$STATE_DIR" "GJC_SESSION_SOCKET_KEY=$SOCKET_KEY" "GJC_SESSION_TMUX_BIN=$TMUX_BIN" "GJC_SESSION_GJC_BIN=$GJC_BIN" "GJC_SESSION_POSTMORTEM_SH=$SCRIPT_DIR/postmortem.sh" "GJC_SESSION_GENERATION_JSON=$GENERATION_JSON" "GJC_SESSION_VERDICT_JSON=$STATE_DIR/verdict.json" "GJC_SESSION_VERDICT_CANONICAL_JSON=$LIFECYCLE_DIR/verdict-$OWNER_GENERATION.json" "GJC_SESSION_VANISHED_JSON=$STATE_DIR/vanished.json" "GJC_SESSION_VANISHED_CANONICAL_JSON=$LIFECYCLE_DIR/vanished-$OWNER_GENERATION.json" "GJC_SESSION_INCIDENT_JSON=$STATE_DIR/incident.json" "GJC_SESSION_INCIDENT_CANONICAL_JSON=$LIFECYCLE_DIR/incident-$OWNER_GENERATION.json" "GJC_SESSION_MONITOR_INTERVAL=${GJC_SESSION_MONITOR_INTERVAL:-5}" bash "$STATE_DIR/monitor.sh")
  "$TMUX_BIN" -L "$SOCKET_KEY" new-session -d -s "$MONITOR_SESSION" -c "$WORKDIR" -n owner-monitor "$(shell_join "${MONITOR_LAUNCH[@]}")" || { echo "owner monitor creation failed" >&2; exit 1; }
  ROLLBACK_MONITOR_CREATED=1
  record_rollback_identity monitor_session "$MONITOR_SESSION" ROLLBACK_MONITOR_NATIVE_ID ROLLBACK_MONITOR_SERVER_PID ROLLBACK_MONITOR_SERVER_START_TIME ROLLBACK_MONITOR_SESSION_NAME || { echo "owner monitor rollback identity receipt failed" >&2; exit 1; }
fi
CREATION_COMPLETE=1
ROLLBACK_ARMED=0
trap - EXIT
flock -u 9
exec 9>&-
unset GJC_SESSION_TRANSITION_LOCK_HELD
printf 'created GJC session: %s\n' "$SESSION"
printf '  workdir: %s\n  branch: %s\n  state: %s\n' "$WORKDIR" "$BRANCH" "$STATE_DIR"
printf '  markers: creation-state.json started.json terminal.json final.json verdict.json incident.json recovery.json\n'
