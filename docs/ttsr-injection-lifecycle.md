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
  if (rule.condition?.length && ttsrManager.addRule(rule)) continue;
  // non-TTSR rules continue through normal rule handling
}
```

### Pre-registration dedupe behavior

`loadCapability("rules")` deduplicates by `rule.name` with first-wins semantics (higher provider priority first). Shadowed duplicates are removed before TTSR registration.

### `TtsrManager.addRule()` behavior

Registration is skipped when:

- `rule.condition` is absent or all condition regexes fail to compile
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

1. `#ttsrAbortPending = false`
2. read `ttsrManager.getSettings().contextMode`
3. if `contextMode === "discard"`, drop the targeted partial assistant output with `agent.replaceMessages(...slice(0, targetAssistantIndex))`
4. build injection content from pending rules using `ttsr-interrupt.md` template
5. append and persist a hidden `custom_message`/runtime custom message with `customType: "ttsr-injection"` and `details.rules`
6. mark those rule names injected, persist a `ttsr_injection` entry, and call `agent.continue()` to retry generation

Template payload is:

```xml
<system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
...
{{content}}
</system-interrupt>
```

Pending injections are cleared after content generation.

### `contextMode` behavior on partial output

- `discard`: partial/aborted assistant message is removed before retry.
- `keep`: partial assistant output remains in conversation state; reminder is appended after it.

### Non-interrupting matches

Non-interrupting matches split by `matchContext.source`:

- **`source === "tool"` (tool-source match).** The rule is bucketed into `#perToolTtsrInjections`, keyed by the matched tool call's `id`. There is **no** deferred follow-up turn and the stream is not aborted. When the tool actually produces a result, the `afterToolCall` hook prepends a rendered `ttsr-tool-reminder.md` block to `ctx.result.content` (a single `text` block inserted ahead of the tool's own content), and persists a `ttsr_injection` entry with the consumed rule names. The template payload is:

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

- interrupted injections append a hidden `custom_message` with `customType: "ttsr-injection"` and append a `ttsr_injection` entry via `appendTtsrInjection(...)`
- deferred non-interrupting prose-source injections are marked/persisted when their queued custom message reaches `message_end`
- non-interrupting tool-source injections are marked at match time and persisted via `appendTtsrInjection(...)` from the `afterToolCall` hook when the matched tool's result is produced
- `createAgentSession()` restores `existingSession.injectedTtsrRules` into `ttsrManager`

Net effect: injected-rule suppression is persisted/restored across session reload/resume for the current branch path.

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
