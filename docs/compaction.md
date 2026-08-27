# Compaction and Branch Summaries

Compaction and branch summaries are the two mechanisms that keep long sessions usable without losing prior work context.

- **Compaction** rewrites old history into a summary on the current branch.
- **Branch summary** captures abandoned branch context during `/tree` navigation.

Both are persisted as session entries and converted back into user-context messages when rebuilding LLM input.

## Key implementation files

- `packages/agent/src/compaction/compaction.ts` (context-full summarization and handoff generation)
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/config/settings-schema.ts`

## Session entry model

Compaction and branch summaries are first-class session entries, not plain assistant/user messages.

- `CompactionEntry`
  - `type: "compaction"`
  - `summary`, optional `shortSummary`
  - `firstKeptEntryId` (compaction boundary)
  - `tokensBefore`
  - optional `details`, `preserveData`, `fromExtension`
- `BranchSummaryEntry`
  - `type: "branch_summary"`
  - `fromId`, `summary`
  - optional `details`, `fromExtension`

When context is rebuilt (`buildSessionContext`):

1. Latest compaction on the active path is converted to one `compactionSummary` message.
2. Kept entries from `firstKeptEntryId` to the compaction point are re-included.
3. Later entries on the path are appended.
4. `branch_summary` entries are converted to `branchSummary` messages.
5. `custom_message` entries are converted to `custom` messages.

Those custom roles are then transformed into LLM-facing user messages in `convertToLlm()` using the static templates:

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`
- `packages/agent/src/compaction/prompts/handoff-document.md`

## Compaction pipeline

### Triggers

Compaction/context maintenance can run in four ways:

1. **Manual context compaction**: `/compact [instructions]` calls `AgentSession.compact(...)`.
2. **Automatic overflow recovery**: after a same-model assistant error that matches context overflow.
3. **Automatic threshold maintenance**: after a successful turn when context exceeds the resolved threshold.
4. **Idle maintenance**: `runIdleCompaction()` can invoke the same auto-maintenance path with reason `"idle"`.

### Compaction shape (visual)

```text
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### Overflow-retry vs threshold/idle maintenance

The automatic paths are intentionally different:

- **Overflow recovery**
  - Trigger: current-model assistant error is detected as context overflow and the error is not older than the latest compaction.
  - The failing assistant error message is removed from active agent state before retry.
  - Context promotion is tried first; if a configured larger model is available, the agent switches model and retries without compacting.
  - If promotion is unavailable and compaction is enabled, context-full compaction runs with `reason: "overflow"` and `willRetry: true`; handoff strategy is not used for overflow.
  - On success, agent auto-continues (`agent.continue()`) after compaction.

- **Threshold maintenance**
  - Trigger: successful, non-error assistant message whose adjusted context tokens exceed `resolveThresholdTokens(...)`.
  - Tool-output pruning can reduce the measured token count before threshold comparison.
  - Context promotion is tried before compaction.
  - If promotion is unavailable, auto maintenance runs with `reason: "threshold"` and `willRetry: false`.
  - With `compaction.strategy: "handoff"`, threshold maintenance starts a new handoff session instead of writing a compaction entry; if handoff returns no document without aborting, it falls back to context-full compaction.
  - On success, if `compaction.autoContinue !== false`, schedules an agent-authored developer prompt from `prompts/system/auto-continue.md`; immediately before that prompt executes, live enabled goal/todo/queue/length/workflow state is re-read and the prompt is skipped if no unfinished work remains.

- **Idle maintenance**
  - Trigger: `runIdleCompaction()` when not streaming or already compacting.
  - Uses `reason: "idle"` and does not auto-continue afterward.

### Pre-compaction pruning

Before compaction checks, tool-result pruning may run (`pruneToolOutputs`).

Default prune policy:

- Protect newest `40_000` tool-output tokens.
- Protect the newest `2` real user turns (`protectRecentTurns`; user or bashExecution boundaries) — nothing in those turns is pruned, including stale-classified entries.
- Require at least `20_000` total estimated savings.
- Never prune tool results from `skill` or `read` (a `read` result loses immunity only when a later read provably covers it — exact same-target repeats or explicit bounded ranges that contain the earlier explicit ranges; open-ended, `:raw`, `:conflicts`, and multi-range selectors never claim range coverage).

Pruned tool results are replaced with a notice that keeps the highest-signal fields, error-first (exit status, error line, path hint, then tail/counts), under an absolute digest budget:

- `[Output truncated - N tokens; exit=1; error=...]` (digest form)
- `[Output truncated - N tokens; full output: artifact://<id>] exit=1; error=...` (when the session artifact manager is available, the original output is spilled to a session artifact so pruning is reversible — the agent can re-read the full output via `artifact://<id>` instead of re-running the tool)

Pruning also returns the pruned originals (`PruneResult.originals`) so callers can persist them; `AgentSession` writes them as `<id>.<toolName>.log` artifact files and only commits a pruned entry that claims an artifact after its artifact write succeeds.

If pruning changes entries, session storage is rewritten and agent message state is refreshed before compaction decisions.

### State-aware summary context

Auto and manual compaction append best-effort session-state lines to the summarization request's `<additional-context>` (after extension-provided context): the active goal (objective + status), up to 5 active workflow skills with phases, and up to 10 open todos. This makes work-in-progress state survive compaction deterministically instead of relying on the summarizer inferring it from the transcript.

### Unfinished-work-gated auto-continue

When `compaction.autoContinue` is enabled, the post-compaction synthetic continue prompt is only scheduled when there is evidence of unfinished work: a goal whose status is exactly `active`, pending/in-progress todos, queued messages, the most recent assistant turn stopping on `length`, or a recognized workflow skill in an active nonterminal phase. Paused goals, terminal phases, explicitly continuation-inert integration phases, and unknown skills/phases do not qualify. Generic Ultragoal `blocked` remains active because blockers may be autonomously resolvable; a verified human wait is represented by a paused inline goal. When no qualifying evidence remains, continuation is skipped with an info notice, avoiding a full cold-context request after already-completed work.

### Boundary and cut-point logic

`prepareCompaction()` only considers entries since the last compaction entry (if any).

1. Find previous compaction index.
2. Compute `boundaryStart = prevCompactionIndex + 1`.
3. Adapt `keepRecentTokens` using measured usage ratio when available.
4. Run `findCutPoint()` over the boundary window.

Valid cut points include:

- message entries with roles: `user`, `assistant`, `bashExecution`, `hookMessage`, `branchSummary`, `compactionSummary`
- `custom_message` entries
- `branch_summary` entries

Hard rule: never cut at `toolResult`.

If there are non-message metadata entries immediately before the cut point (`model_change`, `thinking_level_change`, labels, etc.), they are pulled into the kept region by moving cut index backward until a message or compaction boundary is hit.

### Split-turn handling

If cut point is not at a user-turn start, compaction treats it as a split turn.

Turn start detection treats these as user-turn boundaries:

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` entry
- `branch_summary` entry

Split-turn compaction generates two summaries:

1. History summary (`messagesToSummarize`)
2. Turn-prefix summary (`turnPrefixMessages`)

Final stored summary is merged as:

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### Summary generation

`compact(...)` builds summaries from serialized conversation text:

1. Convert messages via `convertToLlm()`.
2. Serialize with `serializeConversation()`.
3. Wrap in `<conversation>...</conversation>`.
4. Optionally include `<previous-summary>...</previous-summary>`.
5. Optionally inject hook context as `<additional-context>` list.
6. Execute summarization prompt with `SUMMARIZATION_SYSTEM_PROMPT`.

Prompt selection:

- first compaction: `compaction-summary.md`
- iterative compaction with prior summary: `compaction-update-summary.md`
- split-turn second pass: `compaction-turn-prefix.md`
- short UI summary: `compaction-short-summary.md`
- handoff document: `handoff-document.md` (used by `generateHandoff(...)`, not serialized compaction)

Remote summarization modes:

- If `compaction.remoteEndpoint` is set and remote compaction is enabled, local summary generation POSTs:
  - `{ systemPrompt, prompt }`
- Expects JSON containing at least `{ summary }`.
- For OpenAI/OpenAI code provider models, compaction first tries the provider-native `/responses/compact` endpoint when remote compaction is enabled. It preserves provider replacement history in `preserveData.openaiRemoteCompaction` and falls back to local summarization if that native request fails.

### Handoff generation

`packages/agent/src/compaction/compaction.ts` also exports `generateHandoff(...)`. Handoff generation uses the same `completeSimple(...)` oneshot style as summarization, but it preserves the live agent cache prefix by sending the active system prompt, tool array, and real LLM message history, then appending one agent-attributed `user` message containing the handoff prompt. It forces `toolChoice: "none"` and returns joined text blocks directly.

Handoff does not write a `CompactionEntry`. `AgentSession.handoff()` owns the session transition: it starts a new session, injects the generated document as a visible `custom_message` with `customType: "handoff"`, and rebuilds agent messages from that new session.

### File-operation context in summaries

Compaction tracks cumulative file activity using assistant tool calls:

- `read(path)` → read set
- `write(path)` → modified set
- `edit(path)` → modified set

Cumulative behavior:

- Includes prior compaction details only when prior entry is pi-generated (`fromExtension !== true`).
- In split turns, includes turn-prefix file ops too.
- `readFiles` excludes files also modified.

Summary text gets file tags appended via prompt template:

```xml
<read-files>
...
</read-files>
<modified-files>
...
</modified-files>
```

### Persist and reload

After summary generation (or hook-provided summary), agent session:

1. Appends `CompactionEntry` with `appendCompaction(...)` for context-full maintenance; handoff strategy creates a new session and injects a handoff `custom_message` instead.
2. Rebuilds display context from the active leaf via `buildDisplaySessionContext()`.
3. Replaces live agent messages with rebuilt context.
4. Emits `session_compact` hook event.

## Branch summarization pipeline

Branch summarization is tied to tree navigation, not token overflow.

### Trigger

During `navigateTree(...)`:

1. Compute abandoned entries from old leaf to common ancestor using `collectEntriesForBranchSummary(...)`.
2. If caller requested summary (`options.summarize`), generate summary before switching leaf.
3. If summary exists, attach it at the navigation target using `branchWithSummary(...)`.

Operationally this is commonly driven by `/tree` flow when `branchSummary.enabled` is enabled.

### Branch switch shape (visual)

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D ─ [summary of B,C,D]
    A ───┤
         └─ E ─ F (new leaf)
```

### Preparation and token budget

`generateBranchSummary(...)` computes budget as:

- `tokenBudget = model.contextWindow - branchSummary.reserveTokens`

`prepareBranchEntries(...)` then:

1. First pass: collect cumulative file ops from all summarized entries, including prior pi-generated `branch_summary` details.
2. Second pass: walk newest → oldest, adding messages until token budget is reached.
3. Prefer preserving recent context.
4. May still include large summary entries near budget edge for continuity.

Compaction entries are included as messages (`compactionSummary`) during branch summarization input.

### Summary generation and persistence

Branch summarization:

1. Converts and serializes selected messages.
2. Wraps in `<conversation>`.
3. Uses custom instructions if supplied, otherwise `branch-summary.md`.
4. Calls summarization model with `SUMMARIZATION_SYSTEM_PROMPT`.
5. Prepends `branch-summary-preamble.md`.
6. Appends file-operation tags.

Result is stored as `BranchSummaryEntry` with optional details (`readFiles`, `modifiedFiles`).

## Extension and hook touchpoints

### `session_before_compact`

Pre-compaction hook.

Can:

- cancel compaction (`{ cancel: true }`)
- provide full custom compaction payload (`{ compaction: CompactionResult }`)

### `session.compacting`

Prompt/context customization hook for default compaction.

Can return:

- `prompt` (override base summary prompt)
- `context` (extra context lines injected into `<additional-context>`)
- `preserveData` (stored on compaction entry)

### `session_compact`

Post-compaction notification with saved `compactionEntry` and `fromExtension` flag.

### `session_before_tree`

Runs on tree navigation before default branch summary generation.

Can:

- cancel navigation
- provide custom `{ summary: { summary, details } }` used when user requested summarization

### `session_tree`

Post-navigation event exposing new/old leaf and optional summary entry.

## Runtime behavior and failure semantics

- Manual compaction aborts current agent operation first.
- `abortCompaction()` cancels both manual and auto-compaction controllers.
- Auto compaction emits start/end session events for UI/state updates.
- Auto compaction can try multiple model candidates and retry transient failures; long retry delays prefer the next candidate when one is available.
- Overflow errors are excluded from generic retry path because they are handled by context promotion/compaction.
- If auto-compaction fails:
  - overflow path emits `Context overflow recovery failed: ...`
  - threshold path emits `Auto-compaction failed: ...`
- Branch summarization can be cancelled via abort signal (e.g., Escape), returning canceled/aborted navigation result.

## Settings and defaults

From `settings-schema.ts`:

- `compaction.enabled` = `true`
- `compaction.strategy` = `"context-full"` (`"handoff"` and `"off"` are also supported)
- `compaction.reserveTokens` = `16384`
- `compaction.keepRecentTokens` = `20000`
- `compaction.autoContinue` = `true` (gated on unfinished work; see above)
- `compaction.remoteEnabled` = `true`
- `compaction.remoteEndpoint` = `undefined`
- `compaction.thresholdPercent` = `-1` and `compaction.thresholdTokens` = `-1`; when no positive override is set, the threshold is `contextWindow - max(15% of contextWindow, reserveTokens)`
- `compaction.adaptive.enabled` = `false`
- `compaction.adaptive.baseThresholdPercent` = `85`, `compaction.adaptive.aggression` = `0.15`, `compaction.adaptive.turnWindow` = `15` minutes, and `compaction.adaptive.minThresholdPercent` = `50`; when enabled, the adaptive base replaces the sentinel reserve-based percentage and is lowered only for sustained high-context, high-call-rate sessions
- `compaction.idleEnabled` = `false` (when enabled, idle maintenance rewrites history with reason `"idle"` and never auto-continues)
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

These values are consumed at runtime by `AgentSession` and compaction/branch summarization modules.
