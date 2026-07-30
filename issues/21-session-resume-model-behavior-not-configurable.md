# 21 — Session resume always restores the session's saved model; no option to apply the current default

## Severity
LOW (feature gap, not a defect; UX friction for users who change global model config between sessions)

## Context
When a session is resumed — either at CLI startup (`-c`/`-r`) or via `/resume` inside an
already-running TUI session — the model in use is restored from the session file's last
`model_change` entry, not from the currently configured default model:

- `packages/coding-agent/src/sdk/session.ts:1281-1319` — CLI-level resume. Restores
  `existingSession.models.default` unless an explicit `--model`/`options.model` was passed
  (`hasExplicitModel` gate at `session.ts:1281`, restore gate at `session.ts:1309`).
- `packages/coding-agent/src/session/agent-session.ts:15997-16115` (`switchSession`) — in-process
  `/resume` session switch. Same restore-from-`sessionContext.models.default` behavior, with no
  override path other than the CLI flag (which doesn't apply to a mid-run `/resume`).

This is intentional and correct as a *default*: it makes past sessions reproducible with the model
they were actually run under. But there is currently no way to say "when I resume, prefer whatever
model I have configured right now" without manually re-selecting the model via `/model` (or CLI
`--model`) after every resume. Users who change their global default model (`modelRoles.default`,
`model-profile-activation.ts`) between sessions have no persistent setting to make resumed sessions
pick up the new default automatically.

`task.agentModelOverrides` / `modelRoles` (executor/architect/planner/critic) are unaffected — those
are pure global settings, never persisted per-session, so they already apply live. This issue is
scoped to the single `model` (current chat model) restore path only.

## Problem
Two personas exist and neither is well served without manual intervention on every resume:

1. User changed their default model and wants resumed sessions to pick up the new default.
2. User wants a specific session to keep using whatever model it was last run with, regardless of
   global default changes (today's behavior, and the only behavior available).

There is no setting to express (1) persistently, and no way to be prompted per-resume to choose.

## Fix direction
Add a settings key, e.g. `session.resumeModelBehavior` (`packages/coding-agent/src/config/settings-schema.ts`,
enum: `"keepSessionModel"` (default, current behavior) | `"useCurrentDefault"`), and branch on it at
both restore sites:

- `sdk/session.ts:1297-1309` — when `useCurrentDefault`, skip the
  `existingSession.models.default` restore and resolve the model the same way a brand-new session
  would (`resolveModelRoleValue(settings.getModelRole("default"), …)`), with the same
  `hasModelApiKey` fallback guard already used for the session-restore path.
- `agent-session.ts:16087-16115` (`switchSession`) — same branch, applied after `sessionContext` is
  loaded, before the authoritative model restore.

Stage 2 (done): a third `"ask"` mode prompts in the TUI resume picker
(`selector-controller.ts` `handleResumeSession` → `#maybePromptResumeModelChoice`) only when the
session's saved model differs from the resolved current default (`AgentSession#resolveConfiguredDefaultModel`).
CLI/headless resume has no prompt surface, so `"ask"` falls back to `keepSessionModel` semantics
there (the `sdk.ts` gate already only special-cases `"useCurrentDefault"`).

## Status
Stage 1 and Stage 2 both landed. See PR https://github.com/Yeachan-Heo/gajae-code/pull/3293.

## Resolution

**Implemented on current `dev`.** Stage 1 and Stage 2 are landed through PR #3293, including `keepSessionModel`, `useCurrentDefault`, and the TUI `ask` behavior. This record is retained for provenance and should be closed or reclassified in the remote issue tracker rather than treated as an active backlog item.

## Non-goal
- `task.agentModelOverrides` / `modelRoles` are out of scope — already global/live, no session
  persistence involved.
- Does not change the CLI `--model` override precedence (still wins over any resume-behavior setting).

## References
- Discussion: coding-agent session (2026-07-27) on session resume model persistence.
