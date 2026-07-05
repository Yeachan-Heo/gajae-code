#!/usr/bin/env bash
# Public-safe GJC session postmortem helpers. Do not include raw prompt text,
# pane text, tokens, config, or logs in JSON markers written by this file.

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
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
        },
        handle,
        indent=2,
    )
    handle.write("\n")
PY
}
