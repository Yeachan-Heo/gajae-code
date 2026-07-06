# Prompt / Harness / Hook Lifecycle Audit

Read-only architect audit of the per-turn lifecycle: turn pipeline (agent-loop + AgentSession event fan-out), hook execution (HookRunner/ExtensionRunner + native subprocess hook), TTSR injection lifecycle, .gjc skill/mode-state machinery, and plugin/config loading. 13 evidence-backed findings; no files modified.

## Top 5 Prioritized

1. **Finding 4** — Synchronous git spawns block the JS event loop on every turn_end for team workers and delay all downstream extension events; fix with async spawn, per-turn throttle, and cached team config.
2. **Finding 1** — Hot streaming path: quadratic string churn + repeated full-buffer regex on every delta whenever any TTSR rule exists; fix with bounded-window matching, chunked buffers, and short-circuit when no rule is triggerable (also enables honoring ttsr.enabled from finding 13).
3. **Finding 5** — One small TTL/mtime cache on the skill-active-state read pipeline eliminates 4-10 file ops per tool call and per prompt across five independent uncached call sites, and also removes the disk half of finding 11.
4. **Finding 3** — Replace readFileSync with an in-memory last-payload cache, skip identical writes, and short-circuit message_update before promise allocation — removes blocking I/O from every turn boundary and allocation from every delta.
5. **Finding 2** — Combined with finding 10: precomputed handler-presence set + early return in emit/#queueExtensionEvent removes per-delta context allocation and most per-tool-call handler scans in one small change.

## Findings

1. **P1 — TTSR checkDelta O(n²): full-buffer concat + full-buffer regex re-scan per stream delta**
   `packages/coding-agent/src/export/ttsr.ts:337-368`

2. **P1 — Every message_update allocates extension context + promise chain with zero handlers registered**
   `packages/coding-agent/src/session/agent-session.ts:1767-1789`

3. **P1 — Runtime-state sidecar: readFileSync on event path, per-delta promise, redundant identical writes per turn**
   `packages/coding-agent/src/gjc-runtime/session-state-sidecar.ts:137-143`

4. **P1 — turn_end team worker check spawns synchronous git subprocesses + re-parses config every turn, awaited inline**
   `packages/coding-agent/src/session/agent-session.ts:3146-3150`

5. **P1 — readVisibleSkillActiveState uncached: readdir + N JSON parses per prompt, per mutating tool call, per HUD tick**
   `packages/coding-agent/src/skill-state/active-state.ts:617-636`

6. **P2 — Plugin registry re-read + full SHA-256 re-hash of all plugin files on every surface call and system-prompt rebuild**
   `packages/coding-agent/src/extensibility/gjc-plugins/runtime-adapters.ts:111-122`

7. **P2 — turn_start goal baseline runs full O(messages) getSessionStats scan even when goal mode is disabled**
   `packages/coding-agent/src/session/agent-session.ts:1896-1905`

8. **P2 — Full-history structuredClone + convertToLlm + normalize rebuilt on every model call; append-only cache opt-in only**
   `packages/agent/src/agent-loop.ts:709-729`

9. **P2 — Native skill hook is a fresh gjc subprocess per prompt/Stop with cold YAML config re-parse and session re-resolution**
   `packages/coding-agent/src/hooks/native-skill-hook.ts:196-285`

10. **P2 — Hook/extension handlers strictly serialized; O(n) hasHandlers scans ×4 per tool call; 30s timeout timers persist past race**
    `packages/coding-agent/src/extensibility/extensions/runner.ts:508-578`

11. **P2 — Deep-interview/ultragoal guards read .gjc state files per edit/write/ask; Proxy wrappers and execute closures rebuilt per apply/call**
    `packages/coding-agent/src/session/agent-session.ts:3954-3998`

12. **P2 — Streaming-edit precache/abort executes twice per toolcall delta (interceptor + event handler), O(diff) re-parse each time**
    `packages/coding-agent/src/session/agent-session.ts:2055-2068`

13. **P2 — TTSR lifecycle correctness: ttsr.enabled unenforced, repeat policy global-only, lossy after-gap state across resume**
    `packages/coding-agent/src/export/ttsr.ts:77-89`

## Turn Pipeline Map

- **Prompt assembly:** `AgentSession.prompt` (agent-session.ts:4851) → command expansion → refreshGjcSubskillTools (disk) → `#promptWithMessage`: plan/goal-mode messages, nextTurn messages, file mentions, `#buildSystemPromptForAgentStart`, extension emitBeforeAgentStart + internal contributors.
- **Agent loop:** `runLoopBody` (agent-loop.ts) per step: syncContextBeforeModelCall → transformContext (extension context handlers, structuredClone) → convertToLlm → normalizeMessagesForProvider → stream → executeToolCalls (beforeToolCall/afterToolCall, shared/exclusive scheduling, steering checks).
- **Event fan-out:** `Agent.#emit` → `AgentSession.#handleAgentEvent` → local listeners + coordinator sidecar write + serialized extension queue; message_end persists JSONL; turn boundaries drive TTSR/goal/tool-choice/team-integration.
- **TTSR:** per-delta checkDelta on scoped buffers; interrupt: abort + 50ms deferred hidden ttsr-injection custom message + continue; non-interrupt tool matches folded into tool results via afterToolCall; repeat gating via turn-count.
- **Skill state:** `.gjc/_session-*/state` JSON files; reads via readVisibleSkillActiveState (readdir + per-skill JSON + mode-state); writes via dir-lock withFileLock + atomic rename; consumers: prompt path, mutation/ask guards, native hook subprocess, 1Hz HUD.
