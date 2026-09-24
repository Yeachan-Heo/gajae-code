### Fixed

- Recover uncertain ACP `turn.abort` dispatches with bounded exact-kind/correlation `turn.result` reads without replaying mutations. Report `terminal_ok`/`end_turn` results with a missing receipt as `prompt_failed` while prompt settlement is pending; a later owner-only lookup does not turn an already reported `terminal_uncertain` prompt into success. Keep unresolved ownership fenced across transport reattachment and overlapping acknowledged cancels until exact terminal proof or session retirement, without asserting that pending tool resources physically settled (#5401).
