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

## Wave 2 — landed (this branch)

Anthropic chain, landed whole in order:
`597e8e5953` (#4267) → `7538e155fc` (#4339) → `4541baf0ef` → `700d66d045` →
`ef4ce20a23` (#4416) → `236de5111f` (#4443) → `cd51365cc2` (#4557).

Hand-resolution decisions (recorded so the eventual dev merge is mechanical):

- #4443: the cherry-pick conflict in `transform-messages.ts` carried dev's
  `collapseAdjacentThinking` (#4418, `f1150c6037` — not in this chain) as
  context. Only the commit's own payload (`hasAdjacentPrivateThinkingBlocks`)
  was taken; the replay-time collapse stays dev-only, the send-boundary
  collapse (#4425) covers this base.
- #4557: dropped the `&& !localSnapshot` guard in the `maxAttempts`
  resolution — `localSnapshot` comes from deferred #4580, and the commit's
  own trailers call that guard obsolete/unreachable even on dev.
- Changelog conflicts resolved payload-only; dev-context entries excluded.

Branch-only reconciliations:

- The #4573 test hard-coded dev's 128 MiB `MANAGED_ARTIFACT_MAX_FILE_BYTES`;
  main's base is 64 MiB. Assertion now uses the exported constant.
- `artifacts/issue-3670-anthropic-cache-eval.json` (gitignored evidence)
  regenerated via `WRITE_ISSUE_3670_EVAL=1` since the chain rewrote
  `anthropic.ts` and the eval pins its blob identity.

Still pending: #4586 (models-endpoint fail-closed validation) — not yet
merged on dev as of 2026-08-16; clean backport once it lands
(`api-key-validation.ts` byte-identical main↔dev).

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

Wave 2 (2026-08-16):

- `packages/ai` + `packages/coding-agent` package checks (biome + tsc): clean.
- Chain-surface tests: agent-session resilient-retry/retry-fallback,
  adjacent-thinking assertion/detector/diagnostic/collapse, thinking-repair
  budget/retry, stream-timeout, idle-iterator, fallback-transport,
  http-inspector, edit-result-persistence-bounding — all pass.
- Full `packages/ai` suite: 2459 pass / 11 fail. All 11 attributed: the
  cache-eval identity fail was chain-caused and fixed by the sanctioned
  artifact regen; the other 10 (openai-responses-cache-affinity ×3,
  auth-broker/remote-auth-store/oauth-xai ×7) reproduce identically on
  `origin/main` (accd043c16) and pre-date this branch — the broker seven
  pass in file isolation and fail only under full-suite interference.
- session-manager suites: 363 pass / 2 fail; both fails
  (`session-id.test.ts` fsync identity mismatch, resume-readonly picker-root
  drift guard) reproduce on `origin/main` — pre-existing base failures.
- `ci:test:smoke`: ok.
- `check:ts` aggregate fails only in its `check:sdk-closure` receipt:
  `sdk-client.test.ts` 14 pass / 5 fail, reproducing identically on
  `origin/main` in this environment — pre-existing, not wave-2.

Root-cause refinement (2026-08-16, same environment):

- cache-affinity ×3: operator config exports
  `OPENAI_BASE_URL=http://api.layofflabs.com/v1` (`~/.zshrc`, `~/.gjc/.env`).
  `$credentialEnv` trusts both by design, the resolved origin is
  non-canonical, and `shouldSendOpenAIResponsesSessionHeaders` correctly
  withholds `session_id`/`x-client-request-id` from an unknown relay.
  Product behavior is correct; the test is not hermetic against
  user-owned env files. Proven green under `HOME=$(mktemp -d)`.
  Hermeticity fix needs a resolution seam — dev-side work, not a backport.
- broker/oauth ×7: pass in file isolation; full-suite-only interference.
- session-manager ×2 and sdk-client ×5 are distinct families (no shared
  commits or code paths), grouped only by evidence class; both persist
  under HOME isolation and a fresh `build:native` from this branch's
  crates.
  - sdk-client ×5: RESOLVED on this branch. Deeper analysis showed all
    five reduced to one stale genesis-import contract: assertions of
    `connection_closed`/`timeout` for sent-frame scenarios that the
    shipped transport (and dev's rewritten suite, same rewrap logic)
    deliberately classifies `uncertain_after_send` to keep ambiguous
    outcomes non-retryable. Test assertions corrected; no product
    change. The dev transport chain (`9feba5daf7` → #4253 → #4281)
    stays deferred — it deletes the bridge-client workspace.
  - Same skew class, fixed alongside: two `DAEMON_GENERATION` pins
    stuck at 62 while the contract ships 63 (#4200 follow-up).
    `check:sdk-closure` and the full `check:ts` aggregate are now
    exit 0 on this branch (neither passes on `origin/main` in this
    environment). `sdk-host-wiring.test.ts` showed one intra-file
    timing flake under the gate; passes 95/95 in isolation on HEAD
    and `origin/main`.
  - session-manager ×2: natives rename/fsync spy-injection seams.
    Dev's resume-readonly repair (6 lines inside `90da036035`) moves the
    spy to `renameNoReplacePathAsync` and is valid only against dev's
    async receipt publication — this branch still publishes via the sync
    native, so the fix does not backport. `session-id.test.ts` is
    byte-identical main↔dev (no fix exists to take). A spy-seam
    hypothesis (ESM natives namespace vs CJS require view) was tested
    and falsified — the spy is visible through both views — so the
    concrete mechanism on this base is unestablished; it reproduces on
    `origin/main` and is mooted by dev's storage rewrite.
