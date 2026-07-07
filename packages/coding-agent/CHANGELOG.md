# Changelog

## [Unreleased]

### Fixed

- `gjc team` on Windows/psmux now targets the GJC-managed leader session by name instead of trusting the inherited `TMUX_PANE`. `gjc --tmux` propagates the managed session name to the child via `GJC_TMUX_ACTIVE_SESSION`, and `readCurrentTmuxLeaderContext` prefers it when resolving the leader pane. Under psmux the inherited `TMUX_PANE` can resolve to the wrong/default session, so a `ralplan -> ultragoal -> team` handoff could split/send workers into the wrong leader session; native tmux/WSL flows (no `GJC_TMUX_ACTIVE_SESSION`) keep the existing `TMUX_PANE`/ambient-session behavior (#531).

## [0.9.0] - 2026-07-07
### Added

- Added `/quit` as an alias of the `/exit` slash command, so the near-universal REPL/CLI quit verb shuts the session down instead of silently falling through to the model as a chat message. Like `/exit` it is a TUI-only shutdown: it is not advertised to ACP clients and is not listed as its own autocomplete/help entry.
- Added a `/clear` slash command that clears the active conversation context while preserving the current session id and durable session history (#1677).
- Added an Extragoal local skill template (`docs/extragoal-skill-template.md`) documenting an external final review gate on top of `ultragoal` — a fresh-context, cross-family, tool-restricted read-only reviewer with a machine-parsable verdict contract, mandatory bundle secret scan, prompt-injection stance, explicit findings triage, and a bounded re-sign loop — plus a `reviewer` stance profile and cross-session review-gate recipe in `docs/multi-vendor-profiles.md`, pinned by `test/extragoal-template.test.ts`.
- Added opt-in live turn streaming to the notifications surface. With `GJC_NOTIFICATIONS_STREAM=1` the session WebSocket now emits throttled non-finalized `turn_stream` frames (each carrying a per-turn `messageRef`) as the assistant message streams, and the Telegram threaded daemon edits ONE message in place — via `editMessageText` keyed by `(session, coalesceKey)` — so the finalized text lands on the same message instead of posting a new one. Off by default; without a `messageRef` finalized turns keep their legacy one-message-per-turn behaviour. Throttle interval is `GJC_NOTIFICATIONS_STREAM_INTERVAL_MS` (default 500ms); streamed frames remain suppressed under redaction.
- Added `GJC_NOTIFICATIONS_TURN_MAX` to raise the finalized `turn_stream` text cap (default 3500 chars, unchanged) so full long turns reach split-capable clients — the Telegram daemon already fans a long finalized turn across multiple messages via `splitTelegramHtml` — instead of being truncated with an ellipsis at the notification layer. The value is clamped to a finite `[280, 40000]` range: a non-finite or non-positive value (unset, `NaN`, `Infinity`, `<= 0`) falls back to the default, so the cap can never be unbounded. Opt-in and off by default (mirror stays a glanceable per-turn summary); live in-progress frames are intentionally NOT raised so a streaming turn stays one editable preview message rather than fanning across sends.

### Fixed

- Stopped the Hindsight memory backend from injecting stale public-memory-tool guidance into the system prompt. `hindsight/backend.ts`'s `STATIC_INSTRUCTIONS` still instructed the model to "Use `recall`/`retain`/`reflect`", but those tools were removed from the public surface in #341 — they are unregistered in `BUILTIN_TOOLS`/`HIDDEN_TOOLS` and not discoverable — so every Hindsight-backed session advertised three uncallable tools in its injected `# Memory` block. #341 cleaned the local-memory prompts, public docs, and tool registry but never touched the Hindsight backend's own injected block, and its `public-memory-tool-surface.test.ts` guard list omitted `backend.ts`, so the drift went unnoticed. The block now describes the automatic recall/retain lifecycle instead of naming tools, and the regression test now guards `hindsight/backend.ts`.
- Task subagent output-ID allocation now reserves numeric prefixes from `.jsonl` session artifacts and `.patch` sidecars as well as final `.md` outputs, preventing resumed or partial subagent runs from reusing an existing artifact stem (#1733).
- Restored `/changelog` as a built-in slash command, including autocomplete and `/changelog --full`/`/changelog full`, so the What's New prompt no longer points at a missing command.
- Corrected the Extragoal template's read-only enforcement claim: the `--tools` allowlist governs the built-in tool surface, while the runtime injects the session `goal` tool (when `goal.enabled` is on) and `generate_image` (when an image credential exists) beyond it. Because goal's mutating ops persist session mode state, disabling it is now a mandatory gate precondition (`goal.enabled: false` in the review working directory's `.gjc/config.yml`), and reviewer calls outside the allowlist are gate-failing contract violations.
- Corrected the GJC dogfood template's user-level install instructions (`docs/gjc-dogfood-skill-template.md`): the documented verbatim `cp` wrote to `~/.gjc/skills/`, which is not the user-level scan location (`~/.gjc/agent/skills/`), and left the YAML frontmatter mid-file, so the scan's required `description` never parsed and the installed skill was silently skipped. The template now documents the same frontmatter-first `sed` extraction into the scanned location that the Extragoal template ships with, pinned by `test/gjc-dogfood-template.test.ts`.
- Reconciled the skill-template docs with review fixes that raced their merges: the Extragoal reviewer now disables the injected `goal` tool via a dedicated gate directory outside the repository (keeping the reviewed checkout clean, per the #1685 review) instead of an untracked in-repo `.gjc/config.yml`; both the Extragoal and dogfood templates document the one-time skill-discovery enablement (`skills.enabled` plus the install-matched `enablePiUser` **or** `enablePiProject` scan — not both, since the project scan opts every future session into repo-local `.gjc/skills` discovery, per the #1704 review); and the Extragoal template test pins the corrected contract strings.
- Team worker auto-checkpoints now exclude the entire `.gjc/_session-*/` session subtree instead of nine enumerated subdirectories, so extragoal gate receipts and the session activity marker are no longer committed with `--no-verify` and merged into the leader branch on repos that do not gitignore `.gjc/_session-*/`.
- The Telegram threaded daemon now schedules each split chunk of an oversized message through the shared rate-limit pool: a granted send slot maps to exactly one Bot API send, and continuation chunks are re-queued (one token each) rather than fanned out against a single token. This keeps a long finalized turn (e.g. raised via `GJC_NOTIFICATIONS_TURN_MAX`) within the documented per-chat rate-limit / round-robin fairness invariant instead of bursting many `sendMessage` calls on one slot.
- `gjc config list`, `gjc config get`, and `gjc config set` now redact secret-like setting paths even when malformed config files store object, array, boolean, or numeric values there; `--show-secrets` remains the explicit unsafe opt-in (#1738).
- `gjc ultragoal` now fails with a clean CLI error (exit 1, actionable stderr) instead of crashing with an uncaught `SessionResolutionError` stack dump when no session id is resolvable (missing `GJC_SESSION_ID` / `--session-id`), and `gjc ultragoal --help` no longer requires a resolvable session.
- Local memory consolidation no longer falls back to the registry's first model (which can be a retired model the provider rejects with 404, permanently failing every phase1/phase2 job). When no model role is configured and the session model is not yet resolved, it now prefers the most recently used model before falling back to registry order.
- `search` no longer fails schema validation when `paths` is omitted; it defaults to searching the working directory, matching the common repo-wide-search intent.
- Ultragoal validation-batch tests are now hermetic: they previously ran `computeCheckpointChangeSet` against the enclosing repository, so their hardcoded declared change set only covered the branch that introduced them — failing for any contributor branch or dirty checkout that touches other files. They now use a root outside the git work tree with `CI_DEV_CHANGED_PATHS` pinned to the declared paths.
- Added a discoverable `bisect` tool that hunts down the commit responsible for a regression by driving `git bisect` with a shell predicate (exit `0` = good, `125` = skip, any other non-zero = bad). It validates preconditions (git repo, clean worktree, `good` is an ancestor of `bad`), resolves the worktree top level once and runs every git command, the predicate, and teardown from that repository root (so it is safe even when invoked from a subdirectory that a candidate commit deletes), and always restores the working tree on completion, error, or abort — running `git bisect reset` and then discarding any tracked-file edits the predicate made (`git reset --hard`) so the promised clean teardown holds even when the predicate mutates tracked files (untracked files the predicate creates are left in place and reported, never deleted). It supports an `invert` mode to find the commit that *fixed* a behavior, bounds the search with `maxSteps` and a per-step `stepTimeoutMs` (a timed-out step counts as a skip), and reports the culprit commit with its author, date, subject, changed files, and every revision it tested.

## [0.8.2] - 2026-07-06
### Added

- Queued message selector entries can now be reordered with `Ctrl+Up` / `Ctrl+Down`, with `Ctrl+Shift+Up` / `Ctrl+Shift+Down` still accepted when the terminal forwards them, while keeping the current draft intact.

- Added `gjc completion inshellisense`, which generates or installs a Fig/withfig-compatible `gjc` completion spec for Microsoft inshellisense without adding inshellisense as a runtime dependency.

### Fixed
- `gjc team` packaged binaries now avoid persisting Bun virtual `/$bunfs/...` entrypoints as worker commands, so tmux worker panes launch through a real executable or the `gjc` fallback instead of immediately disappearing (#1661).
- `computer` now honors `include_screenshot` and `computer.autoScreenshot` by returning bounded post-action screenshots, and batch steps now respect nested per-step `timeout` values.
- Custom-provider `gpt-5.5` entries without an explicit `contextWindow` now default to the 272K Codex prompt budget unless the provider uses first-party `openai-responses`, so Codex passthrough proxies (e.g. CLIProxyAPI) compact in time instead of dying with `context_length_exceeded` at ~272K while the registry advertises 1M.
- `telegram_send` now rejects files over Telegram's document upload limit before reading them into memory or handing them to the notification sink.
- `telegram_send` now rejects file attachments while Telegram notification redaction is enabled, preventing explicit file sends from bypassing the redaction boundary.
- Telegram notification daemons now persist consumed update ids so threaded replies are not reinjected after a daemon restart replays old `getUpdates` entries.
- Telegram notify setup now hides the interactive BotFather token prompt input, preventing the raw bot token from being echoed into terminal scrollback while pairing notifications.
- Telegram unattended workflow-gate listeners are now disposed when a notification session stops, preventing stale stopped servers from retaining future gate emissions after shutdown or notification restart.
- Telegram notification setup and daemon delivery now reject non-private Telegram chat ids before saving configuration, creating forum topics, or sending session content, preserving the private-chat-only routing boundary.
- Telegram daemon autostart now refuses to attach a new session to a live daemon whose persisted bot-token fingerprint or chat id differs from the current settings, and it avoids registering the session root until ownership is trusted so rotated Telegram credentials cannot keep leaking through the old daemon.
- Skill autocomplete now supports direct skill-name prefixes after prompt text (for example, `please /ra` → `/skill:ralplan`) while keeping bare `/` menus free of skill entries.
- `gjc --tmux` on native Windows/psmux now keeps the status line and composer pinned to the bottom after viewport redraws by honoring the GJC tmux launch marker as a multiplexer signal even when `$TMUX` is absent.
- Provider safety refusals (e.g. Anthropic `stop_reason: "refusal"` → `Refusal (<category>): …`, and `sensitive` → `Content flagged by safety filters`) are now classified as terminal retry errors and surface immediately. They previously fell through to the unbounded `"unknown"` retry class, and because a refusal is deterministic for the submitted context, the session looped refusal → retry → refusal forever — resubmitting the full context every `retry.maxDelayMs` and re-billing it as a prompt-cache write whenever the backoff outlived the cache TTL (#1655).
- Coordinator event watches now wake on runtime sidecar state changes and emit a bounded `turn.acknowledged` event, so a tmux-resident session that accepts a prompt and then vanishes is durably classified as recoverable `tmux_session_missing_after_prompt_acknowledgement` instead of leaving only a watch registration with no terminal verdict (#1496).
- Raw tmux-resident sessions now persist public-safe runtime state under their `.gjc/_session-*/runtime/runtime-state.json` even when no coordinator sidecar env is present, so post-ack owner exits leave recoverable `process_exit_before_terminal_state` evidence instead of looking like successful cleanup with no durable output (#1496).

- `gjc config list`, `gjc config get`, and `gjc config set` now redact secret-like string settings by default, with `--show-secrets` as an explicit unsafe opt-in.

- `/new` session-start notifications now render directly under the welcome panel instead of leaving an extra blank row above the confirmation line.
- Goal completion now preserves the terminal `goal({op: "complete"})` state even when a `goal_updated` extension hook throws, preventing hook-side write errors from trapping a verified ultragoal run in the continuation loop.
- Ultragoal completion no longer requires the computer-use red-team suite for non-computer changes that only touch the shared `tools/index.ts` registration file.
- Task subagent output-ID allocation (`AgentOutputManager`) is now concurrency-safe. `#ensureInitialized` previously set a boolean flag *before* the awaited `readdir`, so when two `task` calls are dispatched in the same turn (they run concurrently as shared-concurrency tools on one session-scoped manager) the second allocation short-circuited initialization and started from index `0` while the first scan was still in flight — colliding with existing `N-*.md` outputs and duplicating ids across batches, which overwrote prior subagent outputs on resume. The scan is now memoized as a promise so concurrent `allocate`/`allocateBatch`/`peekNextIndex` calls await the same `readdir` before `#nextId` is derived.
- Task fork-context seeds (`inheritContext`) now keep a *contiguous* run of the most recent messages. The selection loop in `buildForkContextSeed` walks newest→oldest but used `continue` when a message overflowed the token budget, so it skipped the oversized recent message and scavenged smaller *older* ones — yielding a non-contiguous seed that misrepresents the conversation and breaks the recency contract of the `receipt`/`last-turn`/`bounded` modes. It now `break`s at the first over-budget message, so a subagent receives the actual recent context (or none) instead of a jumbled mix of recent and stale messages.
- The `/settings` → Model → **Default Model Profile** submenu now lists the model profiles from the registry instead of rendering an empty `No matching commands` list. The setting declared `options: "runtime"`, but the selector layer only injected runtime choices for themes, thinking level, and the status-line preset — never for model profiles — so the submenu was always empty. Selecting a profile there now also applies it live (the same `activateModelProfile` path as the `/model` preset flow) and persists it as the startup default, instead of only persisting for the next startup.
- `gjc stats` now resolves to the usage-statistics command instead of being treated as a chat prompt. `src/commands/stats.ts` (backed by the `@gajae-code/stats` dependency via `src/cli/stats-cli.ts`) existed and was fully functional, but the entry was never added to the `commands` registry in `cli.ts`, so `isSubcommand()` returned false for `stats` and the invocation fell through to the default `launch` command — leaving the usage dashboard/summary unreachable and absent from `gjc --help`. Registered the command and listed it in the help surface.

## [0.8.1] - 2026-07-04

### Added

- Skills can now be invoked inline within a prompt (for example, mid-message `/skill:*` references) instead of only as a standalone prompt, with matching autocomplete, input-controller queueing, and ACP dispatch support.

### Fixed

- The Telegram notification daemon now tombstones a session endpoint generation after `session_closed`, preventing the scan loop from reconnecting to the still-live old endpoint and recreating an empty topic immediately after deleting the original topic.
- `/contribute-pr` in the interactive TUI now prepares the redacted manifest and worker prompt without spawning a second GJC process on the same terminal, avoiding competing TUI renderers that make the chat viewport jump around. Run the generated worker prompt from a separate terminal instead.
- The `skill` tool is now a default-registered essential tool instead of a discoverable one, so skill chaining is always available without first activating it through tool discovery.
- The coordinator MCP server now classifies vanished-but-acknowledged tmux turns correctly, avoiding spurious delivery failures when a delegated turn's pane disappears after its prompt was already acknowledged.
- Tool-call argument strings are now sanitized of invalid Unicode surrogate sequences across providers (Anthropic, Bedrock, Google, OpenAI chat/completions/responses, and Codex), including custom Responses tool input, preventing malformed tool calls from breaking requests.

## [0.8.0] - 2026-07-04

### Added

- Reduced default initial-context size by shipping only essential tools up front. `tools.discoveryMode` now defaults to `"all"` and the essential resident set grew to `read, bash, edit, write, search, find`; non-essential built-in tools are hidden behind `search_tool_bm25` and discovered on demand. The system prompt gained a `<tool-discovery>` block that documents the discovery tool and lists discoverable tools with one-line summaries, so the model knows what it can activate without carrying every tool schema. This drops a typical initial context from ~63K tokens (tool-schema dominated) to under 20K.

- The `/model` preset landing now shows the session's current preset, model, and per-role assignments in the header, marks the active preset with `(current)`, and Enter now expands/collapses provider groups (right/left arrows still work).
- MCP server definitions now accept an optional per-server `autoload` boolean that controls whether a configured server connects at session startup. The flag is threaded through the config schema, both parsers (the `mcp-json` discovery reader and the runtime-mcp config loader), an `autoloadOnly` load option on `discoverAndLoadMCPTools`, and a `setServerAutoload` config writer, establishing the config contract that the opt-in runtime and the autoload/connect management surfaces wire up in follow-up changes.
- GJC no longer inherits MCP servers live from other hosts. The MCP capability registrations were removed from the Cursor, Gemini, OpenCode, and Windsurf discovery providers and the MCP-only VS Code discovery provider was deleted, so GJC MCP servers now come only from GJC's own config, plugin bundles, or an explicit import rather than being read live out of another host's configuration; rules, settings, and skills discovery are unchanged.

- Added a `statusLine.maxRows` setting (Appearance → Status Line Rows). When it is greater than 1, status line segments that overflow a narrow terminal now wrap onto additional rows instead of being dropped; the default of 1 keeps the existing single-line, drop-on-overflow behavior. The Appearance preview reflects the wrapped layout.

- The startup welcome screen now renders as a viewport-sized `GJC Forge` panel that reserves the bottom composer/HUD rows, keeps the prompt fixed, and folds What's New highlights into the splash instead of appending a separate changelog block.

### Fixed

- Escape now reliably cancels active context maintenance, handoff generation, retry backoff, and workflow ask dialogs even when transient UI focus or typed drafts would previously consume the key.
- The session tree picker now keeps its selection index valid when it starts on an empty filter mode, receives navigation input, and then switches back to a populated filter.
- The main composer now uses `PageUp` / `PageDown` to page the visible transcript viewport instead of duplicating prompt-history navigation; `Up` / `Down` and `Ctrl+R` remain the prompt-history paths, and autocomplete lists keep their own page navigation.
- Shared the duplicated two-column dashboard renderer used by agent and extension dashboards, keeping narrow-width truncation behavior in one tested component.
- Avoided duplicate line splitting when formatting `ast_grep` matches, reducing allocation in large structural-search result rendering.

- Tab now queues prompt drafts immediately while the agent is streaming or compacting instead of opening/applying forced file autocomplete first.

## [0.7.11] - 2026-07-03
### Fixed

- Coordinator MCP tmux prompt delivery now dismisses any focused TUI autocomplete menu after paste-buffer insertion and before `Enter`, so multiline delegated `/skill:*` prompts submit to the runtime and emit the expected prompt ack instead of selecting the highlighted skill completion and timing out.
- The Python `gjc_rpc` client no longer tears down its reader loop on real server frames it had not modeled: OAuth `open_url` extension-UI requests emitted during `login`, `workflow_gate` frames carrying structured `{value, label, description}` options (the `next_workflow_gate()` queue path re-parsed them with a legacy strings-only parser), and `max`/`inherit` thinking levels returned by `get_state`/model info. `install_headless_ui` now answers interactive UI requests with `extension_ui_response` frames instead of misrouting them as `workflow_gate_response` commands, and `get_pending_workflow_gates()` is exposed as a typed method. Previously dropped payloads (`notice`, `thinking_level_changed`, `goal_updated`, `irc_message`, `subagent_steer_message` events; `agent_end.stopReason`/`telemetry`/`coverage`; `auto_retry_start.unbounded`; `auto_compaction_end.continuationSkipReason`; gate `required`) now parse into typed models, and the env-gated real-binary lane covers the new surface.
- The session picker now keeps its selection index valid after an empty search result is navigated and then cleared, so Enter still resumes the first restored session instead of leaving the list with no selected row.

## [0.7.11] - 2026-07-03

### Fixed

- Notification endpoints now emit the graceful `session_closed` frame on process teardown (native terminal-window close/SIGHUP, SIGTERM, fatal errors) via a postmortem cleanup, so the managed Telegram daemon deletes the session's forum topic instead of orphaning it when the session dies without a clean `/quit`.
- Native Windows terminals now default `app.message.queue` to `Alt+Q` instead of `Alt+Enter`, avoiding the Windows Terminal fullscreen shortcut conflict (#1422).
- Coordinator MCP tmux prompt delivery now submits with tmux `Enter` instead of `C-m`, while preserving runtime prompt-ack/`turn_start` as the delivery success gate (#1409).
- The session-close resume hint now prints the `gjc --resume <id>` command on its own line so it can be selected and copied without the surrounding prose.
- Coordinator MCP tmux prompt delivery now uses a paste buffer for prompt text before submitting with `Enter`, preserving multiline delegated `/skill:*` prompt separators that `send-keys -l` could flatten into an unstarted visible prompt (#1416).

- `/retry` now resumes sessions left with an interrupted user/custom/tool-result tail after a crash or power loss, and recovers unresolved assistant tool-use tails instead of reporting "Nothing to retry".
- Queued prompt shortcuts now keep working during auto context-full compaction: Tab/Alt+Enter queue text immediately, `/skill:*` entries replay through the skill invocation path after compaction, and Alt+Up restores only the newest queued prompt for editing instead of merging the full queue.
- Skill prompt cards now size their collapsed arguments preview to the current terminal width instead of wrapping at a fixed narrow column.
- `gjc update` now refreshes opted-in on-disk default workflow skill copies (written by `gjc setup defaults` under the agent dir) after a successful update, so they no longer stay stale relative to the embedded defaults; copies that were never installed are left absent.
- `gjc migrate` skill imports now tolerate project or agent directories reached through macOS system symlinks such as `/var` while still rejecting symlinked destination skill directories, so local dry-run/live parity tests no longer fail on Darwin temp paths.
- cmux workspace auto-renames now include a `GJC: ` prefix so renamed workspaces remain identifiable as GJC sessions.
- The cmux workspace auto-rename is now ownership-guarded: GJC reads the current workspace title via `cmux workspace list` and only renames a workspace that still has its default title, so it no longer overwrites a user-pinned workspace name or thrash a shared workspace title across multiple sessions running under the same `CMUX_WORKSPACE_ID`. Opt out with `GJC_NO_CMUX_RENAME`.
- `gjc --tmux --resume` now reaches the session picker/resume target instead of auto-attaching a same-branch managed tmux session before the inner resume resolver runs.
- `gjc --tmux` now preserves a newly created managed tmux session when `attach-session` exits after the parent SSH/PTY closes but the tmux server still reports the session live, so closing a Windows Terminal tab no longer kills the Mac host session before reattach.
- Managed `gjc --tmux` launches now size the inner tmux window to the caller terminal minus inherited tmux status lines, preventing the bottom of the GJC input from being clipped when the user's tmux status bar is visible.
- Managed `gjc --tmux` launches no longer pin the initial window to `manual` sizing on native tmux. The pre-attach reassert used `resize-window`, which flips the window's `window-size` option to `manual` and stops `attach-session` from resizing the window to the real terminal; when the attaching terminal was larger than the capture-time size, tmux left a smaller-than-client window and painted the uncovered area with `·` fill. The window now stays on `window-size latest` so it tracks the attaching client (psmux keeps the explicit `resize-window` reassert).

### Changed

- `web_search` latency overhaul: provider hard timeouts are now class-based (pure search APIs 15s, LLM-mediated providers 120s, Kimi 35s aligned to its upstream 30s budget, replacing the uniform 300s ceiling; an explicitly configured `web_search.timeout` still overrides — the schema default no longer reinstalls 300s), DuckDuckGo is fired as a background hedge 3s into a slower primary so a failing primary falls back to an already-settled result, the Gemini 429/5xx retry-delay budget dropped from 5 minutes to 30 seconds, resolved provider chains are cached per AuthStorage for 60s keyed on the credential generation (availability probes skipped on repeat searches; login/logout invalidates immediately), and `WebSearchTool` prewarms the chain at construction. Measured: hung-primary fallback 301s → 15s, slow-failing-primary fallback ~7s → 6s, repeat chain resolution ~26ms → ~0.01ms.
### Fixed

- Kept the default composer border one cell inside the terminal edge to avoid the right rounded input corner protruding in narrow/macOS terminal renderers.

## [0.7.10] - 2026-07-02
### Added

- GJC now best-effort renames the containing cmux workspace to the current GJC session name when running inside a cmux terminal.
- Added a status line default usage preset (#1305).
- Telegram threaded updates now include verbose session identity (session id and cwd) metadata.

### Fixed

- Deep Interview option-clarification prompts now stay out of the interview transcript and ambiguity recorder, so asking about displayed choices no longer persists as the round answer before the user selects an actual option.
- `gjc daemon reload telegram` now spawns the replacement daemon with a stable owner pid so the new daemon does not exit immediately after the short-lived reload CLI process ends.
- Ralplan role agents can now persist Planner/Architect/Critic artifacts through a sanctioned `GJC_RALPLAN_ARTIFACT` env handoff (`--artifact-env GJC_RALPLAN_ARTIFACT`), avoiding restricted-bash failures on markdown containing quotes, backslashes, shell-expansion characters, or command-substitution syntax.
- Managed `gjc --tmux` launches now size the initial window correctly (#1376).
- Coordinator tmux-delivered turns now submit correctly on Enter (#1372).
- Generic long `retry-after` rate limits are now kept retryable instead of being treated as fatal (#1370).
- Anthropic hard 429 responses are now surfaced before the stream watchdog fires (#1369).
- Internal sessions are now hidden from the Telegram recent-session list (#1367).
- Telegram messages exceeding the length limit are now chunked correctly.
- Web search now falls back correctly when the preferred provider is unavailable (#1348).
- Restored the Ultragoal team checkpoint snapshot wording (#1349).
- Deep Interview now exits early for simple tasks instead of running unnecessary rounds (#1311).
- Ultragoal goal identity and state now resolve solely from the canonical session-scoped `goals.json`, eliminating goal-identity drift from transcript-replayed snapshots (#1344).

## [0.7.9] - 2026-07-01
### Added

- Added an optional Tavily web search provider selectable through `providers.webSearch`, using `TAVILY_API_KEY` only when Tavily is selected (#1323).

### Fixed

- Deep Interview now treats English `implementation` and Korean `구현` wording as eventual-target language, not permission to edit code or launch implementation before post-interview approval (#1320).
- Restored default Enter = submit in the main chat composer. #1326 rerouted plain Enter in the prompt to insert a newline (making Ctrl+Enter the submit chord); this reverts that so Enter submits again and Shift+Enter inserts a newline.
- Registered the optional `gjc acp` subcommand so Zed/custom ACP clients can launch the ACP stdio server through the documented command entrypoint, and documented the Zed `agent_servers` custom-agent shape (#1327).
- Compiled binaries can now include the hidden Telegram daemon CLI entrypoint without hanging root startup, and release builds preserve that entry so `gjc notify daemon-internal --smoke` is available in standalone binaries (#1288).
- Documented Windows Terminal BEL limitations for terminal bell notifications and added a PowerShell `completion.notifyCommand` beep workaround example (#1318).

## [0.7.8] - 2026-06-30
### Added

- Terminal bell notifications can now be enabled for agent completion, approval, and ask/user-input prompts (#1277).
- Added a generic `providers.local.openaiCompat` models config path for OpenAI-compatible local endpoints plus `gjc local-provider smoke` for bounded streaming chat-completion checks (#1246).
- Added `gjc local-provider discover` / `models` to list model IDs from a configured local OpenAI-compatible provider via `GET /v1/models`, with clear network and response-shape errors and no chat-completion request (#1247).

### Fixed

- Fixed a class of TUI renderer crashes (`TypeError: undefined is not an object (evaluating 'x.trim'/'x.split')`) where render helpers typed `(x: string)` ran a string op on an optional/possibly-undefined tool-detail field. The deep-interview/ralplan `ask` renderer crashed on a result with a missing `question`; caught during streaming but fatal on render/teardown paths such as `/background` detach. Hardened `normalizeText`, `getPreviewLines`, `shortenPath`, and the eval git_log status-event renderer (#1290).

- `gjc update` now verifies the installed runtime after package-manager failures and treats a nonzero Bun/npm exit as recoverable when the requested version and smoke test actually landed, avoiding false failures from Bun tarball extraction errors (#1280).
- Deep Interview now prefers the native hook's pre-resolved ambiguity threshold state and avoids surfacing missing optional settings files as failed `Read` calls during Phase 0.
- Scoped Ultragoal ask-guard checks for `deep-interview` and `ralplan` asks to the current session, so stale or ambiguous Ultragoal state from other sessions no longer suppresses the choice UI while same-session active Ultragoal blockers still apply.
- Submitted user prompts now use the live terminal viewport width in wide Windows Terminal/PowerShell sessions, keeping Korean/CJK prompt wrapping responsive without changing narrow layouts (#1239).
- Coordinator MCP now fails tmux-delivered turns that never receive a runtime prompt acknowledgement/`turn_start`, surfacing an explicit unacknowledged delivery reason instead of leaving Hermes/Oren waiting on a normal active/running state (#1237).
- Telegram now advertises `/session_create`, `/session_recent`, `/session_close`, and `/session_resume` in the bot command menu so lifecycle control commands are discoverable from `/` autocomplete.
- `gjc --tmux` now prefixes the root terminal title (`GJC: tmp`) and managed tmux window names (`GJC-tmp`) with a GJC workspace label so terminal multiplexers and workspace switchers do not fall back to noisy launch paths.

## [0.7.7] - 2026-06-28
### Added

- Added a `#` prompt action that enters tmux copy-mode and searches backward to the previous rendered `user` input marker, providing a tmux-local previous-input scroll jump without relying on terminal-specific modified key chords.

### Fixed

- Fixed steering regression where a prompt submitted while the agent was busy (`busyPromptMode: "steer"`) could stall in the steering queue — shown as a `Steer:` chip but never delivered — until the user pressed Esc to interrupt. A steer queued while no live agent loop was running (the busy/unwind window between a finished turn and the session going idle) now schedules a continuation so it is delivered promptly, mirroring the follow-up queue. A live loop still consumes the steer at its next tool/turn boundary, so steers are never double-delivered.

## [0.7.6] - 2026-06-28

### Fixed

- Kept Codex `reasoning.encrypted_content` replay strings out of the resident large-text externalizer so resumed sessions preserve the provider's opaque encrypted reasoning payload instead of degrading it to a resident blob object.
## [0.7.5] - 2026-06-27

### Fixed

- Guarded `parentId` session-tree walks against cycles to stop resume from exhausting memory (OOM) on self-referential or cyclic parent chains (#1193).
- Guarded `getTree` against child cycles so cyclic child references can no longer drive unbounded traversal (#1195).
- Elided runaway thinking-token loops in the assistant message renderer so repeated thinking output no longer grows without bound (#1196).
- Made `gjc session` create/list work on psmux-backed multiplexers (#1192).
- Sanitized dot-prefixed cwd window titles so tmux window names render correctly (#1198).
## [0.7.4] - 2026-06-27

### Added

- Native Windows `gjc --tmux` is now backed by [psmux](https://github.com/psmux/psmux) when no real tmux is on PATH: a new `psmux-detect` module probes `psmux` / `pmux` / `tmux` on Windows and resolves the multiplexer to use, `tmux-common.ts` re-exports the resolver for downstream callers, and `buildDefaultTmuxLaunchPlan` builds a real PowerShell-encoded `--tmux` plan instead of falling through to the direct-launch diagnostic. The native Windows `gjc session` / `gjc team` ownership-tag and worker-spawn paths therefore work end-to-end on a Windows host with psmux installed (no WSL required).
- Three new environment knobs back the Windows psmux path: `GJC_PSMUX_COMMAND` (force the multiplexer to be treated as psmux), `GJC_PSMUX_DETECTION` (`off` / `false` to skip probing entirely), and `GJC_PSMUX_FORCE_DETECT` (`1` / `true` to re-probe on every call). `GJC_TMUX_COMMAND` and `GJC_TEAM_TMUX_COMMAND` continue to override the multiplexer selection on every platform.
- Implemented a GJC plugin bundle architecture: `gjc plugin install <path|package>` resolves and installs declarative GJC plugin bundles into user/project scope with a content-addressed registry (per-file SHA-256 manifest hashes), and `gjc plugin list|doctor|enable|disable|uninstall` manage them; local-path bundles install offline without npm (#1149).
- Added Telegram-driven session lifecycle control so sessions can be created, closed, and resumed from Telegram, with per-session topic management wired into connect and shutdown (#1148).
- Added a keyless `insane` web search provider that safely ports upstream [`fivetaku/insane-search`](https://github.com/fivetaku/insane-search) public-route fallbacks (MIT; vendored engine pinned in `packages/coding-agent/vendor/insane-search/`) without TLS impersonation, browser/cookie bypasses, credential storage, or auto-installed dependencies (#1011).
- Added durable cold-spill eviction for compacted session history: after a compaction, `SessionManager.evictCompactedContent()` moves pre-`firstKeptEntryId` payloads (user/assistant text, thinking, tool-call arguments) out of the hot JSONL and resident heap into durable content-addressed sidecar blobs via `BlobStore.putImmutableSync`, keeping hot retained bytes bounded regardless of pre-compaction history size while preserving graph integrity and the compaction summary (#1166).
- Added a non-materializing, path-only `buildSessionContext()` that no longer populates `#materializedEntriesCache` and performs zero cold-spill reads on covered compacted branches, plus fidelity read APIs (`getEntryForFidelity`/`getBranchForFidelity`/`getEntriesForExport`) that rehydrate cold-spilled content on demand for HTML export, branch & re-edit, and branched-session creation (#1166).
- Added `BlobStore.putImmutableSync`/`getCheckedSync` (plus `EphemeralBlobStore`/`MemoryBlobStore` overrides): immutable, crash-safe, hash-verified content-addressed install (exclusive copy fallback + fsync) and checked reads that throw `BlobCorruptError` on corrupt blobs and never return silent wrong data (#1166).
- Raised the `deep-interview` default maximum round count to 100.
- New unit tests under `packages/coding-agent/test/gjc-runtime/psmux-detect.test.ts` cover detection verdicts, override precedence, cache behavior, and the `resolveGjcTmuxBinary` Windows / POSIX resolution paths.

### Changed

- `gjc team` now adopts any real tmux session as its leader — including one you started yourself outside `gjc --tmux` — by writing and reading back GJC's `@gjc-profile` ownership tag, instead of only accepting `gjc --tmux`-launched sessions. Providers that cannot round-trip tmux user options (e.g. psmux) are still rejected as unmanaged (#1140).
- `gjc team` now fails with actionable guidance when there is no tmux leader to host workers: running it with no tmux installed reports `tmux_not_installed`, and running it outside any tmux session reports `not_inside_tmux` (with a hint to start one via `gjc --tmux` or your own `tmux`, or use `--dry-run`), instead of surfacing raw tmux stderr (#1143).
- Improved `ultragoal` artifact-gate guidance in the completion quality gate (#1163).

### Fixed

- First-time `gjc` startup now shows only the installed/current version changelog entry instead of dumping the full historical changelog before the actionable UI; full history remains available through `/changelog --full` (#1184).
- `gjc --tmux` on native Windows no longer silently falls through to a tmux-less launch: when psmux is installed the plan now boots gjc through a PowerShell-encoded inner command, when no tmux-class binary resolves on PATH the diagnostic points at the psmux install URL and `GJC_TMUX_COMMAND` override, and explicit `GJC_TMUX_COMMAND` overrides are honored on every platform.
- The `gjc team` worker-command string is now formatted for the host shell: on Windows + psmux each env assignment uses the `$env:VAR = 'value';` PowerShell form (with PowerShell-safe single-quote escaping) instead of the POSIX `VAR='value'` form, so worker panes spawned via psmux ConPTY panes inherit the right `GJC_TEAM_*` environment.
- `createGjcTmuxSession` now chooses the new-session bootstrap command for the host shell: PowerShell `$env:GJC_TMUX_LAUNCHED = '1'; gjc` on Windows, `exec env GJC_TMUX_LAUNCHED=1 gjc` on POSIX, so psmux-managed sessions tag the spawned gjc the same way tmux-managed ones do.
- `applyGjcTmuxProfile` no longer hard-fails the `gjc --tmux` boot on Windows when psmux drops the UX profile round-trip. When the resolved multiplexer is psmux, only the `mouse` / `set-clipboard` / `mode-style` UX keys are filtered out; the `@gjc-profile` / branch / project / session-identity ownership tags are still emitted because those are required for `gjc session` and `gjc team`.
- `renameExistingTmuxWindowIfNeeded` no longer short-circuits on `platform === "win32"`: on a Windows host running psmux inside `gjc --tmux`, the leader window now inherits the project:branch title the same way it does on POSIX.
- Fixed tmux startup fast paths (#1142).
- Deep Interview (and any scrollable `ask`/hook selector) no longer enables SGR mouse reporting, which was hijacking the mouse wheel and disabling the terminal's native scrollback while a question was on screen. The wheel now scrolls the terminal as usual; long questions still scroll inside the dialog via PgUp/PgDn (#1164).
- Scrollable Deep Interview question boxes now show explicit `▲ more` / `▼ more` affordances when hidden question text exists, and selector mode also supports Ctrl+u/Ctrl+d as question-scroll aliases for PgUp/PgDn (#1164).
- Fixed unbounded memory growth in long sessions: the full verbatim transcript was retained in `SessionManager.#fileEntries`/`#byId` forever across compactions (compaction only summarized the LLM-bound context), so long coding sessions could OOM. Compaction now reclaims hot resident content via cold-spill, the `AgentSession.compact()` post-append path no longer bulk-materializes the branch, and assistant tool-call arguments/text are no longer kept verbatim indefinitely (#1166).
- Lossless branch/export fidelity after compaction: HTML export and branch & re-edit now rehydrate cold-spilled pre-compaction content instead of showing tombstone notices, and branched-session creation preserves cold-spill refs without truncating >500k-char content (#1166).
- Materialize resident blobs before branch export so exported branches never reference unresolved resident blob refs.
- Inherit the live fast-mode (`serviceTier`) into task subagents so delegated work uses the parent session's service tier (#1171).
- Fixed model selection after model-profile preset activation so the activated preset's model is actually used (#1172).
- Preserve session-only model-profile overrides instead of dropping them on later resolution (#1175).
- Fixed the `gjc ultragoal checkpoint` goal-snapshot fallback so checkpoints reconcile correctly when a fresh snapshot is unavailable (#1177).
- Added durable `gjc-session` diagnostics for the routed-session harness scripts (#1189).
- Telegram: apply verbosity commands (#1139), fix clarify-choice rendering (#1147), create the session topic on connect, and delete session topics on shutdown.

### Documentation

- The native Windows psmux section in `docs/environment-variables.md` now reflects that `gjc --tmux` builds a real tmux-backed plan via psmux, lists the new `GJC_PSMUX_*` knobs, and explains the worker-spawn shell-quoting rule. The bundled `team` skill doc points readers at the same environment section instead of the legacy "psmux is not fully supported" warning.
- Clarified Windows tmux fallback guidance.
- Credited `fivetaku/insane-search` for the ported public-route search fallbacks.

## [0.7.3] - 2026-06-25

### Added

- Added the `gruvbox-dark` built-in theme: the canonical Gruvbox dark palette mapped across every GJC theme token, selectable via `/theme`.
- Added a standalone MCP registration command: `gjc mcp add|list|remove` writes explicit user-provided MCP server definitions (stdio/http/sse) into GJC config without importing or inheriting other tools' live MCP configs, with env/header/auth values redacted in output (#1095).

### Changed

- Refined the interactive composer chrome so the input box, status rail, and welcome banner share one visual language: the composer now uses a rounded border (matching the rounded welcome banner) instead of a sharp rectangle, and the status rail uses the subtle elevated `userMessageBg` surface tone instead of the heavy `statusLineBg` block, so it reads as a quiet layered zone rather than a solid bar. Both resolve through existing semantic theme slots, so every bundled theme tracks automatically.
- When a Composer harness model is active, the `bash` tool now hard-blocks repository file I/O — pipes, process/heredoc/command substitution, redirection, `tee`, file read/discovery (`cat`/`head`/`tail`/`grep`/`find`/`ls`), file mutation (`cp`/`mv`/`rm`/`touch`/`mkdir`/`chmod`/`ln`), `sed`/`awk`, git file-read subcommands, and script file I/O — unless the command is on a strict allowlist (`bun test`/`run check|test|build`, `cargo test|check|build`, `git status`/`rev-parse`, package version queries), forcing Composer models to use the dedicated find/search/read/edit tools for file discovery and mutation (#1027).
### Documentation

- Documented the docs-only Aside evaluation boundary as an opt-in search/context retrieval sidecar using explicit user-provided MCP configuration, with browser actions, login flows, payments, internal tools, secrets, and raw browser/session payload logging out of scope by default (#1097).
- Added a UI design and visual QA contract governing future TUI/dashboard/terminal visual work (#1101).
- Added a CodeGraph custom-tool integration guide (#1073).
- Documented the Windows psmux namespace boundary for `gjc --tmux`, `gjc session`, and `gjc team`: cwd/`-c` is now called out as a start directory rather than server isolation, `-L <namespace>` is identified as the psmux namespace primitive, and tmux command overrides are documented as executable names rather than shell command lines (#1118).
- Clarified the Telegram Threaded Mode fallback documentation (#1122).

### Fixed

- Expanded the initial GJC forge welcome box to the live terminal viewport width and pinned the status/composer area to the bottom when the startup layout is shorter than the screen (#1120).

- Deep Interview Restate/option gates now recover through the ask selector path instead of waiting on plaintext `Options:` output.
- Widened the forge splash on wide terminals so it no longer clips (#1110).
- Parse quoted SSH remote host names in the slash-command host parser (#1104).
- Tolerate an unreadable git HEAD in the status chrome instead of throwing (#1072).
- Registered the `plugin` command in the CLI command registry so `gjc plugin …` (install/uninstall/list/marketplace/enable/disable/doctor) resolves instead of silently falling through to the default launch/chat command — the command was implemented and tested but was never registered (#1071).
- Keybinding/Ctrl+Enter newline-handling sweep across the editor and input controller (#1111).
- Fixed model-profile default badge precedence in the `/model` selector so the correct default-profile badge wins (#1117).
- Prevented duplicate Telegram topics being created for transient sessions (#1125).

### Security

- User-supplied URL reads now share the public HTTP(S) network guard that was previously insane-fallback-only: the initial target, the redirect chain, and binary-conversion redirects are all revalidated against private-network blocking before any request is opened or followed, closing an SSRF path through the normal read-tool fetch pipeline (#1114).
- Bridge workflow-gate responses now require the claimed controller token before the unattended control plane may resolve a gate, and the `workflow_gate_response` RPC command was raised from prompt scope to control scope, so prompt-only clients can no longer answer lifecycle workflow gates (#1116).

## [0.7.2] - 2026-06-24
### Added

- Added a keyless `insane` web search provider that safely ports upstream insane-search public-route fallbacks without TLS impersonation, browser/cookie bypasses, credential storage, or auto-installed dependencies (#1011).
- `web_search` `auto` mode now drives native provider search over proxies/custom endpoints by reusing the active model's own credential + baseUrl when canonical native creds are absent: `activeContextNativeId()` matches the model's wire api (+ model-id family) to `anthropic` (anthropic-messages), `openai-compatible` (openai-responses/completions), or `gemini` (google-generative-ai Generative Language), each falling back to DuckDuckGo if the endpoint does not support web search.
- Added built-in C# LSP detection for `csharp-ls`, with `omnisharp` preserved as a fallback when `csharp-ls` is unavailable (#1054).
- Added Discord and Slack notification adapters alongside the existing Telegram surface, so action-needed signals and replies can be routed to those clients (#1043).
- Telegram daemon now supports inbound and outbound photo/file attachments, forwarding agent images and accepting user-sent media (#1053).
- `gjc` verifies Telegram Threaded Mode during notification setup and falls back to a flat private chat when topics are unavailable (#1029).

### Fixed

- Hardened context-overflow recovery so automatic maintenance clears the TUI loader, surfaces overflow completion/skip status, retries resumable tails safely, and falls back to the synthetic auto-continue prompt for non-resumable tails when enabled.
- `web_search` native providers no longer discard genuinely grounded answers that omit structured `url_citation` annotations: when a search demonstrably ran — Responses `web_search_call` / `tool_usage.web_search`, a Chat Completions search request, or Anthropic `web_search_tool_result` / `server_tool_use` / `server_tool_use.web_search_requests` — sources are recovered from inline markdown links and bare URLs. Inline recovery is gated on that real-search signal so a stray prose URL in a non-search answer is never promoted to a citation, and Anthropic now fails closed to DuckDuckGo when Claude answers from stable knowledge without searching. Inline-citation helpers are shared via `providers/text-citations.ts`.
- Preserve GJC-managed tmux sessions on attach/disconnect instead of tearing them down, and stop implicitly attaching on launch (#1063).
- Corrected the auto-compaction output reserve so post-compaction responses keep adequate headroom (#1021).
- Improved active-input shortcut hints and the busy-input queueing hint for clearer in-session guidance (#1022, #1024).
- Fixed the Ultragoal ask guard blocking the `ask` tool when no GJC session can be resolved. `ultragoalReadPaths` falls back to the legacy/global `.gjc/ultragoal` directory when neither `GJC_SESSION_ID` nor an auto-detectable active session is present, but the follow-up `readUltragoalPlan`/`readUltragoalLedger` reads ignored that resolution and re-ran session detection, throwing `no active GJC session found` and surfacing `durable_state_unreadable` — which blocked `ask` for every agent even with no active Ultragoal run. `ultragoalReadPaths` now returns the resolved session id (or `null`); the ask guard treats a null session as inactive and falls open, and threads the resolved id into the plan/ledger reads so they no longer re-resolve. An inconsistent state (state dir present but `goals.json` missing/empty) still fails closed so the pause guard keeps blocking give-ups.
### Added

- Added a user-level `completion.notifyCommand` hook that runs a shell command with `GJC_NOTIFICATION_*` payload environment variables when an agent turn completes, enabling cmux/desktop/webhook completion alerts without project-config command execution.

## [0.7.1] - 2026-06-23
### Fixed

- Fixed packaged source installs (`gajae-code` wrapper) failing `gjc --smoke-test` because native smoke/fallback imports used monorepo-relative paths instead of the `@gajae-code/natives` package export.
- Fixed Telegram/notification turn ordering around pending asks: the assistant's lead-in text is now emitted before the ask prompt, and only the assistant `message_end` is captured as the pre-ask turn text, so remote prompts show the correct context instead of stale or duplicated output (#1006, #1007).

## [0.7.0] - 2026-06-22

### Added

- Notifications SDK with configure-once Telegram UX: each session exposes a loopback WebSocket endpoint with a discovery file and a generic `action_needed`/`reply` JSON protocol, so any client (Telegram, Discord, Slack, mobile) can see action-needed signals and answer pending asks without RPC or terminal scraping (#874).
- Managed Telegram reference daemon with a threaded per-session surface: one-time identity header, streamed `context_update` (last message, task, goal, token/model usage, diff), live/finalized turn output, and agent image streaming (`image_attachment` + multipart `sendPhoto`).
- Typing indicator and native double-check acknowledgements for Telegram inbound messages (#989).
- Scalable `gjc daemon` control plane with safe reload, enforcing one `getUpdates` poller per bot token so new sessions attach to the existing daemon instead of causing Telegram 409 conflicts (#993).

### Changed

- Asks are exempt from redaction so remote prompts stay readable and answerable; idle summaries are stripped and streamed content frames (`turn_stream`, `context_update`, `image_attachment`) are suppressed when redaction is enabled (#998, #1001).
- Telegram replies are routed by their thread/topic; removed the legacy `/answer <session-tag>` command in favour of thread-native replies.
- Pretty HTML formatting and markdown-table rendering for Telegram daemon output (#986, #997).

### Fixed

- Strip embedded option indexes from Telegram button labels and stop double-numbering inline buttons (#994, #996).
- Free-text answers resolve pending asks and ask choices remain unredacted (#998, #1001).
- Recover in-flight sessions after a connection drop and connect new sessions during the `getUpdates` long-poll (#988, #990).
- Daemon hardening: deliver ask buttons at invocation, fix the topic-reuse race, write daemon logs to file with resilient frame handling, and de-duplicate idle output (#985, #991, and related).
### Fixed

- Avoided automatically reusing stale GJC-managed tmux sessions from older GJC versions after an upgrade; scoped `gjc --tmux` reuse now only auto-attaches sessions tagged with the current version.

## [0.6.5] - 2026-06-21

### Changed

- Scoped all GJC workflow state by session ID: skill state, plans, specs, and ledgers now live under per-session `.gjc/_session-{id}/` directories, so concurrent or resumed sessions no longer collide on shared workflow state.
- Hardened skill-state hooks with a writer revision policy, a force-ask on Stop, HUD reconciliation, and an fd-duplication guard; forced/authoritative state writes now survive corrupt prior state (#950).
- Migrated the global debug shortcut into the keybinding registry and added `pasteImage` as a single source of truth with default-collision diagnostics (#925, #939).
- Added safe import of custom skills and MCP servers via `migrate` (#944).
- Trimmed the bundled agent roster to the four canonical role agents: planner, architect, critic, and executor (#922).
- Added a research-plan ledger spike (#933).

### Fixed

- Stopped including `bash` in the planning-phase mutation guard. The phase-boundary block (and the always-on `.gjc/**` runtime-owned block) now apply only to the fully-pathed `write`/`edit`/`ast_edit` tools; `bash` is never blocked by any workflow skill (`deep-interview`, `ralplan`, `ultragoal` goal-planning), so read-only shell commands run freely during planning. This reverts the `bash` parity added in 0.6.2; product-code and `.gjc/**` mutation are still gated through the dedicated edit tools (#951).
- Rejected counterexample-only claims in research-plan regardless of `dropCondition` wording (#942).
- Bounded computer-use screenshot inline images to avoid oversized payloads.
- Tolerated missing session env in guard reads (#930).
- Fixed a session-scoped active-state staleness bug where a freshly written mode-state revision was not reflected in the in-memory envelope, so the active-state/HUD writer skipped the newer update as stale — dropping the deep-interview ambiguity HUD chip after scoring and leaving the active-skills phase mirror behind a `handoff` transition.

### Documentation

- Documented standalone MCP boundaries (#923).

## [0.6.4] - 2026-06-20

### Changed

- Added `startup.welcomeBannerMode = "square"` for a square-corner Unicode welcome-logo fallback, and stopped treating Windows Terminal (`WT_SESSION`) as an automatic ASCII downgrade; `auto` now preserves the rounded Unicode logo while `unicode`, `square`, and `ascii` remain explicit overrides.

- Improved image input discoverability by adding an interactive `#paste-image` prompt action and clearer clipboard fallback guidance when no image is available.

- Improved skill migration guidance for users moving custom skills onto the current skill system (#899).

### Fixed

- Fixed native Windows tmux launch and hardened Windows tmux root launch, and resolved follow-up Windows tmux launch and input regressions (#884, #895, #906).
- Fixed `EXDEV` failures when moving session artifacts across filesystems (cross-device session artifact moves) (#886).
- Excluded user context files from the project prompt so file-level context filtering no longer leaks user-scoped files into project context (#885).
- Fixed a bash cancellation descendant-cleanup race so cancellation now waits for child-process cleanup within a bounded stall prompt (#893).
- Fixed the TUI dropping the first `/goal set <objective>` command from input history: the typed command is now recorded whenever args are supplied, regardless of prior goal-mode state (#910).
- Fixed Ctrl+Enter/Ctrl+Shift+Enter newline handling in the editor: idle Ctrl+Enter now falls through to newline insertion while keeping Ctrl+Enter as the busy-session follow-up shortcut, and Ctrl+Shift+Enter inserts a newline (#911).
- Fixed parsing of psmux modified-enter key sequences in the TUI (#918).

### Documentation

- Documented Windows Terminal welcome-logo troubleshooting with Cascadia Mono / Cascadia Mono Nerd Font and the profile `fontFace` setting.
- Documented CLI `@image` attachments and interactive TUI clipboard image paste fallbacks in the root README.

- Documented lifecycle notification hooks (#903).
- Added a routed GJC session guide for Clawhip/Hermes/OpenClaw visible routed sessions and linked it from the Hermes docs and operator instructions.

### Fixed

- Fixed combo/cross-provider model presets flipping the main provider on resume. A profile's main model was applied through `setModelTemporary`, which records the session `model_change` with `role: "temporary"`; on resume the session restored `models.default` (the stale pre-profile base model), so an "Apply for this session" combo like `opus-codex` came back on the base default (e.g. `openai-codex/gpt-5.5`) instead of the profile's main model (`anthropic/claude-opus-4-8`). Profile activation now records its main model as the session default (without writing global settings), while transient retry/fallback/context-promotion/plan-mode switches keep `role: "temporary"` so the issue #849 protection is preserved.
- Hardened the model-profile activation rollback so a failed activation no longer poisons the resume default. The rollback previously restored the pre-activation *live* model as the session default (`role: "default"`); if the user was on a transient retry/fallback/context-promotion/plan switch when activation failed, that transient model was promoted to the resume default and weakened the issue #849 protection. Activation now snapshots the pre-activation resume default separately from the live model and re-asserts it on rollback, while the runtime live model still rolls back as a transient switch (`role: "temporary"`).

## [0.6.3] - 2026-06-19

### Fixed

- Reverted the experimental minified npm-bundle distribution introduced in 0.6.2. The published `@gajae-code/coding-agent` shipped both `src/` and ~30MB of `dist/` bundles (`cli.js` plus stats/browser/eval worker bundles), which pushed the package past npm's registry payload limit (`E413 Payload Too Large`) and blocked publishing of `@gajae-code/coding-agent` and the `gajae-code` wrapper (so 0.6.2 only partially published the sibling libraries). The CLI `bin`/`./cli` export ships from `src/` again, matching the layout that published cleanly through 0.6.1; the embedded tiktoken/o200k tokenizer removal is unaffected. Local measurement showed the bundle gave no idle-RAM benefit over running from source.
- Fixed `edit-mode.ts` importing the full `@gajae-code/utils` barrel (which re-exports native-addon-backed `ptree`/`procmgr`); it now imports `$env` from the `@gajae-code/utils/env` subpath, so schema generation and other lightweight paths no longer eagerly load the native addon.

## [0.6.2] - 2026-06-19

### Changed

- Reconciled the planning-phase mutation guard into one uniform policy across skill states (`deep-interview-mutation-guard.ts`). Previously only `deep-interview` blocked product-code mutation (and it blocked *all* `write`/`edit`/`ast_edit` targets, including neutral `/tmp` scratch), while `ralplan`/`ultragoal` planning enforced nothing beyond the always-on `.gjc/**` runtime-owned block, and `bash` got a free pass to mutate product code during the interview. Now: (1) the phase-boundary block is shared by every pre-approval planning phase — `deep-interview`, `ralplan`, and `ultragoal`'s `goal-planning` phase (`team` and executing `ultragoal` are unaffected); (2) `bash` reaches parity with `write`/`edit`/`ast_edit` so product-mutating shell commands are blocked too; and (3) neutral scratch writes to a system temp directory (`os.tmpdir()`/`$TMPDIR`, `/tmp`, `/var/tmp`) outside the project tree are always allowed, so an agent can stage a draft and persist it through the sanctioned CLI (`gjc deep-interview --write --spec <temp-path>`, `gjc ralplan --write --artifact <temp-path>`). The `.gjc/**` block is unchanged. Each planning skill now emits its own block message.
- Made the reconciled mutation guard skill-transition/return safe by keying the block off the single canonical *current* workflow skill (the resolved top-level `skill` the HUD and skill-tool chain guard already use) instead of independently scanning every skill. Phase semantics now match the manifest and the Stop hook's `STOP_RELEASING_PHASES`: `handoff` and ralplan's pre-approval `final` keep blocking for `deep-interview`/`ralplan` (until the skill is demoted or cleared), executor phases (`ultragoal` `pending`/`active`/`blocked`) release, and a missing/corrupt mode-state still fails open. As a result a handoff (e.g. ralplan → ultragoal) never lets a stale planning entry block the executor, and a return (e.g. re-entering ralplan/deep-interview after a goal completes) reliably re-blocks.
- Hardened the reconciled guard after architect + red-team review: the `gjc …` bash fast-path no longer skips scanning for compound/redirected/multiline commands (`gjc …; tee src/x`, `gjc … && echo x > .gjc/state/foo`, and newline-separated `gjc …\ntouch src/x` are now caught); the current-skill resolver prefers the most-recently-updated active entry so a stale planning row can never block a newer executor; neutral-temp classification canonicalizes paths (realpath of the nearest existing ancestor) so a `/tmp` symlink or macOS `/tmp`→`/private/tmp` alias pointing back into the project/`.gjc` is blocked; the deferred `ast_edit` apply path now mirrors the always-on `.gjc/**` block; and a heredoc delimiter (`<<EOF`) is no longer mis-read as a write target. Bash mutation detection remains best-effort defense-in-depth (the authoritative guard is the fully-pathed `write`/`edit`/`ast_edit` tools). Added generic guard exports (`getWorkflowMutationDecision`/`assertWorkflowMutationAllowed`/`assertWorkflowMutationRawPathsAllowed`) used by the session and `ast_edit` callers, with the `*DeepInterview*` names retained as compatibility aliases.
- The published `@gajae-code/coding-agent` npm package now ships a prebuilt **minified** `dist/cli.js` (built with `bun build --minify`, not `--compile`) as the CLI entrypoint; the native addon and the stats/browser/eval worker entrypoints are emitted as externals so the bundle loads them from `node_modules` at runtime, and release compiled binaries also gain `--minify`. Measured `gjc --help` RSS dropped from ~302MB (running from source) to ~120MB (#879, #881).
- Lazy-loaded the `eval` tool and its Python-kernel backend via dynamic import, so the kernel and its dependencies are no longer eagerly imported at startup and load only when the `eval` tool actually runs (#879).
- `rust-analyzer` is now treated as an optional LSP server: its startup failure no longer raises a startup warning (it is auto-installed lazily on demand), while non-optional LSP server startup failures still warn (#872).

### Fixed

- Fixed planning-pipeline stage precedence so activating a downstream stage (`deep-interview → ralplan → ultragoal`) supersedes upstream stages by pipeline rank, preventing a stale upstream row from continuing to own the HUD, mutation gate, or primary active-state snapshot (#878).
- Made `gjc state doctor` resolve the session id like every other state command (explicit `--session-id`, then payload `session_id`, then the `GJC_SESSION_ID` env var set for agent-initiated invocations), so it inspects the caller's session-scoped state files instead of a default location (#880).
- Fixed a second workspace-relative import that the 0.6.0 #867 fix missed: `edit-mode.ts` now imports `$env` through the `@gajae-code/utils` package boundary instead of `../../../utils/src/env`, so global Bun installs no longer crash resolving edit mode, with package-boundary regression coverage (#868).

## [0.6.1] - 2026-06-18

### Fixed

- Fixed the `computer` tool (and any other `z.union`/discriminated-union tool) shipping a bare top-level `anyOf`/`oneOf`/`allOf` `input_schema` root that strict providers (Amazon Bedrock Converse incl. Kiro/CodeWhisperer relays, OpenAI strict mode, Gemini) reject. Tool schema roots are now flattened to a single `type: "object"` across all providers via the shared `flattenToolRootCombinators`. See `@gajae-code/ai` 0.6.1.
- `gjc update` now runs the freshly installed `gjc --smoke-test` after version verification and tells users to restart running sessions, surfacing stale or partial runtime updates such as native-addon release mismatches immediately.

## [0.6.0] - 2026-06-18
### Added

- Exposed the existing goal-pause capability through the `goal` tool as `goal({op:"pause"})`. The runtime `pauseGoal()` method and `paused` status already existed and were reachable via the `/goal pause` slash command and the goal menu, but the agent-facing `goal` tool only enumerated `create | get | complete | resume | drop` — so an agent could not park a goal whose remaining work was blocked on human input. It was forced to either `drop` (clearing the goal) or leave the goal `active`, which re-fired the hidden autonomous-continuation steer every turn with no exit condition. `pause` reuses the existing `paused` status and continuation gate (`buildContinuationPrompt` already returns `undefined` when `enabled=false`), parks the goal without dropping it, persists as `goal_paused`, and is resumable via the existing `resume` op. The active-goal and continuation prompts now instruct the agent to pause when every outstanding deliverable is genuinely human-blocked. `pauseGoal()` now rejects any goal whose status is not `active`, so a completed or dropped goal cannot be driven into a paused-mode lifecycle when paused through the tool.

### Fixed
- Fixed global Bun installs crashing during interactive startup when edit-mode resolution followed a workspace-relative `packages/utils/src` import that is absent from the published package layout; coding-agent now imports `$env` through the `@gajae-code/utils` package boundary and has regression coverage for sibling workspace source imports (#867).

- Restored steer-by-default while the agent is busy: `busyPromptMode` now defaults to `steer`, so Enter on a normal prompt interrupts the active turn. Queueing for the next turn is reserved for the explicit Ctrl+Enter follow-up keystroke (or `busyPromptMode: "queue"`); existing steer/cancel plus explicit queue/dequeue controls remain separate (#829).
- Fixed `gjc rlm "<question>"` consuming the seeded question as a one-shot autonomous run that exited immediately; a seeded prompt now lands in the interactive composer so the research session stays interactive.

### Added

- Added an opt-in `gjc rlm` research mode (v1, interactive): a Jupyter-notebook-style research session over the existing agent loop, backed by the shared persistent Python kernel. It loads a distinct research system prompt, restricts the toolset to a hard-gated allowlist (`python` + `read` + `web_search`, asserted after tool-registry assembly — no `bash`/edit/arbitrary mutation), optionally loads a project-root `DATA.md` (overridable via `--data <path>`), aggregates every executed cell live into `.gjc/rlm/<session>/notebook.ipynb` (single-queue atomic temp-rename writes with post-write validation), and synthesizes `.gjc/rlm/<session>/report.md` on session exit. Autonomous goal-arg runs, `--resume`, managed per-workspace venv provisioning, and the optional `>=N` completion gate are deferred follow-ups.
- Added an experimental opt-in `computer` desktop-control tool surface for local macOS screenshot/input coordination, backed by native `ComputerController`/`computerScreenshot` bindings and gated through settings/tool registration so it can continue stabilizing on `dev` outside the 0.5.4 patch release.
- Dropped deprecated GitHub Actions Intel macOS (`macos-13` / `darwin-x64`) release-binary coverage after the runner pool repeatedly blocked v0.6.0 publish; Intel macOS users should install through npm/Bun or build from source.
- Re-enabled GitHub Actions Intel macOS (`darwin-x64`) release-binary coverage using the `macos-15-intel` runner, so standalone `gjc-darwin-x64` binaries ship again alongside Apple Silicon.

## [0.5.4] - 2026-06-17

### Fixed

- Fixed subagent resume returning `not_found` after terminal job eviction removed the in-memory subagent record. Resume descriptors are now retained as durable same-session metadata and rehydrate a resumable record from the saved subagent session file, so ralplan Planner revision passes can resume with fallback metadata instead of forcing a fresh Planner spawn after 0.5.3.
- `AgentSession` now forwards the live provider session state (`providerSessionState`), session affinity id (`providerSessionId ?? sessionId`), and configured WebSocket transport preference (`preferWebsockets`) into local maintenance one-shot calls — manual/automatic compaction summaries, handoff generation, and tree branch summaries — via a shared `#maintenanceProviderTransport()` helper. Previously these Codex/OpenAI-compatible maintenance calls could fall back to HTTP/SSE and lose `session_id` affinity even when `providers.openaiWebsockets: "on"` routed live turns over WebSocket (#736).
- Fixed `ollama-cloud` first-event timeouts driving an unbounded, usage-spiking retry loop. The ollama-chat backend (exclusively `ollama-cloud`; local Ollama uses the `openai-responses` API) can stall before its first token even for tiny prompts, surfacing `Provider stream timed out while waiting for the first event`. That message matched the generic transient classifier, which retries forever (capped only on delay), so every continuation re-issued the full request to a billable backend and silently spiked usage — disabling retries was the only workaround. First-event timeouts on the ollama-chat API are now a distinct fail-closed class bounded by `retry.maxRetries`: they still retry transient cold starts a few times, then surface instead of looping. First-party providers keep their existing unbounded first-event-timeout retry behavior (#713).
- Interactive sessions no longer orphan the `browser` tool's headless/spawned Chrome (and the Python eval kernel) to PID 1 when killed by a signal. The interactive entry now registers a bounded, idempotent `postmortem` cleanup (`session-subprocess-teardown`) that runs `AgentSession.disposeChildSubprocesses()` on `SIGINT`/`SIGTERM`/`SIGHUP`, force-releasing the session's browser tabs (`kill:true`) and disposing its Python/JS kernels — the teardown the graceful `/quit` (`dispose()`) path already performs but that an external `kill`/terminal-close used to bypass. Headless `disposeBrowserHandle` now also SIGTERM/SIGKILLs the captured Chrome process tree as a fallback when forced, so a wedged renderer can't survive a bounded CDP `close()`; graceful release behavior is unchanged. The teardown is time-boxed (5s) so a stuck subprocess can't hang process exit (#698).
- Added first-class xAI search provider support for the `web_search` tool and `gjc q`, including OAuth/API-key auth, web/X/combined search modes, xAI web/X filters, image/video options, citation controls, usage reporting, Settings provider selection, CLI flags, config schema wiring, and edge-case coverage.

## [0.5.3] - 2026-06-16

### Added

- Added `GJC_CREDENTIAL_RANKING_MODE` env var (`balanced` (default) | `earliest-reset`), wired through `discoverAuthStorage` into `AuthStorage.credentialRankingMode`. `earliest-reset` selects multi-account OAuth credentials earliest-expiry-first so soon-to-reset tumbling-window quota (e.g. Claude 5h/7d) is drained before it is lost at reset; unset/unknown leaves the default `balanced` behavior unchanged.
- The `/model` selector and `/fast` status now show a per-model fast-mode indicator (`⚡`) resolved with the provider-aware predicate, including subagent (role) models evaluated against the effective `task.serviceTier` (falling back to the session tier when `inherit`), so it is visible at a glance which models will run with Anthropic `speed:"fast"` / OpenAI `service_tier=priority`. Display-only: no `serviceTier`/`modelRoles`/`agentModelOverrides` writes (#691).
- Added an opt-in `GJC_BRIDGE_ENDPOINTS` env var (`all`, or a comma list of matrix keys: `events`, `commands`, `control`, `uiResponses`, `hostToolResults`, `hostUriResults`) to enable bridge-mode session-control endpoints, which were previously permanently fail-closed (`403 endpoint_disabled`) with no supported way to turn them on. Unset stays fail-closed and backward compatible (#663).

### Fixed

- Auto-compaction no longer silently requires OpenAI when the active route is a custom Anthropic-capable provider. The compaction model-candidate selection already prefers the active session model, but its last-resort "largest-context model" fallback scanned the entire bundled catalog across all providers, so a stray OpenAI credential (e.g. an out-of-credit key left in the environment) could be picked when the active provider's compaction credential was unusable — turning OpenAI into an implicit hard dependency. The implicit fallback is now scoped to the active model's provider; cross-provider compaction still works but only when explicitly configured via `modelRoles`. When the active provider cannot compact and no role is configured, compaction now fails with the existing clear, provider-specific credential error instead of reaching for OpenAI (#697).
- Long-running-session freeze/leak remediation across the TUI, agent, and tool runtime: the TUI render loop, component-dispose lifecycle, and markdown highlighting are hardened against huge frames and reuse leaks (#716); agent context append, an emergency-compaction floor that cannot be disabled, token accounting, and session resource teardown (own-session browser tabs, LSP clients, Cursor conversation cache) are bounded (#717); oversized tool inputs/outputs are capped (8 MiB edit/read guard ahead of the notebook fast-path, 1000-row SQLite raw-query cap, 16 MiB artifact / 256 MiB archive read caps, budget-bounded browser return serialization) (#721); native synchronous entrypoints add defense-in-depth caps for tokenization, highlighting, and fuzzy edit matching (#744); and the session blob store is LRU-bounded (64 MiB / 4096 entries) with bounded-concurrency blob resume (limit 8) (#719).
- Process & resource lifecycle hardening so child processes and external resources are reliably reaped on disconnect, abort, and shutdown, built on a new owned-process foundation — process-group ownership with escalating SIGTERM→SIGKILL tree termination, idempotent dispose, and a postmortem reap hook (F1). Owned-process handles are terminalized on clean drain so a retained handle can never signal a recycled PID/process group (B1); the native blocking-task boundary, PTY lifecycle, and pi-shell timeout/abort reaping are hardened (U1–U3); the Python eval kernel (U4) and JS eval worker/VM (U5) coalesce concurrent first cells, settle queued/pending runs on teardown, and return worker/kernel counts to baseline; bash shell sessions are owner-scoped with one-shot async/monitor jobs and a hard artifact byte cap (U6); DAP adapters and LSP servers are spawned as owned processes and killed on terminate/timeout/reload (U7); MCP stdio/HTTP/SSE transports and the manager close idempotently with stale-publication identity guards (U8); the async job-manager bounds dispose, the delivery queue/retry (with dead-lettering), and terminal purge (U9); and tmux GC never prunes live/attached sessions and reaps only durably-owned orphans (U10).

## [0.5.2] - 2026-06-15

### Fixed

- Rendered `/dump` tool-call parameters with readable structured bodies, XML-safe text, and decoded Unicode escape sequences so `ask`/`proxy_ask` deep-interview payloads no longer show dense `questions` JSON or literal Korean `\u...` escapes.
- Prevented `gjc --tmux` partial-launch diagnostics from throwing when stderr is already closed during shutdown.
- Fixed v0.5.1-style macOS/Linux standalone binaries crashing before the first model request with `Cannot find module '@gajae-code/natives' from '/$bunfs/root/gjc-*'` when pre-prompt context maintenance invokes the native tokenizer.
- Mapped the retired `codex-standard` model profile name to `codex-medium` during profile activation, **as a fallback only** so a user-defined profile literally named `codex-standard` is never shadowed, letting stale `modelProfile.default: codex-standard` configs reach activation instead of blocking startup after the rebuilt profile catalog.
- Fixed interactive goal-mode auto-continuation looping `Error: Agent is already processing…` (`AgentBusyError`) while the session is busy. A wedged/orphaned subagent turn — or an in-progress compaction — can leave the session non-idle while the interactive loop is back at `getUserInput()`; the 800 ms continuation timer then fired `prompt()`, threw `AgentBusyError`, surfaced it via `showError`, and re-armed — spamming the error roughly every 800 ms. The continuation now skips and re-arms while `isStreaming`/`isCompacting`, firing only once the session returns to idle.
- Fixed the built-in `minimax-eco`/`minimax-medium`/`minimax-pro` model profiles 400ing on activation because every role pinned the non-existent `minimax-code/minimax-v3`. All three profiles now pin `minimax-code/minimax-m3`, the canonical `minimax-code` default already present in the bundled models catalog (#656).
- Fixed the native Stop hook letting a deep-interview run terminalize through the ordinary stop path without crystallizing its distilled interview state. A deep-interview mode-state that would release the Stop block (e.g. `active:true` with a `complete`/`completed`/`inactive` phase) is now held until it has actually persisted a final spec — a `spec_path` that still resolves to a real `.gjc/specs/` artifact — and the public-safe diagnostic points the agent at `gjc deep-interview --write --stage final` (optionally `--handoff ralplan`). The guard is scoped to deep-interview only: explicit abort/cancel phases (`failed`/`cancelled`/`canceled`) and the `active:false` demotion/clear outcome remain legitimate terminals, and no other workflow's stop behavior changes (#674).

### Added

- Added three bundled dark TUI migration themes — `claude-code`, `codex`, and `opencode` — whose palettes mirror the Claude Code, OpenAI Codex CLI, and opencode TUIs for easy eye-migration. They join the crustacean defaults (`red-claw` dark, `blue-crab` light) as selectable built-ins via Settings or `/theme`; defaults are unchanged and the new themes keep GJC's default symbol identity. A built-in inventory test now validates every bundled theme against the required `THEME_COLOR_KEYS` token set, name/key equality, var resolution, dark classification, and brand-vs-semantic token separation.
- Documented and regression-guarded the `gjc --tmux` scroll/mouse profile so WSL/Linux launches are not left guessing about mouse-wheel scrolling. The GJC-managed tmux session already applies `mouse on` (plus `set-clipboard on` and a readable copy-mode `mode-style`) scoped to the GJC session only, on macOS/Linux/WSL alike (only native `win32` skips the tmux launch); a new launch-path test asserts a WSL/Linux `--tmux` launch issues session-scoped `set-option ... mouse on` (never global `set -g`) and that `GJC_MOUSE=off` opts out without dropping the ownership tags. `docs/environment-variables.md` now documents the `--tmux` startup env vars (`GJC_LAUNCH_POLICY`, `GJC_TMUX_SESSION`, `GJC_TMUX_COMMAND`, `GJC_TMUX_PROFILE`, `GJC_MOUSE`) and the WSL/Windows Terminal scroll behavior (tmux copy-mode wheel scroll vs. native scrollback, copy-mode keyboard fallback, and that GJC never modifies tmux sessions you started yourself), and `gjc --help` surfaces `GJC_TMUX_PROFILE`/`GJC_MOUSE` (#650).
- Added a subagent-scoped `task.serviceTier` setting (default `"inherit"`) so the service tier / fast mode applied to task-tool subagents can be controlled independently of the main session. `"inherit"` keeps the current behavior (the main session tier is copied into each subagent's isolated settings snapshot), while any explicit value (`none`, `priority`, `openai-only`, `claude-only`, …) overrides only the subagent sessions, which already read `serviceTier` from their own settings. Implemented in `createSubagentSettings` with a focused test covering inherit and explicit-override behavior (#664).

## [0.5.1] - 2026-06-14

### Added

- `gjc --mode rpc` registers each live session in a cross-process registry (`<agent-dir>/rpc-sessions/<id>.json`) on start and removes it on shutdown, so other processes can enumerate running RPC sessions. The Python `gjc_rpc` client exposes `list_sessions()` / `RpcClient.list_sessions()` returning typed `SessionHandle`s and reaps records whose owning process is gone (issue 10; foundation for reattach/issue 09).
- `gjc --mode rpc --listen <socket-path>` runs a persistent Unix-domain-socket RPC server: the `AgentSession` outlives client disconnects (no stdin-EOF teardown) and a client can disconnect and reconnect to the same live session over the socket. The session is registered with `transport: "socket"` and the socket path as its `endpoint`, so it is discoverable/attachable via the registry. The stdio path is unchanged (frame output routes through a swappable sink shared by both transports) (issue 09).

### Fixed

- Subagent/job status panels now freeze a job's elapsed timer the moment it stops running (`completed`/`failed`/`cancelled`/`paused`) instead of counting up against `Date.now()` forever. `AsyncJob` records an `endTime` on the first terminal/pause transition and a shared `jobElapsedMs` helper backs the `subagent` panel, the `job` tool, `/jobs`, and the command-controller job line, so a finished subagent stops at its real duration while siblings keep ticking.
- RPC control-plane hardening (from dogfooding `gjc --mode rpc`): `dispatchRpcCommand` now wraps the command switch so failures return a correlated response carrying the request `id` and the real command name, instead of dropping the id and mislabeling handler exceptions as `parse`; `set_thinking_level`/`set_steering_mode`/`set_follow_up_mode`/`set_interrupt_mode` validate their inputs and reject out-of-contract values instead of silently corrupting session state; `negotiate_unattended` rejects unknown scopes/action classes with `invalid_unattended_declaration` and merges the mandatory `prompt` scope plus its `command.prompt` action floor into the accepted grant (so prompt/`workflow_gate_response` are never locked out); and read-only/control RPC commands no longer consume the unattended `max_tool_calls` budget while wall-time enforcement is preserved. `docs/rpc.md`'s first `workflow_gate` example now matches the canonical `RpcWorkflowGate` shape.
- RPC mode no longer head-of-line-blocks control/cancellation commands behind a long-running command: the stdin loop now dispatches ordered commands through a serial chain (so causal order is preserved — e.g. `get_state` after `bash` still observes the bash result) without blocking the reader, and routes `abort`/`abort_bash`/`abort_retry` on an immediate fast lane so they reach in-flight work. `abort_bash` can now cancel a running `bash`, and a slow `compact`/`handoff`/`login` no longer freezes the whole control plane. Shutdown drains in-flight commands (bounded) so their responses are still emitted on stdin EOF.
- Counted active prompts and agent-initiated custom messages in pre-prompt context maintenance so background task notifications trigger compaction before they can overflow the next model request.
- Bounded monitor task-notification payloads to a compact tail window while preserving full background job output for job inspection.

### Changed

- Expanded coordinator MCP coordination status into a canonical polling snapshot for sessions, session states, turns, questions, reports, and bounded event summaries, and documented that Hermes/coordinator consumption is polling/await rather than push subscription.

## [0.5.0] - 2026-06-13

### Fixed

- Fixed forced `tool_choice` 400s ("tool_choice forces tool use is not compatible with this model") looping after `ast_edit` previews: named queue directives (resolve protocol, eager `todo_write` enforcement, subagent `yield` reminders) now enqueue only when the model supports exact named forcing; otherwise they degrade silently to the existing steer reminder without a forced `tool_choice`, and a runtime-discovered incapability drops the in-flight directive instead of requeueing it.
- `models.yml` compat blocks now accept the `toolChoiceSupport` enum (`none`/`auto`/`required`/`named`) alongside the legacy `supportsToolChoice`/`supportsForcedToolChoice` booleans, mirrored in the generated JSON schema.
### Added

- Made `/model` open to a preset-first landing view: provider-grouped presets with live auth checkmarks, highlight-to-expand tiers, a full clamped role→model preview before applying, and a session/default apply scope choice; typing still jumps straight to model search, "Browse all models" opens the classic tabbed selector, and temporary-only quick-switch bypasses the landing entirely.
- Rebuilt the builtin model profile catalog as 25 profiles: `codex-{eco,medium,pro}` on `gpt-5.5` effort spreads, a single `opencodego` preset, `claude-opus`, `{glm,kimi-coding-plan,mimo,grok,cursor,minimax}-{eco,medium,pro}` trios with thinking levels clamped to provider support, and `opus-codex`/`codex-opencodego` combos. Legacy profile names (including the `*-standard` family and retired Fable presets) were removed clean-break and now fail with the available-profile listing.
- Added a post-`/login` smart preset recommendation: when login succeeds and no profile is active, prompts "Apply <preset> now?" (session-only on confirm); when a profile is active, prints a one-line hint instead. The active profile is tracked in-memory on the session with rollback-safe activation.
- Bundled `kimi-code/kimi-k2.7-code` and `minimax-code/minimax-v3` model entries; MiniMax presets use the canonical `minimax-code` provider id throughout.
- Added a harness receipt JSONL spool exporter for gajae receipt-runtime interop: configured `gjc harness --receipt-spool-dir <dir>` / `GJC_RECEIPT_SPOOL_DIR` now appends persisted native `ReceiptEnvelope` records as `{cursor,envelope}` lines to `spool.jsonl`, with restart-safe 12-digit cursors and installed-package smoke coverage (#545).
- Added Gajae Trinity compatibility golden fixtures and tests that pin ReceiptEnvelope hash basis, validator compatibility, and replayable RPC exchange shape for downstream receipt-runtime interop.
- Optimization Suite v3 Lane 1 (RSS): large resident text in persisted sessions is now backed by an ephemeral session-scoped disk cache (`EphemeralBlobStore`) instead of being pinned in JS heap for the whole session lifetime; canonical JSONL persistence, reload, and export semantics are byte-identical (resident refs never persist). Missing resident text cache blobs now surface a typed `ResidentBlobMissingError` instead of silently leaking `blob:sha256:` refs into provider payloads, UI, or exports. `getEntries()`/`buildSessionContext()` are served from revision-keyed WeakRef caches below the public ownership boundary (callers still receive caller-owned copies). Fixture retained heap −82%, RSS −55%, warm `getEntries()` p95 −80% on 10k-entry sessions; one-shot `exportFromFile()` now closes its session manager.
- Added process-isolated deterministic TUI render-golden capture and fixtures for interactive editor overlays, rich-text resizing, multiplexer viewport repaint, sixel image line preservation, Termux height diffs, and transcript shrink/clear regressions.

### Removed

- Removed the hardcoded OpenAI Codex role-preset action from the model selector; builtin model profiles are now the only preset concept.
- Removed retired Fable model profiles (`claude-fable`, `fable-codex`) after `claude-fable-5` was removed upstream.

### Changed

- Optimization Suite v3 Lane 3 (serialization): session-switch message comparison now uses per-message cached source strings + xxHash64 as an accelerator (source-string compare remains the authority; collision fallback tested) — unchanged-session compares −95% median. The secret obfuscator precomputes a longest-first combined regex (single-pass replace, −70% median/−77% p95 on 100 secrets × 1MiB) with a conservative sequential fallback whenever secrets overlap each other or any replacement/placeholder contains a secret — output bytes are identical in all cases. Intra-line diff rendering gains byte-identical fast paths for identical lines and whitespace-token-aligned prefix/suffix spans (identical −67%, single-token −60%; long lines skip the scan). Mental-model LCS keeps legacy dense-DP tie-break semantics (a Hunt-Szymanski variant was rejected for changing rendered bytes). Provider-visible fork-context seeds use JSON-semantic cloning instead of structuredClone.
- Tightened tool-block rendering to remove vertical padding and rely on Spacer-only separation, reducing transcript noise while preserving stable render-golden output.
- Improved the Bun runtime version guard diagnostic: when the Bun running `gjc` is older than the required version, the error now names the exact detected Bun runtime path and prints a platform-specific upgrade and PATH fix (Windows gets the `irm bun.sh/install.ps1|iex` reinstall plus a `%USERPROFILE%\.bun\bin` PATH hint) instead of a bare `bun upgrade` (#525).
- Aligned the `codex-standard` and `codex-pro` model profiles on the `openai-codex/gpt-5.5` baseline so they no longer default to stale mixed model generations (`gpt-5.4`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.3-codex-spark`); the profiles now differentiate purely by per-role reasoning effort (#532).
- Reduced the default RPC `get_state` payload by omitting static `dumpTools` and `systemPrompt` fields unless requested via `include: ["tools", "systemPrompt"]` (#539).
- Updated `/model` documentation and generated docs index for the rebuilt preset catalog and preset-first selector.

### Fixed

- Tightened the Windows/psmux tmux provider boundary: `gjc team` now honors `GJC_TMUX_COMMAND` (not just `GJC_TEAM_TMUX_COMMAND`) so the team leader resolves the same multiplexer as `gjc session`/`gjc --tmux`; and when a multiplexer lists a session that lacks GJC's `@gjc-profile` ownership tag, `gjc session status` now returns `gjc_tmux_session_untagged` with a `detail` hint and `gjc team` reports the same cause, instead of a bare `gjc_tmux_session_not_found` / `unmanaged_tmux_session`. Documented that alternative multiplexers such as psmux on Windows are not fully supported because they do not round-trip tmux user options (#531).
- Hardened RPC stdio lifecycle behavior: `gjc --mode rpc` now reports malformed JSONL frames as parse-error responses without killing the session, flushes durable session state before exiting on EOF/shutdown, and has red-team coverage for attached persistence, reload, malformed-frame recovery, and concurrent child-session isolation.
- Hardened the harness RPC submit/router contract so `submit` is no longer advertised or accepted during finalizing/non-idle lifecycle windows, non-idle RPC state reports `submitted:false` with a retryable gate, and degraded owner endpoints fall back to `owner-not-live` without false acceptance (#544).
- Ran estimated context maintenance before sending a new prompt, including tool-output pruning and threshold compaction, so large tool results appended after the last assistant turn cannot push the next model request over the context window.
- `gjc team` now self-heals a missing `@gjc-profile` ownership tag when the current leader pane was genuinely launched by `gjc --tmux` (detected via `GJC_TMUX_LAUNCHED=1`): the session is re-tagged with `set-option` and startup proceeds, instead of hard-failing with `unmanaged_tmux_session` after a mid-startup attach failure or registry race stripped the tag. Sessions without the GJC launch marker are still rejected unchanged, so foreign tmux sessions cannot be hijacked.
- Subagent task receipts and live render output now warn when requested role-agent models are substituted by auth fallback or provider-reported assistant model mismatch, including session model-change annotations for server-side substitutions (#559).
- Converted Cursor wire shell timeouts from millisecond values to bash-tool seconds so delegated Cursor-native shell calls honor the expected timeout units.
- Fixed pi-shell bash fixups on multibyte UTF-8 commands by converting parser source indexes to byte offsets before stripping `head`/`tail` pipelines.

## [0.4.5] - 2026-06-12

### Added

- Added a dim `(ctrl+s to observe sessions)` discoverability hint under the `subagent` await panel header while any awaited subagent is still running, pointing to the full session observer overlay; the hint shows in both collapsed and expanded states and disappears once no subagent is running.
- Added a `phase-rollup` receipt family (receipt-of-receipts) to the harness control plane: a hash-sealed rollup that supersedes N child task receipts at a lifecycle boundary, preserving per-child `{id, status, outputUri, outputSha256, receiptSha256, tokens, costTotal, clonedTokens, lowRoi}` pointers plus aggregate ROI totals, with a pure deterministic builder (`buildPhaseRollupReceipt`) and fail-closed semantic validation.
- Added a pure receipt-ingestion fast path (`ingestReceipts`): fail-closed batch validation + lifecycle transition computation via the existing state machine, plus a deterministic model-facing digest hard-capped at 280 chars — groundwork for LLM-free receipt routing.
- Added advisory spawn-ROI reconciliation (`reconcileSpawnRoi`) and deterministic fork-context mode advice (`adviseForkContextMode`) surfaced in task receipts without changing task success semantics.
- Added the Grok Build provider contract design document.

### Changed

- Reduced compiled CLI startup and native bundle pressure with default-small grammar loading, tokenizer tiering, and compiled fast-help paths.
- Preserved dev/main release metadata and changelog consistency for the 0.4.5 lockstep release.

- Added native `gjc ultragoal steer --kind` support for documented steering mutations beyond `add_subgoal`, including split, reorder, wording revision, ledger annotation, and blocked-goal supersession contracts with structured audit expectations.
### Fixed

- Kept the unified `goal` tool registered and active by default whenever `goal.enabled` is true, including explicit tool subsets and `gjc ultragoal create-goals` arming flows.
- Restored no-argument `gjc` interactive startup instead of launching help.
- Rendered and executed Cursor-native tool calls, including detached/native handler paths and empty-pattern composer grep guards.
- Tool-output pruning no longer rewrites already-sent provider-facing history mid prompt-cache epoch and now persists pruned message updates back into canonical session storage.
- Preserved provider abort root causes in the final TUI abort label, kept replay rendering idempotent, and added a `PI_STREAM_IDLE_TIMEOUT_MS` remediation hint when stream idle watchdogs fire.
- Hardened harness owner recovery/finalize paths and submit-prompt-file handling.

## [0.4.4] - 2026-06-10

### Added

- Made coordinator turns event-backed, adding an MCP coordinator server and the `gjc coordinator` / `gjc mcp-serve` commands backed by durable turn/session state (#479).
- Surfaced awaited sub-agent live streaming status in the await panel (#475).

### Changed

- Refreshed the README brand images (#477).

### Fixed

- Persisted ralplan role-agent artifacts via the CLI, returning receipt-only output to the caller (#474).
- Collected the `ask` tool "Other" custom input inline below the option list (#476).

## [0.4.3] - 2026-06-10

### Added

- Added a `busyPromptMode` setting (`steer` | `queue`, default `steer`) so a prompt submitted while the agent is busy can either steer the active turn or be queued to run after it completes, keeping steering and queued-next-turn semantics distinct. Ctrl+Enter still always queues as a follow-up (#434).
### Fixed

- Fixed a persistent `monitor` notification flood where a cancelled or evicted monitor kept delivering queued `task-notification` follow-ups (surviving process death, log deletion, and `job cancel` returning not-found). Monitors now purge their queued notifications on cancel/terminal/eviction, retain a short tombstone so post-eviction `job cancel` still purges, coalesce rapid duplicate output to the latest state, and close a cancel/trailing-flush race.
- Fixed `ultragoal` execution leaking across concurrent independent GJC sessions. The runtime `goal-mode-request.json` is now stamped with the producing session's `GJC_SESSION_ID`, and the consumer only activates a request that belongs to the current session (another session's request is left intact instead of being consumed/deleted). Legacy unscoped requests remain consumable for single-session compatibility ([#457](https://github.com/Yeachan-Heo/gajae-code/issues/457)).

## [0.4.2] - 2026-06-09

### Changed

- Added conservative `timeout-minutes` values to all CI workflow jobs to prevent indefinite hangs.
- Made coordinator MCP turn waiting state-backed by durable turn/session files, with runtime session sidecar updates for running/completed/error states and Meeseeks guidance that avoids fixed sleep/capture-pane loops.

### Fixed

- Failed stale coordinator turns quickly when their recorded tmux session is gone, clearing active-turn state instead of burning await timeouts.
- Improved the grep limit-reached message to show the current limit value and suggest using `--limit` for more results.
- Passed the active model's `maxTokens` (reserved completion budget) into the auto-compaction threshold and context-usage reserve so prompt packing reserves output for large-window models, keeping the safe input budget below the total context window (e.g. ~272K for a 400K/128K model) instead of filling the whole window ([#442](https://github.com/Yeachan-Heo/gajae-code/issues/442)).
- Fixed a `gjc harness` recovery deadlock where a session created by `start` without `--detach` (persisted as `started` with no owner lease/endpoint) could never get a live owner: `recover` refused to spawn one because no prior endpoint existed, while `start` reported `session-already-exists`. `recover` now bootstraps a fresh owner for a never-started session (no lease, no endpoint, no owner-run evidence) without writing a misleading `vanish` receipt, reported via `bootstrappedOwner: true`. Bootstrap is independent of the vanish classifier's `ownerRequired` verdict (nothing has vanished), so a session started in a non-git workspace (git delta `unknown`) is recovered too, while a deleted worktree is still refused (#421).

## [0.4.1] - 2026-06-07

### Changed

- Hardened the default system prompt with a `<skill-discipline>` block (never ignore skill text, keep read-only/interview skills from mutating, recommend and invoke the matching `/skill` on approval) and tightened `<communication>` to ban permission-begging/deferral phrasing and never announce remaining work instead of doing it (#392).
- Cleaned up the bundled GJC workflow skill docs and defaulted execution handoff to ultragoal while prioritizing ralplan refinement (#395, #396).

## [0.4.0] - 2026-06-06

### Added

- Added an agent-driven RPC workflow lifecycle control plane and a `workflow_gate` contract: `negotiate_unattended`, `workflow_gate`, and `workflow_gate_response` frames are validated by an answer-schema validator, persisted through a durable gate broker, and wired into live session dispatch (#314).
- Added a binding-only `gjc-plugins` sub-skill plugin framework that loads, validates, and activates declarative plugin packs without granting implicit arbitrary execution surface (#347).
- Added generated JSON Schemas for the config and models files (`schemas/config.schema.json`, `schemas/models.schema.json`) with a `check:schemas` drift gate (#377).
- Added `cacheRetention` support in the models config (#381).
- Added an Opus max reasoning preset (#372).

### Changed

- Improved slash command and `skill:*` suggestion ranking so `/team` surfaces the matching skill before weaker fallback candidates.

### Removed

- Removed the optional `@gajae-code/swarm-extension` package and its `gjc-swarm` CLI. The YAML/DAG swarm orchestration extension was a standalone optional feature not imported by any other package; it is no longer built or published.

### Fixed

- Routed unattended deep-interview ask-tool questions through `workflow_gate { kind: "question" }` events, including Round 0 topology and challenge-mode metadata, free-text option/schema shape, headless RPC answers, and synchronous response race handling (#316).
- Preserved harness owner-vanish evidence after prompt acceptance: no-owner `recover` now either restores a detached owner when a prior endpoint exists or returns a public-safe concrete owner-exit reason plus a vanish receipt, and no-owner `observe`/`events` expose the preserved owner-exit summary.
- Fixed LSP and MCP server lifecycle cleanup so clients/servers and their child processes are torn down on abort/exit instead of leaking (#389).
- Preserved session retention across resident session rewrites.
- Fixed harness session lookup testability without changing runtime owner-routing behavior.
- Prevented release catalog file specs from recursing during catalog resolution (#351).
- Reconciled the ultragoal skill mode-state and HUD with the plan/ledger so status reflects real goal progress (#342/#346).

## [0.3.2] - 2026-06-05

### Added

- Added model profiles with a `--mpreset <profile>` CLI flag and a `/model` selector "Profiles" section that activate a named profile's default model plus per-agent-role model overrides in one step, validating required-provider credentials before applying and surfacing a custom provider onboarding wizard for missing API-compatible providers.
- Integrated `ai-slop-cleaner` as an internal Ultragoal sub-skill fragment that runs as the mandatory completion-gate cleanup sweep over a story's changed files, reporting blocking and advisory findings without editing code or mutating `.gjc/` state.
### Changed

- Edit tool diff generation (`generateDiffString`) now uses the native `diffLines` from `@gajae-code/natives` (a byte-identical Rust port of jsdiff) instead of the pure-JS implementation, removing the multi-second Myers blowup on large-file edits (~16x faster on ~1MB files) with identical diff output.

### Fixed

- Reconciled native Ultragoal commands with workflow mode-state and the HUD: `gjc ultragoal create-goals`, `complete-goals`, `checkpoint`, steering, review-blocker recording, and status now sync `.gjc/state/ultragoal-state.json` plus `skill-active-state.json` from the durable `.gjc/ultragoal` plan/ledger, clearing stale active HUD chips after all goals complete.
- Forwarded the parent session id when task subagents validate configured role-agent model overrides, preventing session-scoped OAuth providers from being misread as unauthenticated and falling back to the parent chat model.
- Removed unintended public memory-tool guidance and registration: Hindsight retain/recall/reflect helpers are now compatibility-only, local memory prompt injection no longer advertises `memory://` reads, and regression tests guard the public tool surface.
- Fixed `read` hashline anchors drifting on truncated reads so the `line+hash` anchors consumed by `edit`/`apply_patch` stay correct when a file is read past the truncation boundary.
- Reconciled the ultragoal skill mode-state (`current_phase`/`active`) and HUD chip with the `.gjc/ultragoal` plan/ledger on every `gjc ultragoal` command (`create-goals`/`complete-goals`/`checkpoint`/`steer`/`record-review-blockers`/`status`), so `gjc state ultragoal read`, the skill-tool chain guard, and the HUD no longer sit at a stale `active:true`/`goal-planning` after a run completes (#342). A new `reconcileWorkflowSkillState` performs a session-scoped (`GJC_SESSION_ID`) derived write that bypasses only transition-edge validation while preserving schema/unknown-phase validation, version/checksum stamping, and audit provenance (`owner: gjc-runtime`, `verb: reconcile`); reconciliation is best-effort and surfaces failures via stderr and a `reconcile_failed` ledger event without changing command status/stdout. Removed the duplicate sessionless active-state sync from the `gjc ultragoal` command wrapper.

## [0.3.1] - 2026-06-05
### Added

- Added opt-in crash diagnostics for subprocess failures, with a shared crash taxonomy/report writer, bash/Python/LSP/DAP crash notices, and a native Rust panic-report hook gated by `GJC_NATIVE_CRASH_DIAGNOSTICS` / `GJC_CRASH_DIAGNOSTICS`.
- Started the GJC backend bridge foundation with a shared agent-wire protocol module, event envelopes, RPC command scope matrix, UI request broker, typed unsupported UI results, a guarded `--mode bridge` handshake surface, and RPC mode dispatch refactored onto the shared command dispatcher.
- Documented the experimental `--mode bridge` protocol in `docs/bridge.md` and the `GJC_BRIDGE_*` environment variables in `docs/environment-variables.md` (TLS-mandatory startup, bearer auth, coarse command scopes with a `prompt` floor, single live `AgentSession` per process, bounded event-stream replay with `reset`, and the semantic-not-pixel UI capability matrix), and added bridge event-stream/idempotency regression tests plus a docs-conformance check that pins the docs against the protocol version, scope/command catalog, negotiated capabilities/frame types, and unsupported UI surfaces. The bridge protocol/SDK are experimental (`BRIDGE_PROTOCOL_VERSION` 1) and may change in additive, version-negotiated ways.

### Fixed

- Made opt-in crash diagnostics create/chmod report directories to `0700` and report files to `0600` so captured command, cwd, and stderr previews are private even under a permissive umask.
- Scoped `agent://` and `artifact://` resolution to the caller's artifacts directory plus explicitly authorized parent/child tree directories, removed registry-wide live-session lookup/enumeration, and made missing agent-output metadata sidecars fail closed.
- Fail-closed experimental bridge session endpoints by default for 0.3.1: events, commands, controller ownership, UI responses, host tool results, and host URI results are disabled unless an internal endpoint matrix explicitly enables them; only health/help and the authenticated handshake remain available, with the handshake advertising no enabled session surface by default.
- Render terminal-pasted clipboard image temp paths as compact `[image N]` prompt placeholders while attaching the image payload, instead of inserting raw `/var/folders/.../clipboard-*.png` path text.
- Preserved `gjc harness` `owner-vanished:*` blockers when a replacement owner becomes live so unrecovered prior-owner evidence remains visible until explicit recovery or terminal completion evidence; only safe startup liveness false-negatives such as `detached-owner-not-live` are auto-cleared.
- Fixed the interactive agent unexpectedly stopping after automatic context maintenance instead of resuming the in-flight task. Post-compaction continuation now schedules exactly one source per completion (overflow retry → queued messages → synthetic auto-continue prompt), the threshold/handoff auto-continue prompt skips a redundant pre-send compaction check, overflow retry strips only the context-overflow failed turn (never normal/aborted/silent-abort tails), and non-resumable or superseded continuations log a structured reason instead of stranding the session.
- Fixed the native Stop skill-state hook letting active GJC workflow skills stop prematurely. The Stop hook no longer treats a missing/unreadable mode-state file as terminal for handoff workflows, and handoff skills (`deep-interview`, `ralplan`) now keep blocking Stop even in the `handoff` phase until they are demoted (`active:false`) or cleared, so they always end by offering the next handoff step via the ask tool. Non-handoff skills (`team`, `ultragoal`) retain the fail-open safety valve when their mode-state file is corrupt or invalid.

## [0.3.0] - 2026-06-03

### Added

- Added runtime-enforced Ultragoal executor QA/red-team evidence matrices for completion checkpoints, with plan-first contract coverage, user-surface evidence, adversarial cases, artifact references, scoped Executor red-team guidance, and focused rejection tests for shallow or contradictory QA evidence.
### Fixed

- Made `gjc harness observe` preserve completed RPC owner evidence after the owner exits, including a `completedOwnerExited` diagnostic and durable terminal-result cursor.
- Clarified that `gjc team` requires an existing tmux-backed leader session from `gjc --tmux`, with actionable help, docs, and failure text.
- Kept deep-interview ask options visible for long prompts by adding an opt-in scrollable selector title panel with selector-local `PageUp`/`PageDown` prompt scrolling, while leaving normal ask dialogs and global keybinding configuration unchanged.

## [0.2.5] - 2026-06-02

### Added

- Added Claude Code parity `monitor` plus `CronCreate`, `CronList`, and `CronDelete` tools with frozen upstream schema fixtures, inline scheduling, background output monitoring, and ACP permission coverage.

### Changed

- Pruned bundled built-in themes to `red-claw` and `blue-crab`, with `blue-crab` now the default light-appearance theme.
- Clarified ralplan role-agent handoff guidance so Planner/Architect/Critic return compact artifact receipts after `gjc ralplan --write --json` instead of duplicating full persisted verdict markdown into the parent context.
- Made `web_search` permissionless by default with a keyless DuckDuckGo fallback, active-model-gated native provider selection, and explicit-only legacy provider selection so custom providers no longer auto-hit stray OpenAI/Codex OAuth credentials.

### Fixed

- Fixed the skill HUD rail showing already-handed-off planning workflows so it renders only the currently-active stage. Handoffs now supersede every same-session-scope row of the caller and callee skills (not just the exact `skill::session_id` key), the visible-state read collapses duplicate same-skill rows to the most-recent one (so a handoff demotion drops a stale `active:true` row and on-disk state self-heals), and the HUD renderer collapses the `deep-interview → ralplan → ultragoal` pipeline to its most-recent stage. Activating a later stage (e.g. `gjc ultragoal` after ralplan) now supersedes the earlier one even when the activation path does not run the `handoff` verb, while `team` still coexists with ultragoal.

## [0.2.4] - 2026-06-02

### Added

- Added the bundled `blue-crab` dark theme and a TUI-only `/theme` selector that persists the selected appearance slot while keeping `red-claw` as the default dark theme.
- Added `retry.requestMaxRetries` and `retry.streamMaxRetries` settings plus docs for codex-cli-style provider retry budgets ([#157](https://github.com/Yeachan-Heo/gajae-code/pull/157)).

### Fixed

- Forwarded a caller-provided `User-Agent` on non-Anthropic proxy base URLs so the anthropic-messages provider no longer strips it, fixing HTTP 403 "request was blocked" rejections from WAF-fronted proxy gateways.
- Restored Settings theme live preview without persisting browse state so confirm/cancel governs the rendered theme and in-flight previews cannot overwrite an explicit choice ([#166](https://github.com/Yeachan-Heo/gajae-code/pull/166)).
- Preserved the deep-interview session language so interviews continue in the language they started in ([#168](https://github.com/Yeachan-Heo/gajae-code/pull/168)).
- Purged the inherited OMP/pi-mono history from the embedded coding-agent CHANGELOG so post-update notifications and `/changelog` only surface gajae-code releases ([#161](https://github.com/Yeachan-Heo/gajae-code/pull/161)).
- Wired `goal` tool `drop`/`complete` semantics so completing or dropping a goal restores the pre-goal toolset in the same session, with refreshed ultragoal docs ([#152](https://github.com/Yeachan-Heo/gajae-code/pull/152)).
- Added local-memory empty-payload guidance so the agent does not claim facts were saved or remembered when local memory has no confirmed payload/readback ([#165](https://github.com/Yeachan-Heo/gajae-code/pull/165)).
- Fixed `gjc update` binary fallback downloads to use the current owner release repository and report actionable manual update commands for unsupported fallback targets ([#164](https://github.com/Yeachan-Heo/gajae-code/pull/164)).

## [0.2.3] - 2026-06-01

### Added

- Added `/provider add --preset minimax|minimax-cn|glm` and matching `gjc setup provider --preset ...` shortcuts for OpenAI-compatible MiniMax and GLM/zAI custom-provider onboarding.
- Added a built-in `skill` tool so the agent can chain into another loaded skill on its next turn. Mirrors `/skill:<name>` typing and subagent `autoloadSkills` by dispatching the chained skill's SKILL.md as a user-attribution custom message; controlled by the new `skill.enabled` setting (default true).
- Added explicit fork-context task subagents with sanitized bounded parent-history seeds, global `task.forkContext.enabled`, per-agent `forkContext: allowed`, per-task `inheritContext: true`, audit-visible seed metadata, and fresh provider transport state by default.
- Defaulted the bundled `executor` and `architect` agents to `forkContext: allowed` so callers can opt them into a sanitized parent-context seed via `task({ inheritContext: true })`; per-task selection remains explicit (default false).
- Added a `/context` slash command that surfaces the active session's token usage breakdown via `buildSessionContext` without forking prompt assembly, so users can see active context before sessions overflow ([#150](https://github.com/Yeachan-Heo/gajae-code/pull/150)).
- Added multi-line focused-option rendering to the `ask` tool's `HookSelectorComponent` via an opt-in `wrapFocused` flag so long option labels stay readable in plan-mode and other shared consumers ([#148](https://github.com/Yeachan-Heo/gajae-code/pull/148)).
- Added a sanctioned native deep-interview spec persistence bridge so deep-interview can save final specs under `.gjc/specs/` before deliberate ralplan chaining without caller-side `.gjc` writes ([#134](https://github.com/Yeachan-Heo/gajae-code/pull/134)).
- Added the skill chaining lifecycle's `handoff` state verb with same-turn dispatch and atomic HUD-truth synchronization across callee mode-state, caller mode-state, session active-state, and root active-state ([#132](https://github.com/Yeachan-Heo/gajae-code/pull/132)).

### Changed

- Clarified the README to position team as optional and ultragoal as implementation-through-evidence, so docs readers see workflow handoffs without spelunking into skill sources ([#145](https://github.com/Yeachan-Heo/gajae-code/pull/145)).
- Migrated CI to the gajae self-hosted Linux runner with fork-PR guards, idempotent `fd` symlink setup, and Node 24 pinning for self-hosted jobs ([#124](https://github.com/Yeachan-Heo/gajae-code/pull/124)).

### Fixed

- Enforced the deep-interview phase boundary so active interviews block mutation tools until a handoff/spec is produced.
- Allowed read-only `architect`, `planner`, and `critic` role agents to persist ralplan/state workflow receipts through a restricted `bash` allowlist while blocking general shell and product-file mutations.
- Made settings theme browsing confirm-only so arrowing through themes no longer changes the rendered theme before the displayed/persisted theme name changes.
- Made startup CHANGELOG display deterministic by embedding `packages/coding-agent/CHANGELOG.md` into the binary so post-update launches show the shipped history regardless of cwd or `GJC_PACKAGE_DIR`/`PI_PACKAGE_DIR` overrides.
- Registered `gjc update` as a public root subcommand so it invokes the bundled updater instead of routing into the interactive launcher.
- Fixed local memory backend persistence so manual enqueue/rebuild starts maintenance immediately and prompt injection reads the active session's memory root.
- Aligned release-bump CI tests with the highest bundled upstream Claude family and stopped cancelling TTSR retries when an aborted partial was not persisted, so dev PRs no longer regress on v0.2.2-style release assumptions ([#142](https://github.com/Yeachan-Heo/gajae-code/pull/142)).
- Added a runtime guard in the built-in `skill` tool that rejects re-entry into the currently active skill via a typed active-skill bridge from agent sessions into tool sessions, preventing recursive skill handoffs that prompt-only guidance could not stop ([#129](https://github.com/Yeachan-Heo/gajae-code/pull/129)).

## [0.2.2] - 2026-05-31

### Added

- Added `gjc session` for listing, inspecting, removing, and attaching GJC-managed tmux sessions ([#105](https://github.com/Yeachan-Heo/gajae-code/pull/105)).
- Added a managed tmux session surface so `gjc --tmux` and `gjc team` reuse a scoped GJC session instead of mutating the global tmux environment.
- Added a detached contribution prep workflow surface ([#122](https://github.com/Yeachan-Heo/gajae-code/pull/122)).
- Added stricter `models.yml` validation and docs for OpenAI-compatible proxy providers, bridge-command requirements, and team dry-run state behavior ([#121](https://github.com/Yeachan-Heo/gajae-code/pull/121)).
- Added first-class Azure OpenAI and Amazon Bedrock providers ([#119](https://github.com/Yeachan-Heo/gajae-code/pull/119)).
- Added workflow state receipt routing so skill state writes emit a structured `WorkflowStateReceipt` envelope and sync skill-active HUD chips under `.gjc/state/skill-active-state.json` ([#118](https://github.com/Yeachan-Heo/gajae-code/pull/118)).
- Made `gjc state`, `gjc ralplan`, and `gjc deep-interview` work natively as documented in their SKILL.md files. `gjc state read|write|clear|contract` operates directly on `.gjc/state/` receipts (accepts `--input '<json>'` with `@file` shorthand, `--mode <skill>`, positional `<skill>`, `--session-id`, `--thread-id`, `--turn-id`, `--json`, `--replace`); writes emit a structured `WorkflowStateReceipt` envelope and sync skill-active HUD chips. `gjc ralplan` accepts the documented `--interactive`/`--deliberate`/`--architect`/`--critic` flags and the `--write --stage --stage_n --artifact` artifact persistence shape under `.gjc/plans/ralplan/<run-id>/`. `gjc deep-interview` accepts the documented `--quick`/`--standard`/`--deep` resolution flags ([#125](https://github.com/Yeachan-Heo/gajae-code/pull/125)).
- Added a GJC dogfood skill template ([#114](https://github.com/Yeachan-Heo/gajae-code/pull/114)).

### Changed

- Changed `gjc --tmux` startup to create a fresh GJC-managed tmux session instead of attaching to an existing default session.
- Hardened team message delivery and worker enforcement ([#112](https://github.com/Yeachan-Heo/gajae-code/pull/112)).
- Hardened team worker startup and evidence invariants ([#123](https://github.com/Yeachan-Heo/gajae-code/pull/123)).
- Clarified team state while integration is pending ([#109](https://github.com/Yeachan-Heo/gajae-code/pull/109)).
- Removed goal mode budget semantics ([#106](https://github.com/Yeachan-Heo/gajae-code/pull/106)).
- Removed the unused `gjc question` CLI; the `ask` tool covers blocking-question prompts.
- Dropped the obsolete `loop` and `orchestrate` skills and pinned GJC skills in autocomplete ([#126](https://github.com/Yeachan-Heo/gajae-code/pull/126)).
- Enforced CLI-managed workflow artifacts so planning skills persist via `gjc state` and `gjc ralplan --write` instead of editing `.gjc/` files directly.

### Fixed

- Fixed Anthropic extended-thinking replay recovery after aborted turns ([#115](https://github.com/Yeachan-Heo/gajae-code/pull/115)).
- Fixed `gjc deep-interview` ambiguity threshold default so workflow gating matches the documented contract ([#116](https://github.com/Yeachan-Heo/gajae-code/pull/116)).
- Fixed duplicate PR creation in the team integration path ([#117](https://github.com/Yeachan-Heo/gajae-code/pull/117)).
- Fixed package asset resolution to prefer `GJC_PACKAGE_DIR` over the legacy `PI_PACKAGE_DIR`, preventing update-launch changelog displays from reading stale OMP package assets ([#111](https://github.com/Yeachan-Heo/gajae-code/pull/111)).
## [0.2.1] - 2026-05-30

### Fixed

- Added a `gjc skills` inspection command so installed binaries can list and read embedded workflow skills from any project without relying on source-tree `.gjc` files.
- Fixed first-run API provider onboarding so `models.yml` parent directories are created before writing, and malformed `/provicer` startup invocations now report the intended `/provider add` spelling instead of falling through to model bootstrap.

## [0.2.0] - 2026-05-28

### Added

- Added scoped GJC tmux profile handling for `gjc --tmux` and `gjc team` sessions without mutating global tmux configuration.
- Added GJC team integration hardening for worker turn-end integration requests, auto-rebase/auto-merge conflict surfacing, protected checkpoint classification, and leader/worker-visible integration summaries.
- Added Node 20 release baseline validation to the release/check surface.

### Changed

- Clarified the public workflow contract so `deep-interview` and `ralplan` are invoked through `/skill:<name>`, while `gjc ultragoal` and `gjc team` remain native runtime commands.
- Updated the README hero image and Discord community invite.

### Fixed

- Restored Ultragoal completion receipt export/generation validation and completion gates.
- Fixed workflow bridge guidance and tests so private compatibility bridge commands are not advertised as public skill-loading paths.

## [0.1.3] - 2026-05-28

### Changed

- Released the current dev branch fixes with refreshed 0.1.3 package metadata.

## [0.1.2] - 2026-05-28

### Changed

- Updated package metadata for the Gajae Code npm publication.

### Fixed

- Fixed slash-command autocomplete so skill command matches no longer hide built-in fuzzy candidates like `/model` while typing `/mode`.

## [0.1.1] - 2026-05-28

### Changed

- Restored `gjc team` multi-worker GJC-team parity orchestration with current-window worker panes, GJC-scoped state/API semantics, and `N:agent-type` launches.
- Ported GJC team worker-worktree integration parity so `status`/`resume` auto-checkpoint dirty workers, merge or cherry-pick worker commits, cross-rebase idle workers, and record conflicts under `.gjc` integration artifacts.

### Added

- Added a detached `subagent` control tool for task subagents, with list, inspect, await-with-timeout, and cancel actions.
- Added shared provider onboarding for OpenAI-compatible and Anthropic-compatible API providers through `gjc setup provider` and `/provider add`, with model-list configuration and redacted setup feedback.
- Added shared `/model` onboarding guidance and an interactive `/provider` onboarding chooser so first launch, slash commands, and TUI no-model states point at the same provider setup flows.
- Added a native in-TUI skill HUD rail backed by `.gjc/state/skill-active-state.json`, so active GJC workflow skills are visible without a separate tmux pane.
- Added bundled `executor`, `architect`, `planner`, and `critic` role agents for task delegation, including source-defined prompt files and role-agent discovery coverage.
- Added a native `gjc team` runtime that writes GJC-scoped state, mailboxes, task lifecycle files, and telemetry without delegating to an external team binary
- Added `openai-code` and `gemini` to the web search provider settings so users can configure OpenAI and Gemini web search directly from provider selection
- Added OpenAI (`openai-code`) and Gemini web search options with updated setup descriptions for `gjc /login openai-code` and Gemini OAuth login

### Changed

- Changed normal `task` subagent launches to return immediately as detached background work while keeping generic `job` controls available.
- Changed default interactive `gjc` startup to enter a `gajae_code` tmux session before launching the Gajae Code TUI, with non-interactive modes continuing to run directly.
- Changed `/skill:<name>` handling so canonical skill invocations can be chained in one prompt across interactive and ACP sessions, with autocomplete-only `/name` and `/skill-name` normalization back to the public canonical form.
- Changed interactive `gjc` startup to launch tmux only when `--tmux` is provided, with direct startup as the default.
- Changed GJC default definitions so workflow skills remain source-bundled while repo-visible `.gjc` default artifacts are no longer the source of truth; updated system and Ultragoal guidance to use role-agent delegation and ralplan-first planning when needed.
- Changed bare `gjc setup` to install the normal default workflow skills, while keeping hooks, provider, Python, and speech-to-text setup as explicit optional components.
- Changed `gjc team` startup to use tmux worker panes backed by dedicated detached git worktrees by default, while keeping `--worktree` as a backward-compatible launch override.
- Constrained the visible GJC utility surface to the retained workflow/runtime endpoints and four bundled task agents, with MCP, arbitrary skill, plugin, extension, marketplace, and custom discovery surfaces quarantined from default public use.
- Redesigned the interactive TUI chrome with a minimal opencode-style prompt composer, simple user/gajae transcript labels, a forge-style welcome surface, and compact cwd/pulse indicators tuned for terminal coding-agent ergonomics.
- Changed web search provider credential lookup to use the shared `AuthStorage` pipeline (`getApiKey`/`getOAuthAccess`) for API-key and OAuth auth instead of direct `AgentStorage` access
- Changed the `openai-code` web search provider display label from `OpenAI code` to `OpenAI`
- Updated `anthropic` and `openai`/`gemini` web search option descriptions to reflect their native `web_search`/OAuth requirements
- Changed `/model` selection to a canonical single default-model action, removing the redundant role assignment menu for smol/slow/vision/plan/designer/commit/task models.
- Changed public API-compatible provider setup to require `--api-key-env` and reject raw `--api-key` values.

### Removed

- Removed approved non-critical slash-command handlers for plan, share, browser, copy, todo, changelog, context, branch, fork, handoff, force, and quit while keeping /loop, provider setup/login/logout/model selection, and SSH intact.
- Removed redundant model-selector role assignment options for smol, slow, vision, plan, designer, commit, task, and custom roles so selection uses one canonical default model.
- Removed obvious non-critical plugin, marketplace, extension, and reload-plugin slash-command handlers from the built-in registry while preserving ambiguous slash-command utilities for a later approval pass.
- Removed the auto-QA grievance reporting feature, including the `report_tool_issue` tool, `gjc grievances` command, auto-QA settings/env flags, sharing consent prompt, bundled push endpoint, and persistent install ID correlation path.
- Removed standalone utility feature documentation for plugins, extensions, hooks, marketplace, arbitrary skills, custom tools, task-agent discovery, and TUI/config utility internals from the generated docs index.

### Fixed

- Fixed `gjc ultragoal create-goals` native goal activation so live sessions receive a pending reconciliation request even when the session file already contains an active goal.
- Made `gjc ultragoal` run natively, preserving active goal state across interrupted turns.
- Fixed interactive Escape/interrupt recovery so abort cleanup is bounded and forces the session back to idle when a provider stream, tool, or post-turn task ignores cooperative cancellation.
- Fixed root `gjc --worktree` / `gjc -w` startup so the launch command actually creates and enters the sibling `<repo>.gajae-code-worktrees/<branch-slug>` git worktree before starting the session, using collision-resistant branch slugs and avoiding worktree side effects for help/version launches.
- Fixed root `gjc --worktree <branch>` / `gjc -w <branch>` parsing so named branch worktrees create their own `<branch-slug>` directory instead of reusing the dirty detached worktree for the current branch.
- Wired GJC native UserPromptSubmit/Stop skill-state hooks, including `gjc setup hooks`, so public workflow keywords activate `.gjc/state`, active skill state can block premature Stop events, and active Ultragoal sessions remind steering prompts to use `gjc ultragoal steer`.
- Fixed `gjc ultragoal create-goals` to seed GJC goal mode runtime state automatically, avoiding a separate manual `/goal` setup step.
- Fixed legacy Pi plugin import remapping and stale GJC config-path tests so rebranded `.gjc` discovery contracts pass while preserving legacy compatibility.
- Fixed web search OAuth-backed providers (including OpenAI code and Gemini) to use broker-managed token retrieval and account metadata, avoiding direct token-store refresh behavior that could cause search authentication failures
- Updated Tavily missing-credential feedback to prompt users to configure an API-key provider setting instead of referencing `agent.db` directly
- Refreshed expired OpenAI code provider OAuth tokens during `web_search` execution and persisted the updated credentials so searches continue working after token expiry
- Wired `/login`, `/logout`, `/model`, and `/provider` TUI slash commands through interactive provider/model selectors and existing OAuth flows.
