# TTSR Injection Lifecycle

This document covers the current Time Traveling Stream Rules (TTSR) runtime path from rule discovery to stream interruption, retry injection, extension notifications, and session-state handling.

## Implementation files

- [`../src/sdk/session.ts`](../packages/coding-agent/src/sdk/session.ts)
- [`../src/export/ttsr.ts`](../packages/coding-agent/src/export/ttsr.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/prompts/system/ttsr-interrupt.md`](../packages/coding-agent/src/prompts/system/ttsr-interrupt.md)
- [`../src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`../src/extensibility/extensions/types.ts`](../packages/coding-agent/src/extensibility/extensions/types.ts)
- [`../src/extensibility/hooks/types.ts`](../packages/coding-agent/src/extensibility/hooks/types.ts)
- [`../src/extensibility/custom-tools/types.ts`](../packages/coding-agent/src/extensibility/custom-tools/types.ts)
- [`../src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)

## 1. Discovery feed and rule registration

At session creation, `createAgentSession()` loads discovered rules and constructs a `TtsrManager`:

```ts
const ttsrSettings = settings.getGroup("ttsr");
const ttsrManager = new TtsrManager(ttsrSettings);
const rulesResult = await loadCapability<Rule>(ruleCapability.id, { cwd });
for (const rule of rulesResult.items) {
  const hasTtsrCondition = (rule.condition?.length ?? 0) > 0 || (rule.astCondition?.length ?? 0) > 0;
  if (hasTtsrCondition && ttsrManager.addRule(rule)) continue;
  // non-TTSR rules continue through normal rule handling
}
```

### Pre-registration dedupe behavior

`loadCapability("rules")` deduplicates by `rule.name` with first-wins semantics (higher provider priority first). Shadowed duplicates are removed before TTSR registration.

### `TtsrManager.addRule()` behavior

Registration is skipped when:

- the rule has no `astCondition` and `rule.condition` is absent or all condition regexes fail to compile
- a rule with the same `rule.name` was already registered in this manager
- the rule scope excludes all monitored streams

Invalid regex conditions and unreachable scopes are logged as warnings and ignored; session startup continues.

### Setting caveat

`TtsrSettings.enabled=false` makes `TtsrManager` no-op (`addRule`, `checkDelta`, `hasRules`, `restoreInjected`), so no conditional rules are registered or injected.

## 2. Streaming monitor lifecycle

TTSR detection runs inside `AgentSession.#handleAgentEvent`.

### Turn start

On `turn_start`, the stream buffer is reset:

- `ttsrManager.resetBuffer()`

### During stream (`message_update`)

When assistant updates arrive and rules exist:

- monitor `text_delta`, `thinking_delta`, and `toolcall_delta`
- append delta into a source/tool scoped manager buffer
- call `checkDelta(delta, matchContext)`

`checkDelta()` iterates registered rules and returns all matching rules that pass scope, global-path, condition, and repeat policy checks.

## 3. Trigger decision and immediate abort path

When one or more rules match and at least one matched rule allows interruption:

1. Matched rules are deduplicated into `#pendingTtsrInjections`.
2. `#ttsrAbortPending = true` and a TTSR resume gate is created.
3. `agent.abort()` is called immediately.
4. `ttsr_triggered` event is emitted asynchronously (fire-and-forget).
5. retry work is scheduled via the post-prompt task scheduler with a 50ms delay.

Abort is not blocked on extension callbacks.

## 4. Retry scheduling, context mode, and reminder injection

After the 50ms timeout:

1. read `ttsrManager.getSettings().contextMode`
2. build injection content from pending rules and undelivered per-tool reminders using `ttsr-interrupt.md` template; with `contextMode === "discard"`, reminders already delivered in the suffix that will be dropped (settled tool reminders and earlier retry reminders) are carried into this payload as written
3. publish the hidden `custom_message` with `customType: "ttsr-injection"`, `details.rules` and `details.messageCount` before touching live history (see "Interrupt reminder publication outcomes" in section 7)
4. only when the retry still owns the resume and the publication outcome lets it run (committed, or rejected for an in-memory retry): if `contextMode === "discard"`, drop the targeted assistant message and everything after it with `agent.replaceMessages(...slice(0, targetAssistantIndex))`, then append the same reminder to live history
5. mark those rule names injected (a durable `ttsr_injection` marker only after a committed publication) and schedule the owner-guarded continue that retries generation

`#ttsrAbortPending` stays true while the reminder is published; it is cleared when the retry continues or is skipped, or when the retry ends early.

Template payload is:

```xml
<system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
...
{{content}}
</system-interrupt>
```

Pending injections and carried per-tool claims leave their buckets once the publication outcome is known: a retry that runs consumes them, and every other outcome releases them.

### `contextMode` behavior on partial output

- `discard`: partial/aborted assistant message is removed before retry.
- `keep`: partial assistant output remains in conversation state; reminder is appended after it.

### Non-interrupting matches

Non-interrupting matches split by `matchContext.source`:

- **`source === "tool"` (tool-source match).** The rule is bucketed into `#perToolTtsrInjections`, keyed by the matched tool call's `id`. There is **no** deferred follow-up turn and the stream is not aborted. When the tool actually produces a result, the `afterToolCall` hook prepends a rendered `ttsr-tool-reminder.md` block to `ctx.result.content` (a single `text` block inserted ahead of the tool's own content). The `ttsr_injection` entry with the consumed rule names is persisted only when that decorated result is the one the loop publishes; otherwise the provisional claim is released. The template payload is:

  ```xml
  <system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
  ...
  {{content}}
  </system-reminder>
  ```

- **`source === "text"` / `"thinking"` (prose-source match).** Behavior is unchanged: the rule is queued in `#pendingTtsrInjections` and, after a successful non-error, non-aborted assistant message, `AgentSession` injects the hidden `ttsr-injection` custom message as a follow-up and schedules continuation.

Within a single matching batch, each rule is attached to exactly one sibling tool call — if multiple sibling tool calls would satisfy the same rule, deduplication picks one and the others are left untouched. Multiple distinct rules can still fold onto the same tool call.

#### Implications for tool authors and transcript readers

- The tool's own `toolResult` content is preserved verbatim; the reminder is **prepended** as an additional leading text block. Renderers that assume `content[0]` is the tool's primary output must scan past any block whose text begins with `<system-reminder reason="rule_violation"` (or filter on the wrapper tag) to find the real payload.
- The reminder is in-band on the tool result, not a separate `custom_message`/`ttsr-injection` entry. Transcript readers looking for non-interrupting TTSR activity on tool-source rules MUST inspect tool results (and the persisted `ttsr_injection` entry list), not just synthetic injection entries.
- A single tool result may carry reminders for several rules concatenated with a blank line between rendered templates.
- If the assistant message ends with `stopReason === "aborted"` or `"error"` before the matched tools run, the pending per-tool buckets are cleared — those rules are **not** persisted as injected and remain eligible to re-trigger on a future turn (subject to repeat policy).

### `astCondition` matches

`astCondition` rules are evaluated once arguments are finalized, in `beforeToolCall`, before the tool executes. They are never evaluated on streamed deltas or on the existing file:

1. Look up the live tool and obtain its in-memory source digest. `write.matcherDigest` supplies the full content; `edit.matcherEntries` supplies only added source, separated by file, for replace, patch, hashline, and apply_patch edits. Vim keystrokes cannot provide a static source digest and are not evaluated.
2. For each entry, `TtsrManager.checkAstSnapshot(digest, context, signal)` uses native `astMatch` with Smart strictness and a match limit of one. The language is the lowercase file extension, which `astMatch` resolves as a language alias or, failing that, through the same extension mapping path-based AST search uses (so `.scss` matches with the CSS grammar). Per-file contexts narrow `filePaths` to the entry path and isolate the snapshot throttle by stream key and path. Rules must pass repeat gating, `scope`, and `globs`; identical consecutive snapshots are skipped until the buffer resets. Unsupported languages and native match errors do not match. Grammars are never downloaded: only the languages compiled into the default native build match (Bash, C, C++, C#, CSS, Go, HTML, Java, JavaScript, JSON, Markdown, PHP, Python, Ruby, Rust, TOML, TypeScript/TSX, YAML); any other language never matches. Cancelled or superseded checks cannot publish reminders or schedule retries.
3. Non-interrupting matches enter `#perToolTtsrInjections`, emit `ttsr_triggered`, and are folded into the tool result by `afterToolCall` and persisted once that result is published. Interrupting matches use the same abort/inject/retry flow as streamed regex matches. With `interruptMode: "always"`, the hook returns `{ block: true, reason }`, so the call never runs and the file remains unchanged. The aborted call still receives exactly one tool result, and the retry context contains the reminder.

A rule with both `condition` and `astCondition` can trigger through either path; pending and per-tool injections are deduplicated by rule name. AST matching inspects only the proposed added text, so pre-existing matching code does not trigger an unrelated edit.

## 5. Repeat policy and gap logic

`TtsrManager` tracks `#messageCount` and per-rule `lastInjectedAt`.

### `repeatMode: "once"`

A rule can trigger only once after it has an injection record.

### `repeatMode: "after-gap"`

A rule can re-trigger only when:

- `messageCount - lastInjectedAt >= repeatGap`

`messageCount` increments on `turn_end`, so gap is measured in completed turns, not stream chunks.

## 6. Event emission and extension/hook surfaces

### Session event

`AgentSessionEvent` includes:

```ts
{ type: "ttsr_triggered"; rules: Rule[] }
```

### Extension runner

`#emitSessionEvent()` routes the event to:

- extension listeners (`ExtensionRunner.emit({ type: "ttsr_triggered", rules })`)
- local session subscribers

### Hook and custom-tool typing

- extension API exposes `on("ttsr_triggered", ...)`
- hook API exposes `on("ttsr_triggered", ...)`
- custom tools receive `onSession({ reason: "ttsr_triggered", rules })`

### Interactive-mode rendering difference

Interactive mode uses `session.isTtsrAbortPending` to suppress showing the aborted assistant stop reason as a visible failure during TTSR interruption, and renders a `TtsrNotificationComponent` when the event arrives.

## 7. Persistence and resume state (current implementation)

`SessionManager` persists injected-rule state:

- entry type: `ttsr_injection`
- append API: `appendTtsrInjection(ruleNames)`
- query API: `getInjectedTtsrRules()`
- context reconstruction includes `SessionContext.injectedTtsrRules`

`TtsrManager` supports restoration via `restoreInjected(ruleNames)`.

### Current wiring status

In the current runtime path:

- interrupted injections publish a hidden `custom_message` with `customType: "ttsr-injection"`; the `ttsr_injection` marker is written only when that publication commits (see "Interrupt reminder publication outcomes" below)
- deferred non-interrupting prose-source injections are marked/persisted when their queued custom message reaches `message_end`
- non-interrupting tool-source injections are claimed provisionally at match time (the rule's previous injection record is kept), folded into the matched call's result by the `afterToolCall` hook, and persisted via `appendTtsrInjection(...)` only when the loop publishes that reminder-bearing `toolResult` (settled synchronously on its `message_end`, before spill or other async handling)
- a provisional claim whose reminder is never delivered is released and the previous record restored: the call was aborted, skipped by steering, or replaced by an aborted/skipped result after folding, or its turn ended without publishing it. A TTSR interrupt retry instead carries such reminders into its injection
- a deferred prose reminder holds its rule names while follow-up admission is in flight and, once admitted, through the queued message itself; dropping the queued message (abort, `clearQueue`) leaves the rule eligible
- `createAgentSession()` restores `existingSession.ttsrMessageCount` and the injected records (`injectedTtsrRuleRecords`, or legacy `injectedTtsrRules`) into `ttsrManager`

### Interrupt reminder publication outcomes

An interrupt retry publishes its hidden `ttsr-injection` custom message before touching live history. Its `details` carry `rules` and `messageCount`, the manager counter the rules are marked at; the durable entry and the live message share one payload. A legacy session appends the entry directly; if that append throws, the failure is unclassified and handled like an unknown outcome. A session that has armed shared publication goes through the admitted shared append, and the outcome decides what happens next:

- **committed**: the retry runs. The reminder is appended to live history, and the rules are marked at `messageCount` and get a durable `ttsr_injection` marker. The marker is a separate write; in a shared session it is published in the background.
- **rejected** (definite non-commit): this is the only outcome that permits an in-memory retry. A `warning` notice says the reminder could not be saved and the retry runs with it in memory only. The live message is appended and the rules are marked consumed in the live manager (so a `repeatMode: "once"` rule cannot interrupt-loop in this session), but no `ttsr_injection` marker is written. After reopen the rule is eligible again. If the retry was aborted, superseded, or the session was disposed while the append was pending, the retry just releases its claims.
- **stale** (`transcript_moved`, `unsupported_transcript`, `persistence_latched`, `rewrite_required`, `cursor_not_committed`): later shared writes cannot commit, so the retry stops, the session is disposed, and a `warning` notice names the reason and says the session must be reopened. Nothing is retried in memory and no marker is written.
- **unknown** or an unclassified failure: the reminder may already be in the transcript, but that does not prove the model saw it. The retry stops, the live manager does not mark the rules and releases any carried provisional claims, no `ttsr_injection` marker is written, and the session is disposed so a later prompt cannot get past the rule through another match path or repeat gap. The notice includes the attempted entry id when one is known. If the reminder entry did commit, it is still durable evidence: reopening reconciles consumption from it (see "Reconciliation from persisted reminder messages" below).

The stale and unknown fail-closed paths apply even when the retry was invalidated while the append was pending, because they describe this session's persistence state. A reminder that committed after its retry was invalidated is still delivered into live history (marked at its checkpoint, with no new marker) if this retry still owns the resume, the session is not disposed, and live history is unchanged. If the session was already disposed, nothing more happens. Otherwise the session is disposed and must be reopened, so the reminder is neither skipped nor published twice.

### Reconciliation from persisted reminder messages

A committed reminder can outlive a missing `ttsr_injection` marker (for example, a background marker publication failed). While it constructs the session, after `createAgentSession()` has restored marker records and the counter, `AgentSession` reconciles consumption from the reminder messages themselves:

- It walks `sessionManager.getBranch()`, the active leaf's ancestors including entries before compaction, and collects `custom_message` entries with `customType: "ttsr-injection"`. Sibling branches are not consulted, so their rules stay eligible.
- It also reads `ttsr-injection` messages already in the Agent's state at construction (normally the restored branch messages, or messages loaded into an in-memory session). Reconciliation runs only once, at construction. A rejected in-memory retry later in the session suppresses its rule because the retry marks the live manager directly; its message is not in the transcript, so reopen does not see it.
- For each rule it keeps the latest published `messageCount` checkpoint. If the newest checkpoint is ahead of the restored counter, the counter moves up to it so `after-gap` intervals count from the checkpoint. A rule is re-marked at its checkpoint only when it has no record or its record is older. Restored marker records are never re-marked at the current count, which would restart the gap.
- A legacy entry without `messageCount` only proves delivery: it fills a missing record at the current count and never overrides an existing one.

Reconciliation updates only `TtsrManager` state and is skipped when TTSR is disabled. It never re-appends reminder text, so a reminder that compaction removed from Agent context stays out of it. It also does not write the missing `ttsr_injection` marker, so the reminder entry stays the only durable evidence and is reconciled again on every open.

Net effect: injected-rule suppression is persisted/restored across session reload/resume for the current branch path, including reminders whose marker never published. A rejected in-memory retry suppresses the rule only in the live session.

## 8. Race boundaries and ordering guarantees

### Abort vs retry callback

- abort is synchronous from TTSR handler perspective (`agent.abort()` called immediately)
- retry is deferred by timer (`50ms`)
- extension notification is asynchronous and intentionally not awaited before abort/retry scheduling

### Multiple matches in same stream window

`checkDelta()` returns all currently matching eligible rules for that scoped buffer. Pending injections are deduplicated by rule name before injection.

### Between abort and continue

During the timer window, state can change (user interruption, mode actions, additional events). The retry call is best-effort: `agent.continue().catch(() => {})` swallows follow-up errors.

## 9. Edge cases summary

- Invalid `condition` regex: skipped with warning; other conditions/rules continue.
- Duplicate rule names at capability layer: lower-priority duplicates are shadowed before registration.
- Duplicate names at manager layer: second registration is ignored.
- `contextMode: "keep"`: partial violating output can remain in context before reminder retry. **Cost warning:** every aborted partial turn is retained, so context (and token spend) grows each time a rule fires. Prefer the default `discard` unless the partial output is specifically needed.
- `interruptMode: "never"`: prose-source matches queue a deferred hidden injection after a successful assistant message; tool-source matches fold an in-band `<system-reminder>` into the matched tool call's `toolResult` content via the `afterToolCall` hook (no mid-stream abort, no separate follow-up turn).
- Tool-source non-interrupting buckets are cleared when the parent assistant message ends with `stopReason === "aborted"` or `"error"`, so rules whose target tool never produced a result remain eligible to re-trigger.
- Repeat-after-gap depends on turn count increments at `turn_end`; mid-turn chunks do not advance gap counters.
