#!/usr/bin/env bash
# Disposable, public-safe evidence for issue #1938. It never targets a GJC
# gateway, reads panes, inspects caller worktrees, or restarts shared units.
set -u -o pipefail

usage() { echo "Usage: $0 --phase pre-code|post-code --session-id <id>" >&2; exit 2; }
[[ $# -eq 4 ]] || usage
PHASE="" SESSION_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="${2:-}"; shift 2 ;;
    --session-id) SESSION_ID="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$PHASE" == pre-code || "$PHASE" == post-code ]] || usage
[[ "$SESSION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || usage

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EVIDENCE_DIR="$REPO_ROOT/.gjc/_session-$SESSION_ID/runtime/evidence/issue-1938"
EVIDENCE_PATH="$EVIDENCE_DIR/$PHASE.json"


now() {
  if [[ "${GJC_ISSUE1938_TEST_DISABLE_PYTHON:-}" != 1 ]] && command -v python3 >/dev/null 2>&1; then
    python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))'
  elif [[ "${GJC_ISSUE1938_TEST_DISABLE_BUN:-}" != 1 ]] && command -v bun >/dev/null 2>&1; then
    bun -e 'console.log(new Date().toISOString())'
  else
    date -u +%Y-%m-%dT%H:%M:%SZ
  fi
}
LINUX=false; [[ "$(uname -s)" == Linux ]] && LINUX=true
PROC=false; [[ -r /proc/self/cgroup && -r /proc/self/stat ]] && PROC=true
SYSTEMCTL_USER=false; command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 && SYSTEMCTL_USER=true
SYSTEMD_RUN_USER=false; command -v systemd-run >/dev/null 2>&1 && systemd-run --user --help >/dev/null 2>&1 && SYSTEMD_RUN_USER=true
SCRIPT_PTY=false; command -v script >/dev/null 2>&1 && SCRIPT_PTY=true
TMUX_AVAILABLE=false; command -v tmux >/dev/null 2>&1 && TMUX_AVAILABLE=true
GIT_AVAILABLE=false; command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --verify HEAD >/dev/null 2>&1 && GIT_AVAILABLE=true
BUN_AVAILABLE=false; command -v bun >/dev/null 2>&1 && BUN_AVAILABLE=true
PYTHON3_AVAILABLE=false; command -v python3 >/dev/null 2>&1 && PYTHON3_AVAILABLE=true
DISPOSABLE_UNIT=false; [[ "$LINUX" == true && "$PROC" == true && "$SYSTEMCTL_USER" == true && "$SYSTEMD_RUN_USER" == true && "$SCRIPT_PTY" == true && "$TMUX_AVAILABLE" == true && "$GIT_AVAILABLE" == true && "$BUN_AVAILABLE" == true && "$PYTHON3_AVAILABLE" == true ]] && DISPOSABLE_UNIT=true
if [[ "${GJC_ISSUE1938_TEST_FORCE_UNSUPPORTED:-}" == 1 ]]; then SYSTEMCTL_USER=false; DISPOSABLE_UNIT=false; fi
[[ "${GJC_ISSUE1938_TEST_DISABLE_PYTHON:-}" == 1 ]] && PYTHON3_AVAILABLE=false
[[ "${GJC_ISSUE1938_TEST_DISABLE_BUN:-}" == 1 ]] && BUN_AVAILABLE=false

# Capabilities are classified before any disposable resource is made.  Unsupported
# environments have one portable outcome and never leave a partial receipt.


SERVICE_UNIT="" SCOPE_UNIT="" SCOPE_RUNNER_PID="" TMUX_SOCKET="" TMUX_TMPDIR_PRIVATE=""
WORKTREE="" WORKTREE_BRANCH="" RAW_SOCKET="" RECOVERY_SOCKET="" CLEANUP_STATUS="not_started" CASES='[]' SOURCE_REVISION="" RUN_NONCE=""
TRACKED_UNITS=() TRACKED_SERVERS=()
CLEANUP_DEADLINE_ATTEMPTS=50
MONITOR_INTERVAL_SECONDS=5
EXPECTED_VERDICT_DEADLINE_MS=2000
RECOVERY_VERDICT_DEADLINE_MS=7000
VERDICT_POLL_MS=100


publish_evidence_temp() {
  local temporary="$1"
  [[ "${GJC_ISSUE1938_TEST_FAIL_EVIDENCE_RENAME:-}" != 1 ]] || { rm -f "$temporary"; return 1; }
  mv -f -- "$temporary" "$EVIDENCE_PATH"
}
write_evidence() {
  local status="$1" completed_at="${2:-null}" temporary
  temporary="$(mktemp "$EVIDENCE_DIR/.${PHASE}.json.XXXXXX")" || return 1
  PHASE="$PHASE" STATUS="$status" COMPLETED_AT="$completed_at" CASES="$CASES" LINUX="$LINUX" PROC="$PROC" SYSTEMCTL_USER="$SYSTEMCTL_USER" SYSTEMD_RUN_USER="$SYSTEMD_RUN_USER" PYTHON3="$PYTHON3_AVAILABLE" SCRIPT="$SCRIPT_PTY" TMUX="$TMUX_AVAILABLE" GIT="$GIT_AVAILABLE" BUN="$BUN_AVAILABLE" DISPOSABLE_UNIT="$DISPOSABLE_UNIT" SERVICE_UNIT="$SERVICE_UNIT" SCOPE_UNIT="$SCOPE_UNIT" CLEANUP_STATUS="$CLEANUP_STATUS" SOURCE_REVISION="$SOURCE_REVISION" RUN_NONCE="$RUN_NONCE" python3 - "$temporary" <<'PY' || { rm -f "$temporary"; return 1; }
import json, os, sys
completed = None if os.environ["COMPLETED_AT"] == "null" else os.environ["COMPLETED_AT"]
def nullable(name): return os.environ[name] or None
payload = {"schema_version":1,"issue":"1938","phase":os.environ["PHASE"],"status":os.environ["STATUS"],"generated_at":__import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"),"source_revision":nullable("SOURCE_REVISION"),"run_nonce":nullable("RUN_NONCE"),"capabilities":{key:os.environ[key.upper()] == "true" for key in ("linux","proc","systemctl_user","systemd_run_user","python3","script","tmux","git","bun","disposable_unit")},"cases":json.loads(os.environ["CASES"]),"cleanup":{"status":os.environ["CLEANUP_STATUS"],"unit":nullable("SERVICE_UNIT"),"scope":nullable("SCOPE_UNIT"),"completed_at":completed}}
with open(sys.argv[1], "w", encoding="utf-8") as handle: json.dump(payload, handle, separators=(",",":")); handle.write("\n")
if os.environ.get("GJC_ISSUE1938_TEST_FAIL_PYTHON_SERIALIZER") == "1": raise SystemExit(1)
PY
  publish_evidence_temp "$temporary"
}
write_unsupported_evidence() {
  local temporary
  CLEANUP_STATUS="not_started" CASES='[]' SERVICE_UNIT="" SCOPE_UNIT="" SOURCE_REVISION="" RUN_NONCE=""
  if [[ "$PYTHON3_AVAILABLE" == true ]]; then
    write_evidence unsupported null
  else
    temporary="$(mktemp "$EVIDENCE_DIR/.${PHASE}.json.XXXXXX")" || return 1
    if [[ "$BUN_AVAILABLE" == true ]]; then
      EVIDENCE_PATH="$temporary" PHASE="$PHASE" LINUX="$LINUX" PROC="$PROC" SYSTEMCTL_USER="$SYSTEMCTL_USER" SYSTEMD_RUN_USER="$SYSTEMD_RUN_USER" PYTHON3="$PYTHON3_AVAILABLE" SCRIPT="$SCRIPT_PTY" TMUX="$TMUX_AVAILABLE" GIT="$GIT_AVAILABLE" BUN="$BUN_AVAILABLE" DISPOSABLE_UNIT="$DISPOSABLE_UNIT" bun -e 'const env = process.env; const file = env.EVIDENCE_PATH; const phase = env.PHASE; if (!file || !phase) process.exit(1); const capability = key => env[key.toUpperCase()] === "true"; await Bun.write(file, `${JSON.stringify({schema_version:1,issue:"1938",phase,status:"unsupported",generated_at:new Date().toISOString(),source_revision:null,run_nonce:null,capabilities:{linux:capability("linux"),proc:capability("proc"),systemctl_user:capability("systemctl_user"),systemd_run_user:capability("systemd_run_user"),python3:capability("python3"),script:capability("script"),tmux:capability("tmux"),git:capability("git"),bun:capability("bun"),disposable_unit:capability("disposable_unit")},cases:[],cleanup:{status:"not_started",unit:null,scope:null,completed_at:null}})}\n`);' || { rm -f "$temporary"; return 1; }
    else
      printf '{"schema_version":1,"issue":"1938","phase":"%s","status":"unsupported","generated_at":"%s","source_revision":null,"run_nonce":null,"capabilities":{"linux":%s,"proc":%s,"systemctl_user":%s,"systemd_run_user":%s,"python3":%s,"script":%s,"tmux":%s,"git":%s,"bun":%s,"disposable_unit":%s},"cases":[],"cleanup":{"status":"not_started","unit":null,"scope":null,"completed_at":null}}\n' "$PHASE" "$(now)" "$LINUX" "$PROC" "$SYSTEMCTL_USER" "$SYSTEMD_RUN_USER" "$PYTHON3_AVAILABLE" "$SCRIPT_PTY" "$TMUX_AVAILABLE" "$GIT_AVAILABLE" "$BUN_AVAILABLE" "$DISPOSABLE_UNIT" >"$temporary" || { rm -f "$temporary"; return 1; }
    fi
    publish_evidence_temp "$temporary"
  fi
}

proc_start_time() { local stat rest; [[ "$1" =~ ^[1-9][0-9]*$ && -r "/proc/$1/stat" ]] || return 1; IFS= read -r stat <"/proc/$1/stat" || return 1; rest="${stat##*) }"; set -- $rest; [[ "${20:-}" =~ ^[0-9]+$ ]] && printf '%s\n' "${20}"; }
track_server() { local tmpdir="$1" socket="$2" session="$3" pid="$4" start cgroup native_id prefix candidate kept=(); native_id="$(TMUX_TMPDIR="$tmpdir" tmux -L "$socket" display-message -p -t "=$session:" '#{session_id}' 2>/dev/null || true)"; start="$(proc_start_time "$pid" || true)"; cgroup="$(proc_cgroup "$pid")"; [[ "$native_id" =~ ^\$[0-9]+$ && -n "$start" && -n "$cgroup" ]] || return 1; prefix="$tmpdir|$socket|$native_id|"; for candidate in "${TRACKED_SERVERS[@]}"; do [[ "$candidate" == "$prefix"* ]] || kept+=("$candidate"); done; TRACKED_SERVERS=("${kept[@]}" "$tmpdir|$socket|$native_id|$pid|$start|$cgroup"); }
capture_verdict_baseline() { local state="$1" session="$2" value; value="$("$3" -e 'const m=await import(process.argv[1]); console.log(JSON.stringify(await m.captureCanonicalVerdictBaseline(process.argv[2],process.argv[3])))' "$SCRIPT_DIR/wait-for-issue-1938-verdict.ts" "$state" "$session")" || return 1; python3 - "$value" <<'PY'
import json,sys
v=json.loads(sys.argv[1]); fields=("generation","verdictFileId","incidentFileId","incidentAliasFileId","vanishedFileId","vanishedAliasFileId"); print("\t".join(str(v.get(field) or "_") for field in fields))
PY
}


private_tmux_session_pid() {
  local tmpdir="$1" socket="$2" native_id="$3" output rc
  [[ "${GJC_ISSUE1938_TEST_TMUX_CLEANUP_PROBE:-}" != error ]] || return 2
  output="$(TMUX_TMPDIR="$tmpdir" tmux -L "$socket" display-message -p -t "$native_id" '#{session_id}\t#{pid}' 2>&1)"; rc=$?
  if [[ $rc -eq 0 && "$output" =~ ^\$[0-9]+$'\t'[1-9][0-9]*$ ]]; then
    printf '%s\n' "${output#*$'\t'}"
    return 0
  fi
  [[ $rc -ne 0 && "$output" == *"can't find session"* ]] && return 1
  return 2
}
kill_owned_server() {
  local tmpdir="$1" socket="$2" native_id="$3" pid="$4" start="$5" cgroup="$6" current_pid current_start current_cgroup state
  current_pid="$(private_tmux_session_pid "$tmpdir" "$socket" "$native_id")"; state=$?
  [[ $state -eq 1 ]] && return 0
  if [[ $state -ne 0 ]]; then
    current_start="$(proc_start_time "$pid" || true)"
    [[ -z "$current_start" || "$current_start" != "$start" ]]
    return
  fi
  current_start="$(proc_start_time "$current_pid" || true)"; current_cgroup="$(proc_cgroup "$current_pid")"
  if [[ ! "$native_id" =~ ^\$[0-9]+$ || "$current_pid" != "$pid" || "$current_start" != "$start" || "$current_cgroup" != "$cgroup" ]]; then
    current_start="$(proc_start_time "$pid" || true)"
    [[ -z "$current_start" || "$current_start" != "$start" ]]
    return
  fi
  TMUX_TMPDIR="$tmpdir" tmux -L "$socket" kill-session -t "$native_id" >/dev/null 2>&1 || return 1
  private_tmux_session_pid "$tmpdir" "$socket" "$native_id" >/dev/null; state=$?
  [[ $state -eq 1 ]] && return 0
  if [[ $state -ne 0 ]]; then
    current_start="$(proc_start_time "$pid" || true)"
    [[ -z "$current_start" || "$current_start" != "$start" ]]
    return
  fi
  return 1
}
owned_server_state() {
  local pid="$1" start="$2" cgroup="$3" current_start current_cgroup
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$start" =~ ^[0-9]+$ && -n "$cgroup" ]] || return 2
  [[ -e "/proc/$pid" ]] || return 1
  current_start="$(proc_start_time "$pid")" || return 2
  [[ "$current_start" == "$start" ]] || return 1
  current_cgroup="$(proc_cgroup "$pid")"
  if [[ -z "$current_cgroup" ]]; then
    current_start="$(proc_start_time "$pid" || true)"
    [[ -z "$current_start" || "$current_start" != "$start" ]] && return 1
    return 2
  fi
  [[ "$current_cgroup" == "$cgroup" ]] || return 2
  return 0
}
wait_owned_server_gone() {
  local pid="$1" start="$2" cgroup="$3" attempts=0 state
  while [[ $attempts -lt $CLEANUP_DEADLINE_ATTEMPTS ]]; do
    owned_server_state "$pid" "$start" "$cgroup"; state=$?
    [[ $state -eq 1 ]] && return 0
    [[ $state -eq 2 ]] && return 1
    attempts=$((attempts+1)); sleep .1
  done
  return 1
}
terminate_owned_server() {
  local pid="$1" start="$2" cgroup="$3" state
  owned_server_state "$pid" "$start" "$cgroup"; state=$?
  [[ $state -eq 1 ]] && return 0
  [[ $state -eq 0 ]] || return 1
  kill -TERM "$pid" >/dev/null 2>&1 || return 1
  wait_owned_server_gone "$pid" "$start" "$cgroup"
}
unit_is_explicitly_gone() {
  local unit="$1" load_state rc
  [[ "${GJC_ISSUE1938_TEST_SYSTEMD_CLEANUP_PROBE:-}" != error ]] || return 2
  load_state="$(systemctl --user show "$unit" --property=LoadState --value 2>&1)"; rc=$?
  [[ $rc -eq 0 ]] || return 2
  [[ "$load_state" == not-found ]]
}
wait_unit_gone() {
  local unit="$1" attempts=0
  while [[ $attempts -lt $CLEANUP_DEADLINE_ATTEMPTS ]]; do
    unit_is_explicitly_gone "$unit" && return 0
    [[ $? -eq 2 ]] && return 1
    systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
    attempts=$((attempts+1)); sleep .1
  done
  return 1
}

cleanup_incomplete() { echo "issue-1938 cleanup incomplete: $1" >&2; resources_gone=false; }

cleanup() {
  local rc=$? unit server tmpdir socket native_id pid start cgroup resources_gone=true
  trap - EXIT INT TERM
  [[ "$rc" -eq 77 ]] && { CLEANUP_STATUS="not_started"; write_unsupported_evidence || exit 1; exit 77; }

  CLEANUP_STATUS="failed"
  for server in "${TRACKED_SERVERS[@]}"; do IFS='|' read -r tmpdir socket native_id pid start cgroup <<<"$server"; kill_owned_server "$tmpdir" "$socket" "$native_id" "$pid" "$start" "$cgroup" || cleanup_incomplete private_session; done
  for server in "${TRACKED_SERVERS[@]}"; do IFS='|' read -r tmpdir socket native_id pid start cgroup <<<"$server"; terminate_owned_server "$pid" "$start" "$cgroup" || cleanup_incomplete private_server_terminate; done
  for server in "${TRACKED_SERVERS[@]}"; do IFS='|' read -r tmpdir socket native_id pid start cgroup <<<"$server"; wait_owned_server_gone "$pid" "$start" "$cgroup" || cleanup_incomplete private_server; done
  for unit in "${TRACKED_UNITS[@]}"; do
    systemctl --user stop "$unit" >/dev/null 2>&1 || unit_is_explicitly_gone "$unit" || cleanup_incomplete unit_stop

  done
  if [[ "$SCOPE_RUNNER_PID" =~ ^[1-9][0-9]*$ ]]; then wait "$SCOPE_RUNNER_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "$WORKTREE" ]]; then
    if ! git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 && ! rmdir "$WORKTREE" >/dev/null 2>&1; then cleanup_incomplete worktree_remove; fi
    git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || cleanup_incomplete worktree_prune
  fi
  if [[ -n "$WORKTREE_BRANCH" ]]; then git -C "$REPO_ROOT" branch -D "$WORKTREE_BRANCH" >/dev/null 2>&1 || cleanup_incomplete worktree_branch; fi
  if [[ -n "$TMUX_TMPDIR_PRIVATE" && -d "$TMUX_TMPDIR_PRIVATE" ]]; then python3 - "$TMUX_TMPDIR_PRIVATE" <<'PY' || cleanup_incomplete private_tmpdir
import shutil, sys
shutil.rmtree(sys.argv[1])
PY
  fi
  for unit in "${TRACKED_UNITS[@]}"; do wait_unit_gone "$unit" || cleanup_incomplete unit_unload; done
  [[ -z "$TMUX_TMPDIR_PRIVATE" || ! -e "$TMUX_TMPDIR_PRIVATE" ]] || cleanup_incomplete private_tmpdir_present
  [[ -z "$WORKTREE" || ! -e "$WORKTREE" ]] || cleanup_incomplete worktree_present
  [[ -z "$WORKTREE_BRANCH" ]] || ! git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$WORKTREE_BRANCH" || cleanup_incomplete worktree_branch_present
  [[ "$resources_gone" == true ]] && CLEANUP_STATUS="completed"
  if [[ "$rc" -eq 0 && "$CLEANUP_STATUS" == completed ]]; then write_evidence passed "$(now)" || rc=1; else write_evidence failed "$(now)" || rc=1; fi
  [[ "$CLEANUP_STATUS" == completed ]] || rc=1
  exit "$rc"
}
trap cleanup EXIT INT TERM
mkdir -p "$EVIDENCE_DIR" || exit 1
rm -f "$EVIDENCE_PATH" || exit 1
if [[ -n "${GJC_ISSUE1938_TEST_CLEANUP_PROBE_ONLY:-}" ]]; then
  case "$GJC_ISSUE1938_TEST_CLEANUP_PROBE_ONLY" in
    tmux) TRACKED_SERVERS+=("/nonexistent|test|\$1|$$|$(proc_start_time $$)|$(proc_cgroup $$)") ;;
    monitor)
      TMUX_TMPDIR_PRIVATE="$(mktemp -d)" || exit 1
      socket="gjc-issue1938-held-monitor-$$"; monitor_session="issue1938-held-owner-monitor"
      TMUX_TMPDIR="$TMUX_TMPDIR_PRIVATE" tmux -L "$socket" new-session -d -s "$monitor_session" /bin/sleep 120 || exit 1
      monitor_pid="$(TMUX_TMPDIR="$TMUX_TMPDIR_PRIVATE" tmux -L "$socket" display-message -p -t "=$monitor_session:" '#{pid}')"
      track_server "$TMUX_TMPDIR_PRIVATE" "$socket" "$monitor_session" "$monitor_pid" || exit 1
      ;;
    systemd) TRACKED_UNITS+=("gjc-issue1938-test.service") ;;
    *) exit 2 ;;
  esac
  exit 1
fi
[[ "$DISPOSABLE_UNIT" == true ]] || exit 77
SOURCE_REVISION="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"
if ! git -C "$REPO_ROOT" diff --quiet -- . ':!/.gjc/**' || ! git -C "$REPO_ROOT" diff --cached --quiet -- . ':!/.gjc/**' || [[ -n "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard -- ':!/.gjc/**')" ]]; then
  echo "issue-1938 evidence requires a clean product source tree" >&2
  exit 1
fi
RUN_NONCE="$(bun -e 'console.log(crypto.randomUUID())')"
[[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ && "$RUN_NONCE" =~ ^[0-9a-f-]{36}$ ]] || exit 1
RUN_PREFIX="${RUN_NONCE%%-*}"
TMUX_TMPDIR_PRIVATE="$(mktemp -d)"
SERVICE_UNIT="gjc-issue1938-$RUN_PREFIX-$$-$RANDOM.service"
TMUX_SOCKET="gjc-issue1938-$RUN_PREFIX-$$-$RANDOM"
TRACKED_UNITS+=("$SERVICE_UNIT")



append_case() {
  local id="$1" status="$2" started="$3" completed="$4" pid="$5" name="$6" cgroup="$7" expected_signal="$8" expected_result="$9" observed_signal="${10}" observed_result="${11}" scope="${12:-}" verdict="${13:-}" dedupe="${14:-}" latency_ms="${15:-}" artifact_path="${16:-}" artifact_sha256="${17:-}"
  CASES="$(python3 - "$CASES" "$id" "$status" "$started" "$completed" "$pid" "$name" "$cgroup" "$expected_signal" "$expected_result" "$observed_signal" "$observed_result" "$scope" "$verdict" "$dedupe" "$latency_ms" "$artifact_path" "$artifact_sha256" <<'PY'
import json, sys
cases=json.loads(sys.argv[1]); pid=int(sys.argv[6]) if sys.argv[6].isdigit() else None
entry={"id":sys.argv[2],"status":sys.argv[3],"started_at":sys.argv[4],"completed_at":sys.argv[5],"subject":{"pid":pid,"name":sys.argv[7],"cgroup":sys.argv[8] or None},"expected":{"signal":sys.argv[9] or None,"result":sys.argv[10]},"observed":{"signal":sys.argv[11] or None,"result":sys.argv[12]}}
for key,value in (("scope",sys.argv[13]),("verdict",sys.argv[14]),("dedupe_key",sys.argv[15])):
 if value: entry[key]=value
if sys.argv[16].isdigit(): entry["observed"]["latency_ms"]=int(sys.argv[16])
if sys.argv[17] or sys.argv[18]:
 if not sys.argv[17] or not sys.argv[18]: raise SystemExit(1)
 entry["artifact"]={"path":sys.argv[17],"sha256":sys.argv[18]}
cases.append(entry); print(json.dumps(cases,separators=(",",":")))
PY
)"
}
parse_wait_receipt() {
  python3 - "$1" <<'PY'
import json, sys
value=json.loads(sys.argv[1])
key=value.get("dedupe_key"); signal=value.get("signal"); result=value.get("result"); latency=value.get("latency_ms"); artifact=value.get("artifact")
if not isinstance(key,str) or not isinstance(signal,str) or not isinstance(result,str) or not isinstance(latency,int) or latency < 0 or not isinstance(artifact,dict) or not isinstance(artifact.get("file"),str) or not isinstance(artifact.get("sha256"),str): raise SystemExit(1)
print(f"{key}\t{signal}\t{result}\t{latency}\t{artifact['file']}\t{artifact['sha256']}")
PY
}
wait_active() { local attempts=0; until systemctl --user is-active --quiet "$1"; do attempts=$((attempts+1)); [[ $attempts -lt 50 ]] || return 1; sleep .1; done; }
proc_cgroup() { [[ "$1" =~ ^[1-9][0-9]*$ && -r "/proc/$1/cgroup" ]] && tr '\n' ';' 2>/dev/null <"/proc/$1/cgroup" || true; }
start_service() { systemd-run --user --quiet --collect --no-block --unit="$SERVICE_UNIT" /bin/sleep 120 >/dev/null; wait_active "$SERVICE_UNIT"; }
start_pre_owner() { systemd-run --user --quiet --collect --no-block --unit="$SERVICE_UNIT" env TMUX_TMPDIR="$TMUX_TMPDIR_PRIVATE" /bin/bash -c 'tmux -L "$1" new-session -d -s "$2" /bin/sleep 120; exec /bin/sleep 120' _ "$TMUX_SOCKET" "issue1938-pre-$SESSION_ID" >/dev/null; wait_server_pid_private; }
server_pid_private() { TMUX_TMPDIR="$TMUX_TMPDIR_PRIVATE" tmux -L "$TMUX_SOCKET" display-message -p -t "=issue1938-pre-$SESSION_ID:" '#{pid}' 2>/dev/null || true; }
wait_server_pid_private() { local attempts=0 pid=""; while [[ $attempts -lt 50 ]]; do pid="$(server_pid_private)"; [[ -n "$pid" ]] && { printf '%s\n' "$pid"; return 0; }; attempts=$((attempts+1)); sleep .1; done; return 1; }
scope_pid() { local attempts=0 control pid; while [[ $attempts -lt 50 ]]; do control="$(systemctl --user show "$SCOPE_UNIT" --property=ControlGroup --value 2>/dev/null)"; if [[ -n "$control" && -r "/sys/fs/cgroup$control/cgroup.procs" ]]; then while read -r pid; do [[ "$pid" =~ ^[1-9][0-9]*$ ]] && { printf '%s\n' "$pid"; return 0; }; done <"/sys/fs/cgroup$control/cgroup.procs"; fi; attempts=$((attempts+1)); sleep .1; done; return 1; }
# The candidate launches inside a disposable service, deliberately not an outer
# safe scope. Owner isolation must create its own independent scope.
start_unsafe_service() { systemd-run --user --quiet --collect --no-block --unit="$SERVICE_UNIT" "$@" >/dev/null; wait_active "$SERVICE_UNIT"; }
run_unsafe_service() { systemd-run --user --quiet --collect --wait --pipe --unit="$SERVICE_UNIT" "$@" >/dev/null 2>&1; }
server_pid() { TMUX_TMPDIR="$WORKTREE/tmux" tmux -L "$2" display-message -p -t "=$1:" '#{pid}' 2>/dev/null || true; }
session_native_id() { TMUX_TMPDIR="$WORKTREE/tmux" tmux -L "$2" display-message -p -t "=$1:" '#{session_id}' 2>/dev/null || true; }
wait_server_pid() { local attempts=0 pid=""; while [[ $attempts -lt 50 ]]; do pid="$(server_pid "$1" "$2")"; if [[ -n "$pid" ]]; then printf '%s\n' "$pid"; return 0; fi; attempts=$((attempts+1)); sleep .1; done; return 1; }
independent_scope() { [[ "$1" =~ (^|/)gjc-owner-[A-Za-z0-9-]+\.scope(/|;|$) ]]; }
owner_scope() { [[ "$1" =~ (^|/)gjc-owner-([A-Za-z0-9-]+)\.scope ]] && printf 'gjc-owner-%s.scope\n' "${BASH_REMATCH[2]}"; }


run_pre_code() {
  local started pid cgroup scope_pid scope_cgroup completed

  [[ "$SCRIPT_PTY" == true && "$TMUX_AVAILABLE" == true ]] || exit 77
  started="$(now)"; pid="$(start_pre_owner || true)"; cgroup="$(proc_cgroup "$pid")"
  SCOPE_UNIT="gjc-issue1938-$SESSION_ID-$$-$RANDOM.scope"; TRACKED_UNITS+=("$SCOPE_UNIT")
  if [[ -z "$pid" || -z "$cgroup" ]]; then append_case inherited_baseline_death failed "$started" "$(now)" "$pid" "$SERVICE_UNIT" "$cgroup" SIGTERM restart SIGTERM unavailable "$SERVICE_UNIT"; return 1; fi
  systemctl --user restart "$SERVICE_UNIT" >/dev/null 2>&1 || { append_case inherited_baseline_death failed "$started" "$(now)" "$pid" "$SERVICE_UNIT" "$cgroup" SIGTERM restart SIGTERM restart_failed "$SERVICE_UNIT"; return 1; }
  sleep .1; completed="$(now)"
  if [[ -e "/proc/$pid" ]]; then append_case inherited_baseline_death failed "$started" "$completed" "$pid" "$SERVICE_UNIT" "$cgroup" SIGTERM restart SIGTERM still_alive "$SERVICE_UNIT"; return 1; fi
  append_case inherited_baseline_death passed "$started" "$completed" "$pid" "$SERVICE_UNIT" "$cgroup" SIGTERM restart SIGTERM exited "$SERVICE_UNIT" "restart"
  started="$(now)"; systemd-run --user --quiet --collect --scope --unit="$SCOPE_UNIT" /bin/sleep 120 >/dev/null 2>&1 & SCOPE_RUNNER_PID=$!
  wait_active "$SCOPE_UNIT" || { append_case manual_scope_survival_direct_term failed "$started" "$(now)" '' "$SCOPE_UNIT" '' SIGTERM survives_then_exits SIGTERM unavailable "$SCOPE_UNIT"; return 1; }
  scope_pid="$(scope_pid || true)"; scope_cgroup="$(proc_cgroup "$scope_pid")"; systemctl --user restart "$SERVICE_UNIT" >/dev/null 2>&1 || { append_case manual_scope_survival_direct_term failed "$started" "$(now)" "$scope_pid" "$SCOPE_UNIT" "$scope_cgroup" SIGTERM survives_then_exits SIGTERM restart_failed "$SCOPE_UNIT"; return 1; }; sleep .1
  if ! systemctl --user is-active --quiet "$SCOPE_UNIT" || [[ ! "$scope_pid" =~ ^[1-9][0-9]*$ ]] || [[ ! -e "/proc/$scope_pid" ]]; then append_case manual_scope_survival_direct_term failed "$started" "$(now)" "$scope_pid" "$SCOPE_UNIT" "$scope_cgroup" SIGTERM survives_then_exits SIGTERM lost "$SCOPE_UNIT"; return 1; fi

  kill -TERM "$scope_pid" >/dev/null 2>&1 || { append_case manual_scope_survival_direct_term failed "$started" "$(now)" "$scope_pid" "$SCOPE_UNIT" "$scope_cgroup" SIGTERM survives_then_exits SIGTERM signal_failed "$SCOPE_UNIT"; return 1; }; sleep .1; completed="$(now)"
  if [[ -e "/proc/$scope_pid" ]]; then append_case manual_scope_survival_direct_term failed "$started" "$completed" "$scope_pid" "$SCOPE_UNIT" "$scope_cgroup" SIGTERM survives_then_exits SIGTERM still_alive "$SCOPE_UNIT"; return 1; fi
  append_case manual_scope_survival_direct_term passed "$started" "$completed" "$scope_pid" "$SCOPE_UNIT" "$scope_cgroup" SIGTERM survives_then_exits SIGTERM survives_then_exits "$SCOPE_UNIT" "direct_term"
}


run_post_code() {
  local started completed product_bin bun_bin tmux_bin raw_session recovery_session managed_session raw_pid raw_cgroup pid cgroup owner_unit raw_state recovery_state raw_key recovery_key raw_signal recovery_signal raw_result recovery_result raw_wait recovery_wait raw_latency recovery_latency raw_artifact_path raw_artifact_sha256 recovery_artifact_path recovery_artifact_sha256 raw_trigger_started_ms raw_deadline_at_ms recovery_trigger_started_ms recovery_deadline_at_ms tmux_wrapper raw_baseline raw_baseline_generation raw_baseline_verdict_id raw_baseline_incident_id raw_baseline_incident_alias_id raw_baseline_vanished_id raw_baseline_vanished_alias_id recovery_baseline recovery_baseline_generation recovery_baseline_verdict_id recovery_baseline_incident_id recovery_baseline_incident_alias_id recovery_baseline_vanished_id recovery_baseline_vanished_alias_id recovery_native_id

  [[ "$SCRIPT_PTY" == true && "$TMUX_AVAILABLE" == true && "$GIT_AVAILABLE" == true && "$BUN_AVAILABLE" == true ]] || exit 77
  bun_bin="$(command -v bun || true)"
  tmux_bin="$(command -v tmux || true)"
  WORKTREE="$(mktemp -d)"; WORKTREE_BRANCH="gjc-issue1938-$RUN_PREFIX-$$-$RANDOM"; started="$(now)"
  if [[ -z "$bun_bin" || -z "$tmux_bin" ]] || ! git -C "$REPO_ROOT" worktree add -b "$WORKTREE_BRANCH" "$WORKTREE" HEAD >/dev/null 2>&1; then
    for id in raw_proof_before_exec managed_proof_before_exec isolated_survival expected_close_verdict unexpected_incident_recovery; do append_case "$id" failed "$started" "$(now)" '' product-entrypoint '' SIGTERM public_safe_proof SIGTERM unavailable; done
    return 1
  fi
  mkdir -p "$WORKTREE/tmux" "$EVIDENCE_DIR/artifacts"; TMUX_SOCKET="gjc-issue1938-$RUN_PREFIX-$$-$RANDOM"

  [[ -d "$REPO_ROOT/node_modules" ]] || { append_case raw_proof_before_exec failed "$started" "$(now)" '' product-entrypoint '' '' proven '' dependencies_unavailable; return 1; }
  ln -s "$REPO_ROOT/node_modules" "$WORKTREE/node_modules"
  [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$(git -C "$WORKTREE" rev-parse HEAD)" ]] || { append_case raw_proof_before_exec failed "$started" "$(now)" '' product-entrypoint '' '' proven '' source_revision_mismatch; return 1; }
  product_bin="$WORKTREE/issue-1938-gjc"; tmux_wrapper="$WORKTREE/issue-1938-tmux"
  printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$bun_bin" "$WORKTREE/packages/coding-agent/src/cli.ts" >"$product_bin"
  printf '#!/usr/bin/env bash\nexec %q -L "$GJC_ISSUE1938_TMUX_SOCKET" "$@"\n' "$tmux_bin" >"$tmux_wrapper"
  chmod 700 "$product_bin" "$tmux_wrapper"

  raw_session="issue1938-raw-$RUN_PREFIX-$$"; raw_state="$WORKTREE/.gjc-session-state/$raw_session"; RAW_SOCKET="gjc-${raw_session//[^A-Za-z0-9_.-]/_}"

  if ! run_unsafe_service env TMUX_TMPDIR="$WORKTREE/tmux" GJC_ISSUE1938_TMUX_SOCKET="$RAW_SOCKET" GJC_BIN="$product_bin" GJC_SESSION_TMUX_BIN="$tmux_wrapper" GJC_SESSION_MONITOR_INTERVAL="$MONITOR_INTERVAL_SECONDS" GJC_SESSION_SKIP_ROUTER=1 bash "$WORKTREE/scripts/gjc-session/create.sh" "$raw_session" "$WORKTREE"; then append_case raw_proof_before_exec failed "$started" "$(now)" '' "$raw_session" '' '' proven '' launch_failed "$SERVICE_UNIT"; return 1; fi
  raw_pid="$(wait_server_pid "$raw_session" "$RAW_SOCKET" || true)"; raw_cgroup="$(proc_cgroup "$raw_pid")"; completed="$(now)"
  if [[ -n "$raw_pid" && -n "$raw_cgroup" ]] && independent_scope "$raw_cgroup" && track_server "$WORKTREE/tmux" "$RAW_SOCKET" "$raw_session" "$raw_pid" && track_server "$WORKTREE/tmux" "$RAW_SOCKET" "${raw_session}-owner-monitor" "$raw_pid"; then owner_unit="$(owner_scope "$raw_cgroup")"; TRACKED_UNITS+=("$owner_unit"); append_case raw_proof_before_exec passed "$started" "$completed" "$raw_pid" "$raw_session" "$raw_cgroup" '' proven '' proven "$owner_unit"; else append_case raw_proof_before_exec failed "$started" "$completed" "$raw_pid" "$raw_session" "$raw_cgroup" '' proven '' unavailable "$SERVICE_UNIT"; return 1; fi

  start_service || { append_case isolated_survival failed "$started" "$(now)" "$raw_pid" "$raw_session" "$raw_cgroup" SIGTERM survives '' stop_setup_failed; return 1; }
  systemctl --user stop "$SERVICE_UNIT" >/dev/null 2>&1 || { append_case isolated_survival failed "$started" "$(now)" "$raw_pid" "$raw_session" "$raw_cgroup" SIGTERM survives '' stop_failed; return 1; }
  sleep .1
  if TMUX_TMPDIR="$WORKTREE/tmux" tmux -L "$RAW_SOCKET" has-session -t "=$raw_session" >/dev/null 2>&1; then append_case isolated_survival passed "$started" "$(now)" "$raw_pid" "$raw_session" "$raw_cgroup" SIGTERM survives '' survives "$(owner_scope "$raw_cgroup")"; else append_case isolated_survival failed "$started" "$(now)" "$raw_pid" "$raw_session" "$raw_cgroup" SIGTERM survives '' lost; return 1; fi


  managed_session="issue1938-managed-$RUN_PREFIX-$$"; SERVICE_UNIT="gjc-issue1938-managed-$RUN_PREFIX-$$-$RANDOM.service"; TRACKED_UNITS+=("$SERVICE_UNIT")


  if ! start_unsafe_service env -u TMUX -u TMUX_PANE -u GJC_TMUX_LAUNCHED TMUX_TMPDIR="$WORKTREE/tmux" GJC_ISSUE1938_TMUX_SOCKET="$TMUX_SOCKET" GJC_TMUX_COMMAND="$tmux_wrapper" GJC_TMUX_SESSION="$managed_session" GJC_LAUNCH_POLICY=tmux script -qefc "$product_bin --tmux" /dev/null; then append_case managed_proof_before_exec failed "$started" "$(now)" '' "$managed_session" '' '' proven '' launch_failed "$SERVICE_UNIT"; return 1; fi
  pid="$(wait_server_pid "$managed_session" "$TMUX_SOCKET" || true)"; cgroup="$(proc_cgroup "$pid")"
  if [[ -n "$pid" && -n "$cgroup" ]] && independent_scope "$cgroup" && track_server "$WORKTREE/tmux" "$TMUX_SOCKET" "$managed_session" "$pid"; then owner_unit="$(owner_scope "$cgroup")"; TRACKED_UNITS+=("$owner_unit"); append_case managed_proof_before_exec passed "$started" "$(now)" "$pid" "$managed_session" "$cgroup" '' proven '' proven "$owner_unit"; else append_case managed_proof_before_exec failed "$started" "$(now)" "$pid" "$managed_session" "$cgroup" '' proven '' unavailable "$SERVICE_UNIT"; return 1; fi


  raw_baseline="$(capture_verdict_baseline "$raw_state" "$raw_session" "$bun_bin")" || return 1
  IFS=$'\t' read -r raw_baseline_generation raw_baseline_verdict_id raw_baseline_incident_id raw_baseline_incident_alias_id raw_baseline_vanished_id raw_baseline_vanished_alias_id <<<"$raw_baseline"
  raw_trigger_started_ms="$(date +%s%3N)"
  if TMUX_TMPDIR="$WORKTREE/tmux" GJC_ISSUE1938_TMUX_SOCKET="$RAW_SOCKET" GJC_TMUX_COMMAND="$tmux_wrapper" "$product_bin" session force-close "$raw_session" >/dev/null; then :; else append_case expected_close_verdict failed "$started" "$(now)" "$raw_pid" "$raw_session" "$raw_cgroup" SIGTERM expected_operator_shutdown SIGTERM unavailable; return 1; fi
  raw_deadline_at_ms=$((raw_trigger_started_ms + EXPECTED_VERDICT_DEADLINE_MS))
  raw_wait="$("$bun_bin" "$SCRIPT_DIR/wait-for-issue-1938-verdict.ts" --state-dir "$raw_state" --session "$raw_session" --classification expected_operator_shutdown --require-incident false --trigger-start-ms "$raw_trigger_started_ms" --deadline-at-ms "$raw_deadline_at_ms" --poll-ms "$VERDICT_POLL_MS" --baseline-generation "$raw_baseline_generation" --baseline-verdict-id "$raw_baseline_verdict_id" --baseline-incident-id "$raw_baseline_incident_id" --baseline-incident-alias-id "$raw_baseline_incident_alias_id" --baseline-vanished-id "$raw_baseline_vanished_id" --baseline-vanished-alias-id "$raw_baseline_vanished_alias_id" --artifact-dir "$EVIDENCE_DIR/artifacts" --artifact-name expected_close_verdict)" || { append_case expected_close_verdict failed "$started" "$(now)" "$raw_pid" "$raw_session" "$raw_cgroup" SIGTERM expected_operator_shutdown SIGTERM unavailable; return 1; }
  IFS=$'\t' read -r raw_key raw_signal raw_result raw_latency raw_artifact_path raw_artifact_sha256 < <(parse_wait_receipt "$raw_wait") || { append_case expected_close_verdict failed "$started" "$(now)" "$raw_pid" "$raw_session" "$raw_cgroup" SIGTERM expected_operator_shutdown SIGTERM unavailable; return 1; }
  append_case expected_close_verdict passed "$started" "$(now)" "$raw_pid" "$raw_session" "$raw_cgroup" SIGTERM expected_operator_shutdown "$raw_signal" "$raw_result" '' expected_operator_shutdown "$raw_key" "$raw_latency" "$raw_artifact_path" "$raw_artifact_sha256"

  recovery_session="issue1938-recovery-$RUN_PREFIX-$$"; recovery_state="$WORKTREE/.gjc-session-state/$recovery_session"; RECOVERY_SOCKET="gjc-${recovery_session//[^A-Za-z0-9_.-]/_}"; SERVICE_UNIT="gjc-issue1938-recovery-$RUN_PREFIX-$$-$RANDOM.service"; TRACKED_UNITS+=("$SERVICE_UNIT")


  if ! run_unsafe_service env TMUX_TMPDIR="$WORKTREE/tmux" GJC_ISSUE1938_TMUX_SOCKET="$RECOVERY_SOCKET" GJC_BIN="$product_bin" GJC_SESSION_TMUX_BIN="$tmux_wrapper" GJC_SESSION_MONITOR_INTERVAL="$MONITOR_INTERVAL_SECONDS" GJC_SESSION_SKIP_ROUTER=1 bash "$WORKTREE/scripts/gjc-session/create.sh" "$recovery_session" "$WORKTREE"; then append_case unexpected_incident_recovery failed "$started" "$(now)" '' "$recovery_session" '' SIGTERM unexpected_owner_loss UNKNOWN launch_failed; return 1; fi
  pid="$(wait_server_pid "$recovery_session" "$RECOVERY_SOCKET" || true)"; cgroup="$(proc_cgroup "$pid")"
  if [[ -z "$pid" || -z "$cgroup" ]] || ! independent_scope "$cgroup"; then append_case unexpected_incident_recovery failed "$started" "$(now)" "$pid" "$recovery_session" "$cgroup" SIGTERM unexpected_owner_loss UNKNOWN unavailable; return 1; fi
  owner_unit="$(owner_scope "$cgroup")"; TRACKED_UNITS+=("$owner_unit"); track_server "$WORKTREE/tmux" "$RECOVERY_SOCKET" "$recovery_session" "$pid" && track_server "$WORKTREE/tmux" "$RECOVERY_SOCKET" "${recovery_session}-owner-monitor" "$pid" || { append_case unexpected_incident_recovery failed "$started" "$(now)" "$pid" "$recovery_session" "$cgroup" SIGTERM unexpected_owner_loss UNKNOWN unavailable; return 1; }
  recovery_baseline="$(capture_verdict_baseline "$recovery_state" "$recovery_session" "$bun_bin")" || return 1
  IFS=$'\t' read -r recovery_baseline_generation recovery_baseline_verdict_id recovery_baseline_incident_id recovery_baseline_incident_alias_id recovery_baseline_vanished_id recovery_baseline_vanished_alias_id <<<"$recovery_baseline"
  recovery_trigger_started_ms="$(date +%s%3N)"
  recovery_native_id="$(session_native_id "$recovery_session" "$RECOVERY_SOCKET")"
  [[ "$recovery_native_id" =~ ^\$[0-9]+$ ]] || { append_case unexpected_incident_recovery failed "$started" "$(now)" "$pid" "$recovery_session" "$cgroup" SIGTERM unexpected_owner_loss UNKNOWN trigger_identity_unavailable; return 1; }
  TMUX_TMPDIR="$WORKTREE/tmux" tmux -L "$RECOVERY_SOCKET" kill-session -t "$recovery_native_id" >/dev/null 2>&1 || { append_case unexpected_incident_recovery failed "$started" "$(now)" "$pid" "$recovery_session" "$cgroup" SIGTERM unexpected_owner_loss UNKNOWN trigger_failed; return 1; }
  recovery_deadline_at_ms=$((recovery_trigger_started_ms + RECOVERY_VERDICT_DEADLINE_MS))
  recovery_wait="$("$bun_bin" "$SCRIPT_DIR/wait-for-issue-1938-verdict.ts" --state-dir "$recovery_state" --session "$recovery_session" --classification unexpected_owner_loss --require-incident true --trigger-start-ms "$recovery_trigger_started_ms" --deadline-at-ms "$recovery_deadline_at_ms" --poll-ms "$VERDICT_POLL_MS" --baseline-generation "$recovery_baseline_generation" --baseline-verdict-id "$recovery_baseline_verdict_id" --baseline-incident-id "$recovery_baseline_incident_id" --baseline-incident-alias-id "$recovery_baseline_incident_alias_id" --baseline-vanished-id "$recovery_baseline_vanished_id" --baseline-vanished-alias-id "$recovery_baseline_vanished_alias_id" --artifact-dir "$EVIDENCE_DIR/artifacts" --artifact-name unexpected_incident_recovery)" || { append_case unexpected_incident_recovery failed "$started" "$(now)" "$pid" "$recovery_session" "$cgroup" SIGTERM unexpected_owner_loss UNKNOWN unavailable; return 1; }
  IFS=$'\t' read -r recovery_key recovery_signal recovery_result recovery_latency recovery_artifact_path recovery_artifact_sha256 < <(parse_wait_receipt "$recovery_wait") || { append_case unexpected_incident_recovery failed "$started" "$(now)" "$pid" "$recovery_session" "$cgroup" SIGTERM unexpected_owner_loss UNKNOWN unavailable; return 1; }

  SERVICE_UNIT="gjc-issue1938-recovered-$RUN_PREFIX-$$-$RANDOM.service"; TRACKED_UNITS+=("$SERVICE_UNIT")
  if ! run_unsafe_service env TMUX_TMPDIR="$WORKTREE/tmux" GJC_ISSUE1938_TMUX_SOCKET="$RECOVERY_SOCKET" GJC_BIN="$product_bin" GJC_SESSION_TMUX_BIN="$tmux_wrapper" GJC_SESSION_MONITOR_INTERVAL="$MONITOR_INTERVAL_SECONDS" GJC_SESSION_SKIP_ROUTER=1 bash "$WORKTREE/scripts/gjc-session/create.sh" "$recovery_session" "$WORKTREE"; then append_case unexpected_incident_recovery failed "$started" "$(now)" '' "$recovery_session" '' SIGTERM unexpected_owner_loss UNKNOWN recovery_launch_failed '' '' "$recovery_key" "$recovery_latency"; return 1; fi
  pid="$(wait_server_pid "$recovery_session" "$RECOVERY_SOCKET" || true)"; cgroup="$(proc_cgroup "$pid")"; if [[ -z "$pid" || -z "$cgroup" ]] || ! independent_scope "$cgroup"; then append_case unexpected_incident_recovery failed "$started" "$(now)" "$pid" "$recovery_session" "$cgroup" SIGTERM unexpected_owner_loss UNKNOWN recovery_scope_unavailable; return 1; fi; owner_unit="$(owner_scope "$cgroup")"; TRACKED_UNITS+=("$owner_unit"); track_server "$WORKTREE/tmux" "$RECOVERY_SOCKET" "$recovery_session" "$pid" && track_server "$WORKTREE/tmux" "$RECOVERY_SOCKET" "${recovery_session}-owner-monitor" "$pid" || { append_case unexpected_incident_recovery failed "$started" "$(now)" "$pid" "$recovery_session" "$cgroup" SIGTERM unexpected_owner_loss UNKNOWN recovery_identity_unavailable; return 1; }
  if ! python3 - "$recovery_state/recovery.json" "$recovery_state" "$recovery_session" "$recovery_key" <<'PY'
import json, os, sys
try:
 value=json.load(open(sys.argv[1],encoding="utf-8")); state, session, dedupe = sys.argv[2:]
 generation=dedupe.rsplit(":",1)[-1]
 incident_dedupe=f"{session}:{generation}"
 required={"schema_version","kind","session_id","owner_generation","prior_owner_generation","prior_incident_dedupe"}
 if set(value) != required or value.get("schema_version") != 1 or value.get("kind") != "owner_recovered" or value.get("session_id") != session or value.get("prior_owner_generation") != generation or value.get("prior_incident_dedupe") != incident_dedupe or not isinstance(value.get("owner_generation"),str) or value["owner_generation"] == generation: raise ValueError()
 canonical=os.path.join(state,session,"owner-lifecycle",f"recovery-{value['owner_generation']}.json")
 if json.load(open(canonical,encoding="utf-8")) != value: raise ValueError()
except Exception: raise SystemExit(1)
PY
  then append_case unexpected_incident_recovery failed "$started" "$(now)" "$pid" "$recovery_session" "$cgroup" SIGTERM unexpected_owner_loss UNKNOWN recovery_unavailable '' '' "$recovery_key" "$recovery_latency"; return 1; fi
  append_case unexpected_incident_recovery passed "$started" "$(now)" "$pid" "$recovery_session" "$cgroup" SIGTERM unexpected_owner_loss "$recovery_signal" "$recovery_result" '' unexpected_owner_loss "$recovery_key" "$recovery_latency" "$recovery_artifact_path" "$recovery_artifact_sha256"
}

if [[ "$PHASE" == pre-code ]]; then run_pre_code; else run_post_code; fi
