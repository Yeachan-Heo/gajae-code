#!/usr/bin/env bash
# Public-safe GJC session postmortem helpers. Do not include raw prompt text,
# pane text, tokens, config, or logs in JSON markers written by this file.

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

gjc_session_git_dirty_boolean() {
  local workdir="${1:-}"
  if [[ -z "$workdir" ]]; then
    printf 'null\n'
    return 0
  fi
  if ! git -C "$workdir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'null\n'
    return 0
  fi
  if [[ -n "$(git -C "$workdir" status --porcelain 2>/dev/null)" ]]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
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
  local tui_ready="${9:-false}"
  local pane_log="${10:-}"
  local events_log="${11:-}"
  local final_json="${12:-}"
  local runtime_state="${13:-}"
  local prompt_accepted_json="${14:-}"
  local detected_at
  detected_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$(dirname "$vanished_json")"
  python3 - "$vanished_json" "$session" "$detected_at" "$workdir" "$reason" "$phase" "$severity" "$prompt_accepted" "$final_present" "$tui_ready" "$pane_log" "$events_log" "$final_json" "$runtime_state" "$prompt_accepted_json" <<'PY'
import json
import os
import sys

(
    path,
    session,
    detected_at,
    workdir,
    reason,
    phase,
    severity,
    prompt_accepted,
    final_present,
    tui_ready,
    pane_log,
    events_log,
    final_json,
    runtime_state,
    prompt_accepted_json,
) = sys.argv[1:]

def rel_to_workdir(value: str) -> str | None:
    if not value:
        return None
    try:
        return os.path.relpath(value, workdir)
    except ValueError:
        return None

runtime_terminal_state = None
runtime_terminal_source = None
if runtime_state:
    try:
        with open(runtime_state, encoding="utf-8") as runtime_handle:
            runtime_data = json.load(runtime_handle)
        state = runtime_data.get("state")
        session_id = runtime_data.get("session_id")
        cwd = runtime_data.get("cwd") or runtime_data.get("workdir")
        final_response = runtime_data.get("final_response") if isinstance(runtime_data.get("final_response"), dict) else {}
        session_matches = not session_id or session_id == session
        cwd_matches = not cwd or os.path.abspath(str(cwd)) == os.path.abspath(workdir)
        if state in {"completed", "errored"} and session_matches and cwd_matches:
            runtime_terminal_state = state
            runtime_terminal_source = final_response.get("source") or runtime_data.get("source") or "runtime_state"
    except Exception:
        pass
current_dirty_raw = "null"
try:
    import subprocess
    probe = subprocess.run(["git", "-C", workdir, "status", "--porcelain"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    if probe.returncode == 0:
        current_dirty_raw = "true" if probe.stdout else "false"
except Exception:
    pass
baseline_dirty = None
try:
    if prompt_accepted_json:
        with open(prompt_accepted_json, encoding="utf-8") as prompt_handle:
            value = json.load(prompt_handle).get("worktreeBaselineDirty")
        if isinstance(value, bool):
            baseline_dirty = value
except Exception:
    pass
if baseline_dirty is None:
    try:
        metadata_path = os.path.join(os.path.dirname(path), "metadata.json")
        with open(metadata_path, encoding="utf-8") as metadata_handle:
            value = json.load(metadata_handle).get("worktreeBaselineDirty")
        if isinstance(value, bool):
            baseline_dirty = value
    except Exception:
        pass
current_dirty = None if current_dirty_raw == "null" else current_dirty_raw == "true"
changed_since_baseline = baseline_dirty is False and current_dirty is True
with open(path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "session": session,
            "detectedAt": detected_at,
            "phase": phase,
            "reason": reason,
            "severity": severity,
            "promptAccepted": prompt_accepted == "true",
            "finalPresent": final_present == "true",
            "tuiReadyObserved": tui_ready == "true",
            "statePath": rel_to_workdir(os.path.dirname(path)),
            "paneLog": rel_to_workdir(pane_log),
            "eventsLog": rel_to_workdir(events_log),
            "finalStatus": rel_to_workdir(final_json),
            "runtimeState": rel_to_workdir(runtime_state),
            "promptAcceptedStatus": rel_to_workdir(prompt_accepted_json),
            "runtimeTerminal": runtime_terminal_state in {"completed", "errored"},
            "runtimeTerminalState": runtime_terminal_state,
            "runtimeTerminalSource": runtime_terminal_source,
            "worktreeBaselineDirty": baseline_dirty,
            "observedRecoverableWorktreeChanges": current_dirty is True,
            "worktreeChangedSinceBaseline": changed_since_baseline,
        },
        handle,
        indent=2,
    )
    handle.write("\n")
PY
}
