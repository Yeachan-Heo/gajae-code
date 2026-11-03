#!/usr/bin/env bash
# Public-safe GJC session postmortem helpers. Markers contain only lifecycle
# state and paths; they never read or persist pane, prompt, or runtime payloads.


gjc_session_git_dirty_boolean() {
  local workdir="${1:-}"
  local status
  if [[ -z "$workdir" ]] || ! git -C "$workdir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'null\n'
    return
  fi
  status="$(git -C "$workdir" status --porcelain 2>/dev/null)" || { printf 'null\n'; return; }
  [[ -n "$status" ]] && printf 'true\n' || printf 'false\n'
}


# Owner lifecycle state is written by pathname. Before each write, refuse a
# directory whose existing components, walked from the filesystem root with
# lstat, are not all real directories, and a named file that exists as anything
# but a single-link regular file. These are pathname checks, like the TypeScript
# writers': a component swapped after it was inspected is not detected.
# The path is walked as spelled, the way the writer will open it, so a `..`
# component (which the kernel resolves through a preceding link) is refused.
#   gjc_session_require_private_path <directory> [<file>...]
#   gjc_session_require_private_path --create <directory>
# --create makes each missing component owner-only, checking it as it goes.
gjc_session_require_private_path() {
  python3 - "$@" <<'PY'
import os, stat, sys
args = sys.argv[1:]
create = args[:1] == ["--create"]
if create: args = args[1:]
if not args or (create and len(args) != 1): raise SystemExit("usage: gjc_session_require_private_path [--create] <directory> [<file>...]")
def native(target):
    # macOS resolves only its system aliases; every other link is refused.
    if sys.platform == "darwin":
        for alias in ("/var", "/tmp", "/etc"):
            if target == alias or target.startswith(f"{alias}/"): return f"/private{target}"
    return target
def spelled(target):
    # No normalization: os.path.abspath would fold `link/..` lexically.
    return target if os.path.isabs(target) else os.path.join(os.getcwd(), target)
def walk(directory):
    components = [component for component in spelled(directory).split("/") if component not in ("", ".")]
    if ".." in components: raise SystemExit(f"unsafe owner lifecycle path: {directory}")
    current = "/"
    # Without `..`, dropping empty and `.` components names the same file.
    for component in native("/" + "/".join(components)).split("/"):
        if not component: continue
        current = os.path.join(current, component)
        try:
            mode = os.lstat(current).st_mode
        except FileNotFoundError:
            if not create: return
            try: os.mkdir(current, 0o700)
            except FileExistsError: pass
            mode = os.lstat(current).st_mode
        if not stat.S_ISDIR(mode): raise SystemExit(f"unsafe owner lifecycle path: {current}")
try:
    walk(args[0])
    for file in args[1:]:
        walk(os.path.dirname(spelled(file)))
        try: info = os.lstat(file)
        except FileNotFoundError: continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise SystemExit(f"unsafe owner lifecycle path: {file}")
except OSError as error:
    raise SystemExit(f"unsafe owner lifecycle path: {error.strerror}")
PY
}


gjc_session_write_public_marker() {
  local path="${1:?marker path required}"
  local kind="${2:?marker kind required}"
  local session="${3:?session required}"
  local generation="${4:?generation required}"
  gjc_session_require_private_path --create "$(dirname "$path")" || return 1
  gjc_session_require_private_path "$(dirname "$path")" "$path" || return 1
  python3 - "$path" "$kind" "$session" "$generation" <<'PY'
import json
import os
import sys
path, kind, session, generation = sys.argv[1:]
temporary = f"{path}.{os.getpid()}.tmp"
with open(temporary, "x", encoding="utf-8") as handle:
    json.dump({"schema_version": 1, "kind": kind, "session_id": session, "owner_generation": generation}, handle, separators=(",", ":"))
    handle.write("\n")
os.replace(temporary, path)
PY
}


gjc_session_validate_raw_verdict() {
  local verdict_path="${1:?verdict path required}"
  local generation_path="${2:?generation path required}"
  local session="${3:?session required}"
  local generation="${4:?generation required}"
  local server_key="${5:?server key required}"
  local intent_path="${6:-$(dirname "$generation_path")/intent-$generation.json}"
  python3 - "$verdict_path" "$generation_path" "$session" "$generation" "$server_key" "$intent_path" <<'PY'
import datetime, json, re, sys
verdict_path, generation_path, session, generation, server_key, intent_path = sys.argv[1:]
canonical_utc = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$")
def strict_utc(value):
    if not isinstance(value, str) or not canonical_utc.fullmatch(value): raise ValueError("invalid UTC timestamp")
    return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ" if "." in value else "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
try:
    with open(verdict_path, encoding="utf-8") as handle: verdict = json.load(handle)
    with open(generation_path, encoding="utf-8") as handle: current = json.load(handle)
    required = {"schema_version", "generation", "session_id", "server_key", "observed_at", "signal", "exit_code", "result", "observer", "classification", "reason", "dedupe_key"}
    if verdict.get("classification") == "expected_operator_shutdown": required.add("intent_id")
    observed = strict_utc(verdict.get("observed_at"))
    identity = (set(verdict) == required and verdict["schema_version"] == 1 and verdict["generation"] == generation
        and verdict["session_id"] == session and verdict["server_key"] == server_key
        and current.get("schema_version") == 1 and current.get("session_id") == session and current.get("generation") == generation
        and isinstance(verdict["signal"], str) and verdict["exit_code"] is None
        and isinstance(verdict["observer"], str) and isinstance(verdict["reason"], str) and bool(verdict["reason"])
        and verdict["dedupe_key"] == f"owner-loss:{session}:{generation}")
    unexpected = (verdict["classification"] == "unexpected_owner_loss"
        and ((verdict["result"] == "owner_lost" and verdict["signal"] == "UNKNOWN")
            or (verdict["result"] == "signal" and verdict["signal"] in {"SIGTERM", "SIGINT", "SIGHUP"})
            or (verdict["result"] == "unknown_terminal" and verdict["signal"] in {"SIGTERM", "SIGINT", "SIGHUP", "UNKNOWN"}))
        and verdict["observer"] in {"raw_monitor", "replacement_reconciler"})
    expected = False
    if verdict["classification"] == "expected_operator_shutdown":
        consumed_intent_path = f"{intent_path}.consumed"
        with open(consumed_intent_path, encoding="utf-8") as handle: intent = json.load(handle)
        created = strict_utc(intent["created_at"])
        expires = strict_utc(intent["expires_at"])
        expected = (set(intent) == {"schema_version", "intent_id", "generation", "session_id", "server_key", "expected_terminal", "dispatch_id", "created_at", "expires_at", "state"}
            and intent["schema_version"] == 1 and isinstance(intent["intent_id"], str) and bool(intent["intent_id"])
            and intent["generation"] == generation and intent["session_id"] == session and intent["server_key"] == server_key
            and intent["expected_terminal"] == {"signal": "SIGTERM", "result": "owner_term_then_session_cleanup"}
            and isinstance(intent["dispatch_id"], str) and bool(intent["dispatch_id"]) and intent["state"] == "pending"
            and created <= observed < expires and verdict["signal"] == "SIGTERM" and verdict["result"] == "owner_term_then_session_cleanup"
            and verdict["observer"] == "raw_monitor" and verdict["intent_id"] == intent["intent_id"])
    raise SystemExit(0 if identity and (unexpected or expected) else 1)
except (KeyError, OSError, TypeError, ValueError):
    raise SystemExit(1)
PY
}

 gjc_session_publish_current_alias() {
  local canonical_path="${1:?canonical path required}"
  local alias_path="${2:?alias path required}"
  local generation_path="${3:?generation path required}"
  local session="${4:?session required}"
  local generation="${5:?generation required}"
  local kind="${6:-}"
  local transition_lock="${generation_path%.json}.transition.lock"
  gjc_session_require_private_path "$(dirname "$alias_path")" "$alias_path" || return 1
  gjc_session_require_private_path "$(dirname "$generation_path")" "$transition_lock" "$(dirname "$generation_path")/owner-locks.sqlite" || return 1
  if [[ "${GJC_SESSION_TRANSITION_LOCK_HELD:-0}" != 1 ]]; then
    exec {gjc_alias_lock_fd}>"$transition_lock"
    flock -x "$gjc_alias_lock_fd"
  fi
  python3 - "$canonical_path" "$alias_path" "$generation_path" "$session" "$generation" "$kind" <<'PY'
import json
import os
import sqlite3
import sys
canonical_path, alias_path, generation_path, session, generation, kind = sys.argv[1:]
lock_path = os.path.join(os.path.dirname(generation_path), "owner-locks.sqlite")
database = sqlite3.connect(lock_path, timeout=7)
temporary = f"{alias_path}.{os.getpid()}.tmp"
created = False
try:
    os.chmod(lock_path, 0o600)
    database.execute("BEGIN IMMEDIATE")
    with open(canonical_path, encoding="utf-8") as handle: record = json.load(handle)
    with open(generation_path, encoding="utf-8") as handle: current = json.load(handle)
    record_generation = record.get("owner_generation", record.get("generation"))
    valid = (record.get("schema_version") == 1 and record.get("session_id") == session and record_generation == generation and (not kind or record.get("kind") in (None, kind)) and current.get("schema_version") == 1 and current.get("session_id") == session and current.get("generation") == generation)
    if not valid: raise ValueError("invalid canonical identity")
    if kind == "owner_incident" and (record.get("classification") != "unexpected_owner_loss" or record.get("dedupe_key") != f"owner-loss:{session}:{generation}"): raise ValueError("invalid incident canonical")
    alias = dict(record); alias["owner_generation"] = generation
    if kind: alias["kind"] = kind
    if kind == "owner_incident": alias["incident_dedupe"] = f"{session}:{generation}"
    with open(temporary, "x", encoding="utf-8") as handle:
        created = True
        json.dump(alias, handle, separators=(",", ":")); handle.write("\n")
    os.replace(temporary, alias_path)
    database.commit()
except Exception:
    database.rollback()
    if created:
        try: os.unlink(temporary)
        except FileNotFoundError: pass
    raise
finally:
    database.close()
PY
  local rc=$?
  if [[ "${GJC_SESSION_TRANSITION_LOCK_HELD:-0}" != 1 ]]; then
    flock -u "$gjc_alias_lock_fd"
    eval "exec ${gjc_alias_lock_fd}>&-"
  fi
  return "$rc"
}

 gjc_session_write_vanished_json() {
  local vanished_json="${1:?vanished json path required}"
  local session="${2:?session required}"
  local workdir="${3:?workdir required}"
  local reason="${4:?reason required}"
  local phase="${5:?phase required}"
  local severity="${6:-failure}"
  local prompt_accepted="${7:-false}"
  local final_present="${8:-false}"
  local generation="${9:?generation required}"
  gjc_session_require_private_path --create "$(dirname "$vanished_json")" || return 1
  # The record is published with an exclusive link, so an existing leaf is only
  # read and compared; its own link count is legitimately 2 while a peer publishes.
  python3 - "$vanished_json" "$session" "$workdir" "$reason" "$phase" "$severity" "$prompt_accepted" "$final_present" "$generation" <<'PY'
import json
import os
import sys
path, session, workdir, reason, phase, severity, prompt_accepted, final_present, generation = sys.argv[1:]
temporary = f"{path}.{os.getpid()}.tmp"
with open(temporary, "x", encoding="utf-8") as handle:
    json.dump({
        "schema_version": 1,
        "session_id": session,
        "owner_generation": generation,
        "generation": generation,
        "dedupe_key": f"owner-loss:{session}:{generation}",
        "state_path": os.path.relpath(os.path.dirname(path), workdir),
        "phase": phase,
        "reason": reason,
        "severity": severity,
        "prompt_accepted": prompt_accepted == "true",
        "final_present": final_present == "true",
    }, handle, separators=(",", ":"))
    handle.write("\n")
try:
    os.link(temporary, path)
except FileExistsError:
    with open(path, encoding="utf-8") as handle:
        existing = json.load(handle)
    with open(temporary, encoding="utf-8") as handle:
        candidate = json.load(handle)
    if existing != candidate:
        raise
finally:
    os.unlink(temporary)
PY
}
