# Hooks

GJC currently has three execution surfaces that are all called hooks. The canonical model in `packages/coding-agent/src/hooks/events.ts` is a **normalization and adaptation layer** over those existing runtimes. It does not create a second dispatcher: GJC adapters register accepted hooks on the authoritative `ExtensionRunner`, while Codex continues to own managed command execution.

| Surface | Runtime authority | Distribution | Runtime owner |
|---|---|---|---|
| Native/Claude/Codex hook directories | In-process `HookAPI` module adapted to `ExtensionRunner` | User/project files | GJC `ExtensionRunner` |
| Codex managed `hooks.json` | External command | User Codex configuration | Codex invokes `gjc codex-native-hook` |
| Distributable plugin hooks | Constrained GJC API; ambient host-process authority | Installed plugin bundle | GJC `ExtensionRunner` adapter |

The broader in-process `HookAPI` also contains lifecycle/context events. Only semantically safe overlaps are assigned one of the six canonical names.

## Canonical names

| Canonical kind | Accepted source event | Important difference retained |
|---|---|---|
| `user_prompt_submit` | in-process `before_agent_start`; managed Codex `UserPromptSubmit` | Payload, output, ordering, and command behavior remain runtime-owned |
| `pre_tool_use` | directory `pre`; plugin `tool_call/before`; in-process `tool_call` | Directory hooks are imported modules, not shell scripts |
| `post_tool_use` | directory `post`; plugin `tool_call/after` or `tool_result/after`; in-process `tool_result` | Mutation fields and timeouts differ by runner |
| `stop` | managed Codex `Stop`; in-process `agent_end` | `turn_end` is rejected because it fires once per turn, not once per agent loop |
| `session_start` | in-process `session_start` | No command/plugin equivalent |
| `session_shutdown` | in-process `session_shutdown` | The current runner awaits handlers; it is not fire-and-forget |

Unknown names and unsupported convention/event pairs produce bounded diagnostics. The adapter never treats an alias as authority.

## Execution contracts

The authoritative per-convention table is `CONVENTION_EVENT_CONTRACTS`. A single global timeout/error table would be false because the runtimes differ.

### Native, Claude, and Codex hook directories

Discovery paths:

- native GJC: `~/.gjc/hooks/{pre,post}/` and `.gjc/hooks/{pre,post}/`;
- Claude: `.claude/hooks/{pre,post}/`;
- Codex: `.codex/hooks/pre-<tool>.{ts,js}` and `post-<tool>.{ts,js}`.

These files are loaded with Bun `import()` and must export a hook factory. They receive the full in-process `HookAPI`, including `exec`, messages, renderers, and command registration. They are **not command/shell-script hooks** merely because some legacy discovery comments use that terminology.

Current runtime truth:

| Event | Ordering | Timeout | Error behavior | Cancellation/mutation |
|---|---|---|---|---|
| `tool_call` / `pre_tool_use` | sequential, awaited | none | fail closed; the tool does not execute | first `{ block: true }` stops later handlers |
| `tool_result` / `post_tool_use` | sequential, awaited | 30s | errors/timeouts are isolated | `content`, `details`, and `isError` replacements chain in registration order |
| ordinary lifecycle events | sequential, awaited | 30s | errors/timeouts are isolated | event-specific |

Project-directory hook modules execute as code during loading. There is currently no separate workspace-trust prompt in this hook loader. The normalization table therefore records `not-enforced` rather than claiming a nonexistent trust gate.

Extension error listeners receive the extension path, event name, error message, and stack. The runner does not log whole event payloads, but error messages, stacks, and hook code can contain sensitive data; the canonical layer does not add a redaction boundary.

## Codex managed `hooks.json`

`gjc setup hooks` merges two managed entries into `~/.codex/hooks.json`:

- `UserPromptSubmit`;
- `Stop`.

Both invoke `gjc codex-native-hook`. GJC validates and handles its command payload, but Codex owns scheduling, ordering, timeout, cancellation, environment, and command logging. Those fields are marked `external-runtime` or `provider-owned`; they are not guessed from the in-process runner.

The adapter rejects unknown event names and empty commands. It does not claim Claude settings-hook execution: GJC currently discovers Claude `pre/` and `post/` modules only.

## Distributable plugin hooks

Plugin manifests support the compiler-accepted constrained shapes:

- `tool_call` requires a target and `before` or `after` phase;
- `tool_result` requires `after` phase;
- `session_start` and `session_shutdown` accept neither target nor phase.

`tool_call/after` is a post-tool observation and normalizes to `post_tool_use`; it must never gain pre-tool blocking authority. Aliases such as `pre_tool_use`, `UserPromptSubmit`, or `session_start` are rejected for plugins even if those names exist elsewhere.

The loader realpath-confines the implementation beneath the installed plugin root, verifies hashes, requires exactly one registration for the declared event, and provides a constrained **GJC API**. Calls to `exec`, `sendMessage`, `appendEntry`, `registerCommand`, or `registerMessageRenderer` throw `security_policy`.

This is not a JavaScript or operating-system sandbox. The module is imported into the GJC process and retains ambient Bun/JavaScript globals, so an installed plugin must still be treated as trusted executable code. `Constrained` means it cannot obtain broader GJC extension capabilities through the normalizer or supplied API; it does not mean the host process has removed every process/filesystem/network primitive. The contract records `ambient-host` process authority instead of claiming isolation that does not exist.

The runtime adapter filters target tool names with exact, case-sensitive logical-name matching. Normalization rejects empty names, path separators, NUL, `.` and `..`; `*` is the only wildcard. Filesystem case rules do not change logical tool matching.

Plugin execution uses `ExtensionRunner` after adaptation:

| Shape | Canonical kind | Timeout | Error behavior | Authority |
|---|---|---|---|---|
| `tool_call/before` | `pre_tool_use` | none | thrown error fails closed and blocks | constrained GJC API; ambient host |
| `tool_call/after` | `post_tool_use` | 30s | timeout/error isolated | constrained GJC API; ambient host |
| `tool_result/after` | `post_tool_use` | 30s | timeout/error isolated | constrained GJC API; ambient host |
| `session_start` | `session_start` | 30s | timeout/error isolated | constrained GJC API; ambient host |
| `session_shutdown` | `session_shutdown` | 30s | timeout/error isolated | constrained GJC API; ambient host |

## In-process lifecycle normalization

The full in-process extension API remains larger than the six-event model. `context`, compaction, retry, tree, and other events continue directly through `ExtensionRunner` and receive the diagnostic `in_process_event_outside_hook_ir` when inspected by the normalizer.

`before_agent_start` is the closest safe prompt-submission overlap and can return a message for injection. `agent_end` is the loop-end overlap for `stop`. `turn_end` is deliberately rejected with `semantic_mismatch` because collapsing per-turn and per-loop events would silently change invocation counts.

## Diagnostics and batch behavior

Diagnostic codes are stable constants:

- `unsupported_convention_event`;
- `unrecognized_plugin_event`;
- `invalid_plugin_phase`;
- `invalid_tool_matcher`;
- `invalid_source`;
- `invalid_command`;
- `duplicate_hook`;
- `in_process_event_outside_hook_ir`;
- `semantic_mismatch`.

Batch normalization accepts already-bounded adapter results, preserves input order, keeps the first exact duplicate, and emits `duplicate_hook` for later copies. Rejected hooks are never returned in `hooks`, and their diagnostics are never dropped.

## Runtime integration boundary

Native/Claude/Codex discovery is validated through `normalizeDirectoryHook` before discovered modules are imported, then accepted hook factories are adapted into the session's `ExtensionRunner`. Tool-scoped directory handlers receive exact matcher filtering at that adapter boundary. Constrained plugin execution uses the same plugin normalization rules when selecting its runtime registration event and validates the complete batch before the first registration. The canonical layer therefore participates in startup/runtime adaptation without becoming a second dispatcher.

It does **not**:

- execute a hook itself;
- add Claude named settings hooks that discovery does not support;
- change Codex-owned managed-hook semantics;
- replace the extension lifecycle API;
- create a new logging/redaction or workspace-trust mechanism.
