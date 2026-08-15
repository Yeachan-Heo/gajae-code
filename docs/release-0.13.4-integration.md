# release/0.13.4 integration

Branch cut from `main` at v0.13.3 (`accd043c16`). Same discipline as 0.13.3:
cluster-complete landings only, per-group gates, decisions recorded here.

## Wave 1 — landed (this branch)

| Pick | Commit | Notes |
| --- | --- | --- |
| #4579 tui: iTerm pet geometry | cherry-pick of `f024ded614` | pet shipped in 0.13.3; first user-facing polish fix |
| #4573 session: bound apply_patch transcript metadata | `87b540d2ca` | successor #4557 tracked in Wave 2 |
| #4556 ai: release Codex websocket on abort | `91a35114d1` | flagged successor is the unrelated oMLX feat (path overlap only) |

Dropped: #4312 — source byte-identical on main since 0.13.2; only its changelog hunk differed.

Gates at head: full workspace typecheck 0 TS errors; 432 targeted tests 0 fail
(tui pet, session suites, ai codex); `ci:test:smoke` ok.

## Wave 2 — small hand-work, pending go

Anthropic chain (sim: 5 land mechanically, 2 need hand-resolution against the
0.13.3 escaped-non-ASCII detection hunks):
`597e8e5953` (#4267) → `7538e155fc` (#4339) → `4541baf0ef` → `700d66d045` →
`ef4ce20a23` (#4416) → HAND: `236de5111f` (#4443) → HAND: `cd51365cc2` (#4557).
Must land whole or not at all — 5-of-7 recreates the mid-chain hazard.

#4586 (models-endpoint fail-closed validation): awaiting review/merge on dev,
then a clean backport (`api-key-validation.ts` byte-identical main↔dev).

## Deferred to 0.14 — with reasons

- Crash recovery (#4470, #4495 + 6 successors): `src/crash/` does not exist on
  main. The fixes require the +2,569-line consent-ordered crash-report feature
  (`45561d7802`, includes a config-schema addition). That is a minor-release
  feature, not a patch backport. The 0.13.3 plan for these was based on a
  wrong premise.
- Session/storage (#4421, #4450, #4583): dev rewrote managed-session storage
  (46 of 59 chain commits conflict). Landing requires a hand-rebase onto the
  0.13.3 storage shape (the `ebaf35754a` reconcile pattern) — owner decision.
- SDK session-index (#4544/#4555, #4595): broker index moved to v3 semantics
  on dev (15 of 16 chain commits conflict). Rides with 0.14.
- Managed snapshots (#4580, #4587): conflict with main's #4515 variant on
  `agent-loop.ts`. Recommended resolution is taking dev's provisional chain
  wholesale in 0.14, retiring the divergence debt.
- #4570 (positioned session events): touches `sdk/bus` + telegram daemon
  contract — notification architecture, excluded from patches.

## Validation evidence

Updated as groups land. Wave 1: see gates above; commands run in a clean
worktree with correct workspace linkage and built natives.
