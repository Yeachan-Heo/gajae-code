### Changed

- Under `session.ownership.mode: enforce`, a turn a session host refuses because another process now holds the session reaches remote clients as `live_session`, the code the broker already returns for a held session, with the operator message and `holder: { surface, pid }`, instead of `internal`. This covers `turn.prompt`, `turn.follow_up`, `turn.abort_and_prompt` and `skill.invoke`, and the turn's `turn.prompt_status` / `turn.result` record. ACP keeps JSON-RPC `-32603` and now carries `data.code: "live_session"` and `data.holder`.
