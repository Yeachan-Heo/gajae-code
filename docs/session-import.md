# Session Import (Codex and Claude)

GJC can import an external **Codex** or **Claude** session transcript into a new
GJC session so you can continue the conversation with reconstructed context
instead of copying a long session by hand.

## CLI surface

```
/import-session <transcript-file> [--provider codex|claude]
```

- Available in the interactive TUI and to ACP clients (both dispatch through the
  unified builtin registry).
- `<transcript-file>` is an explicit, user-selected export/transcript file
  (absolute or cwd-relative; quote paths containing spaces).
- `--provider` narrows detection to one provider and fails closed on a
  mismatch. Without it, the format is detected deterministically from the file
  content.
- On success, GJC creates a **new** session containing the reconstructed
  context and switches to it. The previous session is left untouched on disk.

There is intentionally no flag-less provider-directory mode: import never
enumerates `~/.codex` / `~/.claude` or reads live provider process state. You
always name the exact file to import.

## Supported source formats

Detection is content-based and provider-neutral; unknown shapes fail with an
actionable diagnostic instead of a speculative parse.

| Format | Provider | File shape |
| --- | --- | --- |
| `codex-rollout-jsonl` | Codex | Codex CLI rollout transcript (`rollout-*.jsonl`): `session_meta`, `response_item` (`message`, `function_call`, `function_call_output`, `custom_tool_call*`, `local_shell_call`, `web_search_call`, `reasoning`), `event_msg`, `turn_context` records, one JSON object per line. |
| `claude-code-jsonl` | Claude | Claude Code session transcript (`~/.claude/projects/<slug>/<uuid>.jsonl` copied out explicitly): `user` / `assistant` / `summary` / `system` records with `uuid`/`sessionId` envelopes. |
| `claude-export-json` | Claude | claude.ai data export: one conversation object (or an array of conversations) with `uuid`, `name`, and `chat_messages[]` (`sender: "human" \| "assistant"`, `content[]` text blocks). |

Normalization rules:

- User/assistant text is preserved; consecutive assistant text is merged.
- Tool calls and results become bounded, single-line **tool/file evidence**
  entries (`$ <tool> <summary>` / `→ <output>`) attached to the preceding
  assistant message. Tool payloads are never executable in the new session.
- Model-internal content (Codex `reasoning`, Claude `thinking`) and provider
  bookkeeping (`turn_context`, `system`, `isMeta` rows, file-history snapshots)
  are recognized and skipped by design.
- Records that fail to parse, lack required fields, or use unknown record types
  are **quarantined** — counted and digested (record number, byte length,
  SHA-256) in provenance and the import summary, never silently dropped.
- A native GJC session file is rejected with `unsupported_format` (use
  resume/fork for those).

## Provenance and identity

Every imported session persists a `custom` entry with
`customType: "session-import"` recording: provider, format, source file
basename, source session id and title (when the format carries them), SHA-256
and byte size of the exact imported source bytes, converter/sanitizer versions,
mapped/quarantined/redacted/omitted counts, truncation flag, target session id,
and import timestamp. The reconstructed context lives in a separate
`custom_message` entry (same `customType`, `display: true`) so imported context
is visually and structurally distinct from native GJC history, while still
participating in LLM context like a handoff document.

Re-importing the same file is allowed and creates another distinct session;
the provenance record (source hash + import timestamp) is what distinguishes
them. The source file is only ever read — verify with the recorded digest.

## Redaction

Before any imported text enters the new session it passes a fail-closed
sanitizer (`sanitizerVersion` in provenance): Anthropic/OpenAI/GitHub/Slack/
Google/AWS keys, JWTs, bearer tokens, PEM private keys, long hex secrets,
URL-embedded credentials, and `NAME=value` / `key: value` assignments whose
name contains a sensitive word (key/secret/token/password/credential/…).
Matches are replaced with `[REDACTED]`; the redaction count and rule kinds are
reported in the summary and provenance. False positives are preferred over
false negatives: a benign look-alike loses one span, a missed credential would
leak into a durable transcript.

## Bounds and diagnostics

| Bound | Value | Over-limit behavior |
| --- | --- | --- |
| Source file size | 64 MiB | `content_too_large` with limit/observed bytes |
| Normalized messages | 5,000 | `content_too_large` with observed count |
| Rendered continuation context | 120,000 chars | deterministic head+tail bounding with an explicit elision marker (`omitted` count in provenance) |
| Single message text | 16,000 chars | truncated with an ellipsis marker |
| Tool evidence per message | 100 lines / 8 KiB | marked truncated |
| Quarantine records | 512 retained | count kept, `quarantine.truncated` flag set |

Error codes are deterministic and actionable: `invalid_request`,
`source_not_found`, `source_unreadable`, `source_changed` (retryable),
`unsupported_format`, `format_mismatch`, `malformed_input`, `content_too_large`,
`destination_conflict`, `io_failed`. If persistence or post-write verification
fails, the partially created session file is removed best-effort and the
current session is never modified.

## Non-goals

- **No model-internal state cloning.** Reasoning traces, token telemetry,
  provider session caches, and tool-execution state are not imported; this is
  context reconstruction, not process migration.
- **No live provider scraping.** Import reads only the file you name.
- **No silent drops.** Every source record is mapped, recognized-and-skipped,
  or quarantined with a digest; totals are reported.
- **No mid-stream import.** `/import-session` refuses to run while a response
  is streaming.
