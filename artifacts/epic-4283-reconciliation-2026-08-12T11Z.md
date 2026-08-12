# Epic #4283 Reconciliation Ledger — 2026-08-12 11:15Z (refresh 2)

**Coordination lane:** `owner/issue-4283-customization-epic` (epic-owner worktree, no child implementation)
**Reference dev head:** `ef3bd5c2276be1e50e59b026d36deb5c0255ccc1` (`origin/dev` at capture time)
**Prior ledger:** `artifacts/epic-4283-reconciliation-2026-08-12.md` (2/7 terminal at ~10:00Z)

## Child-state ledger (freshly derived)

| Child | Contract | Issue state (last API read 10:59Z) | PR evidence | Git evidence vs `origin/dev` `ef3bd5c227` | Terminal |
|---|---|---|---|---|---|
| #4284 | Stored MCP registrations activate in ordinary sessions | OPEN (upd 06:51Z) | PR #4335 OPEN, MERGEABLE / mergeState **UNSTABLE**, head `005ed04c76`, branch ahead=1 behind=6; epic-owner CI diagnosis posted as PR comment `issuecomment-5265916160` | check:`@gajae-code/coding-agent` **FAILURE** — root-caused below | **Nonterminal** (one PR-owned lint fix outstanding) |
| #4285 | Zero-config conventional SKILL.md discovery | **CLOSED 11:13:28Z by epic-owner reconciliation** (keyword auto-close does not fire for non-default base `dev`) | PR #4349 **MERGED** 11:07:45Z, merge commit `ef3bd5c227` (REST-verified) | merge commit is the `origin/dev` head at capture; close evidence comment `issuecomment-5265933569` | ✅ **Terminal** |
| #4286 | Hook convention normalization (IR + adapters) | CLOSED 02:50:15Z | PR #4289 → `77ce3f7b99`, PR #4307 → `eef03e4617` | both `--is-ancestor origin/dev` → YES (re-verified 11:15Z) | ✅ Terminal |
| #4287 | Loose customization vs distributable bundles | CLOSED 00:47:11Z | PR #4290 → `364cbfe610` | `--is-ancestor origin/dev` → YES (re-verified 11:15Z) | ✅ Terminal |
| #4288 | Provenance-aware customization doctor | OPEN (upd 09:44Z) | PR #4350 OPEN; was mergeState CLEAN at 10:20Z, **now `mergeable=false`/`dirty` after #4349 merge** (REST-verified ~11:45Z), head `15a73c5f4d`, branch 6 behind | `git merge-tree` vs `origin/dev` `bc2492af38`: conflicts in `README.md`, `packages/coding-agent/src/discovery/claude.ts`, `packages/coding-agent/src/discovery/codex.ts`; rebase coordination posted `issuecomment-5266385808` | **Nonterminal** (rebase required; caught by QA red-team falsification, gen-1→gen-2 correction) |
| #4291 | `/extensions` UI + Claude/Codex import into `.gjc` | OPEN (upd 06:08Z) | No PR. Lane comment claims branch `feat/issue-4291-extensions-ui-import` ff'd to `e8af95c833` | **remote branch does not exist on origin** (`git ls-remote` zero matches for `4291`/`extensions-ui`); coordination comment `issuecomment-5265942195` posted requesting pushed evidence | **Nonterminal** (unverifiable local-only claims) |
| #4292 | MCP 2026-07-28 stateless protocol (v2) | OPEN (upd 06:02Z) | No PR. Lane comment claims branch `feat/issue-4292-mcp-v2` ff'd to `2067b93976`, spec verified against primary sources, plan defined | **remote branch does not exist on origin**; coordination comment `issuecomment-5265942334` posted requesting pushed evidence | **Nonterminal** (unverifiable local-only claims) |

## PR #4335 CI failure root cause (locally reproduced)

Failed shard run `31585850513` (head `005ed04c7617c1592ca4ed12ea21632841430893`):

- `Affected path validation / check:@gajae-code/coding-agent` → FAILURE
- `Affected path validation / evidence producer` → FAILURE (aggregate: "required affected shards did not succeed")
- `Affected path validation` → FAILURE (aggregate)

Local reproduction (biome from repo `node_modules`, PR head worktree):

- `packages/coding-agent/test/runtime-mcp/mcp-autoload-redteam.test.ts` (**added by the PR**):
  `biome check` exit=1 — `lint/suspicious/noPrototypeBuiltins` @186:11, `assist/source/organizeImports` @9:1, `format` violations. **This is the sole blocking cause.**
- Diagnostics in files outside the PR diff (`src/sdk/host/session-runtime.test.ts` ×5 `captureCalls`, `src/config/settings.ts`:276, `src/sdk/bus/telegram-daemon.ts`:3103, `src/tools/bash.ts`:1084 ×2, `test/sdk-daemon-cli-e2e.test.ts`:359) are **warnings, exit=0**, identical content on `origin/dev` → pre-existing noise, not the failure.
- Sibling PR #4350's `check:@gajae-code/coding-agent` shard is SUCCESS on a similarly current base → consistent with PR-owned failure.

Required lane fix: `biome check --write packages/coding-agent/test/runtime-mcp/mcp-autoload-redteam.test.ts` (or manual equivalent), push, re-verify shard.

## Epic acceptance gaps (beyond child merges)

1. **Integration precedence/trust-model documentation** — partially landed per-surface: `docs/skills.md` now has a Precedence + trust-settings section (via #4349), `docs/hooks.md` documents the canonical hook IR and Claude/Codex normalization (via #4286), MCP autoload precedence rides with PR #4335 (`docs/standalone-mcp.md` update in its diff). Still absent: one umbrella doc tying the Claude Code / Codex / native `.gjc` precedence+trust model together for the epic's import journey. **Owner: epic lane, after remaining children land** (doc must describe final behavior of #4284/#4288/#4291).
2. **Representative cross-convention e2e fixture** — no fixture on `origin/dev` proving the same MCP/skill/hook customization is consumable via Claude Code, Codex, and native GJC conventions. Cross-convention tests exist per-surface only (skills: `test/skills.test.ts`, `test/skill-management.test.ts`; hooks: `test/hook-event-normalization.test.ts`; MCP: `mcp-autoload-precedence` in #4335). **Owner: epic lane, after children land** (depends on #4284 autoload + #4285 discovery + #4286 hooks, which define the consumed surfaces).

## Disposition

#4283 stays **OPEN**. Terminal: 3/7 (#4286, #4287, #4285 — closed with evidence this run). Nonterminal: #4284 (one PR-owned lint fix, diagnosis delivered to lane), #4288 (PR #4350 conflicts with post-#4349 dev; rebase coordination delivered), #4291 + #4292 (no pushed branch, no PR — lanes owe pushed evidence; coordination comments posted). Epic addendum comment `issuecomment-5266388593` records the gen-2 correction.
Resume triggers: #4335 green/merged, #4350 merged, any pushed branch/PR for #4291/#4292. Epic-level acceptance items (umbrella precedence/trust doc + representative e2e fixture) execute in this lane after the remaining children land.
