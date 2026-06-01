# Changelog

## [Unreleased]

### Added

- Added a built-in `skill` tool so the agent can chain into another loaded skill on its next turn. Mirrors `/skill:<name>` typing and subagent `autoloadSkills` by dispatching the chained skill's SKILL.md as a user-attribution custom message; controlled by the new `skill.enabled` setting (default true).

### Fixed

- Made startup CHANGELOG display deterministic by embedding `packages/coding-agent/CHANGELOG.md` into the binary so post-update launches show the shipped history regardless of cwd or `GJC_PACKAGE_DIR`/`PI_PACKAGE_DIR` overrides.
- Registered `gjc update` as a public root subcommand so it invokes the bundled updater instead of routing into the interactive launcher.

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

### Fixed

- Fixed built-in `explore` agent failing every invocation with `schema_violation: files.0.ref: must not be present` on releases prior to 15.3.2 by renaming the `files[].ref` property to `files[].path` in the agent's output schema; `ref` is a JTD-reserved keyword (RFC 8927) and collides with JSON Type Definition's schema-reference form, so the converter previously dropped it from the generated JSON Schema. Defense-in-depth alongside the 15.3.2 converter fix ([#1379](https://github.com/can1357/gajae-code/issues/1379)).

## [15.3.2] - 2026-05-25
### Added

- Added inline `|TEXT` payload support to `»` and `«` hashline insert operations, allowing single-line inserts on the op line and still supporting additional payload lines
- Added support for using inline payloads with BOF/EOF inserts so `|TEXT` is treated as inserted content at file boundaries
- Added live nested-`task` rendering: while a subagent is mid-flight, the parent UI now surfaces both completed nested `task` sub-calls and the in-flight nested snapshot (forwarded from `tool_execution_update`), matching the finished-result tree
- Added `gjc auth-gateway check` (and matching `GET /v1/credentials/check` endpoint) — probes each broker-supplied credential against its provider's auth-verifying usage endpoint and prints per-credential health, so when a multi-account pool starts returning 401s you can identify which row in the broker is the bad one. The existing `/v1/usage` endpoint silently drops failed credentials, which is the wrong shape for diagnosing auth — the new endpoint captures errors and surfaces the credential's id, provider, type, email/accountId, and the upstream error string. CLI groups results per-provider, exits non-zero when any credential failed, and supports `--json` for scripting. The probe also exercises OAuth refresh on expired tokens, so a working refresh + working access reports as `ok` and a revoked refresh token reports as `oauth refresh failed: …` instead of being masked by the cached expired access token.

### Fixed

- Fixed parsing of inline `|TEXT` payloads containing whitespace on `»` and `«` inserts, which previously failed with unrecognized-op errors
- Fixed anchored insert handling so an inline `|TEXT` body matching the anchor line is treated as anchor decoration and no longer inserted as a duplicate

## [15.3.0] - 2026-05-25

### Added

- Added `GJC_NO_WEBP` environment variable to disable WebP encoding in image resize, fixing HTTP 400 errors when attaching browser snapshots to vision models running on local llama.cpp (which uses STB library that lacks WebP support)
- Fixed loop mode submitting the next prompt while a background async-job delivery turn (idle flush) was still pending, which could cause the job result to be silently dropped and make the session appear to keep firing while work was ongoing ([#1294](https://github.com/can1357/gajae-code/issues/1294))
- Fixed clipboard image paste (Ctrl+V) silently failing on WSL2 by routing image reads through a `powershell.exe` bridge when WSL interop is detected, since `arboard` returns `ContentNotAvailable` under WSLg ([#1280](https://github.com/can1357/gajae-code/issues/1280))
- Fixed `bash` tool timeout and ESC cancellation getting stuck when native shell cleanup stalls; the JavaScript-side deadline now returns the tool result on schedule while native cleanup continues in the background ([#1347](https://github.com/can1357/gajae-code/issues/1347))
- Fixed reviewer agent always failing JTD validation with `findings.0.priority: expected number, received string` whenever `report_finding` surfaced a finding; the tool's `"P0"`-`"P3"` priority is now coerced to its numeric ordinal before populating the auto-injected `findings[]` ([#1350](https://github.com/can1357/gajae-code/issues/1350))
- Fixed config-only marketplace LSP plugins such as `csharp-lsp` not registering servers with the CLI when the plugin cache has only marketplace metadata and no package code ([#1352](https://github.com/can1357/gajae-code/issues/1352)).
- Fixed JTD-to-JSON-Schema conversion treating user-named properties as nested JTD forms when their keys collided with JTD keywords like `ref`, which broke the built-in explore agent's output validator with `schema_violation: files.0.ref: must not be present` ([#1345](https://github.com/can1357/gajae-code/issues/1345))
- Fixed extension `ctx.ui.notify()` messages emitted during `session_start` being cleared before the first interactive render ([#1316](https://github.com/can1357/gajae-code/issues/1316)).
- Fixed append-only context mode not being recomputed after model switches — the mode was frozen at session construction time using the initial model's provider, so `provider.appendOnlyContext=auto` left append-only enabled after switching away from DeepSeek (or disabled after switching to DeepSeek) for the rest of the session

### Fixed
- Fixed clipboard image paste (Ctrl+V) silently failing on WSL2 by routing image reads through a `powershell.exe` bridge when WSL interop is detected, since `arboard` returns `ContentNotAvailable` under WSLg ([#1280](https://github.com/can1357/gajae-code/issues/1280))
## [15.2.4] - 2026-05-22
### Breaking Changes

- Replaced the legacy `@@` header and `+`/`<`/`=`/`-` hashline syntax with the new `§PATH` header and `«`/`»`/`≔` operation format, so existing hashline scripts and prompts using old symbols must be updated

### Added

- Added one-anchor `≔ANCHOR` shorthand equivalent to `≔ANCHOR..ANCHOR` for single-line replace/delete

### Changed

- Changed `≔A..B` so an omitted payload now deletes the range, and added an explicit empty payload line to keep a literal blank replacement line

### Removed

- Removed the `hsep` prompt helper and `PI_HL_SEP` payload-prefix configuration because hashline payloads are no longer line-prefixed

### Fixed

- Fixed hashline payload handling in parser and streaming preview to preserve blank lines as actual payload text until the next op, file header, or envelope marker

## [15.2.3] - 2026-05-22
### Breaking Changes

- Changed PR and task-isolation worktree directory layout to hash-based `~/.gjc/wt/<identifier>-<path-hash>` style paths, replacing the previous nested encoded-repo layout

### Added

- Added `gjc worktree` command (alias `wt`) to list and manage agent-managed worktrees under `~/.gjc/wt`
- Added `gjc worktree clear` to remove orphaned worktree directories, with `--all` to include live PR-checkouts, `--dry-run` for preview, and `--json` reporting
- Added machine-readable JSON output to `gjc worktree list` for scripted inspection
- Added `display.shimmer` appearance setting with `classic`, `kitt` (Knight Rider K.I.T.T. scanner), and `disabled` modes

### Changed

- Changed the welcome intro animation to a 3-second eased gradient sweep with a diagonal shine highlight across the logo
- Changed background job completion follow-ups to batch multiple finished jobs into a single `async-result` message, showing each completed job and its result in one place
- Changed MCP notification follow-ups to combine multiple resource updates into a single consolidated message and suppress duplicate server/uri entries
- Updated PR checkout to reuse `hashPath`-based worktree roots when creating and scanning worktrees for cleanup
- Updated `worktree` cleanup logic to gracefully prune parent git metadata after removing worktree directories
- Reworked working-message shimmer animation for 60fps rendering: ANSI sequences are coalesced per same-tier run instead of emitted per code point, palettes compile once and cache per active theme, and the band position is now fractional so motion is smooth at any frame rate
- Switched MCP health-check and "Connecting to…" spinners from hard-coded ASCII (`|/-\`) to `theme.spinnerFrames` so they pick up the active symbol preset (braille on unicode/nerd, ASCII when explicitly themed)

### Fixed

- Fixed PR checkout failures when the default worktree path was already registered or occupied by stale leftovers by automatically selecting suffixed alternatives (`-2`, `-3`, etc.)
- Fixed Memory tab in the settings UI not revealing or hiding the Hindsight-only rows (`Hindsight API URL`, `Hindsight Bank ID`, `Hindsight Scoping`, etc.) when `Memory Backend` was switched via the inline submenu. The selector now rebuilds its item list after every change so condition-gated rows appear/disappear immediately instead of requiring a tab switch

## [15.2.2] - 2026-05-22

### Fixed

- Fixed `RULES.md` not being injected. The documented sticky-rules file at `~/.gjc/agent/RULES.md` and `<repo>/.gjc/RULES.md` was never read by any discovery provider; only `.gjc/rules/*.md` was scanned. The native provider now loads both as always-apply rules so they re-attach every turn as documented ([#1266](https://github.com/can1357/gajae-code/issues/1266)).

## [15.2.1] - 2026-05-21

### Fixed

- Fixed compaction routing to the wrong provider when `modelRoles.default` is set to a different model than the active chat. Auto- and manual compaction now prefer the active session's model and only fall back to role-based candidates when the current model has no usable credentials. Previously, an Anthropic chat with `modelRoles.default = openai/gpt-5` would compact through OpenAI (including the remote-compaction endpoint), even though the live conversation never used OpenAI.

### Fixed

- Fixed context overflow not being detected when the session's model (e.g. `hf:zai-org/GLM-5.1` via `synthetic` provider) returns a 400 with the upstream "400 status code (no body)" message wrapped inside a JSON envelope. The `isContextOverflow` check now matches the no-body status phrase anywhere in the error string rather than requiring it at the very start, so auto-compaction fires correctly instead of leaving the session silently stuck ([#1251](https://github.com/can1357/gajae-code/issues/1251)).
- Fixed `formatCapturedHttpError` not extracting the error text from `{"error":"string"}` response bodies (only object-valued `error` fields were previously handled), resulting in raw JSON in error messages instead of the human-readable string.

## [15.2.0] - 2026-05-21

### Changed

- Changed the interactive working loader and slash-command progress bars to use the active theme's accent shimmer instead of static muted text.

### Fixed

- Fixed false-positive hashline `~ TEXT` separator-padding warning firing on YAML, JSON, Python, Markdown, TOML, and other indent-sensitive file edits. The padding check is now skipped entirely for indentation-sensitive extensions (`.py`, `.yml`/`.yaml`, `.md`/`.mdx`, `.json`/`.jsonc`/`.json5`, `.toml`, `.rst`, `.tf`, `.nix`, `.coffee`, `.haml`/`.slim`/`.pug`, `.sass`/`.styl`, `.nim`, `.cr`, `.elm`, `.fs`, …), and tightened on every other extension to flag only the `~ beta` typo shape (exactly one leading space before non-space content) rather than any leading-space payload.

### Fixed

- Fixed goal state machine: `get` now returns paused goals (was returning null for `enabled=false`), `complete` now works on paused goals after interrupts, `create` is allowed after a previous goal reaches `complete` status, and the goal tool is re-added to the active tool set on session reload when a paused goal is persisted. Added `resume` and `drop` ops to the goal tool so the agent can re-engage or discard a paused goal without requiring user slash commands. ([#1249](https://github.com/can1357/gajae-code/issues/1249))

## [15.1.9] - 2026-05-21

### Fixed

- Fixed `disabledProviders` still probing local discovery endpoints for Ollama, llama.cpp, and LM Studio during background model refresh. Disabled providers are now excluded before implicit and built-in discovery managers are created. ([#1232](https://github.com/can1357/gajae-code/issues/1232))

### Fixed

- Fixed `gjc acp` auto-discovering host `.mcp.json` servers in parallel with the ACP client's `session/new.mcpServers`, which shadowed client-supplied MCP tools in `search_tool_bm25` and the session tool registry. The ACP session factory now forces `enableMCP: false`, so MCP ownership stays with `AcpAgent#configureMcpServers`. Non-ACP modes keep on-disk discovery. ([#1234](https://github.com/can1357/gajae-code/issues/1234))

### Fixed

- Fixed binary `gjc update` rollbacks so a downloaded replacement that fails post-install version verification no longer remains installed over the previous working binary. ([#1240](https://github.com/can1357/gajae-code/issues/1240))

### Fixed

- Fixed `/force <tool>` rejecting Ollama/local models before the requested tool could run; Ollama now receives a named forced choice that the provider transport narrows to the selected tool. ([#1236](https://github.com/can1357/gajae-code/issues/1236))

### Fixed

- Fixed `web_search` freezing the session when an upstream provider stalled. Bun's WinHTTP backend on Windows can silently drop `AbortSignal` once a TCP/TLS connection hangs (oven-sh/bun#15275, oven-sh/bun#18536), so Esc never reached the in-flight fetch and the only recovery was Ctrl+C + `gjc --resume`. Every web-search provider's outbound `fetch` (anthropic, brave, openai-code, exa, gemini, jina, kagi, kimi, parallel, perplexity, searxng, synthetic, tavily, z.ai) now composes the caller signal with a 60s hard timeout via a shared `withHardTimeout` helper, guaranteeing the request settles within a minute even when Bun's abort fails to propagate. Independently, `executeSearch`'s provider-fallback loop was masking real cancellations as ordinary provider errors and returning "All web search providers failed"; it now re-throws as `ToolAbortError` the moment the caller's signal aborts, so the session sees a clean cancel on every platform. ([#1221](https://github.com/can1357/gajae-code/issues/1221))

### Added

- Added OSC 8 terminal hyperlink support for file paths in tool output. When the terminal supports hyperlinks (kitty, Ghostty, WezTerm, iTerm2, Alacritty, VS Code) and the new `tui.hyperlinks` setting is `auto` (default) or `always`, GJC wraps file paths emitted by `read`, `find`, `search`, `edit`, `ast_grep`, and `ast_edit` renderers in `file:///abs/path` hyperlinks. `local://` and other fs-backed internal URLs resolve to their backing path. Set `tui.hyperlinks: off` to disable. ([#1244](https://github.com/can1357/gajae-code/issues/1244))

## [15.1.8] - 2026-05-20

### Fixed

- Fixed streaming edit previews for `apply_patch` and `hashline` jittering as the model typed `+added` lines. Two root causes addressed: (1) the trailing partial line of the streaming text input is now trimmed at each tick so a half-typed `+added` line no longer flickers; (2) the preview is rendered in the model's input order during streaming instead of re-deriving a unified diff via `Diff.structuredPatch`, whose coalescing previously reshuffled existing `+added` lines downward each time a new `-removed` line arrived. Existing additions now stay put and the preview only grows at the bottom while streaming. A residual trailing `-removed`/hunk-header block whose matching `+added` companion has not yet arrived is also suppressed until the additions land.
- Fixed Perplexity web search appearing "logged out" roughly an hour after `gjc auth login perplexity`. The search provider's `findOAuthToken` was honoring the bogus `expires = login_time + 1h` written by older logins (Perplexity JWTs typically omit `exp` because sessions are server-side) and silently dropping the credential. The loader now decodes the JWT's `exp` claim directly and only skips when the JWT itself is expired; tokens without an `exp` claim are treated as non-expiring.

### Fixed

- Fixed `legacy-pi-compat` failing to load plugin extensions (e.g. `pi-schedule-prompt@0.3.0`) that import `@mariozechner/pi-ai` when running from a compiled binary. `getResolvedSpecifier` called `Bun.resolveSync` against `import.meta.dir` inside `/$bunfs/root`, where the virtual FS exposes no resolvable `node_modules` tree at runtime; the throw silently dropped the plugin. The fix lets `rewriteLegacyPiImports` fall back gracefully on resolution failure so that `rewriteBareImportsForLegacyExtension` — which already runs immediately after — can resolve the original specifier against the plugin's own installed peer deps instead. The same fallback is applied to `resolveLegacyPiSpecifier` (the Bun plugin shim's `onResolve` handler) for tool/hook files loaded directly via Bun's import system. ([#1215](https://github.com/can1357/gajae-code/issues/1215))

## [15.1.7] - 2026-05-19

### Fixed

- Fixed `debug` launch/attach failures so `configurationDone` no longer masks the underlying DAP launch error, early stop-outcome watchers cannot emit unhandled rejections, and directory-valued launch programs are rejected before adapter selection. ([#1187](https://github.com/can1357/gajae-code/issues/1187))
- Fixed hashline edit payloads that use a readability space after `~` by warning on separator-padding-shaped payload blocks and tightening the model prompt. ([#1166](https://github.com/can1357/gajae-code/issues/1166))
- Fixed ACP bash permission requests to include execute tool metadata and command content so clients can render command approval prompts consistently. ([#1189](https://github.com/can1357/gajae-code/issues/1189))
- Fixed the status-line fast-mode indicator (`⚡`) rendering for scoped service tiers (`openai-only`, `anthropic-model-only`) even when the active model's provider didn't realize them — e.g. `serviceTier: "openai-only"` would still show the indicator next to a Anthropic model model the wire request couldn't apply fast mode to. The indicator now consults a new `AgentSession.isFastModeActive()` predicate that runs the configured tier through `resolveServiceTier(tier, model.provider)` and only lights up when the result is `"priority"` for the current model. `isFastModeEnabled()` keeps its scope-aware semantics so `/fast on|off|toggle` and `/fast status` continue to reflect the user's configured intent.
### Fixed

- Fixed status-line context% computation freezing the UI for ~1.1 s every 2 s on long sessions (2,000+ messages). The earlier alignment fix (which uses `computeContextBreakdown` to match the `/context` slash command) was running on every agent event via `updateEditorTopBorder()` (event-controller.ts:163), and `computeContextBreakdown` walks every message through the native `countTokens` tokenizer (~0.5 ms each) — for the user's 2,312-message session this was ~1,120 ms synchronous blocking per cache miss, producing the user-visible "jittery rendering" and "status bar disappearing during streaming". `StatusLineComponent.getCachedContextBreakdown()` now uses an incremental per-message token cache: messages are walked ONCE during warm-up, and subsequent refreshes only compute tokens for the NEW messages appended since last call (typically 0–1 per refresh during streaming). The LAST message is always recomputed because its content may still be growing mid-stream; all prior messages are immutable once a newer message exists. Compaction (messages array shrinks) resets the cache. Non-message tokens (system prompt + tools + skills) are cached separately and invalidated via a cheap identity fingerprint. Result: 2,300-message warm refresh drops from ~1,120 ms to ~0.04 ms — 28,000× faster. Functional parity with the prior `computeContextBreakdown` path is preserved.

### Added

- Added scoped service tier values to the `serviceTier` setting: `priority (OpenAI only)` and `priority (Anthropic model only)`. They let you opt into premium processing on one provider family without paying premium costs on the other when switching models mid-session. `/fast on` continues to set the unscoped `"priority"` (active everywhere supported); `/fast status` and `isFastModeEnabled()` now report `on` for any scoped value too.

### Changed

- Changed `/fast` to be a single provider-agnostic toggle: enabling the command sets `serviceTier: "priority"` for every provider, and the anthropic-messages provider translates `priority` into `speed: "fast"` plus the `fast-mode-2026-02-01` beta. Anthropic fast mode is currently supported on Anthropic model Opus 4.6 and 4.7; the server rejects other models, which triggers the provider's auto-fallback (request retried without the priority signal, `providerSessionState.fastModeDisabled` persisted for the rest of the session). The session listens for the `"priority"` marker in `AssistantMessage.disabledFeatures`, syncs `/fast` off, and emits a warning notice. Re-running `/fast on` clears the per-session disable so the next request actually re-tries priority.

## [15.1.6] - 2026-05-19

### Fixed

- Fixed plan-mode `resolve` looping when grammar-constrained models (e.g. Qwen3.6-35B-MTP via llama.cpp) emit `extra: { title: {} }` instead of a string — the open `Record<string, unknown>` schema for `extra` lets such models drop in an empty object, and the apply guard then hard-threw on every retry. Plan approval now derives the title from `extra.title` when usable, falling back to the plan's first `# Heading`, then the plan filename stem (`local://PLAN.md` → `PLAN`), then the literal `"plan"`. Prompt language relaxed from "MUST" to "SHOULD" for `extra.title`. ([#1179](https://github.com/can1357/gajae-code/issues/1179))

## [15.1.5] - 2026-05-19

### Fixed

- Fixed `ast_grep` and `ast_edit` tool details retaining every per-file parse error — a scan over hundreds of files with syntax-error nodes inflated `details.parseErrors` to one entry per file, leaking into traces and the renderer's "X more" overflow. Errors are now capped at `PARSE_ERRORS_LIMIT` (20) at the source, with the original total preserved in a new `parseErrorsTotal` field for accurate count labels.

## [15.1.4] - 2026-05-19

### Fixed

- Fixed `normalizePlanTitle` rejecting plan titles that contain spaces or common punctuation (e.g. "My Feature Plan") — spaces are now converted to hyphens and other invalid characters are dropped, so models that produce natural-language plan titles no longer loop forever trying to call `resolve`. ([#1176](https://github.com/can1357/gajae-code/issues/1176))
- Fixed `ask` tool prompt example showing the legacy `question`/`options` top-level format instead of the current `questions: [{id, question, options}]` array format; models that closely followed the example generated calls that always failed schema validation. ([#1176](https://github.com/can1357/gajae-code/issues/1176))

- Fixed ACP command and custom tool-call notifications to carry the original tool arguments in replayed and final updates, so command text is preserved and raw input is no longer wrapped
- Fixed ACP async-job draining to be scoped by session owner so `getAsyncJobSnapshot` and `drainAsyncJobDeliveriesForAcp` no longer consume or expose jobs from other sessions
- Fixed async job status reporting to include in-flight completions so queued/delivering indicators remain accurate while callbacks are still running
- Fixed `deferAgentInitiatedTurns` handling during ACP async-job draining so background completion follow-up turns are delivered even when agent-initiated turns are deferred
- Fixed ACP ordinary file-editing calls (`edit`, `write`, `ast_edit`) incorrectly requesting `session/request_permission` before every call, while keeping permission prompts for edit operations that delete or move files; permission requests now report the gated tool call as `pending` so clients can render the approval UI instead of returning `Permission request cancelled` without a visible prompt. ([#1134](https://github.com/can1357/gajae-code/pull/1134) by [@jiwangyihao](https://github.com/jiwangyihao))
- Fixed the session tree selector to preserve a readable message column when deeply nested branch gutters would otherwise consume the viewport. ([#1144](https://github.com/can1357/gajae-code/issues/1144))
- Fixed the TUI model selector to keep provider tab labels separate from provider ids, so the human-readable Ollama Cloud tab refreshes and filters `ollama-cloud` models correctly. ([#1153](https://github.com/can1357/gajae-code/issues/1153))

## [15.1.3] - 2026-05-17
### Breaking Changes

- Renamed the embedded-documentation internal URL scheme from `pi://` to `gjc://`. `GjcProtocolHandler` replaces `PiProtocolHandler`; update any external references accordingly.
- Removed the `StringEnum` re-export from `@gajae-code/coding-agent`. Custom tools and extensions should use `z.enum([...])` directly via the injected `pi.zod`.
- Replaced the `eval` tool's LARK-grammar `input` string with a structured `cells` array. Each cell is `{ language: "py" | "js", code, title?, timeout?, reset? }`. Removed the implicit/sniffed language path, the `*** Cell` / `*** End` / `*** Abort` markers, and the per-cell `t:<duration>` unit suffixes — `timeout` is now seconds (1-600).

### Added

- Added `providers.<name>.transport: "pi-native"` to `models.yml`. When set, every model under that provider routes its streaming dispatch through the auth-gateway's `POST /v1/pi/stream` endpoint instead of the per-provider SDK. The provider's `baseUrl` must point at a compatible `gjc auth-gateway` and `apiKey` must carry the gateway bearer. The slot's `models.json` still resolves locally for pricing/capabilities/thinking config; only the wire dispatch is redirected. Use case: containerized gjc installs (robogjc slots, swarm extension) where the slot must stay credential-free and a sidecar gateway holds the real provider tokens. Also surfaced as `transport` on `ProviderConfigInput` for extension-registered providers.
- Added optional backend push for the auto-QA grievance database (`dev.autoqaPush.enabled`, `dev.autoqaPush.endpoint`, `dev.autoqaPush.token`; env overrides `PI_AUTO_QA_PUSH`, `PI_AUTO_QA_PUSH_URL`, `PI_AUTO_QA_PUSH_TOKEN`). When enabled, every `report_tool_issue` call schedules a background flush that `POST`s pending rows to the configured endpoint and deletes them on HTTP 2xx. Each push carries a stable per-install UUID (`installId`) generated on first use and persisted at `~/.gjc/install-id` via `getInstallId()` (new export from `@gajae-code/utils`), so the receiver can dedup retries across host renames and `autoqa.db` wipes. Single-flight, 5s request timeout, 30s in-memory cooldown after failure, and a row-id watermark so rows inserted during an in-flight push survive and ship next time. Tool execution remains non-blocking and never throws.
- `ModelRegistry` now promotes `models.yml` `providers.<name>.apiKey` entries to `AuthStorage`'s new config-override tier (above OAuth, below `--api-key`). Pinning a bearer in `models.yml` was previously a no-op when the broker had an OAuth credential for the same provider — the OAuth access token won and got sent unmodified to whatever `baseUrl` you redirected to, which an auth-gateway in front of that endpoint rightly rejected with 401. The override is now honored, and is cleared/repopulated atomically on `models.yml` reload (`#reloadStaticModels` calls `clearConfigApiKeys` before re-parsing). Use case: route `anthropic` / `openai-code` to `http://llm-gateway.internal:4000` with the gateway's own bearer.
- Added `gjc auth-broker` subcommand for running and consuming a hosted credential vault.
- `serve [--bind=host:port]` — boots a local broker against the SQLite store at `$AGENT_DB_PATH`.
- `token [--regenerate]` — prints (and rotates) the bearer token stored at `~/.gjc/auth-broker.token`.
- `login <provider> [--via=user@host] [--dry-run]` — drives the OAuth flow locally or via SSH `-L` tunnel into a remote broker (callback ports pinned per provider).
- `logout <provider>` — disables every credential for the given provider in the local SQLite store.
- `import <file|dir> [--provider=<id>] [--include-disabled] [--dry-run]` — imports CLIProxyAPI-style JSON credential dumps (`~/.cliproxy/auth/*.json`). When `GJC_AUTH_BROKER_URL` is configured, credentials are uploaded to the remote broker via `POST /v1/credential`; otherwise they go into the local SQLite store. JSON `type` is mapped to gjc providers (`anthropic-model` → `anthropic`, `openai-code` → `openai-code`, `gemini[-cli]` → `google-gemini-cli`, `antigravity` → `google-antigravity`); `--provider` overrides the mapping for unrecognized types.
- `status` — pings the configured remote broker (`GJC_AUTH_BROKER_URL`).
- Added remote credential vault support to `discoverAuthStorage`. Configure via env (`GJC_AUTH_BROKER_URL` / `GJC_AUTH_BROKER_TOKEN`) or by setting `auth.broker.url` and `auth.broker.token` in `~/.gjc/agent/config.yml` (hidden from the settings UI; supports `!command` resolution). Falls back to `~/.gjc/auth-broker.token` when no token is provided inline. Otherwise behavior is unchanged.
- Added `gjc auth-broker migrate --from-local [--include-env] [--include-oauth] [--dry-run]` — uploads local SQLite credentials (and optionally env-var API keys) to the configured broker. Skips anything already on the broker via identity-key matching. OAuth is skipped by default (handled via `cliproxy` import). Idempotent on re-runs.
- Added `gjc auth-gateway` subcommand for running a forward-proxy that hides access tokens from less-trusted clients:
- `serve [--bind=…]` — boots the gateway against the configured broker. Listens on `127.0.0.1:4000` by default.
- `token [--regenerate]` — manages the gateway bearer token at `~/.gjc/auth-gateway.token` (separate from the broker bearer).
- `status` — verifies gateway config and authenticated broker readiness.
- One wire surface: `POST /v1/chat/completions` (OpenAI chat-completions), `POST /v1/messages` (Anthropic messages), `POST /v1/responses` (OpenAI Responses), `GET /v1/usage` (aggregated, 5-min per-credential cache), `GET /v1/models` (catalog). Model id in the request body selects which gjc provider/model services it; the gateway translates wire format ↔ gjc canonical `Context` and dispatches through `pi-ai` `streamSimple()`. Container deployments (robogjc, etc.) get inference auth without ever holding access tokens or the broker bearer.

### Changed

- Changed TTSR `interruptMode` semantics so a non-interrupting decision on a tool-source match now folds the rule reminder into that specific tool's `toolResult` content instead of queuing a loop-wide deferred follow-up turn. Text/thinking matches keep the previous deferred-injection behavior.

### Fixed

- Fixed streaming API requests to recover from provider auth errors by invalidating stale credentials and retrying with a fresh key
- Fixed `auth-broker` migration, `auth-gateway` startup, and `discoverAuthStorage` to fail fast with a clear error when the broker snapshot endpoint returns a non-200 response
- Fixed `gjc auth-broker migrate` to skip local placeholder `<authenticated>` API credentials (not real keys) when exporting to a remote broker
- Fixed `auth-gateway` token initialization to avoid clobbering an existing token when multiple processes initialize it concurrently
- Fixed `gjc auth-gateway` request handling to reject unsupported OpenAI/Anthropic protocol controls with 400 instead of accepting and ignoring them, propagate upstream error/abort terminal states as failures, preserve Responses reasoning and completed text items, accept string/system Responses messages, and keep Anthropic tool-result ordering valid.
- Fixed gateway usage reporting to include cached-token totals for OpenAI Chat/Responses and to serve the last good cached report during transient upstream usage fetch failures.
- Fixed auth-gateway request cancellation for requests that are already aborted before dispatch.
- Fixed `/login` and `/logout` provider selector overflowing tall provider lists off-screen on small terminals. The selector now scrolls a 10-item window centered on the highlighted entry, shows a `(n/total)` indicator when windowed, and accepts PageUp/PageDown for faster navigation.

### Fixed

- Fixed `.env` loading so malformed variable names and NUL-containing values are ignored before they can poison `Bun.env` and break bash/external process execution with `nul byte found in provided data`.

## [15.1.2] - 2026-05-15
### Fixed

- Fixed SSH host additions/removals made inside a running session not refreshing the live `ssh` tool. `/ssh add` and `/ssh remove` now update the model-visible host list immediately, while `/reload-plugins` and `/move` refresh SSH discovery for external or project-scope config changes without restart.
- Fixed loose object output schemas in `YieldTool` so non-strict schemas (for example `additionalProperties: true`) are preserved and accepted instead of being forced into strict mode
- Fixed unconstrained output schema modes (`outputSchema: true` or absent/non-strict schemas) to run in loose mode for successful results
- Fixed bash tool calls with `pty: true` hanging indefinitely on Windows by falling back to the non-PTY executor instead of entering the ConPTY-backed interactive path. ([#1103](https://github.com/can1357/gajae-code/issues/1103))

### Changed

- Updated MCP and theme schema metadata to reference JSON Schema draft-2020-12

## [15.1.0] - 2026-05-15
### Breaking Changes

- Changed the extension and hook runtime API by moving schema typing from direct TypeBox imports to `TSchema` from `@gajae-code/ai`, requiring callers who use TypeScript imports of `Type` to migrate via provided injected modules

### Added

- Added a cancellable handoff progress indicator in `/handoff` that displays while handoff generation runs and can be aborted with `Esc`
- Added `apiKey` as a supported provider override field in model config, allowing API-key-only overrides to provide fallback credentials for built-in models
- Added `supportsMultipleSystemMessages`, `allowsSyntheticReasoningContentForToolCalls`, `disableReasoningOnToolChoice`, and `levels` model-thinking compatibility fields to model configuration schemas
- Added `zod` to the Extension, Custom Tool, Hook, and Custom Command APIs as `pi.zod` so extension and plugin authors can define tool schemas with Zod without separate imports
- Added `pi.zod` as a canonical schema API for examples and extension plugins while keeping `typebox` available as legacy compatibility
- Added a `telemetry` option to `createAgentSession` for passing OpenTelemetry configuration through to the underlying Agent

### Changed

- Changed handoff generation to run as a one-shot handoff request and switch to the new session only after it completes, avoiding an extra assistant handoff turn in chat history
- Changed `pi.typebox.Type.Composite` to merge all object schemas in the provided list, enabling more than two object inputs
- Changed `pi.typebox.Type.Record` to validate record keys against the provided key schema instead of forcing string keys
- Changed `pi.typebox.Type.Array` with `uniqueItems: true` to reject duplicate items while preserving the constraint in wire schemas
- Changed `pi.typebox.Type.Object` with `additionalProperties: false` to reject unknown properties during parsing
- Changed `pi.typebox.Type.Enum` in the compatibility shim to preserve numeric TypeScript enum values
- Changed tool parameter schemas across the agent to use the shared Pi schema pipeline (`TSchema` plus Zod/JSON Schema validation) instead of direct AJV/TypeBox compilation for stricter schema validation compatibility
- Changed GitHub tool input schema shape to expose operation fields in a flat schema form without legacy `run_watch`-style nesting
- Changed Python session pooling to remove the previous 4-session retention cap and 5-minute idle-session eviction, so kernels now stay alive for a session until explicitly disposed via `disposeKernelSessionsByOwner` or `disposeAllKernelSessions`
- Changed kernel cleanup behavior to avoid automatic eviction by idle timeout and capacity pressure, so additional Python sessions are not queued behind retained-session shutdown retries
- Replaced the bundled `@sinclair/typebox` runtime dependency with an in-repo Zod-backed shim exposed through `pi.typebox.Type.*`. Common builders (`Object`, `String`, `Number`, `Integer`, `Boolean`, `Array`, `Tuple`, `Union`, `Intersect`, `Literal`, `Enum`, `Optional`, `Nullable`, `Record`, `Partial`, `Required`, `Pick`, `Omit`, `Composite`, …) keep their existing call signatures but now return Zod schemas that flow through the same validation/wire pipeline as `pi.zod`. Bare `@sinclair/typebox` imports inside extensions are transparently remapped to the same shim by the runtime plugin shim, so plugins that authored against `import { Type } from "@sinclair/typebox"` keep working unchanged. Plugins that relied on TypeBox-only submodule APIs (`@sinclair/typebox/compiler`, `@sinclair/typebox/value`, `TypeRegistry`, the `Symbol(TypeBox.Kind)` marker) must vendor `@sinclair/typebox` in their own package — only the root import is remapped.

### Deprecated

- Deprecated direct TypeBox-only examples for plugin schemas by updating example documentation to prefer `pi.zod`

### Fixed

- Fixed auto-triggered handoff flow to perform only a single handoff-generation model call instead of an extra prompt cycle
- Fixed handoff cancellation behavior so a pre-cancelled signal returns `Handoff cancelled` without starting generation and aborting handoff now propagates through the handoff request signal
- Fixed `create_conventional_analysis` parsing to ignore harmless extra fields and still parse the required conventional fields
- Fixed BashTool async request validation flow so async execution remains disabled and returns the explicit `Async bash execution is disabled` error
- Fixed `task.simple` invalid `schema` and `context` argument handling to still reject unsupported fields after tool-argument validation
- Fixed subagent execution hangs by enforcing `task.maxRuntimeMs` as a wall-clock limit even when inference streaming stalls, so stuck subagents now abort and report runtime-limit exceeded
- Fixed tool schema compatibility validation by routing TypeBox schemas through shared conversion and Zod-based validation to avoid strict-schema provider mismatches
- Fixed Python execution cancellation and timeouts by escalating to kernel shutdown if `SIGINT` did not terminate a running cell within 2 seconds, preventing indefinite hangs in queued or stuck sessions
- Fixed cleanup blocking during long-running executions by forcing a kernel shutdown path when interrupt-based cancellation is ignored
- Fixed bash output emitting a spurious `[… 0 lines elided (NB) …]` marker (and reordering the artifact link before the command output) when the shell minimizer rewrote a small command's output. After `OutputSink.replace()` swapped the minimized text into the buffer, the subsequent `sink.push("[raw output: artifact://N]\n")` chunk was funneled back into the (now empty) head-retention window while the pre-replace `#totalBytes` still tracked the original raw stream — so `dump()` composed `<head=artifact-link> + <middle-elision marker against stale totals> + <tail=minimized text>` instead of `<minimized text> + <artifact link>`. `replace()` now realigns `#totalBytes`/`#totalLines`/`#sawData`/`#truncated` to the authoritative buffer and disables head retention for the lifetime of the sink, so further pushes append to the tail buffer in order. The bash executor also drops the leading `\n` on the artifact-link push when the minimized text already ends with one so the separator stays single-newline.
- Fixed legacy plugin extensions failing to load on Windows when they import a bare-specifier dependency from their own `node_modules` (e.g. `import YAML from "yaml"` in `supipowers`). The legacy-pi mirror resolved the dependency to its absolute path and then ran the path through `isUrlLikeSpecifier`, whose `^[A-Za-z][A-Za-z\d+.-]*:` regex matched the Windows drive letter (`C:`) and short-circuited the `pathToFileURL` conversion. The raw path was emitted into the mirrored TS source as `import x from "C:\\Users\\...\\dep\\dist\\index.js"`, where `\n`, `\U`, `\y` and other backslash sequences were eaten by the TS string-literal parser, producing nonsense package specifiers like `C:Usersjames.ompagentextensionssupipowers\node_modulesyamldistindex.js` that Bun's resolver rejected with `Cannot find package …`. `isUrlLikeSpecifier` now rejects `^[A-Za-z]:[\\/]` first, so Windows absolute paths flow through `pathToFileURL` like every other absolute path and reach the mirror as proper `file:///C:/...` URLs.
- Fixed Python session queued executions silently resurrecting kernels after `disposeAllKernelSessions` or `disposeKernelSessionsByOwner` removed the session: queued work now checks the session is still registered before replacing or executing on a kernel and rejects with cancellation otherwise
- Fixed Python session disposal treating an unconfirmed `PythonKernel.shutdown()` result as success: sessions whose kernel shutdown returns `{ confirmed: false }` (or rejects) are now retained in the registry and a `warn` is logged so a later dispose can retry instead of orphaning the subprocess
- Fixed `task.maxRuntimeMs` losing wall-clock aborts that fired during pre-prompt session setup by re-checking the abort signal immediately before issuing the model prompt, so a stalled subagent now exits with the runtime-limit reason instead of hanging through setup races
- Fixed late `yield` events landing after a wall-clock timeout from flipping a timed-out subagent to a successful exit, so the reported `aborted` flag and exit code now always reflect the runtime-limit breach while yield payloads remain in `extractedToolData`
- Fixed async-task progress consumer to copy `contextTokens` and `contextWindow` from the completed `SingleResult` onto `AgentProgress`, so UI gauges keep showing per-turn context after a backgrounded task finishes
- Fixed the status-line `path` segment ignoring `stripWorkPrefix: false` when selecting the folder icon for scratch directories. The icon selection now respects the same gate as the scratch path stripping, so disabling `stripWorkPrefix` keeps the regular `folder` icon even when the project directory is inside a scratch root.
- Fixed `YieldTool` constructor to fall back to the loose record schema when the session `outputSchema` contains unresolved `$ref` strings (e.g. external or cyclic references that survive dereferencing), instead of installing a validator that would reject every payload with an unresolved-reference error
- Fixed `pi.typebox.Type.String` dropping `minLength`/`maxLength`/`pattern` constraints when a `format` (e.g. `email`, `url`, `uuid`) was also supplied; length and pattern checks are now applied to the format-specific schema instead of being gated on an `instanceof z.ZodString` check that never matched the format subclasses.
- Fixed `pi.typebox.Type.Object` stripping unknown properties when constructed without explicit `additionalProperties`. TypeBox preserves extras by default, so the shim now installs `.loose()` for the omitted/`true` cases while keeping `.strict()` for `additionalProperties: false` and `.catchall(schema)` for a schema value.

## [15.0.2] - 2026-05-15

### Added

- Added the `set_host_uri_schemes` RPC command so hosts can register and replace writable/read-only internal URI schemes with scheme metadata (`writable`, `immutable`) at runtime
- Enabled the `write` tool to dispatch `write(url, content)` to registered internal URL handlers, allowing edits to non-filesystem resources via host-managed URI schemes
- Added host-owned internal URI read/write over RPC, including abort support, so URI operations are resolved by the host transport for `read` and `write` requests
- Added handling of host URI request results in RPC mode so host services can stream completion frames for internal URI operations
- Added scratch-directory awareness to the status-line `path` segment. When the project directory is inside an OS-level scratch root (the platform `os.tmpdir()`, `/tmp` and `/var/tmp` plus their macOS `/private/...` aliases, `~/tmp`, or — on Windows — `%TEMP%` / `%TMP%` / `%SystemRoot%\Temp`), the segment now (1) renders the new `icon.scratchFolder` symbol instead of `icon.folder`, and (2) strips the scratch root from the displayed path so only the trailing folder (and any subpath beneath it) is shown — mirroring how `/work` and `~/Projects` are already abbreviated. Both behaviors honor the existing `stripWorkPrefix` option. Icon defaults: 🗑 (emoji), `` (nf-fa-trash) for Nerd Font, `[T]` for ASCII, `◌` in the poimandres themes; themes can override `icon.scratchFolder` independently of `icon.folder`.

### Changed

- Changed the `github` tool's search ops (`search_issues`, `search_prs`, `search_code`, `search_commits`) to default the `repo` scope to the current checkout's `owner/repo` when `repo` is omitted. The auto-scope is skipped when the query already carries an explicit `repo:`/`org:`/`user:`/`owner:` qualifier or when `gh repo view` cannot resolve a github remote (in which case the search proceeds across all of GitHub as before). `search_repos` is unchanged — repository-scoping there must live in the query.

- Changed bash command preprocessing to strip trailing `| head` and `| tail` pipelines (including `|&`) from each top-level segment in command chains separated by `;`, `&&`, `||`, or `&`
- Changed bash fixup notices to state that stderr is already merged into stdout and to reflect that fixes were applied for multiple stripped segments when several transforms fire
- Changed shell-minimizer per-line truncation marker from a bare `…` to `…[+N]`, where `N` is the count of dropped Unicode scalars. The bracketed tally disambiguates minimizer-driven cuts from genuine `…` characters in the source (paths, JSON, stack traces, etc.) and gives the agent an exact count so it can decide whether the missing tail is recoverable inline or warrants reading the `[raw output: artifact://<id>]` footer the bash wrapper already emits when the minimizer rewrites output. Affects pipeline Stage 5 (`truncate_lines_at` in `defs/*.toml`) and the internal callers in `filters/git.rs`, `filters/listing.rs`, and `filters/lint.rs`. ([#1046](https://github.com/can1357/gajae-code/issues/1046))
- Changed bash command preprocessing to use the real `brush-parser` AST via `pi-natives` `applyBashFixups` instead of a hand-rolled top-level mask scanner. The previous regex/character-walking implementation reimplemented quote/heredoc/`$(...)` tracking with conservative bail-outs (notably refusing to fixup commands containing here-strings); the AST-driven version inherits the full shell parser, so semantics-preserving rewrites like stripping `| head -5` off `cat <<<'content' | head -5` now succeed instead of being skipped. No public API change — `applyBashFixups(command)` returns the same `{ command, stripped }` shape.

### Fixed

- Fixed hashline pure inserts to drop a single echoed anchor line when `edit.hashlineAutoDropPureInsertDuplicates` is enabled and `+ ANCHOR` payloads start with the anchor line or `< ANCHOR` payloads end with it, while preserving intentional single-line duplicates by default. ([#1090](https://github.com/can1357/gajae-code/issues/1090))
- Fixed bash command fixups to remove a redundant standalone trailing `2>&1` redirect when no other pipe or redirection remains
- Fixed command-fixup notices to list all stripped segments instead of reporting only one
- Fixed summarized `read` output stalling agents on elided regions by appending an explicit footer like `[NN lines across MM elided regions; read <path>:raw or a line range like <path>:1-9999 for verbatim content]`. The footer fires whenever the structural summarizer elided at least one span, so the model gets a concrete recovery selector instead of having to guess from a bare `...` / `{ .. }` marker. Surfaces `elidedLines` on `ReadToolDetails.summary` alongside the existing `elidedSpans`. ([#1046](https://github.com/can1357/gajae-code/issues/1046))
- Updated the `read` tool prompt to describe the new elision footer and instruct the model to follow `:raw` (or an explicit line range) when the elided body is actually needed, rather than guessing.
- Fixed plugin extensions failing to load when their `peerDependencies` reference internal `pi-*` packages under any scope other than `@mariozechner` (e.g. `Cannot find module '@earendil-works/pi-tui'` from `@juicesharp/rpiv-ask-user-question`, or `Cannot find module '@gajae-code/utils'` from `@gajae-code/swarm-extension`). The legacy-pi specifier shim now treats `@mariozechner`, `@earendil-works`, **and** the canonical `@gajae-code` itself as aliases for the same set of bundled in-process packages (`pi-agent-core`, `pi-ai`, `gajae-code`, `pi-natives`, `pi-tui`, `pi-utils`), and additionally rewrites the upstream-only `pi-ai/oauth` subpath onto our `pi-ai/utils/oauth` layout. Restored the `Key` runtime helper export on `@gajae-code/tui` to match upstream — plugins using `Key.enter` / `Key.ctrl("c")` (e.g. `@plannotator/pi-extension`, `@juicesharp/rpiv-ask-user-question`) no longer fail with `Export named 'Key' not found`. End-to-end verified against `@juicesharp/rpiv-ask-user-question`, `@gajae-code/swarm-extension`, and `@plannotator/pi-extension` — each now loads cleanly with all of its tools/commands/handlers registered. Plugins importing any of those scopes are remapped to the gjc binary's own copy at load time, so peer deps are no longer dragged in from npm and there is exactly one module instance per package regardless of which scope name the plugin's manifest happened to declare.
- Fixed `gjc commit` hanging after a successful commit instead of returning to the shell. The command now mirrors the `runPrintMode` exit pattern and calls `postmortem.quit(0)` once the pipeline resolves so lingering HTTP/2 keep-alive sockets, the Settings autosave timer, and other AgentSession background handles don't keep the event loop pinned. ([#1041](https://github.com/can1357/gajae-code/issues/1041))
- Fixed hashline payload parsing to silently treat truly-blank lines as empty `~`-prefixed payload lines when more payload follows in the same run. The previous behavior broke at the blank ("payload line has no preceding +, <, or = operation.") even though the intent is obvious — the only ambiguity is between in-payload blanks and end-of-section blanks, and a one-line lookahead resolves it: blanks that precede a non-payload op still end the run cleanly as section separators. Recovers the common case of forgetting the leading separator on a blank inserted line without changing how trailing blanks between ops behave.
- Rewrote the hashline edit prompt examples to use an ASCII-only `TITLE = "Mr"` → `"Mrs"` / `"Dr"` motif instead of the previous `" • "` and `"·"` separators. Some agents had been copying the middle-dot literal characters into real edits as if they were format scaffolding (e.g. emitting payload lines like `~	·`), since the demo inserts were near-twins of the existing string. The new example keeps every original op shape (single-line replace, multiline replace, insert AFTER/BEFORE, append, delete, blank, plus both anti-patterns) but uses content that is obviously domain-specific and clearly distinct from any payload separator. Pure prompt change; no parser, schema, or runtime behavior is affected.
- Fixed startup fallback-chain validation to recognize cached runtime-discovered standard provider models, including Ollama Cloud models listed by `--list-models`, so `retry.fallbackChains` no longer warns that valid `ollama-cloud/<model>` selectors are unknown. ([#1052](https://github.com/can1357/gajae-code/issues/1052))
- Fixed `discoverAgents()` ignoring `disabledProviders` for the `anthropic-model-plugins` provider. Plugin roots from `~/.anthropic-model/plugins/` were scanned unconditionally, so agents from Anthropic Code marketplace plugins continued to appear in `/agents` and the Agent Control Center even when `disabledProviders: [anthropic-model-plugins]` was set. The discovery path now checks `isProviderEnabled("anthropic-model-plugins")` before calling `listAnthropic modelPluginRoots()`, matching how every other capability respects the disabled-providers set. ([#1075](https://github.com/can1357/gajae-code/issues/1075))

### Fixed

- Fixed `$env:VAR` PowerShell variables being mangled on Windows when commands invoked PowerShell as a subprocess (e.g. `powershell -Command "Write-Host $env:SystemRoot"`). Brush-core applied POSIX parameter expansion to `$env` before spawning the child, leaving a dangling `:NAME`. The fix lives in `pi-shell` at env-var application time: every brush session now defines `env=$env` as an internal shell variable so `$env:NAME` expands to the literal `$env:NAME` token that PowerShell expects. The fallback is not exported, only influences brush's own expansion, and is shadowed by any user assignment to `env` (e.g. `env=prod; echo "$env:8080"` still prints `prod:8080`), so the POSIX bash contract is preserved. ([#1079](https://github.com/can1357/gajae-code/issues/1079))


## [15.0.1] - 2026-05-14
### Breaking Changes

- Removed the dedicated `exit_plan_mode` tool and its prompt, requiring plan-mode completion to use the existing `resolve` tool path instead

### Added

- Added optional `extra` metadata object to the `resolve` tool so callers can pass context-specific payloads, including plan approval titles
- Added `hide: true` frontmatter option for skill `SKILL.md` files. Hidden skills are still loaded and remain reachable via `skill://<name>` URLs and (when enabled) `/skill:<name>` slash commands, but are omitted from the rendered system prompt's `<skills>` listing so the model won't auto-discover them. Use for skills the user opts into explicitly rather than ones the model should pick up from descriptions.
- Added middle elision for streaming tool outputs (bash, ssh, python, js eval) and post-execution tool result spill. When `tools.artifactHeadBytes` is set (default 20 KB), large outputs now keep both the first N KB and the last N KB with an inline `[… N lines elided (M KB) …]` marker between them, instead of dropping everything before the trailing tail. Setting `tools.artifactHeadBytes = 0` reverts to the previous tail-only behavior. The full output is still mirrored to the session artifact (`artifact://<id>`) regardless of elision mode. Exposes `truncateMiddle` and `formatMiddleElisionMarker` from `@gajae-code/coding-agent/session/streaming-output`, extends `OutputSinkOptions` with `headBytes`, and adds `direction: "middle"` plus `headRange` / `tailRange` / `elidedLines` / `elidedBytes` to `TruncationMeta`.
- Added per-line column cap shared across streaming tool outputs (`bash`, `ssh`, `python`, `js eval`) and the `read` tool. Lines wider than `tools.outputMaxColumns` bytes (default **768**) are ellipsis-truncated at write time and remaining bytes up to the next `\n` are dropped — bounded memory even on multi-MB single-line outputs (e.g. `cat /dev/urandom`). The cap lives on `OutputSink` as the new `maxColumns` option, persists state across chunk boundaries so split-mid-line writes still respect the budget, and exposes `columnDroppedBytes` / `columnTruncatedLines` on `OutputSummary`. Middle-elision byte math subtracts column drops so the "elided from middle" count stays honest. `read` reuses the same setting but trims its already-collected lines via `truncateLine`. Skipped when the read selector is `:raw`. The artifact file (`artifact://<id>`) keeps the full uncapped stream. Set `tools.outputMaxColumns = 0` to disable.
- Added Bun HTTP/2 fetch opt-in. Dev scripts (`bun run dev`, `bun run stats`) now pass `bun --experimental-http2-fetch` so every `fetch()` advertises `h2` in the TLS ALPN list and falls back to HTTP/1.1 when the server doesn't select it. Multiplexing collapses parallel requests to the same origin onto one TLS connection. For the installed `gjc` binary, export `BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1` in your shell to enable the same behavior (the flag has to be set before Bun starts; `process.env` from inside JS is too late). Requires Bun **1.3.14**.
- Added per-subagent cost display (`$X.XX` in the task progress tree and the session-observer stats line). Cost is accumulated incrementally from `message_end` events and shown only when non-zero, using the `statusLineCost` theme color. Providers that do not report per-turn cost data (e.g. subscription/OAuth usage) continue to show nothing.
- Added ACP elicitation bridge so skills/extensions calling `select`, `confirm`, or `input` on the extension UI context now produce real `unstable_createElicitation` form requests to the ACP client (rather than always resolving to `undefined` / `false`). The `acpExtensionUiContext` constant is promoted to `createAcpExtensionUiContext(connection, getSessionId, clientCapabilities)` — invoked once per session inside `#configureExtensions`, with `getSessionId: () => string` so the live `record.session.sessionId` is read on every elicitation (the underlying id mutates when an extension command calls `ctx.newSession` / `ctx.switchSession`). Each method maps to a single-property `value` schema: `select` → `{type: "string", enum}`, `confirm` → `{type: "boolean"}` (joined `title` + `message` when the trimmed message is non-empty; otherwise just `title`), `input` → `{type: "string", description: placeholder?}` (ACP has no `placeholder` field on `StringPropertySchema`; empty / whitespace-only placeholders are treated as absent). `accept` responses narrow the returned `ElicitationContentValue` back to the method's declared type with a runtime `typeof` guard; `decline` / `cancel` / transport failures fall back to the prior stub return values. `dialogOptions.signal` is honored: an already-aborted signal short-circuits before any SDK round-trip, and an abort mid-flight races against the elicitation so the caller's promise resolves to the stub fallback (the ACP request itself keeps running on the client side — the SDK exposes no form-mode cancel surface; `unstable_completeElicitation` is URL-mode only — matching the in-flight pattern used by `requestRpcEditor`). `dialogOptions.timeout` is honored on parity with `RpcExtensionUIContext`: when the timer fires before the client responds, `onTimeout` is invoked and the caller resolves to the stub fallback. A throwing `onTimeout` is caught and logged (`logger.warn`) so the elicitation promise still settles. Late SDK rejections that arrive after abort/timeout are dropped silently to keep operator logs clean; transport failures still emit `logger.warn` with `{ sessionId, method, error }`. Calls are skipped when the client did not advertise `clientCapabilities.elicitation.form` during `initialize`, so non-elicitation clients are unaffected. `createAcpExtensionUiContext` is exported for tests.

### Changed

- Changed plan-mode completion to use `resolve { action: "apply", reason, extra: { title } }` to request plan approval rather than calling `exit_plan_mode`
- Changed resolve pending-action previews to trim and truncate long `reason` text for cleaner status-line rendering
- Raised the image downscaling default JPEG quality from 75 to 80 in `resizeImage` output generation
- Changed image resize metadata notes from coordinate-scale hints to a simple `Image resized from <original> to <displayed>` message and hide the note when the resized dimensions are unchanged
- Removed `utils/image-convert.ts` and its `convertToPng` helper; callers now inline `new Bun.Image(bytes).png().toBase64()` from [`Bun.Image`](https://bun.com/docs/runtime/image) (Bun 1.3.14+).
- Changed image decode/resize/encode in `utils/image-resize.ts` from the native `PhotonImage` binding to [`Bun.Image`](https://bun.com/docs/runtime/image). Same PNG/JPEG/WebP quality+dimension ladder, but pipelines run off-thread on Bun's statically-linked codecs with no native-addon round-trip. Bumped the minimum Bun runtime requirement to **1.3.14**.
- Changed `search` pagination in multi-file scopes so `skip` now skips entire files and pages results in groups of up to 20 files, with output guiding the next `skip` value via `Showing files X-Y of N`
- Changed multi-file search result selection to cap each file at 20 matches and round-robin across files, so one noisy file no longer suppresses visibility of hits in other files and truncation now reports per-file limits
- Changed search truncation metadata/renderer output from match/result-based limits to file-based limits (`fileLimitReached`, `perFileLimitReached`) and updated truncation labels accordingly
- Lowered `read.defaultLimit` default from `500` to `300` lines, and split the per-range context padding into asymmetric `RANGE_LEADING_CONTEXT_LINES = 1` / `RANGE_TRAILING_CONTEXT_LINES = 3` (was symmetric `RANGE_CONTEXT_LINES = 3`). Replay analysis over post-summarizer sessions (`scripts/session-stats/optimize_read_config.py`) showed that bare-path reads are over-provisioned at the median (file p50 = 220 lines) and that most follow-up reads are disjoint hops rather than adjacent extensions — so a smaller default plus narrower leading context reclaims tokens without measurably changing first-cover rate. Trailing context stays at 3 lines to keep anchor-stale recovery on narrow reads. Explicit `read.defaultLimit` overrides in settings are honoured unchanged.

### Fixed

- Fixed abrupt process termination data loss during session persistence by moving steady-state session writes to a synchronous path that writes each entry to the kernel page cache before returning
- Fixed `--help` startup to avoid a config/model-registry load cycle so the root CLI help command now exits successfully in a clean environment
- Queued `/skill:<name> [args]` invocations now show as compact `Steer: /skill:<name> [args]` / `Follow-up: /skill:<name> [args]` chips in the pending-messages bar and disappear when the agent consumes the queued message (parity with plain-text steer/follow-up). Previously the queued skill was invisible while queued and rendered as a full skill block at consumption with no chip ever appearing.
- Plan-mode "Approve and compact context" no longer surfaces a red "Operation aborted" line on the plan-mode assistant message; the silent transition into compaction now renders cleanly on both live and replay paths. Real user-cancel aborts on unrelated turns and the existing "Compaction cancelled" path are unchanged.
- Auto-recover conflict-resolution `write`/`read` paths that the agent malformed as `<file>:conflict://<N>` (or `<file>:conflict://*`) by mixing the `:conflicts` read selector with the `conflict://` scheme. The stripped `<file>:` prefix is stored on `ParsedConflictUri.recoveredPrefix` and, for writes, surfaces as a trailing note in the result text so the agent learns the correct shape. Clean `conflict://…` URIs are unchanged.
- Fixed hashline edit renderer leaving a stray `@` in the displayed file path when the agent emitted a canonical `@@ PATH` header (or any `@`-run longer than one). Titles like `Edit: @ packages/foo.ts` now render as `Edit: packages/foo.ts`, matching the actual parser in `hashline/input.ts` which already strips every leading `@` before resolving the path. Purely cosmetic — the edit itself was always routed to the correct file.
- Fixed model contextWindow and maxTokens defaulting to `UNK_CONTEXT_WINDOW` (222222) / `UNK_MAX_TOKENS` (8888) when cached or freshly-discovered provider models replace bundled models through `ModelRegistry.#mergeResolvedModels`. The merge now preserves the bundled model's values when the replacement only has sentinel fallbacks.
- Fixed headless `browser.open` tab startup on slow Chromium target enumeration by making worker-side stealth user-agent target setup selective, bounded, and best-effort for non-active targets. Worker startup errors are now surfaced directly instead of degrading into the generic tab worker initialization timeout.
- Fixed token display for sessions and subagents inflating far beyond the context window. `token_total` status-line segment and the subagent overlay token counter now show `input + output + cacheWrite` instead of `input + output + cacheRead + cacheWrite`. With prompt caching, `cacheRead` per turn equals the full cached context — summing it across all turns produces a cumulative total that is N×context_size (e.g. a 5-turn session with a 1 M-token context reported ~5 M tokens). Cache activity is still visible via the dedicated `cache_read`/`cache_write` status-line segments; billing cost is unaffected.
- Fixed ACP clients missing `config_option_update` notifications when the thinking level changed via any path other than the client's own `session/set_session_config_option` call (slash commands, model auto-adjust, extension UI). `AgentSession` now emits a `thinking_level_changed` event from `setThinkingLevel`, and `AcpAgent` subscribes to each managed session for the session's lifetime and pushes a fresh `config_option_update` whenever the effective level changes — independent of any active prompt turn. The subscription is installed inside `#scheduleBootstrapUpdates`'s 50 ms timer so it shares the same race guard that prevents Zed's `Received session notification for unknown session` drop when notifications fire before `session/new` (or fork) returns; the pre-bootstrap thinking level is reported in the response's `configOptions`. The `session/set_session_config_option` handler keeps its own push only when the subscription has not yet been installed, so client-driven thinking changes still notify pre-bootstrap, post-bootstrap they flow through the subscription exactly once. Subscriptions are released in `#disposeSessionRecord`.
- Fixed MCP OAuth refresh failing with `HTTP 401 invalid_client` for servers that require Dynamic Client Registration (RFC 7591) and have no `oauth.clientId` configured (e.g. `mcp.linear.app`). `MCPOAuthFlow` registered a fresh public PKCE client on each authorize and discarded the issued `client_id` once the flow object went out of scope; refresh then called the provider's `/token` endpoint without a `client_id`. The flow now exposes `resolvedClientId` / `registeredClientSecret` getters, `MCPCommandController#handleOAuthFlow` returns them alongside `credentialId`, and both the initial-connect and `/mcp reauth` paths persist them into `auth.{clientId,clientSecret}` (used at refresh) and `oauth.{clientId,clientSecret}` (used by subsequent `/mcp reauth` to skip re-registration). The `MCPAddWizard` `onOAuth` callback type is now `Promise<MCPAddWizardOAuthResult>` and `#launchOAuthFlow` folds the registered credentials into wizard state. Servers with a statically-configured `oauth.clientId` (Notion, Slack, Datadog) are unaffected — `#tryRegisterClient` short-circuits and the write-back is a no-op. ([#1061](https://github.com/can1357/gajae-code/pull/1061) by [@ldx](https://github.com/ldx)).

## [15.0.0] - 2026-05-13
### Breaking Changes

- Removed `op: issue_view` and `op: pr_view` from the `github` tool. Read single issues/PRs via the `read` tool against `issue://<N>` / `pr://<N>` (or the long form `issue://<owner>/<repo>/<N>` / `pr://<owner>/<repo>/<N>`); append `?comments=0` to drop the comments section. The `issue` and `comments` parameters were removed from the tool schema since no remaining op consumes them. Mutating ops (`pr_create`, `pr_checkout`, `pr_push`), `repo_view`, `search_*`, and `run_watch` are unchanged.
- Removed `op: pr_diff` (along with the `nameOnly` and `exclude` schema fields) from the `github` tool. Read PR diffs through the new `pr://` URL family: `pr://<N>/diff` for the changed-file listing, `pr://<N>/diff/<i>` for a single file slice (1-indexed), and `pr://<N>/diff/all` for the verbatim unified diff. Long-form `pr://<owner>/<repo>/<N>/diff[/…]` works the same way. All three variants share one `gh pr diff` invocation through a new `pr-diff` cache row, so the listing and per-file slices reconstruct from cached bytes without re-shelling. Diff content is served as `text/plain` so the `read` tool's line selectors (e.g. `pr://<N>/diff/all:200-400`) page the cached output without falsely advertising hashline anchors.
- Renamed ACP custom extension methods from `gjc/*` to `_gjc/*` to comply with the ACP spec's `_`-prefix requirement for non-spec methods; existing callers must update method names

### Added

- Added markdown rendering for `read` results when content type is `text/markdown`, so GitHub internal-URL outputs are shown as formatted markdown instead of plain code blocks
- Added `pr://<N>/diff`, `pr://<N>/diff/<i>`, and `pr://<N>/diff/all` internal-URL shapes covering changed-file listings, per-file slices, and the full unified diff. They share one `pr-diff` SQLite cache row with the same TTL knobs as `pr://<N>` views (`github.cache.softTtlSec` / `github.cache.hardTtlSec` / `github.cache.enabled`). Single PR views now advertise the diff entry point via a `Diff: pr://<owner>/<repo>/<N>/diff` note. Cache schema bumped to `user_version = 3`; older rows are dropped on first open to add credential-scoped keys and relax the `kind` CHECK constraint.
- Added `issue://` / `pr://` internal-URL schemes that share a SQLite-backed cache with the rest of the `github` tool. Single-item reads (`issue://<N>`, `issue://<owner>/<repo>/<N>`) return rendered markdown and within `github.cache.softTtlSec` (default 5 minutes) skip the `gh` round-trip entirely; within `github.cache.hardTtlSec` (default 7 days) the cached row is returned and a background refresh is scheduled. Root and repo-scoped reads (`issue://`, `pr://owner/repo`) issue a live `gh issue list` / `gh pr list` for browsing, supporting `?state=open|closed|all` for issues, `?state=open|closed|merged|all` for PRs, and `?limit=`, `?author=`, `?label=` query params. Rendered output lands in `~/.gjc/cache/github-cache.db` (override via `GJC_GITHUB_CACHE_DB`); disable the cache entirely with `github.cache.enabled = false`. Cwd→default-repo lookups (`gh repo view`) are memoized per-process.
- Added new `Approve and compact context` choice to the ExitPlanMode approval selector. Sits between `Approve and execute` (purge session) and `Approve and keep context` (full transcript) — runs `/compact` on the plan-mode transcript with a planning-specific summarization hint, then dispatches the plan-approved execution turn so it lands on a fresh cache anchor with the summarized rationale carried over. Cancelling the compaction (Esc or any other abort source) defers the execution dispatch and surfaces a warning so the operator can resubmit manually; non-abort failures proceed best-effort.
- Added `CompactionCancelledError` typed sentinel and `CompactionOutcome` (`"ok" | "cancelled" | "failed"`) return type to `@gajae-code/agent-core/compaction`. `CommandController.executeCompaction` and `handleCompactCommand` now return the outcome instead of `void` so callers can discriminate user-driven aborts from generic failures without inspecting error messages.
- Added a `credential_disabled` extension event so extensions can subscribe via `pi.on("credential_disabled", handler)` and react when `AuthStorage` automatically soft-disables a credential (e.g. OAuth `invalid_grant`). Replaces the current `agent_end` errorMessage regex pattern downstream extensions have to match against. Handler payload is `{ type, provider, disabledCause }`. `createAgentSession()` subscribes the per-session extension runner to the shared `AuthStorage` via `authStorage.onCredentialDisabled(...)` at the very top of session creation — before any startup model probes run — so events fire on every disable regardless of whether the embedder also has a constructor `onCredentialDisabled` handler attached. The SDK forwards through `ExtensionRunner.emitCredentialDisabled(event)`, which buffers events until `runner.initialize(...)` runs in the mode controller and then flushes them through `emit()` so extension handlers see populated UI/runtime context (rather than the constructor's no-op default with `hasUI=false`, an unset model, and no-op runtime actions). On `session.dispose()` the subscription is unsubscribed; the embedder's constructor-attached listener keeps firing through its own permanent subscription. The outer `createAgentSession()` catch also releases the subscription if startup throws before the dispose-wrap is wired, so repeated retries don't accumulate dead listeners.
- Added `gjc acp` subcommand for launching as an ACP (Agent Client Protocol) server over stdio
- Added explicit `type` discriminators to ACP `initialize` auth methods, including a `terminal` setup method gated on `clientCapabilities.auth.terminal`
- Added ACP equivalents for the remaining TUI slash commands (`/jobs`, `/changelog`, `/dump`, `/copy`, `/hotkeys`, `/extensions`, `/agents`, `/model`, `/plan`, `/loop`, `/btw`, `/login`, `/logout`, `/resume`, `/tree`, `/branch`, `/new`, `/drop`, `/handoff`, `/fork`, `/session delete`, `/export`, `/share`, `/todo`, `/memory`, `/move`, `/mcp`, `/ssh`, `/marketplace`, `/plugins`) so ACP clients reach feature parity with the TUI for non-interactive flows
- Added ACP `plan` mode: when `plan.enabled` setting is on, ACP `session/new`/`load`/`resume`/`fork` advertise a `plan` mode alongside `default`; `session/set_mode` toggles plan-mode state so the next agent turn injects the plan-mode system prompt
- Added ACP `ClientBridge` abstraction (`packages/coding-agent/src/session/client-bridge.ts`) that routes tool I/O through the connected client when capabilities are advertised at `initialize`; populated from `AgentSideConnection` in ACP mode
- Added ACP `terminal/*` routing for `bash`: when the client advertises `terminal: true`, the tool creates a client-side terminal, embeds its `terminalId` on the live tool card, polls output, and releases the handle on exit or abort
- Added ACP `fs/read_text_file` and `fs/write_text_file` routing for the `read` and `write` tools: when the client advertises `fs.readTextFile` / `fs.writeTextFile`, plain-text reads/writes go through the editor (surfacing unsaved buffer content and letting the editor track agent writes); falls back to disk only for reads, throws on bridge write failures
- Added ACP `session/request_permission` gate around `bash`, `edit`, `write`, and `ast_edit` when an ACP client is connected; remembers `allow_always` / `reject_always` decisions per tool for the session lifetime
- Added `diff` `ToolCallContent` emission for edit tool results: per-file `oldText`/`newText` is threaded through `EditToolPerFileResult` / `EditToolDetails` so ACP clients can render inline diffs
- Added richer ACP `StopReason` mapping (`max_tokens`, `refusal`, `cancelled`) derived from the last assistant message's internal stop reason; previously only `end_turn`/`cancelled` were emitted
- Added `_meta.messageCount` and `_meta.size` on `session/list` `SessionInfo` entries
- Added ACP `tool_call_update` `locations` refresh from in-flight tool args and final result details so clients can "follow along" multi-file edits in real time

### Changed

- Changed issue and pull-request list entries to link to repository-qualified URLs (for example `issue://owner/repo/<N>`) so list items open correctly outside the default repo
- Aligned prompt instruction language by defining `NEVER` and `AVOID` as strict aliases for `MUST NOT` and `SHOULD NOT` in the system prompt, and standardized agent, tool, and system prompt templates to use those terms consistently
- Changed `--mode acp` to apply the same stdout-quiet overrides as `--mode rpc` so no banner or status text leaks into the JSON-RPC channel
- Changed ACP startup to no longer require a configured model so registry validators and clients can complete `initialize` and `authenticate` before any model is selected
### Fixed

- Deferred flushing of buffered `credential_disabled` events during extension runner initialization to a microtask so handler failures are now routed through `onError()` registrations made immediately after `initialize()`, preserving extension error reporting
- Fixed `eval` tool dynamic `await import("./relative.ts")` calls failing with `Cannot find module ... from .../eval/js/shared/runtime.ts`. The static-import rewriter only handled `ImportDeclaration` nodes, so dynamic-import call expressions resolved their specifier against the worker module's URL instead of the session cwd. The rewriter now walks the full AST and additionally swaps `import` callees in `CallExpression` nodes for `__gjc_import__`, which forwards the optional options bag verbatim to native `import()` so `{ with: { type: "json" } }` round-trips. Renamed `rewriteStaticImports` → `rewriteImports`.
- Fixed `pr://<owner>/<repo>/diff` URLs for repositories named `diff` to continue resolving to PR list lookups instead of being parsed as short-form diff links
- Fixed `issue://<N>/diff` short form previously misparsing as a repo named `<N>/diff` and surfacing a confusing GraphQL "Could not resolve to a Repository" error. The numeric-host disambiguation that already routed `pr://<N>/diff` through the diff path now applies to both schemes, so `issue://<N>/diff[/…]` falls through to the existing "Issue views do not have a diff; use pr://<owner>/<repo>/<n>/diff for pull requests." rejection — matching the long-form `issue://<owner>/<repo>/<N>/diff` behavior. `<scheme>://<owner>/diff` listings for a repo literally named `diff` are unchanged.
- Fixed PR unified diff parsing so changed-file headers with quoted paths (such as paths containing spaces) are now detected correctly and hunk content lines beginning with `---`/`+++` are counted in additions/deletions
- Fixed GitHub view caching to account for active credential identity and avoid serving cached issue/PR data across different account/token contexts
- Fixed `read` call tracking so calls without an explicit path or URL target no longer appear as regular file reads in the execution tracker
- Fixed `createAgentSession()` subscribing the `credential_disabled` bridge to a freshly discovered `AuthStorage` orphan when an embedder supplied only `options.modelRegistry` (no `options.authStorage`). Refresh failures emitted by `modelRegistry.getApiKey()` flow through `modelRegistry.authStorage`, so a divergent local instance silently swallowed every disable event and also leaked into the `mcpManager` and session result. The SDK now reconciles `authStorage` to `modelRegistry.authStorage` up front and rejects mismatched `options.authStorage`/`options.modelRegistry.authStorage` pairs at session construction.
- Fixed `runSubagent` (subagent task executor) carrying the same latent `AuthStorage`/`ModelRegistry` divergence as `createAgentSession()`: when only `options.modelRegistry` was supplied, the executor previously fell through to a fresh `discoverAuthStorage()` and handed that orphan into `createAgentSession()` alongside a registry whose `.authStorage` was a different instance. The executor now reconciles to `modelRegistry.authStorage` before any further work and rejects mismatched `options.authStorage`/`options.modelRegistry.authStorage` pairs the same way the SDK does, so subagents can no longer silently observe a different storage view than their parent.
- Fixed `github` tool's `search_issues`/`search_prs`/`search_code`/`search_commits`/`search_repos` ops always returning 0 results when the query contained more than one qualifier (e.g. `is:merged is:pr`, `is:open author:foo`). `gh search …` since the `advanced_search=true` rollout in gh 2.92 silently wraps multi-token positional queries in parentheses and quotes everything after the first qualifier as that qualifier's value (`is:"merged is:pr"`), which GitHub then matches as a literal state filter that no PR can satisfy. The tool now calls `gh api -X GET /search/<endpoint> -f q=… -F per_page=…` directly so the qualifiers reach GitHub's search API verbatim. `is:issue`/`is:pr` and `repo:<owner>/<repo>` are appended internally to preserve the previous CLI-flag behavior; the user-facing query string in the formatted output is unchanged. `state` for merged PRs is derived from `pull_request.merged_at` so the rendered `State:` line stays `merged`/`closed`/`open` as before.
- Fixed `read` tool renderer rendering failed reads with a success check (`✓`) and styling the error message as file content while the surrounding box was red. The renderer now branches on `isError` for both file and URL paths: header shows `✘ Read <path>` with a proper error icon and the underlying message is rendered as an error line. `renderReadUrlResult` got the same treatment so failed URL reads also get the cross icon instead of falling through to the `"No response data"` Text fallback. Mirrors the `bash`/`find` renderer error pattern.
- Fixed ACP mode to advertise and handle non-TUI builtin slash commands and `/skill:<name>` commands
- Fixed ACP `session/resume` and `session/close` to dispatch correctly under SDK 0.21 by renaming `unstable_resumeSession` / `unstable_closeSession` to the stable `resumeSession` / `closeSession` method names the SDK now routes to
- Fixed ACP `tool_call` / `tool_call_update` `locations` to always emit absolute paths (resolved against the session cwd) so editor clients can reliably open or focus the referenced file
- Fixed ACP edit `diff` metadata for moves to point at the destination path rather than the now-deleted source so post-edit "open file" actions land on the new file
- Fixed ACP `session/request_permission` `locations` to be absolute and to honor the `requestPermission` capability bit instead of only checking for the method, matching the read/write/bash capability gating
- Fixed ACP `authenticate` to reject `methodId` values that were not advertised by `initialize` so malformed clients fail fast instead of being treated as authenticated
- Fixed ACP mode changes made via `session/set_session_config_option` (`MODE_CONFIG_ID`) to also emit a `current_mode_update` notification, matching `session/set_mode` so clients tracking `modes.currentModeId` stay in sync
- Fixed `/model` ACP builtin to emit a `config_option_update` after switching models so clients show the new model in config selectors immediately
- Fixed `/mcp list` (ACP) to redact query strings and userinfo from server URLs before emitting them, so API keys embedded in URLs (e.g. `?exaApiKey=…`) are not leaked to clients
- Fixed `/mcp test|resources|prompts` (ACP) to wire the auth storage before `prepareConfig` so OAuth-backed MCP servers can refresh tokens and inject `Authorization` headers
- Fixed `/mcp list`, `/mcp test`, `/mcp resources`, `/mcp prompts`, `/mcp enable`, and `/mcp disable` (ACP) to preserve project-over-user precedence when the same server name is defined in both scopes, matching the runtime capability merge so toggling the duplicated name flips the effective entry
- Fixed `/ssh add --port` parsing to reject non-integer values (e.g. `22oops`) instead of silently coercing them via `Number.parseInt`
- Fixed `/ssh list` to deduplicate hosts shared between project and user scopes, listing project entries first to match capability-loader precedence
- Fixed `/export` (ACP) to reject clipboard aliases (`--copy`, `clipboard`, `copy`) instead of using them as the output filename
- Fixed ACP builtin commands (`/compact`, `/force`, `/move`, `/browser`) to surface underlying failures via `output()` instead of swallowing them
- Fixed `/session save|delete` (ACP) to route through the active `SessionManager` so the persist writer is consulted and stale storage references are removed
- Fixed `/reload-plugins`, `/marketplace install|uninstall|upgrade`, and `/plugins enable|disable` (ACP) to refresh slash command registries and emit `available_commands_update` after plugin state changes
- Fixed ACP `usage()` text emission to be awaited so help and error output is not dropped or reordered when commands return immediately
- Fixed ACP `bash` tool to release the client terminal handle on `terminal/output` or `waitForExit` failures, and to race output polling against abort so a stuck RPC cannot delay cancellation
- Fixed ACP `resource` content blocks with `image/*` MIME types to be routed into the LLM `images` array instead of being dropped as opaque blobs
- Fixed `pr://` and `issue://` URLs accepting empty, `.`, or `..` path segments. `pr://owner//77`, `pr://owner/repo/77/diff//2`, and `pr://owner/../77/diff` previously slipped past the `.filter(Boolean)` split and were forwarded to `gh`; now they throw `Invalid <scheme>:// URL: empty or unsafe path segment` before any subprocess work.
- Fixed `read` of `issue://` / `pr://` URLs ignoring the read tool's `AbortSignal`. Aborting a long `pr://<N>/diff/all` or stale issue fetch now propagates into the resolver and short-circuits at the handler entry; previously the `gh` round-trip and cache write ran to completion.
- Fixed `read <path>:raw` (and the `raw: true` arg) still rendering markdown internal-URL content through the formatted markdown renderer. The TUI now respects the raw selector and falls back to the code-cell renderer so verbatim bytes are shown when requested.
- Fixed `eval` tool JS cells crashing with a `structuredClone` error when an awaited final expression returned a non-cloneable value (module namespace, function, symbol, etc.). `displayValue` now falls back to a text representation and logs at debug instead of throwing.
- Fixed `eval` tool JS rewriter missing the final expression when followed by trailing empty statements (e.g. `await Promise.resolve(1);;`). `returnFinalExpression` now scans backward past `EmptyStatement` nodes before deciding there is no final expression.
- Fixed `github` view cache evicting valid rows on open whenever a longer-than-default `github.cache.hardTtlSec` was configured. `openDb()` no longer sweeps with the 7-day default before settings load; the per-lookup `sweepIfDue()` enforces the configured retention exclusively.
- Fixed extension `ctx.shutdown()` being a no-op in the primary interactive path. The handler in `initHooksAndCustomTools` now sets `shutdownRequested` (mirroring the backgrounded-reinit path), and the main REPL loop drains the flag at the post-stream idle boundary so queued steering messages still flush before teardown.
- Fixed plan-mode "Approve and compact context" dispatching queued user input against the stale plan-mode reference path. `setPlanReferencePath(finalPlanFilePath)` now runs before `handleCompactCommand` flushes the compaction queue, so any message typed during compaction is delivered with the approved plan context attached.
- Fixed `.gjc/commands/fix-issues.md` and `.gjc/commands/review-prs.md` still instructing agents to call the removed `github issue_view` / `pr_view` / `pr_diff` ops; they now reference `read issue://<N>` and `read pr://<N>[/diff[/all|<i>]]`.
- Fixed `ExtensionRunner.initialize()` flushing buffered `credential_disabled` events before mode controllers had a chance to register their `onError` listener. Mode controllers call `runner.initialize(...)` immediately followed by `runner.onError(...)` synchronously; the flush now runs in a microtask after splicing the buffer, so a synchronously throwing `credential_disabled` handler is routed through the registered error listener instead of being silently dropped.

### Security

- Secured the GitHub cache store with strict file permissions (`0600` files) and private permissions for newly created cache directories (`0700`) to reduce local cache exposure

## [14.9.9] - 2026-05-12

### Added

- Added new `task.isolation.mode` values `auto`, `apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, and `rcopy` for native PAL-backed task isolation backends
- Added automatic PAL-backed isolation backend selection so `task.isolation.mode` uses the host's best-available backend
- Added input-token and output-token totals to `gjc stats --summary`.

### Changed

- Changed `task.isolation.enabled=true` migration to map to `task.isolation.mode = "auto"` instead of legacy `worktree` isolation
- Updated isolation configuration UI labels and descriptions to expose new back-end names (`overlayfs`, `projfs`, etc.) and removed references to deprecated values in guidance text

### Fixed

- Fixed worktree delta capture to include previously untracked file state by baselining untracked patches for both snapshots
- Fixed task isolation startup to try alternate PAL backends when the preferred one is unavailable, allowing successful fallback instead of immediate failure
- Mapped legacy `task.isolation.mode` values `worktree`, `fuse-overlay`, and `fuse-projfs` to their new equivalents during settings migration to preserve behavior with older configs

## [14.9.8] - 2026-05-12

### Breaking Changes

- Changed the `eval` tool input format to a single-line `*** Cell <lang>:"<title>" [t:<duration>] [rst]` header per cell, replacing the `*** Begin <LANG>` / `*** End <LANG>` envelope and the standalone `*** Title:` / `*** Timeout:` / `*** Reset` directives. The lark grammar enforces a fixed attribute order; the runtime parser remains lenient (alias keys, bare positional tokens, single-quoted titles).

### Added

- Added `:conflicts` read selector (`read <path>:conflicts`) to return a one-line index of all unresolved merge conflicts with stable `#N` IDs for quick inspection
- Added bulk conflict resolution with `write({ path: "conflict://*", content })` to resolve all currently registered conflicts across files in one call, expanding `@ours`/`@theirs`/`@base`/`@both` per conflict and returning per-file counts
- Added `read` support for `conflict://<N>` and `read conflict://<N>/<scope>` to inspect unresolved conflict regions captured by a prior read, including `ours`, `theirs`, and `base` side views with original file line alignment
- Added shorthand content tokens `@ours`, `@theirs`, `@both`, and `@base` to conflict-resolution writes using `path: "conflict://<N>"` so replacement content can be composed from recorded conflict sections
- Added conflict count metadata to read results so conflict files now show a warning badge (`⚠ N`) in the read tool UI
- Added support for explicit boolean `rst` values (`rst:true`, `rst:false`, `rst:1`, `rst:0`, `rst:yes`, `rst:no`, `rst:on`, `rst:off`) in `*** Cell` headers
- Added detection of unresolved git merge conflicts in `read` output: each marker block is registered with a session-stable id and surfaced in a footer with `ours`/`theirs` previews. Resolve a block by calling `write({ path: "conflict://<id>", content })` — the tool splices the recorded marker region (markers and all sides) with the supplied content and routes through the normal writethrough (LSP format/diagnostics, fs-cache invalidation).

### Changed

- Changed `read` conflict warning footers to show `X of Y` unresolved conflicts when a range only captures part of a file and provide a `read <path>:conflicts` hint for the full list
- Changed conflict scanning in conflict read paths to inspect the whole file (with a 10 MB cap) so totals better reflect hidden conflicts and truncated scans are called out
- Changed conflict marker scanning during `read` to only register fully formed, column-0 merge-marker blocks, so indented or malformed marker-like lines are no longer treated as conflicts
- Changed `write` conflict resolution to validate `conflict://` IDs and report clear errors for malformed or unknown conflict URIs
- Changed the HTML transcript renderer to parse the new `*** Cell` headers while keeping the older `*** Begin <LANG>` and `===== ... =====` formats renderable for historical sessions.
- Changed the `eval` tool parser so a stray non-marker line between cells no longer crashes with `null is not an object (evaluating 'BEGIN_RE.exec(lines[i])[1]')`; stray content is consumed without aborting parsing.
- Changed `*** End` to be an optional, undocumented per-cell terminator (kept in the lark to satisfy GPT-trained models' natural terminator habit during constrained sampling).

### Fixed

- Fixed single-conflict `write` retries to re-locate the recorded conflict block by exact marker content so shifted line numbers from out-of-band edits no longer prevent resolution
- Fixed `read conflict://*` handling by rejecting wildcard reads with a clear write-only guidance error
- Fixed conflict resolution to verify the live file still contains recorded `<<<<<<<` and `>>>>>>>` markers before splicing, preventing stale conflict IDs from silently corrupting out-of-band-edited files
- Fixed `@base` token handling so two-way conflicts without a base section now return a clear error
- Improved `*** Cell` header parsing to reject invalid `rst` values with a clear `invalid rst value` error

## [14.9.7] - 2026-05-12

### Breaking Changes

- Changed the `timeoutMs` execution option to no longer be enforced during worker-based JS runs, so callers must rely on external cancellation signals for time limits
- Replaced the Jupyter kernel gateway + WebSocket protocol behind the Python `eval` backend with a subprocess-backed runner that speaks NDJSON over stdin/stdout; removed the `jupyter_kernel_gateway`/`ipykernel` pip dependencies, the `python.sharedGateway` setting, the `gjc jupyter` CLI command, and the `PI_PYTHON_GATEWAY_URL` / `PI_PYTHON_GATEWAY_TOKEN` environment variables

### Added

- Added Python `tool.<name>(args)` support to `executePython` sessions so evaluated Python code can invoke session tools through the prelude `tool` proxy
- Added per-execution Python tool bridge session registration and loopback endpoint wiring so Python tool calls resolve to host tools and return tool results
- Added status-event forwarding for Python tool bridge calls so `tool` invocations can emit execution status updates
- Added browser-tab JavaScript execution through the shared runtime so tab runs now expose the standard helper globals (`read`, `write`, `sort`, `uniq`, `counter`, `diff`, `tree`, `env`, `output`, `display`, and `tool`)
- Added static ESM `import` support to browser-tab JavaScript by rewriting top-level imports and resolving them against the tab session context
- Added substring fallback matching to `HistoryStorage.search` so infix and short-token queries that FTS5 prefix matching misses are still returned
- Added a live single-line sync progress display to the stats command showing current/total sessions while syncing
- Added automatic inline JS evaluation fallback when worker creation failed so script execution still works in environments without worker support

### Changed

- Changed `setup python` to only verify a reachable Python 3 interpreter instead of installing Jupyter dependencies
- Changed `info` output to remove the obsolete Python Gateway status block now that shared gateway management is no longer available
- Changed JavaScript execution in `executeJs` to expose the worker\u2019s real `process` object instead of a restricted, frozen subset
- Changed JavaScript evaluation to run per session in a worker-backed runner with explicit initialization and teardown handling
- Changed the Python backend to launch one `python -u runner.py` subprocess per kernel; cancellation now sends `SIGINT` which raises a real `KeyboardInterrupt` in user code, and the same subprocess is reused across cells in session mode
- Changed Python magic handling so `%pip`, `%cd`, `%env`, `%pwd`, `%ls`, `%time`, `%timeit`, `%who`, `%reset`, `%load`, `%run`, `%%bash`, `%%capture`, `%%timeit`, `%%writefile`, and `!shell` work without depending on IPython

### Fixed

- Fixed Python output rendering so `text/markdown` takes precedence over `text/plain` and status bundles are emitted as status updates rather than plain text
- Fixed query tokenization in `HistoryStorage.search` so punctuation-delimited terms like `git-commit` are aligned with indexing and matched correctly
- Fixed history search result merging to de-duplicate matches and return full-text matches before substring-only matches while still respecting the requested limit
- Fixed JS run cancellation so aborting a run now also cancels in-flight tool calls and terminates the active worker session
- Fixed top-level `const`, `let`, and `class` declarations in evaluated JavaScript to persist across subsequent runs by rewriting top-level declarations

## [14.9.5] - 2026-05-12
### Breaking Changes

- Removed the `jobs://` internal URL protocol; inspect background jobs via the `job` tool's `list: true` operation instead

### Added

- Added `since` and `until` date-range filters to `search_issues`, `search_prs`, `search_commits`, and `search_repos`, accepting relative durations (`m`/`h`/`d`/`w`/`mo`/`y`), ISO dates, and ISO datetimes
- Added `dateField` support for date filtering (`created` or `updated`) so search results can be constrained by creation, update, pushed (for repos), or committer date (for commits)
- Added owner-based scoping to async job registration and queries so background jobs can be registered with an `ownerId` and filtered per agent in `getRunningJobs`, `getRecentJobs`, `getAllJobs`, and `cancelAll`
- Added agent ownership metadata to async jobs started by `task` and `bash` tools so their lifecycle and cancellation is attributed to the creating agent
- Added `list: true` operation to the `job` tool, returning an immediate snapshot of every job spawned by the calling agent without waiting (replaces the deleted `jobs://` URL)
- Added per-agent visibility scoping to the `job` tool so `list`, `poll`, and `cancel` only see and act on jobs owned by the calling agent; cross-agent operations now return `not_found`

### Changed

- Changed `search_issues`, `search_prs`, `search_commits`, and `search_repos` to allow date-only queries where `query` is omitted if `since`/`until` is provided
- Changed `search_code` to return a validation error when `since`/`until` is supplied because GitHub code search does not support date qualifiers
- Changed async job manager ownership so subagents inherit the parent session’s global `AsyncJobManager` instead of creating and owning separate instances
- Changed session lifecycle cleanup so the global async-job manager is disposed only by the owning top-level session
- Changed subagent session switches and handoff paths to stop global async-job cancellation and cancel only jobs owned by that session
- Changed `agent://` and `artifact://` URL resolution to search artifact outputs across all active sessions instead of only the current session, allowing parent and subagent sessions to read each other’s generated outputs by ID
- Changed `memory://` URL resolution to walk all active sessions’ memory roots and return the first matching file, so worktree-based subagents can access their own memory views as well as shared roots
- Changed internal URL routing to use a shared process-global `InternalUrlRouter` and protocol handlers, so built-in tools resolve `agent://`, `artifact://`, `memory://`, `skill://`, `rule://`, `mcp://`, and `local://` URLs without requiring session-specific router wiring
- Changed `mcp://` handler to use the globally registered MCP manager so MCP resource links work for agents sharing session context

### Changed

- Changed the `ask.timeout` default from `30` (seconds) to `0` (wait indefinitely). Auto-selecting the recommended option after a fixed delay was surprising users mid-deliberation; the timer is now strictly opt-in. The legacy auto-select behavior is preserved when `ask.timeout` is set to a non-zero value, and the `ask` tool's prompt has been updated so the model expects unlimited reply time by default.

### Fixed

- Added `ModelRegistry.hasConfiguredAuth(model)` to mirror the upstream `@mariozechner/gajae-code` API surface; external plugins and downstream wrappers that pre-flight auth before launching a subagent no longer crash with `this._modelRegistry.hasConfiguredAuth is not a function` on the direct agent-launch path. ([#993](https://github.com/can1357/gajae-code/issues/993))
- Fixed an ESM circular-import TDZ that crashed test suites when modules from the `task/` and `tools/` graphs were evaluated together (e.g. `executor-warnings.test.ts` + `task-simple-mode.test.ts`) by deferring `BUILTIN_TOOLS.task`'s `TaskTool.create` dereference to factory-call time and sourcing `truncateTail` from `session/streaming-output` instead of the `tools/` barrel
- Treat keyless-by-design providers (llama.cpp, ollama, lm-studio) as authenticated in subagent model resolution; fixes silent fallback to parent remote model when a local model is configured. ([#1008](https://github.com/can1357/gajae-code/issues/1008))
- Fixed subagent disposal and session transitions that previously canceled all running async jobs, preventing inadvertent termination of a parent agent’s background work
- Fixed multi-entry edits silently rendering a fake success when every entry failed (e.g. all hit the auto-generated guard), by surfacing `isError: true` from the single-path edit orchestrator so the renderer takes the error branch instead of falling through to the streaming-preview fallback that displays the *proposed* diff
- Fixed the auto-generated streaming guard being gated behind `edit.streamingAbort` (default false), so it now pre-empts streaming edit tool calls targeting auto-generated files regardless of that setting
- Fixed subagents launched in the same parallel batch not seeing each other in their initial `# IRC Peers` system-prompt block by pre-registering the agent in the global `AgentRegistry` before `rebuildSystemPrompt` runs and attaching the live session afterwards
- Fixed plugin manifest extensions whose entry points at a directory (e.g. `pi-goal`'s `"pi": { "extensions": [".pi/extensions/pi-goal"] }`) failing to load with `Failed to load extension: Directories cannot be read like files`. The plugin path resolver now resolves directory entries to their `index.{ts,js,mjs,cjs}` file, matching the behavior of native auto-discovery via `resolveExtensionEntries`.
- Fixed the SSH tool on native Windows by avoiding OpenSSH ControlMaster multiplexing, which Win32-OpenSSH does not support and reports as `getsockname failed` ([#154](https://github.com/can1357/gajae-code/issues/154)).
- Fixed `/export` and `/tree` not showing developer-role messages (including the plan content injected after `/plan` approval) so the HTML export and TUI session tree now render developer messages dimmed with their actual content instead of hiding them entirely ([#753](https://github.com/can1357/gajae-code/issues/753))
- Fixed `Timed out initializing browser tab worker` on prebuilt binaries by rewriting `spawnTabWorker` to import the worker entry with `with { type: "file" }` so Bun's `--compile` bundler statically discovers and embeds `tab-worker-entry.ts` in the single-file binary ([#1011](https://github.com/can1357/gajae-code/issues/1011))

## [14.9.3] - 2026-05-10
### Breaking Changes

- Changed the `eval` tool input format to canonical `*** Begin <LANG>` ... `*** End <LANG>` cells with `*** Title`, `*** Timeout`, and `*** Reset` directives, so legacy `===== ... =====` eval inputs are no longer accepted for execution
- Removed the `sectionSeparator` re-export from `config/prompt-templates`, so existing imports from `@gajae-code/coding-agent/config/prompt-templates` now need to resolve `sectionSeparator` from its utility package

### Added

- Added support for the `*** Abort` recovery marker in eval and hashline parsing to terminate processing safely when stream corruption is detected
- Added support for wrapping hashline edits in `*** Begin Patch` and `*** End Patch` markers so patch input with these envelopes is parsed and applied
- Added support in the HTML export renderer for the new `*** Begin`/`*** End` eval cell format
- Added a dedicated `[now]` prompt block to `buildSystemPrompt` output containing current date, current working directory, and required end-of-turn continuation/verification guidance
- Added a new `[project]` prompt block wrapper around workstation and workspace context and ensured it is emitted as a separate system prompt segment
- Added dedicated HTML rendering for `eval` tool calls, including cell-by-cell parsing of `===== ... =====` blocks with inferred Python/JS/TypeScript highlighting
- Added dedicated rendering support for `search`, `recipe`, and `irc` tool calls in transcript exports
- Added a collapsible `Available Tools` section with a tool count and chip-style compact tool names
- Added macOS power assertion settings `power.preventIdleSleep`, `power.preventSystemSleep`, `power.declareUserActive`, and `power.preventDisplaySleep` so users can control what types of sleep are blocked during sessions

### Changed

- Kept legacy `===== ... =====` eval transcripts renderable in HTML while adding parsing for the new `*** Begin` format for newer transcripts
- Changed the system prompt’s Bash usage guidance to explicitly forbid specific anti-patterns (`sed`/`awk` line-range reads, stderr redirects, and `| head|tail` pagination) and require using dedicated tools for those operations
- Changed delegated subagent prompts so shared task context is now rendered only in the system-level `[context]` block, while the user-facing task message now contains only the assignment prompt text
- Changed system prompt rendering to use block markers such as `[env]`, `[contract]`, `[role]`, `[coop]`, and `[closure]` for more explicit structural instructions
- Changed the working-directory value in rendered prompts to use `shortenPath` before interpolation
- Updated subagent prompt assembly to compose prompt blocks and place the `[now]` block after the subagent-specific instructions
- Changed GitHub (`gh`) tool cards to include operation, PR, branch, and truncated query/title/body details
- Changed tool-call output to display internal `_i` intent separately and hide it from rendered argument JSON
- Changed `ast_edit` and `find`/`search` rendering to show resolved path values and option flags such as `limit`, `no-hidden`, and `no-reply`
- Changed power assertion behavior to take effect only while a prompt is in flight, replacing session-level persistent assertions

### Removed

- Removed the unused `head` and `tail` parameters from the `bash` tool schema, along with the dead `normalizeBashCommand` / `applyHeadTail` post-processing module — output truncation is already handled by the harness's streaming tail buffer and artifact spillover, so the agent should rely on `read` (or the artifact link) instead of inline truncation pipes.

### Fixed

- Fixed eval tool outputs to append a truncation warning and ask users to re-issue remaining work when parsing is aborted by `*** Abort`
- Fixed hashline parsing and input splitting to stop at `*** Abort` and ignore trailing edits after the marker
- Fixed subagent task prompt construction so a trailing `[now]` block in the base prompts is preserved and not swallowed when rendering `subagent-system-prompt`
- Fixed edit rendering so provided `input` text is shown in the export even without a file path
- Fixed `args.paths` handling in `ast_edit` and `find` so multiple paths are shown as a comma-separated list
- Fixed power assertion state handling so subsequent prompts are no longer blocked after an aborted or canceled prompt
- Fixed IRC background exchange poll loop leaking after session disposal: `#scheduleBackgroundExchangeFlush` now stops immediately when `dispose()` is called, preventing stale `setTimeout` callbacks from firing against a torn-down agent

## [14.9.2] - 2026-05-10
### Added

- Added `agentsMdFiles` to `WorkspaceTree` so AGENTS.md discovery results are returned with the workspace scan output

### Changed

- Changed startup workspace discovery to use one native `listWorkspace` walk for both the rendered tree and AGENTS.md directory-context candidates, removing the layered `git ls-files` orchestration and secondary AGENTS.md glob.

### Fixed

- Fixed AGENTS.md context discovery to include AGENTS.md files that are explicitly gitignored while still excluding AGENTS.md files under ignored directories
- Fixed task tool renderer spamming `Tool renderer failed: undefined is not an object (evaluating 'args.tasks.length')` warnings while a `task` call was streaming in (the `tasks` array is undefined until the partial JSON parser closes it); the renderer now tolerates an absent `tasks` field and shows `0 agents` until the array arrives ([#985](https://github.com/can1357/gajae-code/issues/985)).
- Fixed MCP HTTP streamable transport spamming `HTTP SSE stream error: ReadableStream already has a controller` after every JSON-RPC request whose response was returned as `text/event-stream`. The transport used to break out of the SSE iterator once the matching response was captured and then re-open `response.body` for a background drain, but the body had already been piped through a `TransformStream` and could not be re-read. The drain now runs from a single iterator that resolves the response promise inline and continues to dispatch piggybacked notifications on the same stream.

## [14.9.0] - 2026-05-10
### Breaking Changes

- Moved hashline APIs to the dedicated `@gajae-code/coding-agent/hashline` module, moved hash helpers to `@gajae-code/coding-agent/hashline/hash`, and removed the legacy `edit/modes/hashline` and `edit/line-hash` source subpaths.

### Removed

- Removed hashline auto-rebase. Anchor mismatches now reject immediately so the model re-reads instead of silently relocating an edit to a hash-collision within ±5 lines, which could otherwise apply the change to the wrong region. Stale-anchor recovery via the cached read snapshot is unaffected.

### Fixed

- Fixed compaction crashing with `auth_unavailable` when the current model's provider has no credentials configured; compaction now falls back to an available model role (or fails fast with a clear error) instead of attempting a doomed provider call ([#986](https://github.com/can1357/gajae-code/issues/986)).
- Fixed top-level static import rewriting in JS evaluation to use parser-based detection so only real import declarations are rewritten and `import` text inside strings, comments, or template literals is preserved
- Fixed `import ... with` attribute handling in rewritten ESM imports so static imports with module attributes now become dynamic imports with matching `with` options
- Fixed model resolution silently falling back to a different provider (e.g. Amazon Bedrock) when `modelRoles` specified a fully-qualified `<provider>/<id>` whose exact pair was not in the bundled catalog. Explicit provider prefixes are now honored or surface a clear error ([#980](https://github.com/can1357/gajae-code/issues/980)).
- Fixed session count inflation on Anthropic backend caused by a fresh random `metadata.user_id` being generated on every API request; all requests within one conversation now share a stable `metadata.user_id` derived from the session ID, matching the expected one-session-per-conversation counting
- Fixed plan mode review resubmits to append each refreshed `local://PLAN.md` preview to the chat history, preserving the full refined plan in terminal scrollback.
- Fixed compaction requests (manual and auto) not carrying `metadata.user_id`, leaving them unattributed on the backend
- Fixed direct session-bound LLM calls (`/btw` ephemeral turns via `runEphemeralTurn`, branch summarization, session title generation) bypassing the agent and emitting a fresh random `metadata.user_id` per request on Anthropic OAuth: the session-level `prepareSimpleStreamOptions` helper now stamps the agent's session metadata onto direct calls, and `generateBranchSummary` plus `generateSessionTitle` accept and forward an explicit `metadata` option from the call site
- Fixed `metadata.user_id` lacking the authenticated `account_uuid` on Anthropic OAuth requests; sessions now install a dynamic resolver via `Agent#setMetadataResolver` that builds `{ session_id, account_uuid? }` per request, looking the live OAuth account UUID up from `AuthStorage` so it stays in sync with token refreshes and login/logout transitions instead of stranding a stale value
- Fixed multi-file legacy Pi extensions failing to load when sibling `.ts` files import each other via relative paths ([#983](https://github.com/can1357/gajae-code/issues/983)).
- Fixed sub-agent dispatch silently routing to a model whose provider has no working credentials (e.g. an unqualified `modelRoles.task` id like `qwen3.6-plus-free` resolving to a provider the user is not authenticated against). Task dispatch now falls back to the parent session's active model — which by definition has working auth — when the resolved subagent model has none ([#985](https://github.com/can1357/gajae-code/issues/985)).

### Added

- Added a debug-panel raw SSE stream viewer so stuck model/tool-call streams can be inspected live from the TUI.

### Fixed

- Fixed legacy Pi plugin extensions failing to load on Windows when their entry path contains a drive letter ([#990](https://github.com/can1357/gajae-code/pull/990) by [@jiwangyihao](https://github.com/jiwangyihao)).

### Added

- Added `get_login_providers` RPC command to list registered OAuth providers with their current authentication status (`id`, `name`, `available`, `authenticated`)
- Added `login` RPC command to trigger OAuth login for a given provider; emits an `open_url` extension UI event (fire-and-forget) carrying the auth URL and optional instructions so headless clients can open the browser, then resolves when the callback-server flow completes
- Added `open_url` variant to `RpcExtensionUIRequest` for the above
- Added `getLoginProviders()` and `login(providerId)` methods to `RpcClient`

## [14.8.0] - 2026-05-09
### Added

- Added hashline stale-anchor recovery by replaying edits against a session-scoped `read`/`search` snapshot and 3-way-merging them onto the current file when anchors no longer match

### Fixed

- Fixed legacy pi extensions failing to import their own bare-specifier dependencies (e.g. `import x from "pkg"`): files loaded via the `gjc-legacy-pi-file:` namespace now pre-resolve bare imports against the extension's directory so the extension's own `node_modules` is honored.

### Changed

- Changed hashline success output to include a warning when stale-anchor recovery is used

## [14.7.8] - 2026-05-08

### Fixed

- Fixed indefinite startup hang on large repos introduced in 14.7.6 ([#975](https://github.com/can1357/gajae-code/issues/975)) on two fronts: (1) `createAgentSession` was awaiting `buildAgentsMdSearch` and `buildWorkspaceTree` directly in its blocking `Promise.all`, bypassing the existing 5s preparation deadline that previously protected startup — both scans are now raced against a 5s deadline and fall back to the system-prompt fallback path on timeout; (2) `buildWorkspaceTree` now derives its listing from `git ls-files --cached --others --exclude-standard` when the workspace is a git worktree, which is O(index size) and avoids the per-call full-tree gitignore-aware native scan that the previous implementation triggered. Repos without git, or where the call fails / times out, transparently fall back to the previous native-glob path.

## [14.7.6] - 2026-05-07
### Changed

- Changed the "Hide Thinking Blocks" setting (Ctrl+T) to also instruct the provider to omit thinking/reasoning summaries from responses, instead of just hiding them client-side. Anthropic sees `thinking.display = "omitted"` (where supported); OpenAI Responses / Azure / OpenAI code requests drop `reasoning.summary` entirely.

### Fixed

- Fixed the `Hide Thinking Blocks` toggle so changing it updates the active session’s request settings immediately, ensuring new responses reflect the current hide-thinking preference
- Fixed system prompt preparation to keep successful context data and only fall back to minimal defaults for preparation steps that fail
- Fixed system prompt preparation timeout to apply per-step instead of all-or-nothing: a single slow step (e.g. `buildAgentsMdSearch` on a huge directory tree, `buildWorkspaceTree`, `loadProjectContextFiles`) now falls back to its own minimal default while the other steps still populate, and the warning names which steps timed out.
- Fixed subagents re-running expensive workspace scans (`buildAgentsMdSearch`, `buildWorkspaceTree`) on every spawn: parents now forward their already-resolved `AGENTS.md` search and workspace tree to subagents through `createAgentSession`, matching how `contextFiles`, `skills`, and `promptTemplates` are already inherited. On large monorepos this removes seconds of redundant work per `task` invocation and prevents the per-subagent system-prompt timeout warnings.

## [14.7.5] - 2026-05-07
### Added

- Added optional `/loop` limits: `/loop 10` stops after 10 auto-iterations, while duration forms such as `/loop 10m` and `/loop 10min` stop after the time limit.

### Changed

- Changed `/loop` to include the configured limit and remaining budget in the enabled status message

### Fixed

- Fixed `/loop` handling of malformed count or duration arguments by showing usage errors instead of enabling unbounded loop mode
- Fixed inherited disabled macOS malloc stack logging variables leaking into shell sessions and spamming Bun subprocess output with `MallocStackLogging` warnings.

## [14.7.4] - 2026-05-07

### Breaking Changes

- Removed the dedicated `notebook` tool; `.ipynb` reads and edits now go through `read` and `edit`.

### Changed

- Changed diff previews to syntax-highlight contiguous context lines in the unchanged sections when file language can be detected
- Changed `read` tool behavior for `.ipynb:raw` requests to return raw notebook content instead of converting via markit
- Changed `.ipynb` edit and read handling to route through notebook serialization helpers
- Changed `.ipynb` reads to return an editable cell text representation and apply edits back to notebook JSON while preserving cell metadata and outputs where possible.

### Removed

- Removed the `notebook.enabled` configuration option from tool settings

### Fixed

- Fixed hashline edit streaming preview collapsing to a header-only "opaque box" when a second `@PATH` section header arrived mid-stream — earlier completed sections now stay rendered while the trailing section is still being typed.

## [14.7.2] - 2026-05-06
### Breaking Changes

- Removed the exported `BUILTIN_TOOL_METADATA` API, including `BuiltinEntry`-style metadata exports and discoverable-built-in helper exports, which will break consumers relying on those symbols

### Changed

- Updated discoverable tool search (`search_tool_bm25` and related discovery metadata) to read each tool’s own `summary` field when present, improving discoverability descriptions for built-in tools

### Fixed

- Fixed SearXNG web search Basic Auth validation to reject RFC 7617 control characters and clarified the equivalent `config.yml` and environment variable settings.
- Fixed extension commands that return without starting a model turn leaving the interactive `Working…` spinner active indefinitely. (#927)
- Fixed `authHeader: true` provider overrides without custom `models` so built-in model transport headers receive `Authorization: Bearer <resolved-key>` (#929).

## [14.7.1] - 2026-05-06

### Added

- Added `pr_create` operation to the GitHub tool to create pull requests with title/body (or `fill`), base/head branch, draft, reviewer, assignee, and label options and return a summarized result including the new PR URL
- Added `read.summarize.prose` setting to keep Markdown and plain-text reads out of the structural summarizer by default.

### Changed

- Changed the `PI_GREP_WORKERS` environment variable help text to state that it sets filesystem walker workers, defaults to 4, and uses `0` for automatic worker selection
- Changed hashline replacement and pure-insert auto-absorb to also drop a single duplicated structural-closing line (`}`, `);`, `]`, etc.) on either boundary when keeping it would unbalance brackets. The pure-insert variant fires regardless of `edit.hashlineAutoDropPureInsertDuplicates`, while the existing 2+ line generic absorb stays gated on that setting.

## [14.7.0] - 2026-05-04
### Breaking Changes

- Changed session system-prompt APIs to use ordered string block arrays by requiring `buildSystemPrompt`, `CreateAgentSessionOptions.systemPrompt`, `Session.rebuildSystemPrompt`, and extension `before_agent_start`/`getSystemPrompt` hooks to accept and return `systemPrompt: string[]` instead of a plain system-prompt string or separate `projectPrompt` field
- Changed `buildSystemPrompt` and session `rebuildSystemPrompt` APIs to return `{ systemPrompt, projectPrompt }`, requiring callers expecting a plain system prompt string to update to the new shape
- Removed the top-level `sel` parameter from the `read` tool schema, requiring callers to migrate to `path`-embedded selectors (for example `path:50-100`, `path:raw`, or `https://...:L1-L40`)

### Added

- Added a separate `projectPrompt` artifact containing per-session project context (workstation, context files, AGENTS.md rules, workspace tree, and append prompt) so dynamic context is decoupled from the static system prompt
- Added `Project prompt` token accounting to context-usage breakdowns and charts
- Added `tools.elideFileMutationInputs` setting to optionally elide large `write`, `edit`, and `apply_patch` payloads in history after successful mutations
- Added hashline-style return data for elided `write` calls so tools can include the resulting file content without leaking full input text
- Added `buildDirectoryTree` and `DirectoryTree` exports to generate configurable directory trees with options for depth, entry limits, hidden-file handling, and truncation caps
- Added `buildWorkspaceTree` and `WorkspaceTree` exports so callers can precompute and pass a workspace context to prompt generation
- Added `workspaceTree` support to `buildSystemPrompt` options to reuse a prebuilt directory snapshot
- Added `read.summarize.enabled`, `read.summarize.minBodyLines`, and `read.summarize.minCommentLines` settings to control whether `read` returns structural summaries and how many multiline body/comment lines are collapsed
- Added `edit.hashlineAutoDropPureInsertDuplicates` setting to opt into dropping 2+ pure-insert hashline payload lines that duplicate adjacent file context; default is `false`.

### Changed

- Updated session dump and HTML export output to serialize ordered system-prompt blocks (including project context) and removed the dedicated project-prompt dump section
- Renamed context-usage system-prompt accounting from a separate `projectPrompt` bucket to `systemContext` to match the new multi-block prompt structure
- Changed prompt delivery to inject non-empty `projectPrompt` as a leading `developer` message before conversation messages instead of merging it into the base system prompt
- Added `projectPrompt` to session dumps to expose the injected per-session project context separately
- Changed write success output and preview rendering to display hashline-formatted written content from captured file text when mutation inputs are elided
- Changed `read` directory rendering to return a two-level recency-sorted directory tree (including nested folders) instead of a flat alphabetical entry list, while still applying configurable truncation
- Changed generated system prompts to include a working-directory tree block after directory context, showing recent files/directories (depth ≤ 3) and truncation notices when entries are elided
- Changed `read` summary rendering to merge opening- and closing-brace boundaries around elided sections into a single `..` line (including closers like `};` or `})`), reducing those segments to one concise anchored summary line
- Changed default `read` output for parseable code files without an explicit selector to return a structural summary instead of full verbatim lines, while still supporting full output for `:raw` and explicit ranges
- Changed truncation/pagination hints in read, archive, and SQLite outputs to use colon syntax (`Use :<offset>`) when continuing reads
- Changed the read tool UI preview title to include summary elision counts when a summary is returned
- Changed hashline pure-insert duplicate auto-drop to be opt-in through `edit.hashlineAutoDropPureInsertDuplicates` instead of always enabled.

### Fixed

- Fixed selector parsing for colon-containing paths by only splitting `:<sel>` when the suffix matches a valid line-range or `raw` pattern, preventing paths like `db.sqlite:users:42` from being misread as selectors

## [14.6.6] - 2026-05-04

### Added

- Added Ctrl+D draft persistence: pressing Ctrl+D with text in the editor now exits the app and saves the unsent text as a per-session draft. Resuming the same session (e.g. via `--resume`) restores the draft into the editor (one-shot, removed after restore).

## [14.6.4] - 2026-05-03
### Added

- Added `hindsight.mentalModelsEnabled`, `hindsight.mentalModelAutoSeed`, `hindsight.mentalModelRefreshIntervalMs`, and `hindsight.mentalModelMaxRenderChars` settings to control curated Hindsight mental-model activation, seeding, refresh cadence, and prompt render budget
- Added `<mental_models>` injection to developer instructions, loading bank-level curated summaries as stable background context
- Added built-in `/memory mm` commands (`list`, `show`, `refresh`, `history`, `seed`, `reload`, `delete`) to inspect and manage mental models on the active bank
- Added scope-aware mental-model seeding for `global`, `per-project`, and `per-project-tagged` banks, including built-in seed models like user preferences, project conventions, and project decisions
- Added warning output when hashline block replacements auto-absorbed duplicate boundary lines

### Changed

- Changed `/memory clear` and `/memory enqueue` to apply only to the current agent session’s Hindsight cache instead of all live Hindsight sessions
- Changed the prompt assembly order so `<mental_models>` blocks are appended before `<memories>` recall blocks in developer instructions

### Fixed

- Fixed Hindsight memory prompt injection and recall/retain tool execution to resolve against the active session state, preventing context from an unrelated session from being used
- Fixed subagent `/task` sessions to persist memories into the parent agent’s Hindsight bank by explicit parent state wiring
- Fixed per-session memory retention behavior when switching or resuming sessions by rekeying Hindsight state and resetting conversation-tracking counters so first-turn recall and nth-turn retain cadence no longer leak across conversations
- Fixed the first-turn startup race so `<mental_models>` appears in the opening system prompt when mental-model loading is enabled
- Fixed retention hygiene by stripping `<mental_models>` blocks from retained content to prevent curated summaries from feeding back into future memory writes
- Fixed `<mental_models>` rendering to honor the configured character budget and truncate with an explicit truncation marker when the snapshot exceeds limits
- Fixed hashline replacements so duplicated payload boundary lines adjacent to a replaced block are absorbed into the replacement range instead of being duplicated

## [14.6.3] - 2026-05-03

### Breaking Changes

- Renamed hashline separator configuration from `PI_HASHLINE_SEP` to `PI_HL_SEP` and changed the default payload separator from `\\` to `>`

### Added

- Added inline hashline edit syntax so `< ANCHOR${sep}TEXT` prepended text to an anchored line and `+ ANCHOR${sep}TEXT` appended text to it without requiring a multi-line payload block
- Added a `memory.backend` setting (off, local, hindsight) under a new Memory settings tab to control which memory subsystem is active
- Added Hindsight memory settings (`hindsight.*`) for API connection, bank identification, and recall/retain policy
- Added `retain`, `recall`, and `reflect` tools for direct long-term memory search, retention, and reflection when using the Hindsight backend
- Added `hindsight.scoping` setting (`global`, `per-project`, `per-project-tagged`) that controls whether memories are shared across projects, isolated per cwd, or tagged so global + project memories merge on recall (default: `per-project-tagged`)
- Added `search_code`, `search_commits`, and `search_repos` ops to the `github` tool so the search surface mirrors `gh search`'s subcommands

### Changed

- Changed `hindsight` tool retains to enqueue memory writes and return `Memory queued.` immediately instead of waiting on a network request
- Changed `hindsight` tool memory writes to use automatic background batching (up to 16 items or 5 seconds) so tool calls do not block
- Changed failed `hindsight` queue flushes to be surfaced as UI warning notices rather than failing the foreground `hindsight` tool call
- Changed hashline read/search previews and diff output to keep `|` as the anchor-to-text separator while using the separate configured edit payload separator
- Mapped invalid `hindsight.scoping` settings back to the default `per-project-tagged` behavior with a warning
- Changed `/memory view`, `/memory clear`, and `/memory enqueue` to route through the selected memory backend instead of being hardcoded to local memories
- Changed compaction context assembly to include backend-provided recall context when available
- Updated multi-path `search`, `find`, `ast-edit`, and `ast-grep` calls to skip missing base paths, returning matches from remaining paths and reporting skipped paths in output
- Replaced `hindsight.dynamicBankId` (boolean) with the explicit `hindsight.scoping` enum; legacy values are migrated automatically (`dynamicBankId=true` → `scoping="per-project"`)
- Changed `search_repos` to run as a global repository search using query qualifiers without applying the `repo` filter

### Deprecated

- Set explicit `hindsight.scoping` now takes precedence over legacy `hindsight.dynamicBankId` when migrating old settings

### Removed

- Removed legacy `hindsight.dynamicBankId` and `hindsight.agentName` fields from the active settings model
- Removed `hindsight.agentName` and the `HINDSIGHT_AGENT_NAME` / `HINDSIGHT_CHANNEL_ID` / `HINDSIGHT_USER_ID` env vars; the legacy `agent::project::channel::user` bank tuple is gone. A user-set `agentName` is migrated onto `hindsight.bankId`.

### Fixed

- Fixed pending `hindsight` queued memory writes to flush on agent end, clear, and enqueue operations so tool-invoked facts are not dropped when sessions transition
- Fixed retained memory writes from the `hindsight` tool to include session context and tags consistently in background batches
- Fixed inline hashline modify operations to fail fast when combined with a delete or replace on the same target line
- Fixed hashline parsing of payload blocks to handle a shared extra leading symbol prefix (such as markdown `>>`) on all payload lines by stripping it as an auto-correction instead of rejecting the edit
- Forwarded project scoping tags to `hindsight` retain, recall, and reflect operations so manual memory commands honor the active tagging mode
- Fixed legacy migrations by mapping existing `memories.enabled` values to `memory.backend` on load to preserve prior enable/disable behavior
- Fixed memory retention so recalled `<memories>` blocks and legacy `<hindsight_memories>` / `<relevant_memories>` blocks are stripped before storing transcripts and do not feed back as new memory
- Fixed `search_code` output to include each match path, repository, shortened SHA, and a one-line matching fragment
- Fixed `search_commits` output to show shortened SHAs with commit message first lines
- Fixed `search_repos` output formatting to return repository summaries including language, stars, forks, issues, visibility, and key status fields

## [14.6.2] - 2026-05-03

### Added

- Added `statusLine.sessionAccent` to disable session-name accent coloring for the editor border and status line gap ([#918](https://github.com/can1357/gajae-code/issues/918))

### Fixed

- Disabled repeated OSC 11 background-color polling under WSL to avoid Windows terminal tab crashes while keeping initial and event-driven appearance detection ([#914](https://github.com/can1357/gajae-code/issues/914))

- Fixed SSH ControlMaster socket paths to use OpenSSH's connection hash (`%C`) so connections to the same host with different users, ports, or jump hosts do not share a master session.

## [14.6.1] - 2026-05-02

### Changed

- Updated GitHub call headers to display operation-specific titles and contextual metadata such as repository, branch, issue/PR IDs, and search query snippets for supported operations
- Changed non-run-watch result rendering to honor terminal width, truncate long lines, and show a `+N more lines` expansion hint when output exceeds the preview limit

### Fixed

- Fixed GitHub tool output fallbacks that previously always showed a GitHub Run Watch heading so they now show the actual operation and clear `no output`/`request failed` status messaging

## [14.6.0] - 2026-05-02

### Breaking Changes

- Reworked autoresearch storage and protocol. State now lives in `~/.gjc/autoresearch/<project>.db` (SQLite) and per-run logs in `~/.gjc/autoresearch/<project>/runs/<id>/benchmark.log`. The repo-side artifacts `autoresearch.md`, `autoresearch.sh`, `autoresearch.checks.sh`, `autoresearch.program.md`, `autoresearch.ideas.md`, `autoresearch.jsonl`, `.autoresearch/`, and `autoresearch.config.json` are no longer read or written; they are deleted by `/autoresearch clear`. Any existing data is not migrated.
- Removed the autoresearch edit guard. `write`/`edit`/`ast_edit` are no longer blocked based on scope. Scope/off-limits are now post-hoc accountability fields on `log_experiment`.
- Replaced rigid `init_experiment` contract validation with a simpler schema: `name`, `goal`, `primary_metric`, `metric_unit`, `direction`, `secondary_metrics`, `scope_paths`, `off_limits`, `constraints`, `max_iterations`, `new_segment`. Removed `from_autoresearch_md`, `abandon_unlogged_runs`, `force`, and `preferred_command` flags — the harness `./autoresearch.sh` is the canonical workload, edit it and bump segment when you need to change it.
- `run_experiment` no longer accepts a `command` parameter. The tool always runs `bash autoresearch.sh`. To change the workload, edit the harness and call `init_experiment new_segment: true`. Removed `force`, `checks_timeout_seconds`, and the legacy `autoresearch.checks.sh` auto-execution; run validation through the regular `bash` tool.
- Replaced `log_experiment` ASI requirements and `force`/`skip_restore` flags with `justification` (post-hoc explanation for scope deviations) and `flag_runs` (mark earlier runs suspect to exclude them from baseline math). ASI is now opaque metadata.
- `/autoresearch clear` now resets the worktree to the session's recorded baseline commit (when on an `autoresearch/*` branch or with `--reset-tree`), closes the active session, and deletes any leftover legacy autoresearch repo artifacts.
- `/autoresearch` now refuses on a dirty worktree with an explicit error instead of silently continuing on the current branch. Commit or stash before invoking — the session needs a clean baseline on a dedicated `autoresearch/*` branch.
- Split `/autoresearch` into a two-phase protocol. Phase 1 (no session) prompts the agent to build the benchmark harness as `./autoresearch.sh` (must exit 0 and print `METRIC <name>=<value>`). Calling `init_experiment` ends Phase 1: it requires `./autoresearch.sh` to exist, auto-commits any pending harness changes on an `autoresearch/*` branch, then records that commit as the baseline. Phase 2 is the existing iteration loop.
- Autoresearch sessions are now scoped to the git branch they were created on. Switching off the `autoresearch/*` branch hides the dashboard widget, detaches the experiment tools, and skips the autoresearch system prompt; switching back resumes seamlessly. `/autoresearch` on a fresh branch starts a fresh session instead of resurrecting a session bound to a different branch.
- `log_experiment discard` no longer rewinds prior `keep` commits. On an `autoresearch/*` branch it now resets the worktree to `HEAD` (and `git clean`s untracked) instead of `git reset --hard $baseline_commit`. Discard reverts only the current iteration's uncommitted edits; previously kept improvements stay on the branch. `/autoresearch clear` continues to reset to the recorded baseline commit when explicitly requested.
- Autoresearch SQLite storage is now created lazily on first `init_experiment`. Running `gjc` in a project that never invokes `/autoresearch` no longer creates a per-folder DB.

- Changed `search`, `find`, `ast_grep`, and `ast_edit` to accept `paths: string[]` instead of comma- or whitespace-delimited path strings.

### Added

- Added `update_notes` tool with `body` (replace) and `append_idea` (append a bullet under an `## Ideas` section). Notes are injected into the system prompt every iteration and replace the file-based `autoresearch.md` / `.program.md` / `.ideas.md` ecosystem.

### Changed

- Updated `log_experiment` summary output to include the count of scope deviations detected for a run
- Used the active session context in autoresearch resume instructions instead of referencing deleted repo-side files
- Removed `PI_STRICT_EDIT_MODE`; model-specific edit mode fallbacks are no longer disableable by environment flag.

### Fixed

- Atom edit auto-rebase warning now dedupes by `(originalLid, rebasedLine)` pair. Previously, `@Lid` followed by N `+TEXT` lines emitted N identical "Auto-rebased anchor" warnings (one per cloned cursor anchor); now emits exactly one per distinct rebase.
- Atom/hashline diff preview no longer renders deleted lines with a 2-space hash placeholder (`-20  |old`) that visually mimicked a Lid. Removed lines now use `--` as the placeholder (`-20--|old`), making them unambiguously non-Lid.
- Atom/hashline diff preview no longer folds size-mismatched `-`/`+` runs into a confusing mix of `*` (paired modification) lines plus surplus `-`/`+` lines. The `*` collapse now applies only to clean 1:1 line replacements (same number of dels and adds); range replaces with N→M (N≠M) render as plain unified-diff `-` then `+` runs.
- Atom edits now warn when `@Lid` lands on a brace-opening line and the inserted content is at sibling indent (≤ anchor indent) — a foot-gun where the agent meant `^<nextSibling>` but the inserts ended up as the first body element of the `{...}` block.
- Atom auto-fix warning for adjacent-duplicate cleanup is now formatted as `AUTO-FIX applied — verify the result. Removed ...` instead of the easier-to-miss `Auto-fixed: removed ...`, and explains that `{}/()/[]` balance was the trigger.
- Fixed multi-target `search`, `ast-grep`, and `ast-edit` path handling by running each resolved target separately under root-level path resolution
- Fixed pagination and match/replacement summaries for multi-target AST and text searches so totals and affected file counts include all targets
- Fixed returned file paths for multi-target `search` and `ast-grep` results by normalizing them to the original search scope
- Fixed `log_experiment keep` silently dropping the iteration's diff on an autoresearch branch. The previous logic filtered out every path that was already dirty when `run_experiment` ran — but in the iteration cycle the agent's edits always land before `run_experiment`, so the entire iteration was filtered away and nothing was committed. On an autoresearch branch, `keep` now treats every currently-dirty path as the iteration's change and commits it.

## [14.5.14] - 2026-05-01

### Changed

- Changed markdown conversion and archive tooling to defer loading heavy dependencies (Turndown, fflate, and browser agent content) until first use, reducing startup overhead for CLI startup and command initialization

### Fixed

- Fixed changelog state tracking by flushing `lastChangelogVersion` to settings immediately when showing new entries, so the updated version is persisted across restarts

## [14.5.13] - 2026-05-01

### Breaking Changes

- Removed the built-in `python` tool in favor of `eval`, so tool allowlists and tool-call handlers referencing `python` need to migrate
- Removed the `python.toolMode` setting and replaced mode control with separate `eval.py` and `eval.js` toggles
- Changed the tool runtime config surface by migrating `python` execution timeout/export behavior to `eval` and replacing `./ipy/*` internal exports with `./eval/*` paths
- Changed the `eval` tool wire format to a single `input` string composed of markdown fenced code blocks (with per-fence language, timeout, title, and reset metadata in the info string) instead of top-level `cells`, `language`, `timeout`, and `reset` fields

### Added

- Added a JavaScript backend to the `eval` tool with an in-process VM runtime and JS helper bridge (`read`, `write`, `glob`, etc.)
- Added `eval.py` and `eval.js` settings so Python and JavaScript `eval` backends can be enabled or disabled independently
- Added `rename_file` action to the Lsp tool to rename files and directories with LSP `workspace/willRenameFiles` and `workspace/didRenameFiles` flow, applying returned workspace edits before moving files
- Added `apply: false` preview mode for `rename_file` so users can see planned LSP edits without performing filesystem changes
- Added `request` action to invoke arbitrary LSP methods, with automatic `textDocument`/`position` parameter construction from `file`/`line`/`symbol` and support for explicit JSON `payload`
- Added `capabilities` action to display language server capabilities (for a file or all configured servers) through the LSP tool

### Changed

- Changed AGENTS.md discovery to respect `.gitignore` files during project context collection so ignored context files are no longer loaded
- Changed eval tool initialization to skip Python kernel preflight when the JavaScript backend is enabled, avoiding unnecessary startup checks
- Changed model registry refresh flow to defer rebuilding the canonical model index until refresh operations complete, reducing refresh churn
- Changed execution/tool discovery flow so `exec` maps to `eval` when any `eval` backend is enabled, while `bash` stays independently available
- Changed `eval` dispatch to automatically fall back to JavaScript when Python is unavailable and JavaScript backend is enabled
- Parallelized plugin root preloading with other startup initialization in `runRootCommand` to reduce startup latency
- Parallelized session bootstrap work in `createAgentSession`, including AGENTS.md scanning, context discovery, prompt template loading, slash command loading, and skill discovery, to reduce time to first available session

### Fixed

- Fixed eval startup messaging to report `eval` as unavailable when Python is unreachable and JavaScript backend is disabled

### Fixed

- Stabilized MCP tool ordering so reconnects and refreshes no longer reorder the tools array sent to the model. Anthropic prompt caching is keyed on byte-identical tool definitions; previously, the order depended on connection sequence and a single MCP server reconnect could shuffle tools across servers and invalidate the tools cache breakpoint.
- Skipped redundant system-prompt rebuilds in `AgentSession.refreshMCPTools` when the active tool set is unchanged. MCP transport flapping (e.g. routine 5-minute SSE reconnects) used to call `rebuildSystemPrompt` on every reconnect even though the resulting prompt was byte-identical, eating CPU and risking cache misses if the rebuild ever became non-deterministic. The applied-tool signature also covers `customWireName` so a wire-name flip with the rest of the tool metadata constant still forces a rebuild.

## [14.5.12] - 2026-04-30

### Breaking Changes

- Removed the legacy browser action verbs (`goto`, `observe`, `click`, `type`, `fill`, `press`, `scroll`, `drag`, `wait_for_selector`, `extract_readable`, and `screenshot`) in favor of invoking those workflows through `run`

### Added

- Added a `browser` tool `open`/`run`/`close` flow with a `run` action that executes async JavaScript and provides `page`, `browser`, `tab`, `display`, `assert`, and `wait` in scope
- Added named tabs on `open` with default name `main` so browser state can be reused across `run` calls and subagents
- Added support for `app.path` and `app.cdp_url` on `open` to launch/connect to CDP-capable desktop apps

### Changed

- Changed browser tool output rendering to display `run` calls as JavaScript code cells with status and output previews while showing `open`/`close` as compact status lines
- Changed `open` to open or reuse named tabs and `close` to support `all: true` and `kill`-based process termination behavior
- Changed app attachment behavior to reuse an existing CDP endpoint when available and avoid unnecessary respawn of matching app processes
- Changed tab closing so closing a tab no longer implicitly affects unnamed sessions when multiple tabs are used
- Changed browser export rendering to label outputs under the `browser` tool and include app metadata badges

### Fixed

- Fixed Electron/CDP attachment target selection to skip helper windows and pick the most likely user-visible page target
- Fixed connection startup by waiting for the CDP endpoint and surfacing a timeout error when it does not become available
- Fixed plan mode to auto-redirect `write` and `edit` calls targeting a bare `PLAN.md` (or any same-basename cwd-relative path) to the canonical `local://PLAN.md` plan artifact instead of rejecting them

## [14.5.11] - 2026-04-30

### Breaking Changes

- `todo_write`: renamed `replace` op to `init` and reshaped its input to `list: [{phase: string, items: string[]}]`. Tasks no longer accept a `status` field; all start `pending` and the first auto-promotes to `in_progress`. The `append` op's `items` is now `string[]` (was `{id, label}[]`)
- `todo_write`: removed the synthetic `task-N` / `phase-N` ids — task identity is now its `content` and phase identity is its `name`. The `task` field on `start`/`done`/`drop`/`note` and the `phase` field on `done`/`drop`/`rm`/`append` take those values directly
- `todo_write`: phase names no longer accept a numeric/roman prefix (`I.`, `1.`, `Phase 1:`, …). The renderer numbers phases visually (Ⅰ. Ⅱ. Ⅲ. …) and the model-facing state stores the bare noun phrase

### Changed

- Changed `/todo` task and phase operations to target items by fuzzy content or phase name matching instead of numeric IDs
- Changed initial todo markdown export template heading from `# I. Todos` to `# Todos`

### Fixed

- Fixed todo auto-clear scheduling to identify completed tasks by phase and content so only the matching task is cleared after delays

## [14.5.10] - 2026-04-30

### Breaking Changes

- Removed the `worktree` parameter from `github` `pr_checkout`. Worktrees are now always written to `~/.gjc/wt/<encoded-primary-repo>/pr-<number>/`, derived from the primary repository path
- Stopped reading the `branch` parameter for `github` `pr_checkout`. The local branch is now always `pr-<number>`; the `branch` schema field is still accepted by `pr_push`, `repo_view`, and `run_watch`

### Added

- Added `checkouts` summary entries to `pr_checkout` results, including each checkout's branch, worktree path, remote, and reuse status
- Added combined summaries for `pr_view` and `pr_diff` when `pr` is an array, so multi-request responses now include all requested pull requests in one return
- Added array support to the `pr` parameter on `github` `pr_view`, `pr_diff`, and `pr_checkout` so a single call can fetch, diff, or check out multiple pull requests in one batch
- Added a per-repo serialization lock (`withRepoLock`) so concurrent `pr_checkout` calls against the same repository no longer race on git's internal `.git/config.lock`, commit-graph, and worktree lock files

### Changed

- Changed the diff preview shown after edits so changed lines are never collapsed: removed runs and the global preview budget no longer truncate, only unchanged context still collapses
- Changed adjacent `-`/`+` pairs in edit previews to fold into a single `*<line><hash>|<new-content>` modification line so 1:1 line replacements stay compact
- Changed `git.remote.add` to be idempotent when the remote already exists with the same URL (instead of failing with `remote ... already exists`), and to surface a clear error when the existing URL differs
- Changed `pr_checkout` to run `gh pr view` calls in parallel for batch invocations while serializing the in-repo git mutations to keep the operation race-free
- Changed `pr_checkout` to auto-derive the worktree location and local branch name (see Breaking Changes), removing the per-call overrides that previously let callers pin a worktree path or local branch

### Removed

- Removed the `./hooks` and `./hooks/*` package export entries
- Removed the `Suspicious duplicate` warning emitted after edits — it produced too many false positives (e.g. legitimate adjacent `\t});\n\t});`); the auto-fix path that uses bracket balance to safely de-duplicate is unchanged

### Fixed

- Fixed bash interceptor rules to also check the original command before `cd` normalization, so leading `cd ... &&` wrappers no longer bypass interception
- Fixed LSP client shutdown to properly await the language server's exit instead of fire-and-forget, preventing premature process termination on SIGINT and SIGTERM
- Fixed concurrent bash commands being tracked independently so aborting one no longer silently drops tracking of others

## [14.5.9] - 2026-04-30

### Added

- Added the `/context` slash command to display an estimated context-usage breakdown panel for the current session
- Added `-LidA..LidB` syntax to delete inclusive line ranges in a single atom operation
- Added `LidA..LidB=TEXT` range-replace syntax with `\TEXT` and `\` continuation lines for multi-line replacement blocks
- Added shorthand cursor+insert operations in atom edits, including `^Lid` (insert before anchor), `^+TEXT`, `$+TEXT`, and `Lid+TEXT`/`@Lid+TEXT`
- Added standalone file-op fallback so `!rm` and `!mv DEST` inputs can be normalized into sections when using split input parsing

### Changed

- Changed token counting to use tokenizer-based estimates instead of a character-per-4 heuristic for context and compaction calculations
- Changed hashline anchor auto-rebase tolerance from ±2 lines to ±5 lines for stale Lid recovery
- Changed atom input handling so `#`-prefixed lines are treated as comments and ignored
- Changed execution when all edits are no-op `Lid=TEXT` replacements to return success with a no-change explanation instead of throwing

### Fixed

- Fixed malformed range and unified-diff-like atom syntax by rejecting reversed ranges, mismatched range endpoint hashes, and forms like `+Lid|TEXT`, `+Lid=TEXT`, and `-LidA..LidB|TEXT` with explicit actionable errors
- Fixed hash mismatch errors to include likely-shifted anchor hints when a unique matching line is found elsewhere in the file

## [14.5.8] - 2026-04-29

### Breaking Changes

- Changed the task runner toggle from `just.enabled` to `runCommand.enabled`, so existing configurations using `just.enabled` must be migrated
- Removed the legacy `just` tool and replaced it with `run_command`
- Renamed the built-in tool API from `just` to `run_command`, so clients requesting/handling the old tool name must update

### Added

- Added a new `run_command` tool that runs project tasks via a single `op` argument, auto-detecting and supporting recipes from justfiles, `package.json` scripts (including workspace packages), Cargo bin/example/test targets, Makefiles, and Taskfiles
- Added support for explicit runner-qualified tasks via `run_command` with `runnerId:task` syntax in the prompt guidance

### Changed

- Changed automatic tool availability so requesting `bash` can now auto-include `run_command` when a supported task runner manifest is detected in the working directory
- Changed task resolution to disambiguate identical task names across multiple runners and show runner-aware command execution errors

### Fixed

- Fixed editor draft being erased when a user message queued during streaming was eventually submitted; the queue/steer path now preserves any new prompt the user has typed since queuing, matching the existing optimistic-send protection.

## [14.5.7] - 2026-04-29

### Fixed

- Fixed hook editors to recognize Ctrl+Enter when terminals include NumLock or keypad Enter metadata.

## [14.5.6] - 2026-04-29

### Changed

- Removed the atom edit mode's multi-anchor auto-rebase rejection so stale-but-uniquely-rebasable block edits apply with warnings instead of failing.

## [14.5.5] - 2026-04-29

### Breaking Changes

- Rejected atom diffs with unrecognized operations (including lone '-' lines) by throwing parse errors instead of treating them as inserts

### Added

- Added duplicate-line post-edit detection that warns on newly introduced adjacent identical lines and auto-removes one duplicate when bracket-balance is restored
- Added a warning when suspicious adjacent duplicates are introduced after edits so users can review potential stale-line issues

### Changed

- Changed anchor rebase handling to fail when multiple mutating anchors would need auto-rebase, preventing silent misapplied contiguous block rewrites

### Fixed

- Fixed bracket-corruption caused by botched block rewrites by automatically removing a newly introduced duplicate adjacent line when removing it restores the original `{}`, `()`, and `[]` balance and by warning when automatic removal is unsafe

## [14.5.4] - 2026-04-28

### Breaking Changes

- Changed the `atom` edit mode from JSON `{ path, edits }` calls to the compact file-oriented `input` patch language that was previously exposed as `atomd`; `atomd` is no longer a separate edit variant
- Renamed MCP tool identifiers from the `mcp_<server>_<tool>` format to `mcp__<server>_<tool>` so custom tool names, active tool lists, and persisted MCP selections must be updated to the new prefix
- Renamed the built-in content-search tool from `grep` to `search`, including SDK/tool event names and settings keys (`search.enabled`, `search.contextBefore`, `search.contextAfter`), so integrations using `grep` and `grep.*` references must be updated

### Added

- Added the `after_provider_response` extension event for observing provider response status, headers, and request IDs.
- Added internal URL support to the `search` tool, allowing `artifact://`-style paths that resolve to local files to be searched directly
- Added IRC relay observation in the main agent UI so every IRC exchange between agents is rendered in the main transcript, even when the main agent is not a direct participant
- Added stateful `href`/`hrefr` prompt helpers that can reuse anchors remembered from prior `hline` helper calls

### Changed

- Changed file-path rendering across search, find, AST, LSP, and related edit outputs to display targets as cwd-relative paths when they resolve inside the working directory and keep absolute paths for files outside the cwd
- Changed system prompt guidance so in-cwd tool paths must be passed as cwd-relative paths and absolute paths only for out-of-cwd targets or `~` expansion
- Updated `edit` streaming diff previews for `patch`, `replace`, and `hashline` to produce a single request-level preview for the new single-file `path` mode
- Bumped default `read.defaultLimit` from 300 to 500 lines, and scaled the read tool's byte budget with the line limit (`max(50KB, lines * 512)`) so the configured line count is no longer truncated by the shared 50KB cap

### Fixed

- Fixed atom edit streaming previews to use atom headers for file names instead of apply_patch parsing errors.
- Fixed collapsed search result rendering so summary and truncation rows stay within the collapsed output budget
- Updated search path handling to support path lists and internal file paths while preserving previous search behavior

## [14.5.3] - 2026-04-27

### Added

- Added bracketed `loc` forms `(anchor)`, `[anchor]`, `[anchor`, `(anchor`, `anchor]`, and `anchor)` to `atom` `splice` editing so a single anchor can target a block body, whole node, or partial node region
- Added automatic block-delimiter inference for block splices using file extension, defaulting to `{` and using `(` for Lisp-family files
- Added optional `pre`/`post` arguments to the `href` prompt helper so hashline references can be wrapped as bracketed or parenthesized anchors
- Added destination-aware indent handling for block replacements by detecting file indent style and reapplying tabs/spaces to spliced body text

### Changed

- Changed bracketed atom locators to be `splice`-only and reject `pre`, `post`, or `sed` on region locators
- Changed `applyAtomEdits` to forbid mixing `splice_block` with other anchor-scoped edit verbs in one call
- Changed `splice_block` resolution behavior to include selected block range and enclosing-count context in warning output
- Changed balanced-block parsing to support `kind` selection (`{`, `(`, `[`), nesting depth, and safer same-line enclosing selection

### Removed

- Removed the `sed` `F` option for literal matching; `sed` now accepts only `pat`, `rep`, and optional `g`, with `F`-style literal matching no longer supported

### Fixed

- Fixed `splice_block` multi-line replacements to replace the exact target region and avoid duplicate braces or duplicated signature lines from bare-anchor `splice` attempts
- Fixed false-positive “unbalanced” replacement-body warnings caused by braces in regex/string/comment text by skipping those constructs during block scanning
- Fixed `splice_block` for same-line `(` bodies so inline call sites like `int(port)` can be replaced correctly

## [14.5.2] - 2026-04-26

### Breaking Changes

- Removed support for sed-style string expressions and required `sed` to be specified as an object with `pat` and `rep` (and optional `g`, `F`, `i` flags)

### Changed

- Changed atom `sed` replacements to be global by default and require `g:false` for first-match-only replacements
- Changed anchor validation so multiple `sed` operations can target the same line and run sequentially
- Changed cross-entry conflict resolution so `del` edits on an anchor are ignored when that line is also replaced by `sed` or `splice` in another edit entry

### Fixed

- Fixed zero-length regex `sed` patterns (for example `()`, `^`, `$`) to fall back to literal substring matching instead of producing insertion-like replacements
- Fixed `sed` chaining so each edit on the same anchor applies to the latest line state from prior replacements

## [14.5.1] - 2026-04-26

### Removed

- Removed `\t` escaped-tab indentation autocorrect from hashline and atom edit modes (and the `PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS` environment toggle); literal `\t` in edit content is now preserved verbatim
- Removed the suspicious-`\uDDDD` warning preflight from hashline edits
- Removed the hand-rolled JSON unescape fallback in the streaming edit-arg renderer; partial fragments that fail `JSON.parse` are now surfaced raw rather than partially decoded with a non-spec-compliant unescaper that mishandled lone surrogates

## [14.4.3] - 2026-04-26

### Added

- Added `irc` tool for agent-to-agent messaging with `list` and `send` operations, including optional broadcast to `all` and optional suppression of reply waits
- Added `irc.enabled` tool setting (default `true`) to toggle agent-to-agent messaging
- Added live in-chat rendering of IRC incoming and auto-reply messages so peer messages now appear in the session transcript

### Changed

- Changed peer-aware prompts for subagents to include currently live agent peers and IRC usage guidance when available
- Changed the `/btw` helper to use a session-side ephemeral turn path that preserves streaming-context handling and updates the existing request handling behavior
- Merged the `poll` and `cancel_job` tools into a single `job` tool that accepts `poll` and `cancel` arrays; the renamed tool reuses the richer poll renderer for both polling and cancellation calls

### Fixed

- Fixed IRC messaging to use a background ephemeral turn path so a recipient can reply even while its main loop is busy
- Fixed `/btw` handling of empty prompts and missing model configuration by rejecting invalid requests before starting a stream
- Fixed `/btw` request replacement so issuing a new query cleanly aborts the previous active request

## [14.4.2] - 2026-04-26

### Breaking Changes

- Changed `/todo append` from JSON payload input to `/todo append [<phase>] <task...>` with optional quoted tokens and automatic phase creation

### Added

- Added `note` to todo-write operations so you can append follow-up text notes to a task via `op: "note"` and `text`
- Added markdown note-block support to `/todo export` and `/todo import` so task notes are written as blockquote lines and reloaded with the todo list
- Added `/todo export <path>` to write the current todo list as Markdown to a file, defaulting to `TODO.md` when no path is provided
- Added `/todo import <path>` to replace the current todo list from a Markdown file, defaulting to `TODO.md` when no path is provided
- Added live poll progress updates so the UI now emits intermediate job state while waiting for jobs to finish
- Added a dedicated TUI renderer for the `poll` tool that displays job status, counts, duration, and result/error previews
- Added a `/todo` slash command to view and modify todos with `edit`, `copy`, `start`, `done`, `drop`, `rm`, `append`, and `replace` operations
- Added `/todo edit` to open the current todo list in `$EDITOR` as Markdown and sync the edited checklist back into the session
- Added `/todo copy` to copy the rendered Markdown todo list to the clipboard

### Changed

- Changed todo list rendering and summaries to show a `+N` note marker on task lines and display attached notes for tasks in progress
- Changed `/todo start`, `/todo done`, `/todo drop`, and `/todo rm` to resolve task/phase targets by fuzzy id/name matching instead of strict identifiers
- Removed `/todo replace` from supported slash commands
- Changed todo list restoration to include user todo-edit custom session entries so slash-command and editor-based todo updates persist after reload
- Restored sensible defaults for `grep.contextBefore` (1) and `grep.contextAfter` (3) so grep matches show context lines by default after the `pre`/`post` parameters were folded into settings

### Removed

- Removed the `chunk` edit mode, chunk-aware `read` selectors, chunk-aware `grep` rendering, and the `gjc read` chunk CLI subcommand
- Removed the `read.prosechunks`, `read.explorechunks`, and `read.anchorstyle` settings
- Removed the underlying `chunk` native module and AST-based chunk schema generation from `pi-natives`

### Fixed

- Fixed poll final output to reflect live job data from the async job manager, improving status and result visibility
- Fixed job duration and output reporting to use current job snapshots instead of initial poll input metadata
- Fixed `poll` wait duration parsing to fall back to `30s` when the provided value is an empty string

## [14.4.1] - 2026-04-26

### Breaking Changes

- Replaced the legacy `gh_repo_view`, `gh_issue_view`, `gh_pr_view`, `gh_pr_diff`, `gh_pr_checkout`, `gh_pr_push`, `gh_run_watch`, `gh_search_issues`, and `gh_search_prs` tool names with only `github`, which requires updating existing callers that invoked the old `gh_*` tools

### Added

- Added a `sed` verb to the `atom` edit tool for line-local substitutions using sed-style syntax (`s/pattern/replacement/`) with `g`, `i`, and `F` flags and model-tolerant delimiter choices
- Added the unified `github` tool with op-based dispatch for repository, issue, pull request, search, checkout, push, and Actions watch workflows
- Added `op` routing so callers can select `repo_view`, `issue_view`, `pr_view`, `pr_diff`, `pr_checkout`, `pr_push`, `search_issues`, `search_prs`, or `run_watch` through a single tool entry point

### Changed

- Changed hashline-based read and match output formatting to use `LINE+ID|content` as the anchor/content separator, and updated match/context markers to `>` for matches and `:` for context
- Updated GitHub CLI render output to show `GitHub <op>` for tool calls dispatched through `github` operations

### Removed

- Removed the built-in `taplo` Language Server entry from default LSP settings, so TOML files no longer have default TOML server startup

### Fixed

- Fixed `atom` `loc` parsing so path-qualified anchors like `path:263ti| ...` and single-anchor locs containing hyphens no longer mis-parse as ranges
- Fixed hashline anchor handling in `atom` edits so a provided content hint after the anchor (`|` or `:` suffix) can rebond a stale hash to the intended line
- Fixed `atom` `sed` execution to tolerate common model-emitted forms such as `/pat/rep/`, and to apply safe literal fallbacks for regex failures or metacharacter-heavy patterns while still erroring when no match is possible

## [14.4.0] - 2026-04-26

### Breaking Changes

- Removed multi-pattern array input from `ast_grep` by changing `pat` to a single pattern string, so call sites using `pat: [...]` must be updated to send one query per invocation
- Removed `lang`, `glob`, and `sel` options from `ast_edit` and `ast_grep`, and moved those behaviors into the required `path` argument
- Required `path` for `ast_edit` and `ast_grep`, so invocations that relied on implicit repo-root searching are no longer valid
- Changed `todo_write` from multi-field verb payloads to an ordered array of flat operations, while retaining `replace` for harness bootstrap compatibility
- Renamed atom edit operations from `before` and `after` to `pre` and `post`, so existing `atom` payloads using the old operation keys must be updated
- Changed the hashline anchor format from `LINE#ID:content` to `LINEID:content` (no `#` separator, colon between anchor and content, no padding on line numbers); expanded the bigram alphabet from 40 hand-picked English bigrams to the full 647 single-token 2-letter bigrams — invalidates every previously captured `LINE#ID` reference
- Renamed the subagent completion contract from `submit_result` to `yield`, so subagent sessions must now finish with the `yield` tool and the `requireYieldTool` option; `submit_result`/`requireSubmitResultTool` and old completion calls are no longer recognized
- Changed the hashline and chunk anchor ID format from the prior hex-like tokens to two-letter BPE bigrams (for example `#th`), which invalidates previously captured `LINE#ID`/chunk selectors and requires re-reading to refresh anchors

### Added

- Added inline file overrides in atom locators (`loc: "a.ts:160sr"`) so cross-file edits can be written without a separate per-entry `path` field
- Added `openai` to the `providers.image` options, allowing image generation to be explicitly routed through the active GPT Responses/OpenAI code model
- Added `between` atom edit operation to replace only the lines between two surviving anchors while preserving the boundary anchors
- Added conflict detection for `between` atom edits to require non-overlapping regions and forbid edits targeting lines strictly inside those regions
- Added `atom` edit mode to `edit` with single-anchor operations (`set`, `before`, `after`, `del`, `sub`, `ins`) for hashline-anchored line edits
- Added support for request-level `path` defaults in patch, replace, and chunk edits so shared file paths no longer need to be repeated in every entry

### Changed

- Updated `atom` and `hashline` edit anchor validation to auto-rebase a stale anchor within ±2 lines when the same hash matches a unique nearby line, continuing the edit with a warning instead of immediate failure
- Changed bash command output labels from `[full result: artifact://…]` to `[raw output: artifact://…]` for artifact references produced from large command output
- Changed `todo_write` `done`, `rm`, and `drop` operations to target all tasks when neither `task` nor `phase` is provided, and made `append` create the target phase automatically when missing
- Updated `ast_edit` and `ast_grep` to pass file-selection intent through `path` (including inline globs and comma/space-separated path lists) instead of separate `glob` filters
- Changed `ast_grep` pagination API from `offset` to `skip`
- Flattened `todo_write` operation arguments to `{ op, task?, phase?, items? }[]` and removed task details from the persisted todo shape
- Changed `grep` truncation output to report `Result limit reached; narrow path.` and label match/result caps as `first N`
- Changed JSON tree output to truncate inline argument pairs by available width and add an ellipsis when values no longer fit in the display
- Changed JSON tree rendering to hide harness-internal `intent` and `__partialJson` fields from top-level tool output
- Simplified the `grep` tool schema by requiring `path`, folding glob and type filtering into path globs, auto-detecting multiline patterns, removing model-controlled context and limit options, and renaming result skipping to `skip`.
- Changed atom edit request format to use a shared `loc` selector, including range (`"160sr-9ab"`) and boundary (`"^"`, `"$"`) forms instead of per-operation anchor fields
- Changed atom edit payload fields so `set`, `pre`, and `post` now require line-array values and `sub` now takes a `[find, replace]` tuple, with boundary deletion now expressed as `set: []`
- Changed edit diff wrapping to preserve the active line-prefix separator (`|` or `│`) while keeping continuation lines aligned by line-number width
- Changed Vim focus and viewport rendering to align cursor/selection markers and line numbers in a single gutter format
- Changed auto image provider selection for `providers.image=auto` to try active GPT image generation before Antigravity, OpenRouter, and Gemini
- Updated atom and hashline anchor validation to require the full `line+suffix` anchor format and report missing-line-number errors more clearly, including guidance when only a 2-letter suffix is provided
- Changed read, grep, and ast-edit line-prefixed output to drop fixed-width line number padding, so anchors render in natural width without leading spaces
- Updated terminal diff rendering to use a continuous `│` gutter and hide repeated line numbers on adjacent diff lines
- Updated subagent reminders, prompts, and rendered subagent output to reference `yield` completion and report missing/final results from `yield` tool data
- Updated the `edit` workflow to treat `atom` mode like hashline mode for read output, so hashline anchors are shown when `atom` is selected
- Adjusted patch/replace/chunk tooling to accept optional entry paths and to apply a top-level path default
- Updated hashline/chunk selector parsing to the new stable bigram token set used for checksums
- Renamed the image generation implementation module to `image-gen` and routed active GPT Responses/OpenAI code models through OpenAI's hosted `image_generation` tool with WebP output

### Removed

- Removed line-range support from `atom` mode selectors, including `loc` values like `160sr-170ab`, so edits must target a single anchor (`160sr`, `^`, or `$`) per entry
- Removed the atom `del` verb and now require anchored-line deletion to be requested with `set: []`
- Removed `todo_write` task details and the `add_notes` operation

### Fixed

- Improved no-op edit diagnostics for `atom` and `hashline` operations so edits that leave content unchanged now fail with contextual details (edit index, locator, and reason), including guidance for `replace_range` no-op cases
- Wrapped `todo_write` operations in an `ops` object so OpenAI code/OpenAI function schemas always use a JSON Schema object.
- Fixed JSON tree rendering for tool arguments by excluding injected internal keys from displayed root records
- Printed assistant `errorMessage` text in print mode output to stderr so message-level errors are visible during non-interactive runs
- Displayed assistant `errorMessage` text in the assistant message component for completed tool responses with non-terminal stop reasons
- Fixed atom input handling to ignore null optional verb fields so entries with `pre`, `set`, `post`, or `sub` set to `null` remain valid
- Fixed status-line Git branch rendering to degrade gracefully when the process hits `ENFILE`/`EMFILE` while reading optional Git refs
- Changed hashline mismatch failure output to show a clean numbered context block with numbered gutter and full-anchor alignment guidance when edits are rejected after the file changed
- Fixed `atom` mode to apply multiple edits on the same anchor line without index-shift artifacts, so mixed operations like `before`, `after`, `set`, `sub`, `ins`, and `del` now resolve consistently
- Fixed `atom` mode `append_file` insertion to preserve a file’s trailing newline sentinel when appending content
- Fixed `read` output for raw archive entries so hashline anchors, line numbers, and chunked formatting are not injected into raw content
- Fixed hashline parsing so lines like `# Note:` or `# TODO:` are no longer misinterpreted and stripped as hashline prefixes
- Adjusted patch and replace validation to report a clear missing-path error when neither an entry path nor a top-level path is provided

## [14.3.0] - 2026-04-25

### Added

- Added Markdown pipe-table `row_N` chunk selectors for row-level table edits.
- Added `resolveToolAlias` export so tool names in CLI and session setup are normalized to canonical names, including mapping legacy `read` references to `open`
- Added new `open` and `open-chunk` tool prompt documentation pages to describe canonical `open` usage for local files/directories, chunk reads, and URLs
- Added full-output retrieval metadata to minimized shell command output by appending an `artifact://<id>` footer with byte counts, allowing users to open the original unminimized command output
- Added streaming preview API exports from the package (`resolveEditMode`, `EDIT_MODE_STRATEGIES`, and chunk preview helpers) so editors can reuse mode-aware edit preview logic programmatically
- Added `shellMinimizer` configuration options (`enabled`, `settingsPath`, `only`, `except`, and `maxCaptureBytes`) so users can control shell output minimization behavior

### Changed

- Changed the canonical file/URL reader tool from `read` to `open` across default tool lists and routing, including system prompts, plan mode, cursor handlers, and runtime tool registration
- Changed runtime and UI handling to render and track `open` tool calls as first-class (with `read` accepted as legacy alias), including ACP mapping, session observers, and streaming message groups
- Changed chunk edit guidance to document parser-specific region behavior, including TypeScript decorator/JSDoc sibling chunks, Python docstrings as body content, Python opaque nested chunks, Markdown whole-chunk fallbacks, ID volatility, and indentation display differences
- Changed chunk deletion in chunk edit mode to require explicit `delete: true`; `write: null` and bare `{ path }` entries now fail with guidance instead of deleting content.
- Changed chunk edit validation to reject entries with multiple operation fields instead of choosing one and ignoring the rest.
- Changed chunk edit validation to reject `write: ""` as an accidental destructive empty replacement; use the open tool for inspection or `delete: true` for deletion.
- Changed chunk edit responses to warn when appending or prepending to a container without `~`, since that inserts outside the container rather than inside its body.
- Changed fetch output logging so URL-fetch artifacts now use `.open.log` naming instead of `.read.log`
- Changed Bash interception guidance and errors to recommend `open` in place of `read` for cat/head/tail-style commands
- Changed exported SDK tool surface to expose `OpenTool` as canonical and keep `ReadTool` as a compatibility alias
- Changed session list loading to use parallel workers and fixed-size prefix reads per session file, reducing latency when loading many or large sessions
- Changed edit call rendering to use mode-aware streaming diff previews, including multi-file chunk edit previews grouped by file path while arguments are still streaming
- Changed shell execution in both interactive and non-interactive modes to route command output through the configured shell output minimizer
- Changed default behavior so shell output minimization can now be toggled from settings without code changes
- Changed shell output minimization to leave compound and piped commands unchanged; only a single eligible whole command is captured and minimized after it exits

### Removed

- Removed the chunk edit `read: true` operation; use the open tool to inspect chunks without modifying files.
- Removed the `replace: { old, new }` chunk edit operation. Use `write` or `insert` for chunk edits instead.

### Fixed

- Fixed startup crashes on Linux systems where Bun's `os.cpus()` fails on non-contiguous CPU numbering ([#779](https://github.com/can1357/gajae-code/issues/779))
- Fixed `gh_pr_push` so branches without `gh_pr_checkout` metadata fail instead of falling back to the tracked merge branch, and updated the GitHub tool setting copy to stop calling the tool group read-only ([#778](https://github.com/can1357/gajae-code/issues/778))
- Fixed session list metadata extraction to better populate session titles and first-user summaries from partial session data when full JSONL parsing is unavailable
- Fixed shell execution output to replace raw streamed bash output with the minimizer’s rewritten text before final output while still preserving the full original output as artifact metadata
- Fixed bash command minimization to save the full unminimized output as a `bash-original` artifact during AgentSession shell execution, enabling `artifact://` access to complete command output
- Fixed streaming chunk previews that could display an incomplete trailing edit as a deletion when partial JSON temporarily converted in-flight values to `null`
- Fixed edit streaming preview updates to cancel obsolete in-flight computations and avoid rendering stale previews as args change
- Fixed chunk edits to reject unsafe `^`/`~` writes on code leaf chunks instead of falling back to whole-chunk replacement and risking structural indentation corruption
- Fixed chunk `replace` operations to dedent multiline replacement snippets before reapplying the matched source indentation, preventing Python nested replacements from compounding indentation on repeated edits.
- Fixed Go chunk trees to classify `package` clauses separately from imports and to avoid duplicating method receivers in method summaries.
- Fixed chunk path-not-found guidance so it recommends `sel="?"` without claiming the already-shown listing must be re-read.
- Fixed Markdown chunk appends to preserve blank-line separators after line-oriented inserts such as table rows
- Fixed Markdown section region-fallback warnings to call out child chunks that will be replaced by whole-section edits.
- Fixed rejected chunk-edit errors to distinguish current file content from hypothetical post-edit parse-error previews and to state when a same-file batch was rolled back.
- Fixed unsafe Python head-region edits by rejecting decorated Python `^` writes and Python `^` deletes that can orphan indented bodies while still parsing.
- Fixed Markdown table-row appends so row-shaped content lands inside the table block instead of after the trailing blank-line separator.
- Fixed Markdown root writes to preserve fenced-code indentation verbatim.
- Fixed Rust enum-variant replacement matching so trailing commas are included consistently with whole-variant writes.
- Fixed streaming edit call headers to keep showing the target file path while the edit arguments are still arriving
- Fixed Mermaid fenced markdown rendering in assistant messages on terminals without image protocol support ([#650](https://github.com/can1357/gajae-code/issues/650))
- Fixed chunk edit path parsing so plan-mode edits to section-addressed `local://PLAN.md:<selector>` paths are classified as writes to the plan file
- Fixed SQLite `read` helper queries to reject `where=` clauses with SQL control syntax that could override the structured selector's pagination; raw SQL remains available through `q=SELECT ...`
- Fixed `models` provider transport overrides so `headers`-only entries apply without requiring `baseUrl`, including runtime `registerProvider()` overrides that now persist across `refresh()` / `refreshProvider()`, preserve existing `baseUrl` on subsequent headers-only updates, clear stale transport overrides when a provider is re-registered under a different extension source, and keep runtime transport headers authoritative when `modelOverrides` set overlapping header keys

## [14.2.0] - 2026-04-23

### Added

- Added an `apply_patch` edit mode that accepts OpenAI code `*** Begin Patch` envelopes, shares patch-mode execution and diagnostics, and renders streaming per-file diffs in the TUI.

### Changed

- Changed Spark models to default to `apply_patch` edit mode instead of `replace`.
- Tightened the contract for `SearchParams.recency` in `web/search/providers/base.ts`: providers MUST interpret recency as a pure time filter and MUST NOT use it as an implicit signal to change topic scope, content domain, or ranking strategy.
- Inline read tool previews are now optional via `read.toolResultPreview` and default to off

### Fixed

- Fixed `apply_patch` streaming previews to avoid showing the missing `*** End Patch` parse error while the patch body is still arriving.
- Fixed diagnostics rendering to replace tabs before TUI output, preventing compiler messages from breaking tree alignment.
- Fixed compiled `gjc` binaries to ignore project-local `bunfig.toml` and `.env` autoloading at startup, preventing unrelated project config from crashing or preloading code into the CLI
- Fixed edit tool diff and replace operations to report missing-file failures as `File not found: <path>` errors instead of raw filesystem ENOENT errors
- Fixed `local://` URL path leak on Linux where `//` collapsing to `/` produced `local:/path` forms that bypassed the internal protocol handler and leaked as filesystem paths, breaking plan mode file resolution
- Fixed Darwin compiled binaries failing to start under Bun 1.3.12 by ad-hoc signing local and release binary builds after applying Bun's no-codesign workaround ([#754](https://github.com/can1357/gajae-code/issues/754))
- Fixed Tavily web search silently returning off-topic news articles when `--recency` was set. The provider was unconditionally coupling `topic: "news"` to recency, which scoped Tavily's index to news publications and excluded documentation, release notes, GitHub, and all non-news technical content. Technical queries with `--recency` now return the correct corpus.
- Fixed status-line sanitization to strip OSC, DCS, PM, APC, and 8-bit CSI escape sequences instead of leaving payload fragments in the UI
- Fixed inline read tool previews to avoid rendering duplicate summary rows above the same code cell

## [14.1.3] - 2026-04-17

### Breaking Changes

- Replaced the legacy `todo_write` `ops`-based API (`replace`, `update`, `add_task`, and `remove_task`) with direct top-level fields, requiring migration of any callers using the old request shape
- Removed in-place updates to existing task `content`, `details`, and `notes` via `todo_write`; note changes now append through `add_notes`
- Phased task definitions in `todo_write` now reject `notes` on initial creation, so notes must be added later with `add_notes`

### Added

- Added `complete`, `start`, `abandon`, `remove`, `add_notes`, and `add_tasks` parameters to `todo_write` so callers can complete, jump to, drop, and annotate tasks without op wrappers
- Added direct `add_phase` support as a top-level argument for inserting a new phase in `todo_write`
- Added `task.simple` with `default`, `schema-free`, and `independent` modes so the task tool can disable task-call `schema` and shared `context` inputs while preserving agent-defined and inherited subagent schemas

### Changed

- Changed `add_tasks` to insert tasks by phase name or ID and allow multiple tasks to be added in one call

### Fixed

- Fixed task calls in `schema-free` and `independent` modes to return clear mode-specific errors when disallowed `context` or `schema` inputs are provided
- Fixed newly generated session IDs to use UUIDv7 for new, forked, and branched sessions while preserving resumed session IDs

## [14.1.1] - 2026-04-14

### Breaking Changes

- Removed the standalone `vim` tool from built-in tool lists, so vim-style editing is now invoked through `edit` in `vim` mode
- Removed the `searchDb` field from session and extension tool contexts, so custom tools and extensions no longer receive a shared native search DB handle from `ToolSession`, `CustomToolContext`, `ExtensionContext`, and `CreateAgentSessionOptions`
- Changed the `vim` tool API to require either `open: "path"` or `kbd: [...]` per call and removed direct `line`/`col` cursor parameters from `open`, so callers must position the cursor via key sequences after opening
- Changed the `edit` schemas for patch, replace, hashline, and chunk modes from top-level request fields to `edits` array entries, requiring path/mode details on each edit and breaking callers that send legacy top-level `path`, `old_text`, `new_text`, `op`, `move`, or `delete` payloads

### Added

- Added Vim ex aliases `:del`, `:ya`, `:co`, and `:mo` as shorthand for existing delete, yank, copy, and move commands
- Added support for additional Vim ex command aliases `:write`/`write!`, `:edit`/`edit!`, and `:update`/`:up` in command parsing
- Added support for vim `:global` and `:vglobal`/`/` variants as `:g/pattern/d` and `:v/pattern/d` parsing and execution
- Added support for extra Vim operations by treating `x`, `X`, `s`, `S`, `C`, and `D` as delete/change operator aliases
- Added support for new Vim motions `gE`/`ge`, `g_`, `g*`, `g#`, and `|`
- Added support for `C-f` and `C-b` page motions in vim mode
- Added `C-u` and `C-o` in vim insert mode to clear to line start and execute a one-off normal-mode command before returning to insert
- Added insert-mode visual operators `J`, `u`, `U`, `p`, and `P` to join lines, convert case, and replace the selected region with register content
- Added normal-mode line motions `+`, `-`, and `_` to move to line offsets at the first non-blank character
- Added `*` and `#` normal-mode commands to search forward or backward for the word under the cursor
- Added `gJ` to join a line range, `gv` to restore the last visual selection, and `ZZ`/`ZQ` shortcuts for save-and-exit or exit-without-save in vim mode
- Added paragraph text object `p` for `ip`/`ap`-style paragraph selection
- Added support for Vim ex line-address forms like `.`, `$`, `+N`/`-N`, destination addresses such as `:t$`, and ranged `:global` commands
- Added Vim ex `:join`/`:j` and `:join!`/`:j!` support to join addressed lines with or without whitespace normalization
- Added a warning when chunk edits write to the `~` selector with body lines that appear over-indented, instructing users to start top-level body text at column 0
- Added validation feedback for suspect indentation in chunk-mode `~` body writes so users can align content with the tool's automatic base indentation
- Added support for multi-file `edit` calls across replace, patch, hashline, and chunk modes by grouping `edits` entries by file path and returning combined per-file results
- Added per-edit `path` support in chunk entries so each operation can target explicit files when submitting mixed edits in a single request
- Added support for `computeHashlineDiff` to accept hashline edits with `loc` and `content` payloads without requiring pre-resolved `op` fields
- Added `/rename <title>` slash command to set an explicit session name, updating the session header and terminal tab title ([#658](https://github.com/can1357/gajae-code/issues/658))
- Added `session_name` status line segment: displays the session name in the status bar right side with a stable hash-derived accent color unique to each name; shown in all presets when a name is set

### Changed

- Changed vim path normalization to accept colon-prefixed `path` values instead of rejecting them as Vim commands
- Changed default `providers.openaiWebsockets` setting to `off` when unset, so OpenAI websocket transport is now disabled unless explicitly enabled
- Changed Vim ex `:update`/`:up` execution to skip writing unchanged buffers and report buffer unchanged status
- Changed Vim page-scroll commands `C-f`, `C-b`, `C-u`, and `C-d` to move in viewport-height based increments instead of fixed constants
- Changed `z` command behavior so `zt`, `zb`, and `z.` now align cursor movement to first non-blank in the line
- Changed `:g`/`:v` global command handling to process matching lines safely by working in reverse order and preserving file structure
- Changed vim tab breadcrumb rendering from `→` to `→` in the editor view
- Changed custom tool and task execution contexts to no longer expose a shared `searchDb` accessor, removing direct access to native grep/glob/fuzzyFind search backends from extension callbacks
- Changed the `task` tool `schema` field to require JSON-encoded JTD schema text instead of a schema object, matching prompt guidance and task-subagent invocation
- Changed chunk edit payloads to encode selectors as `path: "file:selector"` and updated chunk tool guidance and examples to match
- Updated `edit` call/result rendering to show per-file diff sections and append a `(+N more)` hint when edits target multiple files
- Grouped chunk-mode `grep` results by directory, file, and chunk so directory searches now render as hierarchical sections (`#`/`##`) with per-chunk anchor lines
- Updated chunk-mode `grep` output to include match lines under their containing chunk entries with consistent line-number alignment based on file length
- Changed eager todo enforcement to only apply on the first user message of a conversation, skipping subsequent user turns that may correct, clarify, or redirect the prior task

### Removed

- Removed live in-progress Vim tool previews during streaming call execution, so the TUI now shows only the last completed file viewport until the call finishes

### Fixed

- Fixed vim-mode multi-step line edits by auto-reordering ascending line-positioned commands to descending order before execution
- Fixed Vim viewport rendering to display the inline highlighted cursor character and keep long cursor lines centered around the cursor in tool previews
- Fixed Vim `:global` command defaults to handle only supported subcommands and report unsupported ones explicitly
- Fixed Vim ex execution so parsed `:update`, `:yank`, and `:put` commands now run instead of falling through
- Fixed vim tool rendering so streamed calls preview the live target viewport and large insert payloads update incrementally instead of popping in all at once
- Fixed session event delivery so streaming `message_update`/tool-call previews reach the TUI immediately instead of waiting for extension handlers to finish
- Fixed HTML session export rendering so background-job wait calls render as `poll` instead of stale `await`, while still recognizing legacy exported sessions
- Fixed OpenRouter model resolution to accept dated routed selectors such as `openrouter/z-ai/glm-4.7-20251222:nitro`, inheriting metadata from the base catalog model when the exact variant is not listed yet
- Fixed pre-execution edit preview routing so replace/patch/hashline mode diffs are computed from the new structured edit entries
- Adjusted chunk/hashline/prompt guidance and validation to align with the refactored per-entry schema
- Fixed chunk streaming output detection to verify chunk edits with `chunkToolEditSchema`, preventing non-chunk edit payloads from being rendered as chunk diffs
- Fixed tool execution output to return the original `toolResult` text content from tools instead of sanitizing it before sending completion messages
- Fixed session accent rendering in the status line and editor to reset only foreground color (`\x1b[39m`) so applying a session color no longer clears other ANSI styles
- Session name sanitization: strip C0/C1 control characters (including ANSI ESC) from session names at storage time and in status line rendering, preventing escape sequence injection into TUI output
- Auto-generated session titles no longer overwrite a name set via `/rename`: `setSessionName` now tracks whether the name was set by the user or auto-generated and silently ignores auto titles once a user name is in place; terminal title follows the same guard
- Session accent border color now applied on session resume and after auto-title generation, not only after an explicit `/rename`
- Fixed retained Python kernel ownership so `AgentSession.dispose()` only shuts down kernels owned by that session, including warmup-created kernels

## [14.1.0] - 2026-04-11

### Added

- Added richer tool rendering details in session export HTML, including metadata badges, argument formatting, and todo task tree styling for exported tool and workflow messages
- Added a persistent `js` tool backed by `node:vm`, with cross-session `highway` KV/pubsub, tool calls from inside JS cells, and `$` / `$$` interactive JavaScript execution
- Added SQLite database read support to the `read` tool for `.sqlite`, `.sqlite3`, `.db`, and `.db3` files with table listing, schema + sample output, row lookup, paginated query filtering, and read-only `q=SELECT` mode
- Added SQLite mutation support to the `write` tool so `db.sqlite:table` inserts JSON5 rows and `db.sqlite:table:key` updates or deletes rows via row key
- Added rendering of usage report entries for accounts with no usage limits, including account label and optional plan type with a `-- no limits` indicator
- Updated account label resolution to fall back to email or accountId so unlabeled unlimited-plan accounts display a meaningful name
- Added canonical model equivalence and provider coalescing across `models.yml`, `enabledModels`, `--models`, `/model`, and `--list-models`
- Added `equivalence` overrides/exclusions to `models.yml` and `modelProviderOrder` to `config.yml` for global canonical-provider preference

### Changed

- Enabled `await` and `cancel_job` to be available when `bash.autoBackground.enabled` is set, so auto-backgrounded bash jobs can be awaited or cancelled without enabling `async.enabled`
- Updated bash auto-background behavior so short commands returned inline output when they completed before the configured threshold, while longer runs moved to background jobs automatically
- Replaced the LLM-callable Python execution path with JavaScript execution in the shared VM context, including updated renderers, prompts, session messages, and extension events
- Updated interactive and CLI model listings/selectors to work with canonical model ids while resolving them to concrete provider variants for actual execution
- Updated role assignment persistence so selected model settings now store the selector used by users, including thinking-level suffixes, while runtime continues to run against the resolved concrete provider model
- Updated model scope resolution to expand exact canonical model ids into all matching provider variants when filtering supported model sets
- Changed the agent to avoid giving time estimates or task-duration predictions in user responses, focusing on required work instead
- Changed generated code guidance to avoid speculative abstractions and extra compatibility scaffolding, favoring direct implementations that match current needs
- Changed model role resolution so roles can store either canonical model ids or explicit `provider/model` selectors while sessions continue to record the concrete model actually used
- Updated bash execution to optionally auto-background long-running commands through the existing background-job pipeline, with dedicated settings for enabling the behavior and adjusting the delay

### Fixed

- Fixed session export rendering so JavaScript execution messages now use `jsExecution` labels and content instead of `pythonExecution`, matching current tool behavior
- Fixed JavaScript cell execution to auto-display returned values once and preserve persistent VM bindings across calls until reset
- Fixed `.db`/`.db3` reads to verify SQLite file headers and fall back to normal file reading when the extension matches but the content is not a SQLite database
- Fixed SQLite selector parsing and resolution to correctly route requests to database operations at the file-extension boundary instead of misrouting through plain file/archive handlers
- Fixed unsupported or unsafe selectors by rejecting missing tables, composite primary keys for row lookups, unknown query parameters, and row operations on non-existent tables
- Fixed model resolution for commit message generation, title generation, memory consolidation, and image inspection when role strings use canonical ids instead of raw provider/model values
- Fixed default-model updates so previously configured thinking levels were preserved when reassigning a role
- Fixed model scope and selection handling in CLI/session startup paths that previously failed to resolve aliases consistently across features
- Fixed short-lived git subprocesses to disable `core.fsmonitor` and `core.untrackedCache`, avoiding unnecessary repository watchers and cache work during agent git operations

### Security

- Blocked destructive SQL execution in read-mode SQLite access by using read-only connections and rejecting bound-parameter raw SQL

## [14.0.5] - 2026-04-11

### Added

- Added `designer` model role for UI/UX design tasks with Gemini 3.1 Pro as default model
- Added support for model role fallback lists — roles can now resolve to multiple model patterns with automatic fallback to next available model
- Added `extractReadableFromHtml` utility function to extract readable content from HTML with Readability article extraction and CSS selector fallback
- Added support for GFM (GitHub Flavored Markdown) features including tables, strikethrough, and task lists in HTML-to-markdown conversion
- Added `resolveDiagnosticTargets` utility function to handle glob pattern resolution with fallback to literal file paths for bracket-style paths

### Changed

- Clarified fenced code block editing behavior in markdown — the tool now preserves literal indentation inside fenced blocks, with content written verbatim as supplied
- Updated guidance for inserting content after markdown section headings to use `after` on the heading chunk rather than `before`/`prepend` on the section itself
- Reduced default image resize limits to 1568px (from 2000px) and 500KB (from 4.5MB) to match Anthropic's internal downscaling threshold and reduce payload sizes in tool calls
- Adjusted screenshot compression to use 1024px max dimensions and 150KB budget for more aggressive optimization of browser screenshots in LLM requests
- Updated JPEG quality defaults from 80 to 75 and refined quality ladder steps (70, 60, 50, 40) for tighter byte budgets
- Improved image resize fast-path to skip re-encoding when images are already within dimensions and at ≤25% of byte budget, avoiding unnecessary processing of small icons and diagrams
- Clarified that chunk names are truncated and must be copied from `read` or `?` output rather than constructed from source identifiers
- Enhanced guidance for editing fenced code blocks in markdown to preserve exact whitespace using `raw` reads, as the tool normalizes tabs to spaces which can damage indentation-sensitive content
- Updated designer agent to use `pi/designer` role alias instead of explicit model list
- Refactored model role resolution to support multiple fallback patterns per role, improving model availability handling
- Replaced regex-based HTML-to-markdown conversion with Turndown library and GFM plugin for more accurate formatting of complex HTML structures
- Simplified no-changes response to omit redundant response text when chunk content already matches
- Clarified region suffix behavior on leaf and compound statement chunks — `~` and `^` now fall back to whole-chunk replacement with explicit guidance to supply complete structural content
- Updated CRC refresh guidance to direct users to use CRCs from edit responses or run `read(path="file", sel="?")`
- Added clarification that region suffixes fall back to whole-chunk replacement for prose and data formats (markdown, YAML, JSON, fenced code blocks, frontmatter)
- Documented `L20` shorthand syntax for single-line reads extending to end-of-file, with `L20-L20` for one-line windows
- Refactored diagnostic target resolution to use new `resolveDiagnosticTargets` function, consolidating glob pattern detection and file matching logic
- Updated chunk selector syntax from `@region` format to `~` (body) and `^` (head) suffixes for more concise region targeting
- Simplified chunk edit documentation to use new `~` and `^` region syntax instead of `@head`, `@body`, `@tail`, `@decl` keywords
- Replaced internal `raceAbort` function with imported `raceWithAbort` utility from pi-utils
- Refactored cleanup timer to use async iterator pattern with `timers.setInterval` instead of `setInterval`
- Made `#cleanupIdleSessions` synchronous and moved async cleanup loop logic to new `#runCleanupLoop` method
- Replaced regex-based `htmlToBasicMarkdown` with a Turndown + GFM plugin pipeline (tables, strikethrough, task lists, nested lists now convert correctly). Added direct `turndown` and `turndown-plugin-gfm` dependencies

### Fixed

- Fixed chunk edit tool to report file-not-found error distinctly when attempting to use chunk selectors on non-existent files, with guidance to use write tool or verify the path
- Fixed stale child selector reuse to correctly match chunks by checksum when multiple sibling chunks with the same name exist under the same parent
- Fixed stale diagnostics being reused after unrelated file publishes by clearing cached diagnostics before refreshing file state
- Fixed OpenAI code search to use streamed answer text when final answer is an image placeholder or empty

### Fixed

- Fixed MCP config docs and schema to use `~/.gjc/agent/mcp.json` for user-scoped GJC-native MCP config while keeping project config at `<cwd>/.gjc/mcp.json`

## [14.0.4] - 2026-04-10

### Added

- Added `PI_CHUNK_AUTOINDENT` environment variable to control whether chunk read/edit tools normalize indentation to canonical tabs or preserve literal file whitespace
- Added dynamic chunk tool prompts that automatically adjust guidance based on `PI_CHUNK_AUTOINDENT` setting without exposing a tool parameter
- Added `<instruction-priority>`, `<output-contract>`, `<default-follow-through>`, `<tool-persistence>`, and `<completeness-contract>` sections to system prompt for improved long-horizon agent workflows

### Changed

- Updated chunk edit tool to apply `normalizeIndent` setting during edit operations, enabling literal whitespace preservation when `PI_CHUNK_AUTOINDENT=0`
- Refactored environment variable parsing to use `$flag()` and `$envpos()` utilities from pi-utils for consistent boolean and integer handling across codebase
- Updated system prompt communication guidelines to emphasize conciseness and information density, and added guidance on avoiding repetition of user requests
- Enhanced system prompt with explicit rules for design integrity, verification before yielding, and handling of missing context via tool-based retrieval
- Added `PI_CHUNK_AUTOINDENT` to control whether chunk read/edit tools normalize indentation, and updated chunk prompts to switch guidance automatically based on that setting
- Refined the default system prompt with explicit instruction-priority, output-contract, tool-persistence, completeness, and verification rules for long-horizon GPT-5.4-style agent workflows

### Fixed

- Fixed typo in system prompt: 'backwards compatibiltity' → 'backwards compatibility'

## [14.0.3] - 2026-04-09

### Fixed

- Fixed cached Ollama discovery rows so upgraded installs switch to the OpenAI Responses transport instead of staying on the old completions transport

## [14.0.2] - 2026-04-09

### Added

- Added `/force` slash command to force the next agent turn to use a specific tool
- Added `ToolChoiceQueue` for managing tool-choice directives with lifecycle callbacks and requeue semantics
- Added `setForcedToolChoice()` method to AgentSession to programmatically force tool invocations
- Added `toolChoiceQueue` property to AgentSession for direct queue access
- Added `peekQueueInvoker()` method to AgentSession to retrieve in-flight tool invocation handlers
- Added `queueResolveHandler()` function as the canonical entry point for preview/apply workflows
- Added `buildToolChoice()` and `steer()` methods to ToolSession for tool-choice queue integration
- Added `getToolChoiceQueue()` method to ToolSession for accessing the tool-choice queue
- Added support for embedded URL selectors (`:raw` and `:L#-L#` line ranges) in read command paths
- Added `parseReadUrlTarget` function to parse and validate URL read targets with line range support
- Added `decl` region to chunk selector for targeting declarations without leading trivia
- Exported `hooks` subpath for extensibility API access
- Added `build` script for compiling binary artifacts

### Changed

- Refactored pending action handling from `PendingActionStore` to `ToolChoiceQueue` with generator-based directives
- Changed tool-choice override mechanism from simple override to a queue-based system with callbacks
- Updated `ResolveTool` to dispatch to in-flight queue invokers instead of popping from a pending action store
- Updated custom tool loader to accept `pushPendingAction` callback instead of `PendingActionStore` instance
- Updated `AstEditTool` to use `queueResolveHandler()` for preview/apply semantics
- Changed eager-todo prelude to use the tool-choice queue instead of simple override
- Updated todo reminder suppression to check for user-forced directives via `consumeLastServedLabel()`
- Made model-specific edit mode defaults conditional on `PI_STRICT_EDIT_MODE` environment variable for greater flexibility in edit mode selection
- Updated slash command handlers to support returning remaining text as prompt input instead of consuming input entirely
- Enhanced slash command parser to recognize both whitespace and colon (`:`) as command argument separators
- Updated indentation guidance for chunk edit content to use single leading spaces per indent level instead of tabs
- Updated read CLI to delegate URL inputs through the read tool pipeline instead of treating them as local file paths
- Updated chunk edit documentation to clarify region semantics and emphasize using the narrowest region for edits
- Improved chunk selector guidance with visual diagram showing region boundaries
- Renamed `build:binary` script to `build`
- Refactored `check` script to include linting via Biome and type checking
- Added `check:types`, `lint`, `fmt`, and `fix` scripts for improved developer workflow
- Simplified TypeScript configuration by extending workspace-level config

### Removed

- Removed `PendingActionStore` class and related pending-action module
- Removed `pendingActionStore` parameter from AgentSession config
- Removed `pendingActionStore` from ToolSession interface
- Removed `consumeNextToolChoiceOverride()` method from AgentSession (replaced by `nextToolChoice()`)

### Fixed

- Fixed tool-choice queue cleanup on agent loop abort to prevent orphaned in-flight directives
- Fixed requeue semantics to preserve `onInvoked` and `onRejected` callbacks across multiple abort cycles

## [14.0.1] - 2026-04-08

### Changed

- Improved auto-generated file detection to gracefully handle ENOENT errors when peeking file content, preventing unnecessary abort failures
- Optimized context emission by skipping message cloning when no extensions have context handlers
- Improved message cloning resilience by falling back to shallow array clone when structured cloning fails due to non-cloneable objects
- Made `assertEditableFileContent` synchronous instead of async for improved performance in streaming edit checks
- Enhanced streaming edit abort detection to check for auto-generated files as soon as the file path is available, rather than waiting for the full diff
- Improved file prefix reading in session storage to use `peekFile` utility from @gajae-code/utils for better efficiency
- Moved image metadata detection to @gajae-code/utils package for shared use across projects
- Simplified image loading API by removing redundant metadata parameters and consolidating image utilities
- Updated imports to use readImageMetadata and parseImageMetadata from @gajae-code/utils instead of local implementations

### Removed

- Removed image-input.ts utility module; functionality consolidated into image-loading.ts
- Removed mime.ts utility module; MIME detection moved to @gajae-code/utils
- Removed ImageMetadata interface and ReadImageMetadataOptions from local codebase

### Fixed

- Fixed streaming edit abort for auto-generated files by adding LRU caching and early path-based detection to prevent unnecessary edits

## [14.0.0] - 2026-04-08

### Breaking Changes

- Simplified chunk edit operations: removed `append_child`, `prepend_child`, `append_sibling`, `prepend_sibling`, and `replace_body` ops in favor of unified `replace`, `before`, `after`, `prepend`, and `append` with region targeting (`@head`, `@body`, `@tail`)
- Chunk edit `target` format changed: now accepts `selector#CRC@region` for mutations and `selector@region` for insertions; removed separate `crc` and `anchor` fields from edit operations
- Removed checksum requirement from insert operations (`before`, `after`, `prepend`, `append`); only `replace` requires `#CRC` suffix

### Added

- Auto QA tool (`report_tool_issue`) for automated tracking of unexpected tool behavior; enabled via `PI_AUTO_QA=1` environment variable or `dev.autoqa` setting
- `dev.autoqa` setting to enable automated tool issue reporting for all agents
- System prompt guidance when `report_tool_issue` tool is available, encouraging agents to report tool behavior discrepancies
- LSP server discovery at startup via `discoverStartupLspServers()` to detect configured language servers without blocking initialization
- LSP startup event channel (`lsp:startup`) for asynchronous server warmup notifications with completion or failure status
- `LspStartupServerInfo` type for tracking LSP server status including connecting, ready, and error states
- LSP server status display in `/info` command showing connecting, ready, and error states with color-coded indicators
- Multi-session support in ACP mode: agents can now manage multiple concurrent sessions with independent state, models, and configurations
- Session forking in ACP mode: `unstable_forkSession` creates a new session from an existing one's history
- Session resumption in ACP mode: `unstable_resumeSession` reloads a previously saved session
- Session closure in ACP mode: `unstable_closeSession` cleanly shuts down a session and releases resources
- Model state reporting in ACP mode: `SessionModelState` with available models and current selection in session responses
- Direct model setting in ACP mode: `unstable_setSessionModel` RPC command for changing the active model
- Turn-level usage tracking in ACP mode: prompt responses now include `usage` with input/output/cached token counts
- Message ID tracking in ACP mode: stable message IDs for assistant chunks enabling client-side message correlation
- Settings cloning: `Settings.cloneForCwd()` method to create isolated settings instances for different working directories
- Extension flag value retrieval: `ExtensionRunner.getFlagValues()` to inspect current flag state
- Exported autoresearch module and submodules via `./autoresearch` and `./autoresearch/*` package paths
- Exported autoresearch tools via `./autoresearch/tools/*` package path
- Exported CLI commands via `./cli/commands/*` package path
- Exported DAP module and submodules via `./dap` and `./dap/*` package paths
- Exported edit module and submodules via `./edit`, `./edit/*`, and `./edit/modes/*` package paths
- Exported bundled ci-green custom command via `./extensibility/custom-commands/bundled/ci-green` package path
- Exported extensibility plugins marketplace via `./extensibility/plugins/marketplace` and `./extensibility/plugins/marketplace/*` package paths
- Exported ACP mode via `./modes/acp` and `./modes/acp/*` package paths
- Exported web utilities via `./web/*` package path
- Exported line-hash utilities from edit module via `./edit/line-hash`
- Host-owned custom tools support: RPC clients can now register custom tools via `setCustomTools()` and the RPC server will invoke them over the transport with `host_tool_call` requests
- RPC host tool framework: `RpcHostToolBridge` for managing host tool execution, `RpcHostToolDefinition` for tool metadata, and bidirectional `host_tool_call`, `host_tool_cancel`, `host_tool_update`, and `host_tool_result` frames
- RPC client tool API: `defineRpcClientTool()` helper, `RpcClientCustomTool` interface, and `RpcClientToolContext` for implementing host-side tool execution with update streaming and abort support
- `set_host_tools` RPC command to replace the active set of host-owned tools before the next model call
- `refreshRpcHostTools()` method on `AgentSession` to integrate host tools into the active tool registry with conflict detection and auto-activation of non-hidden tools
- Instruction breakpoints support: `set_instruction_breakpoint` and `remove_instruction_breakpoint` debug actions for setting breakpoints at specific instruction addresses
- Data breakpoints support: `data_breakpoint_info`, `set_data_breakpoint`, and `remove_data_breakpoint` debug actions for monitoring variable/memory access
- Memory introspection: `read_memory` and `write_memory` debug actions for inspecting and modifying debugger memory
- Disassembly support: `disassemble` debug action for viewing assembly instructions with symbol resolution
- Module and source introspection: `modules` and `loaded_sources` debug actions for querying loaded modules and source files
- Custom DAP requests: `custom_request` debug action for sending arbitrary Debug Adapter Protocol commands
- Reverse request handling in DAP client: `onReverseRequest()` method for responding to adapter-initiated requests like `runInTerminal` and `startDebugging`
- DAP reverse request support: adapters can now request terminal spawning and child debug sessions via `runInTerminal` and `startDebugging` reverse requests
- Instruction pointer reference in debug snapshots: `instructionPointerReference` field in session summaries for low-level debugging
- Hit condition support for instruction and data breakpoints: `hit_condition` parameter for conditional breakpoint triggering
- RPC `set_todos` command and `todoPhases` in `get_state`, allowing hosts to pre-seed and inspect session todo state over the protocol
- Deferred diagnostics support in LSP writethrough: `onDeferredDiagnostics` callback and `deferredSignal` in `WritethroughOptions` allow callers to receive diagnostics that arrive after the main 5-second timeout
- Language detection for `.pm` (Perl modules), `.astro` (Astro framework), and special filenames `containerfile` and `justfile`
- Workspace-scoped diagnostics and reload actions via `*` file parameter; `diagnostics` action now supports `*` for workspace-wide diagnostics across all configured servers
- Socket-mode DAP adapter support for debuggers like dlv that communicate via network sockets instead of stdio; Linux uses unix domain sockets, macOS/other platforms use TCP with client-addr dialing
- Improved extensionless binary debugging: native debuggers (gdb, lldb-dap) and adapters with root markers are now preferred over unrelated adapters like debugpy
- Debug tool with DAP (Debug Adapter Protocol) support for launching and attaching debuggers, setting breakpoints, stepping through execution, inspecting threads/stack/variables, and evaluating expressions
- Debug adapter configuration for gdb, lldb-dap, debugpy, and dlv with language/file-type matching and root marker detection
- Debug session management with support for source and function breakpoints, conditional breakpoints, stack trace inspection, scope/variable exploration, and program output capture
- `debug.enabled` setting to control debug tool availability
- Chunk read formatting: `anchorStyle` (full / kind / bare), `read.anchorstyle` setting, and `chunked` flag on file display mode
- `read.prosechunks` and `read.explorechunks` settings for prose chunk trees and checksum-free explore trees
- Handlebars helpers `anchor` and `sel` (with template `anchorStyle` context) for chunk examples in prompts
- Chunk-mode grep lines as `path:selector>LINE|content`; unified grep tool template behind `IS_CHUNK_MODE`
- `lru-cache` for chunk tree caching
- Chunk-mode `read` output: recursive rendering with `$XXXX` checksum suffixes, inline large-chunk previews, and normalized `#path$XXXX` selectors between read and edit
- Autoresearch: `init_experiment` options `new_segment`, `from_autoresearch_md`, `abandon_unlogged_runs`; `log_experiment` options `skip_restore` and broader `force`; `run_experiment` `force` (with warnings); pre-run dirty-path tracking; `abandonUnloggedAutoresearchRuns` and `abandonedAt` on runs
- LSP: diagnostic versioning (`versionSupport`, stored document version per diagnostic set), and `waitForDiagnostics` / `getDiagnosticsForFile` options (`expectedDocumentVersion`, `allowUnversioned`)

### Changed

- Extracted working directory formatting logic into `formatToolWorkingDirectory()` utility for consistent path display across tools
- Bash command rendering now sanitizes tabs and shortens home directory paths in command previews
- Chunk edit tool schema: renamed `target` parameter to `sel` for consistency with read tool terminology
- Chunk edit tool: `op` parameter is now required (previously optional with `replace` default)
- Chunk edit documentation: updated all region references from `@inner` to `@body` for clearer semantics
- Chunk edit documentation: expanded with comprehensive real-world examples showing full read output, operation effects, and indentation rules
- Chunk edit documentation: simplified indentation guidance to write content at indent-level 0 with automatic re-indentation by the tool
- Chunk edit documentation: clarified that `@region` only works on container chunks, not leaf chunks
- Chunk edit documentation: emphasized that CRCs change after every edit and must be refreshed from latest responses
- Read chunk tool documentation: updated selector examples to use `@body` instead of `@inner`
- Chunk edit region terminology updated: `@inner` renamed to `@body` for clearer semantics in container chunks
- Chunk edit documentation restructured with comprehensive examples showing full read output, operation effects, and indentation rules
- Chunk edit indentation guidance simplified: content should be written at indent-level 0 and the tool automatically applies correct base indentation
- Chunk edit examples expanded with realistic TypeScript code samples demonstrating replace, insert, prepend, append, and delete operations
- Python tool description now dynamically reflects prelude documentation availability instead of static text
- Python tool now automatically warms the environment on first execution if prelude helpers are unavailable, ensuring documentation is loaded before use
- Tool creation now auto-injects `report_tool_issue` when auto QA is enabled, regardless of requested tool list
- Chunk edit region names standardized to `@head`, `@body`, and `@tail` for clearer semantics
- Chunk edit documentation clarified: region defaults to full chunk when omitted; leaf chunks no longer support region targeting
- Chunk read documentation updated: selector examples now use region-specific selectors based on `@head`, `@body`, and `@tail`
- LSP server connecting status in welcome banner now uses muted pending symbol instead of warning symbol for clearer visual distinction
- OpenAI code websocket prewarm now runs asynchronously in the background instead of blocking session creation, allowing faster startup
- OpenAI code websocket status updates now display in interactive mode when prewarm completes or fails
- LSP server warmup now runs asynchronously in the background instead of blocking session creation, allowing faster startup
- LSP servers returned from `createAgentSession()` now include `connecting` status during initial warmup phase
- Interactive mode now subscribes to LSP startup events and displays status updates and error messages to the user
- LSP server status in `/info` command now distinguishes between connecting (yellow), ready (green), and error (red) states
- ACP agent now manages multiple sessions instead of a single session; session lifecycle and configuration are now per-session
- ACP session creation now uses a factory function to support creating new sessions for different working directories
- ACP event mapping now accepts optional `getMessageId` callback for stable message ID assignment to assistant chunks

### Removed

- Deleted `src/utils/prompt-format.ts` module; prompt formatting logic moved to `pi-utils`
- Deleted `src/utils/frontmatter.ts` module; frontmatter parsing logic moved to `pi-utils`
- Removed `waitForChildProcess` utility (child process termination now handled by native `killTree` from pi-natives)
- `grep-chunk.md` (folded into unified grep template)
- `startMacAppearanceObserver` export (use `MacAppearanceObserver.start()`)
- `copyToClipboard` export from pi-natives
- `PI_CHUNK_SPLICES` env and `chunkSplicesEnabled()`
- Autoresearch `segmentFingerprint` and related config hashing

### Fixed

- Chunk edit parameter validation: corrected detection of chunk edit operations to check for `sel` field instead of `target`
- Chunk edit streaming previews: updated to reference `sel` parameter instead of `target`
- Python prelude introspection now respects execution timeout and signal options, preventing hangs during environment warmup
- Welcome banner LSP server status now updates in real-time when background startup warmup completes, eliminating stale connecting status displays
- Welcome banner LSP startup rows now re-render when background warmup finishes, use the pending status symbol while servers are still connecting, and no longer add a redundant `LSP ready` status line on successful startup
- ACP session initialization now registers connection cleanup handlers to dispose all sessions on disconnect
- Reorganized package.json exports: moved `./edit` exports before `./plan-mode` for better logical grouping
- Notebook conversion logic now checks for raw read mode or non-chunk mode before converting via markit, allowing chunk-mode reads of `.ipynb` files to use chunk parsing instead of conversion
- Go receiver methods now render as top-level siblings instead of nested under their receiver type in chunk read output
- Moved prompt formatting and rendering utilities from `coding-agent` to `pi-utils` package; `renderPromptTemplate()` and `formatPromptContent()` now accessed via `prompt.render()` and `prompt.format()` from `@gajae-code/utils`
- Moved `parseFrontmatter()` utility from `coding-agent` to `pi-utils` package; now imported from `@gajae-code/utils` instead of local utils
- Consolidated prompt template handling: `TemplateContext` type now available as `prompt.TemplateContext` from `@gajae-code/utils`
- DAP initialization now advertises support for `runInTerminal` and `startDebugging` reverse requests, and memory references
- Debug tool schema expanded with new parameters for instruction/data breakpoints, memory operations, and custom requests
- DAP session state now tracks instruction and data breakpoints separately from source breakpoints
- Replaced `Bun.which()` with `$which()` from pi-utils for command resolution
- Chunk edit tool documentation restructured: replaced operation-specific examples with region-based guidance and canonical indentation rules
- Chunk read documentation updated: selectors now support region syntax (e.g., `class_Foo.fn_bar#ABCD@body`) and canonical target listings show supported regions per chunk
- Chunk edit schema simplified: `target` description now documents region format; `op` and `content` descriptions clarified for region-aware operations
- Chunk edit streaming previews updated: labels now reflect region-aware operations (e.g., `append` instead of `append child`, `insert after` without anchor reference)
- Removed CRC parsing from `parseChunkSelector()` and `parseChunkReadPath()`: selectors no longer extract embedded checksums
- Chunk edit normalization simplified: no longer requires async checksum resolution or context-dependent operation mapping
- RPC mode now automatically disables session title generation by default; hosts can opt in with `PI_RPC_EMIT_TITLE=1` environment variable to receive title updates
- RPC mode now resets workflow-altering `todo.*`, `task.*`, and `async.*` settings to built-in defaults instead of inheriting user overrides
- RPC mode now disables automatic session title generation by default and suppresses `setTitle` extension UI requests unless hosts opt in with `PI_RPC_EMIT_TITLE=1`
- Reorganized edit tool implementation from `patch/` to `edit/` directory structure with dedicated mode subdirectories (`edit/modes/chunk.ts`, `edit/modes/hashline.ts`, `edit/modes/patch.ts`, `edit/modes/replace.ts`)
- Updated package.json exports to use `./edit` path instead of `./patch` for edit tool and related utilities
- Chunk edit tool documentation simplified: removed line-based edit examples, clarified `target` format with full path and CRC suffix, added guidance for `replace_body` operation to preserve declarations
- LSP diagnostics timeout reduced from 10 seconds to 5 seconds for faster feedback; slow diagnostics now fetch in background via deferred mechanism
- Diagnostics action error messaging clarified: requires `file` parameter or `*` for workspace scope; improved guidance in error responses
- Workspace symbols and reload actions now accept `*` to operate across all configured servers instead of requiring a file path
- DAP session initialization now subscribes to stop events before launching/attaching to avoid missing stopOnEntry events
- Stack frame fetching moved outside the event dispatch loop to prevent deadlocks and improve responsiveness
- Evaluate requests now default to the top stopped frame when frameId is not explicitly provided
- Eager todo enforcement now skips prompts ending with question marks or exclamation marks, treating them as queries or commands rather than statements requiring task planning
- Chunk read output now displays fully-qualified anchor paths (e.g., `[class_Worker.fn_run#CRC]`) instead of bare names, making targets unambiguous for edits
- Chunk edit tool documentation clarified: `target` must be the fully-qualified path with `#CRC` suffix; added guidance to run `read(path="file", sel="?")` for canonical target listings when anchor style is unclear
- Chunk read tool documentation updated: `sel` parameter now documents the `?` selector for canonical target listings, and clarifies that default output shows full paths
- Chunk edit schema and tool contract: explicit `op` (`replace`, `append`, `prepend`, `after`, `before`); use `replace` with empty `content` to remove a chunk (no separate `delete` op); sibling inserts use `anchor` instead of separate after/before target fields; insert ops omit CRC where appropriate, mutations require checksum on target
- Chunk path handling: parse selector and CRC separately, sanitize selectors (strip filename prefixes, uppercase checksums), accept embedded `#CRC` on targets, auto-accept stale CRC for later ops in the same batch on the same chunk
- Chunk UX: streaming and final edit previews show chunk edits next to hashline edits with op-specific labels; prompt docs shortened with rules table, `…` in examples, and helper-based path/anchor samples
- `log_experiment` only reverts files modified by the run; prompts and errors document that pre-existing dirty files are preserved; richer pending-run error context; `init_experiment` no-ops when the contract matches unless `new_segment`; secondary metrics informational only (no `force` for drift)
- Autoresearch: `log_experiment` reloads benchmark/scope/constraints from `autoresearch.md` after resolving a pending run; `/autoresearch` without `autoresearch.md` follows `/plan`-style toggle and message flow; setup moved into autoresearch system prompt (removed `command-initialize.md`)
- Native/shell alignment: `GrepOutputMode` from pi-natives; shell and `getDiagnosticsForFile` callbacks use error-first `(err, chunk)`; `getDiagnosticsForFile` takes an options object
- Clipboard: `copyToClipboard` / `readImageFromClipboard` live in `utils/clipboard.ts` (OSC 52 and Termux)
- macOS: session-wide power assertion while the agent runs; `MacAppearanceObserver.start()` with error-first callback; `detectMacOSAppearance()` returns enum values
- ACP session cleanup now properly cancels in-flight prompts and disposes resources when sessions are closed or connection aborts
- Removed unused `_createErrorToolResult` helper function from RPC host-tools module
- Fixed Go receiver method indentation in append operations to preserve relative indentation from the anchor chunk
- Fixed Go type chunk line counts to report only the type body lines instead of including grouped receiver methods
- Fixed enum variant insertion to avoid adding extra blank lines between variants
- Chunk read output now correctly preserves embedded CRC in selectors (e.g., `class_Foo.fn_bar#ZZPM`) instead of stripping them during path parsing
- Chunk edit error messages now consistently report checksum mismatches with format `Checksum mismatch` instead of variable phrasing
- Chunk-mode read output now correctly displays scoped response trees showing only touched chunks and adjacent siblings, preventing unrelated distant chunks from appearing in responses
- DAP stopped event handling no longer blocks the message reader, preventing potential deadlocks during rapid event sequences
- Chunk-mode whole-chunk replaces now preserve attached leading comments and docblocks when replacement content starts at the declaration, preventing accidental comment loss during agent edits
- Chunk edit error messages now consistently report checksum mismatches with the format `did not match checksum "XXXX"` instead of variable phrasing
- Chunk selector validation for edits now rejects non-canonical selectors (suffix-only like `fn_run` or prefix-stripped like `run`), requiring fully-qualified paths to prevent ambiguity
- Plan review previews now re-append at the chat tail on refresh, keeping them adjacent to the active selector instead of updating off-screen
- `log_experiment` validates and reverts run-scoped file changes without clobbering unrelated dirty worktree state
- Chunk edit targets that embed CRC in the selector (e.g. `fn_foo#ABCD`) parse correctly
- Shell paths check errors before consuming chunk output (bash executor, config resolution)
- `/autoresearch` toggles like `/plan` when empty; slash completion no longer suggests `off`/`clear` on an empty prefix after the command
- Chunk-mode read/edit edge cases (zero-width gap replaces, stale batch diagnostics, grouped Go receivers, line-count headers, parse error locations)

### Added

- `/review` command now accepts inline args as custom instructions appended to the generated prompt for all structured review modes (PR-style, uncommitted, specific commit). When inline args are provided, option 4 (editor) is suppressed from the menu. The no-UI (Task tool) path forwards args as a focus hint.

## [13.19.0] - 2026-04-05

### Added

- Added idle auto-compaction settings and scheduling so sessions can compact after inactive turns without auto-continuing.
- Added `onExternalEditor` callback to extension UI dialog options for handling external editor shortcut in select dialogs
- Added external editor shortcut support in plan review selector, allowing users to open and edit the plan in their configured editor
- Added `matchesAppExternalEditor` keybinding matcher to detect external editor shortcut (Ctrl+G or configured binding)
- Added `trimTrailingNewline` option to `openInEditor` function to preserve trailing newlines when editing files
- Added GitHub CLI utilities to git module (`utils/git.github`) with `available()`, `run()`, `json()`, and `text()` methods for GitHub CLI operations
- Exported git utilities from main package entry point for use by extensions
- Added comprehensive git utility module (`utils/git`) with organized namespaces for common git operations (branch, commit, diff, log, patch, ref, stage, status, head, repository)

### Changed

- Changed idle compaction settings (`compaction.idleThresholdTokens` and `compaction.idleTimeoutSeconds`) from enum to numeric type for flexible configuration
- Modified secret obfuscation to deobfuscate restored session messages for local display while keeping outbound LLM messages obfuscated
- Updated stash pop operation to preserve staged changes with `--index` flag when restoring after task branch merges
- Changed secret placeholders to deterministic hash-style redaction tokens and deobfuscated assistant output for local display.
- Updated hook editor and hook selector components to use `matchesAppExternalEditor` matcher for consistent external editor keybinding detection
- Modified plan review flow to read the latest plan content from disk before approval, allowing changes made in external editor to be reflected
- Enhanced plan review help text to dynamically display the configured external editor keybinding
- Refactored git operations to use centralized utility module instead of `ControlledGit` class throughout codebase
- Replaced `ControlledGit` dependency injection pattern with direct `cwd` parameter in commit agent tools
- Migrated git HEAD resolution in footer and status-line components to use new synchronous and asynchronous utilities
- Updated git status summary calculation in status-line component to use new git utility API
- Simplified git branch operations in task execution and cleanup to use new utility functions
- Refactored patch application logic in task worktree to use new git patch utilities

### Removed

- Removed `gh-cli.ts` module; GitHub CLI functionality now available via `utils/git.github`
- Removed `ControlledGit` class and associated git wrapper infrastructure from `commit/git` module
- Removed `mergeStdoutStderr` helper function from autoresearch git utilities
- Removed `findGitHeadPathAsync` and `findGitHeadPathSync` from modes/shared module (replaced by git utilities)
- Removed `./commit/git` export from package.json (internal diff parsing still available via `./commit/git/*`)

### Fixed

- Fixed idle compaction timer to properly cancel when event controller is disposed, preventing memory leaks
- Fixed session resumption to preserve the last non-empty session when starting a fresh session
- Fixed stash detection to use git ref resolution instead of output parsing for reliable stash state tracking
- Fixed isolated task merge-back to preserve task outputs on merge failure and stash dirty worktrees before cherry-pick.
- Fixed web search source rendering to truncate long title, metadata, and URL lines before they overflow the UI.
- Fixed PR checkout tool to resolve symlinks in worktree paths, ensuring consistent path references in results and metadata
- Fixed `read` output for file-backed internal URLs like `local://...` to include hashline prefixes in hashline edit mode, preserving usable line refs for follow-up edits
- Fixed the plan review selector to support the external editor shortcut for opening and updating the current plan from the approval screen
- Fixed status line dropping git branch name when path is long by shrinking the path segment before dropping other segments

## [13.18.0] - 2026-04-02

### Breaking Changes

- Removed standalone `fetch` tool; URL fetching is now integrated into the `read` tool

### Added

- Added URL reading capability to `read` tool with support for web pages, GitHub issues, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, technical blogs, RSS/Atom feeds, and JSON endpoints
- Added `offset` and `limit` parameter support for paginating cached URL fetch results
- Added URL caching mechanism to avoid redundant network requests when reading the same URL multiple times

### Changed

- Renamed `fetch.enabled` setting to `Read URLs` with updated description to reflect integration with read tool
- Updated `read` tool to accept `timeout` and `raw` parameters for URL handling
- Updated `read` tool to support `file://` URLs for local file paths
- Removed `fetch` tool from agent tool lists (explore, librarian, oracle, plan, reviewer agents)

### Fixed

- Fixed `read` tool to properly handle `file://` URL scheme by converting to filesystem paths

## [13.17.5] - 2026-04-01

### Added

- Added support for writing to ZIP archives using fflate library for cross-platform compatibility

### Changed

- Modified archive writing to detect and handle ZIP files separately from Bun archives

### Removed

- Removed GhPrPushTool test case

## [13.17.4] - 2026-04-01

### Added

- Support for writing to archive entries in `.tar`, `.tar.gz`, `.tgz`, and `.zip` files using `archive.ext:path/inside/archive` syntax
- Ability to create new archives when writing to archive subpaths that don't yet exist

## [13.17.3] - 2026-04-01

### Added

- Added support for converting Jupyter notebooks (`.ipynb`) to markdown via markit
- Added `markit-ai` npm package for native document and notebook conversion
- Added support for reading files from `.tar`, `.tar.gz`, `.tgz`, and `.zip` archives using virtual subpaths like `archive.ext:path/to/file`
- Added ability to list archive contents and navigate subdirectories within supported archive formats
- Added archive-aware `read` support for `.tar`, `.tar.gz`, `.tgz`, and `.zip`, including virtual subpaths like `archive.ext:path/to/file`
- Added `/tools` slash command to show the tools currently visible to the agent in the interactive session

### Changed

- Replaced Python-based markitdown CLI tool with native `markit-ai` library for document conversion
- Updated document conversion to use markit library instead of external markitdown command
- Removed markitdown from Python tools manager (no longer needed as external dependency)
- Updated `read` tool documentation to reflect archive support and usage patterns

## [13.17.2] - 2026-04-01

### Added

- Added `/marketplace help` command to display usage guide for all marketplace operations
- Added dedicated `gh-renderer.ts` module for rich terminal rendering of GitHub Actions workflow runs with live status snapshots and job details
- Added `gh_pr_checkout` tool to check out GitHub pull requests into dedicated git worktrees with contributor push metadata
- Added `gh_pr_push` tool to push checked-out pull request branches back to their source branches
- Added `gh_repo_view` tool to read GitHub repository metadata using the local GitHub CLI
- Added `gh_issue_view` tool to read GitHub issues with optional comment context
- Added `gh_pr_view` tool to read GitHub pull requests with optional comment context
- Added `gh_pr_diff` tool to read GitHub pull request diffs with optional file filtering
- Added `gh_search_issues` tool to search GitHub issues with repository scoping
- Added `gh_search_prs` tool to search GitHub pull requests with repository scoping
- Added `gh_run_watch` tool to watch GitHub Actions workflow runs, fast-fail on job failures, and stream tailed logs for failed jobs
- Added `github.enabled` setting to enable read-only `gh_*` GitHub CLI tools for repository, issue, pull request, diff, and search workflows
- Added bundled `/green` command to generate iterative CI fix prompts with optional tag instructions when HEAD is tagged
- Added `github.enabled` setting to enable read-only `gh_*` GitHub CLI tools for repository, issue, pull request, diff, and search workflows
- Added `gh_repo_view` tool to read GitHub repository metadata using the local GitHub CLI
- Added `gh_issue_view` tool to read GitHub issues with optional comment context
- Added `gh_pr_view` tool to read GitHub pull requests with optional comment context
- Added `gh_pr_diff` tool to read GitHub pull request diffs with optional file filtering
- Added `gh_search_issues` tool to search GitHub issues with repository scoping
- Added `gh_search_prs` tool to search GitHub pull requests with repository scoping
- Added `gh_run_watch` tool to watch GitHub Actions workflow runs, fast-fail on job failures, and stream tailed logs for failed jobs
- Added bundled `/green` command to generate iterative CI fix prompts with optional tag instructions when HEAD is tagged
- Project-scoped marketplace plugin installs: `gjc plugin install --scope project name@marketplace` and `/marketplace install --scope project name@marketplace` install plugins into the nearest `.gjc/` or `.git`-rooted project directory instead of the user directory ([#581](https://github.com/can1357/gajae-code/issues/581))
- `--scope user|project` flag added to `/marketplace uninstall`, `/marketplace upgrade`, `/plugins enable`, and `/plugins disable` to disambiguate when a plugin is installed in both scopes
- `gjc plugin upgrade --scope project` with no plugin ID warns that `--scope` is ignored for bulk upgrades
- Added opt-in `gh_*` GitHub CLI tools behind the `github.enabled` setting for repository, issue, pull request, diff, and search workflows
- Added opt-in `gh_run_watch` to fast-fail GitHub Actions runs, stream job status snapshots, and return tailed logs for failed jobs
- Added bundled `/green` command to generate the iterative “fix CI until green” prompt, with final tag instructions included only when `HEAD` already has a tag

### Changed

- Improved marketplace catalog parsing to skip invalid plugin entries with warnings instead of failing the entire catalog load
- Enhanced `/marketplace discover` command to suggest adding the official marketplace when no plugins are available
- Improved `/marketplace` command messaging with clearer guidance for first-time setup and available commands
- Enhanced `gh_run_watch` tool call rendering to display animated spinner status and target description (run ID, branch, or current HEAD) with improved visual hierarchy
- Enhanced `gh_pr_view` tool to include inline review comments alongside pull request reviews for improved discussion context
- Improved `gh_run_watch` tool output rendering with dedicated visual component for streaming run snapshots and job status updates

### Fixed

- Fixed marketplace error messages to display error details instead of object stringification
- Fixed artifact storage for non-persistent sessions to use in-memory fallback instead of returning undefined, enabling proper spill truncation for all session types
- Fixed prompt file formatting to include trailing newlines at EOF for consistency across all prompt markdown files
- Fixed `gh_pr_diff` to preserve raw patch content instead of normalizing tabs and whitespace
- Fixed `gh_pr_view` to include inline review comments alongside pull request reviews and issue-style comments for discussion context
- Fixed `gh_run_watch` to resolve explicit branch watches against the selected branch head instead of local `HEAD`
- Fixed `gh_run_watch` to hide repo and polling internals from the tool schema and save full failed-job logs as session artifacts alongside the inline tailed output
- Fixed `gh_*` tool outputs to spill full large results to artifacts instead of pre-truncating the head with unusable `offset=` guidance
- Fixed bundled `/green` to watch the workflow runs for the current `HEAD` commit instead of whichever branch run was newest
- Fixed OpenAI Responses session rehydration to strip stale assistant replay payloads before resumed requests ([#594](https://github.com/can1357/gajae-code/pull/594) by [@daandden](https://github.com/daandden))
- Fixed inline image rendering to cap image height and preserve multiplexer scrollback during terminal resizes ([#587](https://github.com/can1357/gajae-code/pull/587) by [@smileynet](https://github.com/smileynet))

## [13.17.1] - 2026-04-01

### Removed

- Removed `code_search` tool for code snippet and documentation search

### Fixed

- Fixed edit tool diff rendering to wrap long diff lines with continuation gutters instead of truncating them at terminal width ([#578](https://github.com/can1357/gajae-code/issues/578))
- Fixed `--list-models` and `/model` provider filtering to hide models from disabled providers ([#588](https://github.com/can1357/gajae-code/issues/588))
- Fixed edit tool diffstats to use diff-specific add/remove theme colors instead of success/error status colors ([#589](https://github.com/can1357/gajae-code/issues/589))

## [13.17.0] - 2026-03-30

### Added

- Added `marketplace.autoUpdate` setting (`off`/`notify`/`auto`, default `notify`) for automatic plugin update checking on startup
- Added background marketplace catalog refresh on startup when catalogs are stale (>24h)
- Added `/marketplace upgrade [name@marketplace]` slash command to upgrade outdated plugins
- Added `gjc plugin upgrade [name@marketplace]` CLI command for plugin upgrades
- Added `checkForUpdates()`, `upgradePlugin()`, `upgradeAllPlugins()`, and `refreshStaleMarketplaces()` to MarketplaceManager
- Added marketplace plugin system: registry types, ID helpers, atomic read/write for `marketplaces.json` and `installed_plugins.json` (Anthropic Code-compatible format)
- Added `MarketplaceManager` orchestrator for marketplace and plugin lifecycle (add/remove/update marketplaces, install/uninstall/enable plugins)
- Added marketplace fetcher with source classification (GitHub, git, URL, local) and catalog validation
- Added plugin source resolver with `pathIsWithin` containment checks and versioned cache manager
- Added CLI commands: `gjc plugin marketplace add|remove|update|list`, `gjc plugin discover [marketplace]`
- Added `classifyInstallTarget()` to distinguish `name@marketplace` from npm install targets
- Extended `listAnthropic modelPluginRoots()` to read GJC's installed plugins registry alongside Anthropic Code's, with GJC as authoritative for duplicate plugin IDs
- Added `--plugin-dir <path>` repeatable CLI flag for loading plugins from local directories
- Added `/reload-plugins` slash command that invalidates fs content cache and plugin roots cache
- Added `printPluginHelp()` entries for marketplace and discover commands
- Added MCP server loading from marketplace plugin `.mcp.json` files with `${ANTHROPIC_MODEL_PLUGIN_ROOT}` variable substitution
- Added skill and command namespacing for marketplace plugins (`plugin-name:skill-name`)
- Added LSP config loading from marketplace plugin roots via `getPreloadedPluginRoots()`
- Wired `--plugin-dir` runtime injection into plugin roots at session startup with highest precedence
- Added git (GitHub, SSH, HTTPS) and HTTP URL marketplace source fetching
- Added `/marketplace` TUI slash command with subcommands: add, remove, update, list, discover, install, uninstall, installed
- Added `/plugins` TUI slash command to view all installed plugins (npm + marketplace) and enable/disable marketplace plugins

### Changed

- Changed marketplace clone promotion to occur after duplicate and drift checks, improving safety of concurrent marketplace operations

### Removed

- Removed grep.app code search provider support; code search now uses Exa exclusively
- Removed `providers.codeSearch` setting and related configuration options

### Fixed

- Fixed git-subdir plugin source resolution to properly clean up temporary clone directories on path validation errors
- Fixed LSP config loading to use correct filenames variable when scanning plugin roots
- Fixed plugin selector UI to request render on cancel, preventing stale display state
- Fixed marketplace install command error handling to display user-friendly error messages instead of crashing
- Fixed MCP tools from newly added servers not being activated after `/mcp add` — `refreshMCPTools` preserves prior MCP tool selections, so brand-new servers had their tools registered in the registry but never passed to the agent; tools are now explicitly activated on successful connection
- Fixed `skill://` URI resolver to handle namespaced skills via longest-prefix matching against registered skill names

## [13.16.5] - 2026-03-29

### Fixed

- Fixed `--model provider/id` resolving to wrong provider when model ID exists in multiple catalogs ([#560](https://github.com/can1357/gajae-code/issues/560))

## [13.16.4] - 2026-03-28

### Changed

- Renamed hashline helper functions from `hlineref`/`hlinefull` to `href`/`hline` for brevity
- Simplified hashline edit location API: replaced separate `line` and `block` properties with unified `range` property accepting `{ pos, end }` for all range-based edits
- Updated hashline prompt documentation to reflect new `range` syntax and clarified editing guidelines

### Fixed

- Added detection for `kysely-codegen` generated files in auto-generated file guard

## [13.16.1] - 2026-03-27

### Added

- Added `searchDb` parameter to `PromptActionAutocompleteProvider` constructor for native search database integration in autocomplete workflows
- Added `searchDb` parameter to enable native search database integration for grep and find operations
- Exported `SearchDb` type from tools module for type-safe search database usage

### Changed

- Updated grep tool to accept and utilize `searchDb` parameter for improved search performance
- Updated find tool to pass `searchDb` parameter to underlying search operations
- Updated grep tool description to remove ripgrep-specific implementation detail

## [13.16.0] - 2026-03-27

### Added

- Implemented root path alias: bare `/` in tool inputs now resolves to the session working directory instead of the filesystem root
- Added `browser.screenshotDir` setting to configure screenshot save directory with path expansion

### Changed

- Improved hashline tool documentation with clearer guidance on block boundary handling and closing delimiter duplication prevention
- Updated screenshot path resolution to use `resolveToCwd` for consistent workspace-relative path handling
- Updated hook editor hint text to include `ctrl+g external editor` option when using prompt style
- Refactored question result formatting to consistently include question ID in output

## [13.15.3] - 2026-03-26

### Added

- Added configurable `app.model.selectTemporary` keybinding for temporary model selection.

## [13.15.0] - 2026-03-23

### Breaking Changes

- Changed hashline edit schema from flat `op`/`pos`/`end`/`lines` fields to structured `loc`/`content` format with location-specific objects
- Renamed hashline edit operations: `replace_line` → `{ line: anchor }`, `replace_range` → `{ block: { pos, end } }`, `append_at` → `{ append: anchor }`, `prepend_at` → `{ prepend: anchor }`, `append_file` → `"append"`, `prepend_file` → `"prepend"`
- Changed `lines` parameter to `content` in hashline edit entries
- Renamed hashline edit operation types: `append` → `append_at`, `prepend` → `prepend_at`, `append_eof` → `append_file`, `prepend_bof` → `prepend_file`
- Changed hashline edit operation types from `replace` (with optional `end`) to explicit `replace_line` and `replace_range` operations
- Added required `append_eof` and `prepend_bof` operations for file-level edits; `append` and `prepend` now require an anchor position
- Made `pos` parameter required for `replace_line`, `append`, and `prepend` operations; `append_eof` and `prepend_bof` no longer accept anchors

### Added

- Added custom model roles/tags via config YAML
- Added ability to reorder model role/tag cycling via config YAML
- Added prompt for tradeoff metrics during autoresearch setup to collect secondary metrics alongside primary metric
- Added validation of contract path specifications to reject absolute paths and parent directory references
- Added stricter benchmark command validation in `isAutoresearchShCommand()` to reject chained commands, pipes, and redirects
- Added protection against prototype pollution in ASI data and metric cloning by filtering `__proto__`, `constructor`, and `prototype` keys
- Added `autoResumeArmed` flag to track when autoresearch should automatically resume pending runs
- Added `lastAutoResumePendingRunNumber` to prevent duplicate auto-resume prompts for the same pending run
- Added `git clean -X` invocation during failed experiment rollback to remove ignored build artifacts
- Added validation to reject `init_experiment` when a previous run is still pending and unlogged
- Added autoresearch contract system for validating benchmark commands, metrics, scope paths, off-limits paths, and constraints with fingerprint tracking to detect configuration drift
- Added `autoresearch.program.md` support for repo-local playbook overlays that guide session strategy while preserving `autoresearch.md` as source of truth
- Added pending run artifact tracking and recovery to resume incomplete experiments from `.autoresearch/runs/` directory with run numbers and benchmark logs
- Added run directory organization with numbered run artifacts, benchmark logs, and optional checks logs for experiment traceability
- Added segment fingerprinting to detect when benchmark configuration changes between runs and warn about potential incomparability
- Added support for secondary metrics tracking alongside primary metric with configurable direction (lower/higher is better)
- Added `getCurrentAutoresearchBranch()` helper to detect and validate existing autoresearch branches for session resumption
- Added `PendingRunSummary` type to track unlogged run state including parsed metrics, ASI data, and pass/fail status
- Added hidden next-turn message delivery via `deliverAs: 'nextTurn'` with optional `triggerTurn` to queue context for next LLM call without exposing in editable queue
- Added `#queueHiddenNextTurnMessage()` and `#promptQueuedHiddenNextTurnMessages()` to AgentSession for autonomous tool reactions
- Added resume context support in `command-resume.md` template for user-provided guidance when resuming sessions
- Added current segment snapshot display in autoresearch prompt showing recent runs, baseline metrics, and best results
- Added pending run indicator in autoresearch prompt to guide users to complete unlogged experiments before starting new benchmarks
- Added local playbook section in autoresearch prompt when `autoresearch.program.md` exists
- Added tab replacement in dashboard and tool output rendering to prevent display corruption from shell commands with tabs
- Added boundary duplication warning when replace_range or replace_line operations include a last inserted line that matches the next surviving line, helping detect off-by-one range errors
- Added git branch isolation for autoresearch sessions via `ensureAutoresearchBranch()` to safely revert failed experiments
- Added branch status line to autoresearch initialization and resume prompts showing created or reused branch name
- Added `Files in Scope`, `Off Limits`, and `Constraints` sections to autoresearch.md template for explicit scope definition
- Added validation of ASI metadata requirements in `log_experiment` tool, requiring hypothesis for all runs and rollback context for failed runs
- Added keybinding matcher utilities `matchesAppInterrupt()` and `matchesSelectCancel()` for consistent escape key handling across components
- Added support for customizable `app.interrupt` and `tui.select.cancel` keybindings in interactive components
- Added `defaultInactive` property to `ToolDefinition` to allow tools to be registered but excluded from the initial active set, with extension responsibility for activation/deactivation
- Added dynamic tool activation/deactivation in autoresearch mode via `setActiveTools()` API
- Added separate initialization and resume workflows for autoresearch with `command-initialize.md` and `command-resume.md` prompts
- Added intent dialog to prompt users for autoresearch optimization goals when starting fresh
- Added automatic detection of existing `autoresearch.md` to resume from previous sessions without re-prompting for intent
- Added autoresearch extension with autonomous experiment loop capabilities
- Added `init_experiment` tool to initialize and reset autoresearch sessions with configurable metrics
- Added `log_experiment` tool to record experiment results with metric parsing and confidence tracking
- Added `run_experiment` tool to execute commands and capture metrics with timeout and crash detection
- Added autoresearch dashboard controller for displaying experiment results and optimization progress
- Added support for secondary metrics tracking alongside primary metric
- Added `ExtensionWidgetContent` and `ExtensionUiComponentFactory` types for flexible widget configuration
- Added `ExtensionWidgetOptions` interface with `placement` parameter to position widgets above or below editor
- Added `WidgetPlacement` type supporting 'aboveEditor' and 'belowEditor' placement options
- Added `hookWidgetContainerAbove` and `hookWidgetContainerBelow` containers to InteractiveMode for separate widget management
- Added autoresearch mode for autonomous experiment loops with init_experiment, log_experiment, and run_experiment tools
- Added autoresearch dashboard widget displaying experiment results, metrics, and optimization progress
- Added support for metric tracking with configurable direction (lower/higher is better) and secondary metrics
- Added widget placement options to position extensions above or below the editor via `placement` parameter
- Added `ExtensionWidgetContent` and `ExtensionWidgetOptions` types for flexible widget configuration
- Added ACP (Agent Client Protocol) mode for headless agent operation via `--mode acp`
- Added support for Agent Client Protocol SDK integration with session management, MCP server configuration, and streaming communication
- Added `ensureOnDisk()` method to SessionManager to persist sessions immediately for ACP discovery
- Added multiline custom input for `ask` custom answers, using the prompt-style editor without inactivity timeout while composing ([#506](https://github.com/can1357/gajae-code/issues/506))

### Changed

- Changed autoresearch initialization to collect and validate benchmark command, metric definition, scope paths, off-limits list, and constraints before `init_experiment`
- Changed `init_experiment` to require exact benchmark command, metric definition, scope, off-limits, and constraints matching collected contract
- Changed `log_experiment` to record run number, benchmark command, scope paths, off-limits list, constraints, and segment fingerprint with each result
- Changed `run_experiment` to organize output in numbered run directories with separate benchmark and checks logs for artifact preservation
- Changed autoresearch dashboard to show pending run indicator when unlogged experiment exists
- Changed autoresearch resume workflow to detect and offer recovery of pending run artifacts before continuing experiment loop
- Changed `ExperimentResult` to include `runNumber`, `benchmarkCommand`, `scopePaths`, `offLimits`, `constraints`, and `segmentFingerprint` fields
- Changed `RunningExperiment` to track `runDirectory` and `runNumber` for artifact organization
- Changed `AutoresearchRuntime` to include `lastRunArtifactDir`, `lastRunNumber`, `lastRunSummary`, `benchmarkCommand`, `secondaryMetrics`, `scopePaths`, `offLimits`, `constraints`, and `segmentFingerprint`
- Changed autoresearch prompts to emphasize `autoresearch.md` as source of truth for benchmark, scope, and constraints
- Changed `command-initialize.md` to display collected setup (benchmark command, metric, direction, scope, off-limits, constraints) before initialization
- Changed `resume-message.md` to reference pending run artifacts and guide completion of unlogged experiments
- Changed `sendMessage()` API documentation to clarify `deliverAs: 'nextTurn'` behavior for hidden context delivery
- Changed `SendMessageHandler` type documentation to explain hidden next-turn message queuing during prompt teardown
- Changed autoresearch startup to create or reuse a dedicated `autoresearch/...` git branch before enabling the experiment loop
- Changed autoresearch to refuse startup when unrelated worktree changes would make auto-reverts unsafe
- Changed autoresearch prompts to emphasize scope and constraints as source of truth for session direction
- Changed component escape key handling to use keybinding manager for `app.interrupt` and `tui.select.cancel` with fallback to raw Escape matching
- Updated autoresearch prompt guidance to require explicit files in scope, off-limits paths, and session constraints
- Changed autoresearch command to use intent-based initialization instead of goal parameter, with user input dialog for new sessions
- Changed autoresearch startup to create or reuse a dedicated `autoresearch/...` git branch before enabling the experiment loop, and to refuse startup when unrelated worktree changes would make auto-reverts unsafe
- Changed autoresearch startup to activate experiment tools (`init_experiment`, `run_experiment`, `log_experiment`) only when autoresearch mode is enabled
- Changed autoresearch shutdown to deactivate experiment tools when mode is disabled or cleared
- Changed autoresearch session rehydration to dynamically manage experiment tool activation based on session state
- Changed autoresearch prompts and notes guidance to require explicit files in scope, off-limits paths, and session constraints
- Refactored hashline edit validation to enforce stricter anchor requirements per operation type
- Updated edit application logic to handle explicit file-level operations (`append_eof`, `prepend_bof`) separately from anchor-based operations
- Changed `setWidget` API to accept `ExtensionWidgetOptions` parameter for placement control
- Changed widget placement logic to manage widgets above and below editor separately
- Changed hashline edit application to preserve duplicated boundary lines exactly as provided instead of auto-correcting them
- Updated RPC mode to support widget placement option in `setWidget` requests
- Changed hashline edit application to preserve duplicated boundary lines exactly as provided instead of auto-correcting them
- Changed widget API to support placement options and component factories in addition to string arrays
- Updated extension UI controller to manage widgets above and below the editor separately
- Updated ask tool rendering to support markdown formatting in questions and option labels
- Refactored hook input and selector components to render titles as markdown for richer text formatting
- Changed session collection to include sessions with zero messages, enabling ACP mode to create discoverable sessions immediately
- Changed session persistence logic to use atomic file rewrite when flushing unflushed sessions to prevent duplication
- Removed hashline edit autocorrection for duplicated boundary lines; escaped-tab autocorrection remains available for leading `\\t` sequences

### Removed

- Removed `command-start.md` prompt template in favor of separate initialize and resume workflows
- Removed auto-correction of off-by-one range edits that duplicated closing braces or boundary lines
- Removed `shouldAutocorrect` function and related boundary line deduplication logic from hashline editor
- Removed auto-correction of off-by-one range edits that duplicated closing braces or boundary lines

### Fixed

- Fixed autoresearch resume to detect and recover pending run artifacts that were left unlogged from previous sessions
- Fixed dashboard overlay to display when running experiment even with zero completed results
- Fixed tab character rendering in dashboard command display and tool output summaries
- Fixed autoresearch logging to require durable ASI metadata (hypothesis, rollback_reason, next_action_hint) for every run including rollback context for discarded, crashed, and checks-failed experiments
- Fixed autoresearch logging to require durable ASI metadata for every run, including rollback context for discarded, crashed, and checks-failed experiments

### Fixed

- Fixed resumed and session-switched GitHub Copilot/OpenAI Responses conversations replaying stale assistant native history from older saved sessions by sanitizing persisted assistant replay metadata on rehydration and resetting provider session state across live session boundaries ([#505](https://github.com/can1357/gajae-code/issues/505))

### Added

- Session observer overlay (`Ctrl+S`): view running subagent sessions with a picker and read-only transcript showing thinking, text, tool calls, and results

## [13.14.0] - 2026-03-20

### Added

- Auto-reconnect MCP servers on connection loss with proactive SSE stream monitoring and retry backoff
- Tool-level reconnect: retriable connection errors (ECONNREFUSED, ECONNRESET, stale session 404/502/503) trigger automatic reconnection and single retry
- `/mcp reconnect <name>` command for manual server recovery after extended outages

### Changed

- Extended transport reconnect handling to all transport types (not just HTTP/SSE), ensuring stdio and other transports trigger automatic reconnection on connection loss
- Improved reconnect robustness by aborting retry attempts when MCP server configuration changes during reconnection sequence
- Updated explore agent thinking level from off to med for improved reasoning
- Simplified explore agent output schema: consolidated file references into single `ref` field with optional line ranges instead of separate `path`, `line_start`, `line_end` fields
- Removed `code` section from explore agent output (critical code excerpts no longer extracted)
- Removed `dependencies` section from explore agent output
- Removed `risks` section from explore agent output
- Removed `start_here` section from explore agent output

### Fixed

- Fixed reconnect retry loop continuing after configuration changes by checking epoch before each reconnection attempt
- `roots/list` timeout on MCP server initialization: `connectToServer` now always installs a default handler for `ping` and `roots/list`
- Fixed resumed GitHub Copilot conversations that could fail with `401 input item does not belong to this connection` on the first follow-up after process restart ([#488](https://github.com/can1357/gajae-code/issues/488))
- Fixed STT Alt+H mic cursor rendering to measure the actual microphone glyph width, preventing one-column TUI overflow crashes when the active symbol preset uses a wide icon ([#484](https://github.com/can1357/gajae-code/issues/484))

## [13.13.2] - 2026-03-18

### Added

- Added automatic stripping of hashline display prefixes (LINE#ID:) from write tool content when hashline edit mode is enabled, preventing the model from accidentally copying display markers into files
- Added `mcpServerName` and `mcpToolName` optional properties to custom tools for MCP server discovery and search metadata

## [13.13.1] - 2026-03-18

### Added

- Automatic deduplication of identical context files by content, keeping the closest (lowest depth) copy when duplicates are discovered

## [13.13.0] - 2026-03-18

### Added

- Added `edit.blockAutoGenerated` setting to control whether auto-generated file detection is enforced (enabled by default)
- Improved auto-generated file detection to use language-specific comment parsing instead of broad regex patterns, reducing false positives
- Added auto-generated file detection to prevent accidental modification of generated code (protoc, sqlc, buf, swagger, etc.)
- Added validation in Edit and Write tools to block modifications to files with auto-generated markers or naming patterns

### Changed

- Enhanced auto-generated marker detection to only scan leading header comments rather than entire file prefix, improving accuracy for files with generated markers in code

## [13.12.10] - 2026-03-17

### Added

- Added `args` field to ShellResult to capture the executed command
- Added `exit_code` property to ShellResult as an alias for `returncode`
- Added `check_returncode()` method to ShellResult to raise CalledProcessError on non-zero exit codes

### Changed

- Renamed `code` field to `returncode` in ShellResult (accessible via `code` property for backward compatibility)
- Updated `run()` command documentation to clarify available ShellResult fields

## [13.12.9] - 2026-03-17

### Added

- Added `/session delete` command to delete current session with confirmation and return to session selector
- Added session deletion in session selector via Delete key with confirmation dialog

### Changed

- Changed session deletion callback to return a boolean indicating success, allowing callers to distinguish between failed deletions and upstream cancellations

### Fixed

- Fixed OAuth redirect URI validation to preserve exact configured values without adding trailing slashes
- Fixed session deletion error handling to display error messages in the session selector UI instead of silently failing
- Added `oauth.redirectUri`, `oauth.clientSecret`, and `oauth.callbackPath` support for MCP server OAuth config so providers can use exact registered redirect URIs while preserving local callback listener settings ([#445](https://github.com/can1357/gajae-code/issues/445))

## [13.12.8] - 2026-03-16

### Breaking Changes

- Changed `SessionManager.create()` to require explicit `sessionDir` parameter instead of optional—callers must now pass `SessionManager.getDefaultSessionDir(cwd)` to use default behavior
- Changed `SessionManager.continueRecent()` to require explicit `sessionDir` parameter instead of optional—callers must now pass `SessionManager.getDefaultSessionDir(cwd)` to use default behavior
- Changed `SessionManager.forkFrom()` to require explicit `sessionDir` parameter instead of optional—callers must now pass `SessionManager.getDefaultSessionDir(cwd)` to use default behavior
- Changed `SessionManager.list()` signature to accept only `sessionDir` parameter instead of `cwd` and optional `sessionDir`—callers must now compute and pass the session directory explicitly

### Added

- Added `SessionManager.getDefaultSessionDir()` static method to explicitly resolve the canonical default session directory for a working directory
- Added support for quoted paths in grep, ast_grep, and find tools to handle directory names with spaces
- Added `normalizePathLikeInput` utility function to consistently handle quoted and whitespace-trimmed path inputs

### Changed

- Made `sessionDir` parameter optional in `SessionManager.create()`, `SessionManager.continueRecent()`, and `SessionManager.forkFrom()`—callers can now omit it to use the default session directory
- Changed `SessionManager.list()` signature to accept `cwd` as the first parameter instead of requiring an explicit `sessionDir`—callers can now omit `sessionDir` to use the default for the given working directory
- Updated `SessionManager.getDefaultSessionDir()` to accept optional `agentDir` parameter for computing session directories within a custom agent root
- Improved status line path display to strip display roots using canonical path resolution, correctly handling symlink aliases to home and Projects directories
- Improved error messaging in ast_grep when no matches are found with parse errors, now suggests narrowing `path`/`glob` or setting `lang` to resolve mis-scoped queries

### Fixed

- Fixed SDK-created default sessions to honor the configured `agentDir` for session storage, preventing tests from writing stray session directories into the real `~/.gjc/agent/sessions` root
- Fixed session directory resolution to correctly handle symlink-equivalent paths, ensuring aliased home and temp directories resolve to the same session storage location as their real targets

## [13.12.7] - 2026-03-16

### Changed

- Modified `getSelectedMCPToolNames()` to return only active MCP tools in non-discovery sessions, filtering by tool registry availability
- Updated `search_tool_bm25` tool instantiation to conditionally create the tool only when MCP discovery mode is enabled and execution hooks are available
- Changed search results to exclude already-selected MCP tools before applying the limit parameter, allowing discovery of additional tools in subsequent searches

### Fixed

- Fixed MCP tool selection tracking to properly distinguish between discovery-enabled and non-discovery sessions, preventing orphaned tool selections after manual deactivation

## [13.12.6] - 2026-03-15

### Changed

- Updated llama.cpp model discovery to read context window from the `/props` endpoint's `default_generation_settings.n_ctx` field instead of using hardcoded 128000 default
- Updated llama.cpp model discovery to detect vision capabilities from the `/props` endpoint's `modalities.vision` field instead of defaulting to text-only input
- Changed llama.cpp `maxTokens` calculation to respect discovered context window limits, capping at 8192 or the server's context window, whichever is smaller

### Fixed

- Fixed llama.cpp auto-discovery to read context window and vision support from the native `/props` endpoint instead of relying on hardcoded defaults

## [13.12.5] - 2026-03-15

### Added

- Automatic discovery of Ollama model context window from model metadata, enabling accurate token limit configuration
- Added `attribution` option to `PromptOptions` to explicitly control billing/initiator attribution for prompts
- Added automatic clearing of completed and abandoned todo tasks after ~1 minute

### Changed

- Ollama model registration now uses discovered context window instead of hardcoded 128000 token default
- Ollama model maxTokens now respects discovered context window constraints
- Improved session directory migration to handle legacy absolute paths with double-dash format, automatically relocating them to new canonical locations
- Enhanced session directory encoding to use `-tmp-` prefix for temporary directories instead of legacy double-dash format for better clarity
- Updated `SessionManager.create()` to require both `cwd` and `sessionDir` parameters for explicit session directory control
- Improved session directory naming for temporary working directories using `-tmp-` prefix instead of legacy `--` format
- Made `cwd` and `sessionDir` fields mutable in SessionManager to support session relocation without type casting
- Changed subagent prompts to explicitly set `attribution: "agent"` for accurate billing attribution
- Strip already-completed tasks when restoring session from branch history

### Fixed

- Fixed automatic migration of legacy session directories to new `-tmp-` prefixed naming scheme for temp-root sessions

## [13.12.4] - 2026-03-15

### Added

- Exposed `settings` instance in `CustomToolContext` for session-specific configuration access

### Changed

- Improved artifact spill configuration to use session settings with schema defaults as fallback
- Refactored type annotations for better type safety in tool result handling

## [13.12.2] - 2026-03-15

### Added

- Added `compaction.thresholdTokens` setting as a fixed token limit alternative to percentage-based compaction threshold
- Added more artifact spill threshold options (1 KB to 1 MB) with size descriptions
- Added more artifact tail bytes and tail lines options with descriptions
- Added `toExtensionId` capability method to enable granular disabling of individual capabilities by ID
- Added support for disabling specific capabilities (skills, tools, hooks, rules, prompts, instructions, slash commands, MCP servers, extension modules, and context files) via `disabledExtensions` setting
- Added `includeDisabled` and `disabledExtensions` options to `LoadOptions` for capability loading
- Added plugin manifest support for `extensions` entry points to allow plugins to contribute extension modules
- Added `extensions` field to plugin features for feature-specific extension entry points
- Added automatic discovery of extension modules from installed plugins during extension loading
- Added `disabledExtensions` setting to allow disabling specific extensions and skills by ID
- Added support for filtering skills by disabled extension IDs with `skill:` prefix

### Changed

- Changed capability loading to filter out disabled items based on extension IDs before returning results
- Changed plugin loader to support `extensions` as a manifest entry type alongside tools, hooks, and commands
- Changed extension discovery to include extension entry points from all enabled plugins
- Changed context file path handling to use `path.basename()` for consistent cross-platform filename extraction

### Fixed

- Fixed skill loading to properly respect disabled skill names when loading from custom directories

## [13.12.1] - 2026-03-15

### Added

- Support for move-only operations that preserve exact bytes including binary files

### Fixed

- Fixed handling of file moves when no edits are specified, now correctly preserves binary content
- Fixed validation to reject move operations where source and destination paths are identical

## [13.12.0] - 2026-03-14

### Added

- Added per-rule TTSR interrupt mode override via `interruptMode` field in rule frontmatter to allow fine-grained control over when TTSR interrupts stream processing
- Added `task` model role to allow configuring a dedicated model for subtask execution via `modelRoles.task` setting
- Added `moveCursorToMessageEnd` and `moveCursorToMessageStart` prompt actions to navigate to the beginning and end of the entire message
- Added support for provider-level `compat` configuration to apply OpenAI compatibility settings across all models from a provider
- Added `reasoningEffortMap` configuration option to map reasoning effort levels to provider-specific values
- Added support for `supportsUsageInStreaming`, `requiresToolResultName`, `requiresAssistantAfterToolResult`, `requiresThinkingAsText`, `thinkingFormat`, and `supportsStrictMode` OpenAI compatibility options
- Added support for provider-configurable `OpenAICompat.extraBody` to inject request-body fields for custom gateway/proxy routing
- Added `close()` method to SessionManager for properly closing persistent writers after flushing pending data
- Added `gjc config init-xdg` command to initialize XDG Base Directory structure on Linux
- Added `getHistoryDbPath()`, `getModelDbPath()`, `getMemoriesDir()`, `getTerminalSessionsDir()` path helpers

### Changed

- Path resolution on Linux redirects to XDG locations when `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` environment variables are set

### Changed

- Changed TTSR interrupt logic to respect per-rule `interruptMode` settings, falling back to global `ttsr.interruptMode` when rule-level override is not specified
- Reorganized settings tabs from 12 tabs (display, agent, input, tools, config, services, bash, lsp, ttsr, status) to 8 focused tabs (appearance, model, interaction, context, editing, tools, tasks, providers) for improved discoverability
- Consolidated status line settings into the Appearance tab instead of a separate Status tab
- Reorganized sampling parameters (temperature, topP, topK, minP, presencePenalty, repetitionPenalty) into the Model tab
- Moved edit tool settings (mode, fuzzyMatch, fuzzyThreshold, streamingAbort) to the Editing tab
- Moved read tool settings (readLineNumbers, readHashLines, read.defaultLimit) to the Editing tab
- Moved LSP settings (lsp.enabled, lsp.formatOnWrite, lsp.diagnosticsOnWrite, lsp.diagnosticsOnEdit) to the Editing tab
- Moved bash interceptor settings to the Editing tab
- Moved Python settings (python.toolMode, python.kernelMode, python.sharedGateway) to the Editing tab
- Moved task delegation settings (task.isolation.\*, task.eager, task.maxConcurrency, task.maxRecursionDepth) to the Tasks tab
- Moved skill and command settings to the Tasks tab
- Moved provider selection settings (providers.webSearch, providers.codeSearch, providers.image, etc.) to the Providers tab
- Moved Exa settings to the Providers tab
- Moved secret handling settings to the Providers tab
- Moved speech-to-text settings to the Interaction tab
- Moved context promotion, compaction, branch summary, memories, and TTSR settings to the Context tab
- Updated tab icon symbols across unicode, nerd, and ASCII presets to match new tab structure
- Changed default agent model from `default` to `pi/task` to enable independent model configuration for subtasks
- Changed agent model resolution to support single-pattern inheritance fallback, allowing `pi/task` agents to inherit the active session model when the task role is unconfigured
- Changed system prompt to use ISO 8601 date format (YYYY-MM-DD) instead of locale-specific formatting
- Changed system prompt template to use `{{date}}` instead of `{{dateTime}}` for current date display
- Changed tool download timeout from 15 seconds to 120 seconds to accommodate slower network conditions
- Changed working directory paths in system prompt to use forward slashes for consistency across platforms
- Modified bash executor to fall back to one-shot shell execution after a persistent session hard timeout, preventing subsequent commands from hanging

### Removed

- Removed bash executor hard timeout recovery test file (functionality already documented in existing entries)

### Fixed

- Fixed bash execution to fall back to one-shot shell runs after a persistent session hard timeout, preventing later commands from hanging until restart
- Fixed timeout handling in RpcClient to properly clear timeouts and prevent resource leaks
- Fixed AgentSession disposal to call SessionManager's `close()` method when available, ensuring proper cleanup of persistent writers
- Removed redundant `path.join()` call wrapping `getHistoryDbPath()` in history-storage.ts

## [13.11.1] - 2026-03-13

### Added

- Added `llama.cpp` as local provider
- Added `code_search` tool supporting both Exa and grep.app providers for code snippet and documentation search
- Added `providers.codeSearch` setting to configure code search provider (exa or grep)
- Added grep.app integration for public code search with result ranking by context relevance

### Changed

- Updated compact diff preview to include line hashes for visibility and integrity verification of unchanged and added lines
- Modified compact diff preview to track line number synchronization between old and new files when processing insertions and deletions
- Simplified web search tools: removed `web_search_deep`, `web_search_crawl`, `web_search_linkedin`, and `web_search_company` tools
- Removed `exa.enableLinkedin` and `exa.enableCompany` settings; LinkedIn and company research are no longer available
- Refactored code search to use pluggable provider system instead of Exa-only implementation

### Removed

- Removed Exa LinkedIn search tool (`exa_linkedin`)
- Removed Exa company research tool (`exa_company`)
- Removed Exa deep search tool (`exa_search_deep`)
- Removed Exa URL crawl tool (`exa_crawl`)

### Fixed

- Fixed line number parsing in compact diff preview to handle variable-width line number fields with leading whitespace

## [13.11.0] - 2026-03-12

### Added

- Added Parallel as a web search provider with support for fast and research modes
- Added Parallel extract API integration for URL content fetching and YouTube video extraction
- Added `providers.parallelFetch` setting to enable/disable Parallel extract for URL fetching
- Added `/login parallel` command support for Parallel API authentication
- Added subcommands to `/copy` command: `code` (copy last code block), `all` (copy all code blocks), `cmd` (copy last bash/python command), and `last` (copy full message)
- Added support for copying last executed bash or python command via `/copy cmd` subcommand
- Added `assignment` field to task progress and result objects to track the raw per-task assignment text separately from the full templated task
- Added `details` field to todo items for storing implementation specifics, file paths, and edge cases (shown only when task is active)
- Added support for multi-line details in todo items with automatic indentation in interactive and reminder displays
- Added `todo.eager` setting to automatically create a comprehensive todo list after the first user message
- Added `buildNamedToolChoice` utility function to build provider-aware tool choice constraints for named tools
- Support for comma/space-separated path lists in `find`, `grep`, `ast_grep`, and `ast_edit` tools (e.g., `apps/,packages/,phases/` or `apps/ packages/ phases/`)
- New `resolveMultiSearchPath` and `resolveMultiFindPattern` functions to handle multi-path search inputs with automatic common base path detection
- Added `display.showTokenUsage` setting to show per-turn token usage (input, output, cache) on assistant messages

### Changed

- Updated HTML-to-text rendering to prefer Parallel extract when credentials are available, before falling back to jina, trafilatura, or lynx
- Updated YouTube scraper to prefer Parallel extract when credentials are available, before falling back to yt-dlp
- Updated web search provider priority order to include Parallel between Exa and Kagi
- Updated hashline tool documentation with explicit guidance on `replace` operation semantics, clarifying that `lines` must not extend past `end` to avoid unintended line duplication
- Improved diagnostic message formatting to group errors by file path with indented details for better readability
- Modified eager todo prelude to use hidden custom message type instead of visible developer message, preventing duplicate prompt text in session history
- Updated eager todo prompt to remove dynamic user request injection, simplifying the template and preventing request repetition in displayed messages
- Modified eager todo enforcement to prepend the todo reminder to the first user turn instead of executing it as a separate synthetic turn, reducing unnecessary prompt calls
- Updated task rendering to display assignment text instead of full task template when available, reducing noise in progress and result displays
- Modified task section rendering to show trimmed assignment text without stripping context blocks, simplifying the display logic
- Updated todo item display to show `details` field indented below active tasks in both interactive mode and todo reminder component
- Modified tool choice resolution to support per-turn tool choice overrides via `consumeNextToolChoiceOverride()`
- Updated tool documentation to clarify that `path` parameter accepts files, directories, glob patterns, or comma/space-separated path lists
- Refactored path resolution logic in `find`, `grep`, `ast_grep`, and `ast_edit` tools to use unified multi-path handling

### Fixed

- Fixed hashline line normalization to trim trailing whitespace and strip carriage returns instead of removing all whitespace, preserving intentional spacing in code
- Fixed noop detection in hashline replace operations to check array length equality before comparing lines, preventing false noop classification when single-line replacements expand to multiple lines
- Fixed path resolution to accept bare directory names without trailing slashes in comma/space-separated path lists (e.g., `apps packages phases`)
- Per-role `modelRoles` thinking selectors now propagate through commit/title helper model selection, legacy commit analysis, and agentic commit sessions while preserving default thinking inheritance when no role override is configured

## [13.10.1] - 2026-03-10

### Added

- Exported `submitInteractiveInput()` function for programmatic submission of user input in interactive mode
- Added proactive OAuth token refresh for MCP server connections with 5-minute expiry buffer
- Added reactive 401/403 retry with automatic token refresh on HTTP MCP transports
- Added `refreshMCPOAuthToken()` for standard OAuth 2.0 refresh_token grants
- Persisted `tokenUrl`, `clientId`, and `clientSecret` in MCP auth config for cross-session token refresh

### Fixed

- Respected `PI_CONFIG_DIR` when discovering native user config paths for slash commands and related config directories ([#349](https://github.com/can1357/gajae-code/issues/349))

## [13.10.0] - 2026-03-10

### Fixed

- Preserved text signature metadata (id and phase) when building OpenAI native history during session compaction

## [13.9.16] - 2026-03-10

### Breaking Changes

- Web search tool no longer accepts `provider` parameter in tool calls; use internal provider resolution instead
- Removed `no_fallback` option from search parameters

### Added

- Added `before_provider_request` extension event to intercept and modify provider request payloads before sending
- Added `emitBeforeProviderRequest()` method to ExtensionRunner for chaining payload transformations across extensions
- Added `refreshInBackground()` method to ModelRegistry for non-blocking model discovery
- Added `refreshProvider()` method to refresh models for a specific provider on demand
- Added `getDiscoverableProviders()` method to list all configured discoverable providers
- Added `getProviderDiscoveryState()` method to inspect provider discovery status, cache age, and errors
- Added provider discovery state tracking with status indicators (idle, ok, cached, unavailable, unauthenticated)
- Added model caching with 24-hour TTL to preserve discovered models across sessions
- Added provider-specific empty state messages in model selector showing cache age and discovery status
- Added live provider refresh when switching provider tabs in model selector

### Changed

- Changed model discovery to load cached models immediately before attempting live refresh, improving startup performance
- Changed model selector to refresh offline by default when reloading config, deferring live discovery to background
- Changed model discovery timeout from 3000ms to 250ms for faster failure detection
- Changed model discovery error handling to preserve cached models when live refresh fails
- Changed `refresh()` strategy parameter to support 'offline' mode for config-only reloads
- Changed main.ts to defer model refresh until needed (--list-models or background refresh)
- Changed SDK session creation to use background refresh instead of blocking on model discovery
- Removed `provider` parameter from web search tool schema; provider selection now handled internally
- Removed `no_fallback` parameter from web search parameters; fallback behavior now automatic based on provider availability
- Renamed `SearchParams` type to `SearchToolParams` for tool execution; introduced `SearchQueryParams` for CLI queries with optional provider selection

### Fixed

- Fixed model discovery to continue using cached models when provider is temporarily unavailable
- Fixed unauthenticated provider discovery to preserve cached models instead of discarding them
- Fixed model selector to show discovery status messages when provider has no models

## [13.9.15] - 2026-03-10

### Added

- Added `ensureLoadingAnimation()` method to manage loading animation lifecycle and prevent duplicate spinners

### Changed

- Refactored loading animation initialization to use centralized `ensureLoadingAnimation()` method in event and input controllers
- Updated `showError()` to properly clean up loading animation state when errors occur

## [13.9.12] - 2026-03-09

### Added

- Added Tavily as a supported web search provider with `TAVILY_API_KEY` credential discovery and provider fallback support
- Added `#`-triggered prompt action suggestions in the editor, with keybinding hints for line navigation and prompt copy actions
- Added Tavily as a supported web search provider with `TAVILY_API_KEY` credential discovery and provider fallback support ([#313](https://github.com/can1357/gajae-code/issues/313))

### Removed

- Removed Kagi Universal Summarizer integration from fetch tool—HTML rendering now uses jina, trafilatura, and lynx only
- Removed `fetch.useKagiSummarizer` setting
- Removed Kagi summarization from YouTube video handling

### Fixed

- Canonicalized bash executor working directories before handing them to brush so `pwd` stays aligned with canonical Git worktree paths in symlinked workspaces

## [13.9.10] - 2026-03-08

### Added

- Added `env` parameter to bash tool to pass environment variables safely without shell re-parsing, preventing quote and special character bugs with multiline or untrusted values
- Added support for rendering partial `env` assignments in command preview while tool arguments are still streaming
- Added `env` support to the bash tool so commands can reference safe shell variables without inline quoting bugs for multiline or quote-heavy values

### Changed

- Changed bash tool to display environment variable assignments in command preview when `env` parameter is used

## [13.9.8] - 2026-03-08

### Added

- Added docs.rs scraper for extracting Rust crate documentation from rustdoc JSON, including support for modules, functions, structs, traits, enums, and other Rust items with caching

## [13.9.7] - 2026-03-08

### Added

- Added `skipPostPromptRecoveryWait` option to handoff operations to defer recovery work until after handoff completion
- Added deferred auto-compaction scheduling to allow threshold-triggered handoffs to complete while the original prompt is still unwinding

### Changed

- Extracted handoff document template to dedicated prompt file for improved maintainability and template variable support
- Changed handoff prompt generation to use template rendering with support for custom focus instructions
- Refactored internal prompt-in-flight tracking from boolean flag to counter to properly handle nested prompt operations
- Moved llms.txt endpoint discovery to fallback strategy when rendered page content is low quality, prioritizing page-specific content over site-wide files
- Enhanced llms.txt endpoint detection to scope candidates to the requested URL path, searching section-specific files before site-wide ones

## [13.9.6] - 2026-03-08

### Added

- Added `glob` parameter to `ast_grep` and `ast_edit` tools for additional glob filtering relative to the `path` parameter
- Added `combineSearchGlobs` utility function to merge glob patterns from `path` and `glob` parameters

### Changed

- Renamed `patterns` parameter to `pat` in `ast_grep` tool for consistency
- Renamed `selector` parameter to `sel` in `ast_grep` and `ast_edit` tools for brevity
- Updated tool documentation with expanded guidance on AST pattern syntax, metavariable usage, and contextual matching strategies
- Updated `grep` tool to combine glob patterns from `path` and `glob` parameters instead of throwing an error when both are provided

## [13.9.4] - 2026-03-07

### Added

- Automatic detection of Ollama model capabilities including reasoning/thinking support and vision input via the `/api/show` endpoint
- Improved Kagi API error handling with extraction of detailed error messages from JSON and plain text responses

### Changed

- Updated Kagi provider description to clarify requirement for Kagi Search API beta access

## [13.9.3] - 2026-03-07

### Breaking Changes

- Changed `ThinkingLevel` type to be imported from `@gajae-code/agent-core` instead of `@gajae-code/ai`
- Changed thinking level representation from string literals to `Effort` enum values (e.g., `Effort.High` instead of `"high"`)
- Changed `getThinkingLevel()` return type to `ThinkingLevel | undefined` to support models without thinking support
- Changed model `reasoning` property to `thinking` property with `ThinkingConfig` for explicit effort level configuration
- Changed `thinkingLevel` in session context to be optional (`ThinkingLevel | undefined`) instead of always present

### Added

- Added `thinking.ts` module with `getThinkingLevelMetadata()` and `resolveThinkingLevelForModel()` utilities for thinking level handling
- Added `ThinkingConfig` support to model definitions for specifying supported thinking effort levels per model
- Added `enrichModelThinking()` function to apply thinking configuration to models during registry initialization
- Added `clampThinkingLevelForModel()` function to constrain thinking levels to model-supported ranges
- Added `getSupportedEfforts()` function to retrieve available thinking efforts for a model
- Added `Effort` enum import from `@gajae-code/ai` for type-safe thinking level representation
- Added `/fast` slash command to toggle OpenAI service tier priority mode for faster response processing
- Added `serviceTier` setting to control OpenAI processing priority (none, auto, default, flex, scale, priority)
- Added `compaction.remoteEnabled` setting to control use of remote compaction endpoints
- Added remote compaction support for OpenAI and OpenAI code provider models with encrypted reasoning preservation
- Added fast mode indicator (⚡) to model segment in status line when priority service tier is active
- Added context usage threshold levels (normal, warning, purple, error) with token-aware thresholds for better context awareness
- Added `isFastModeEnabled()`, `setFastMode()`, and `toggleFastMode()` methods to AgentSession for fast mode control

### Changed

- Changed credential deletion to disable credentials with persisted cause instead of permanent deletion
- Added `disabledCause` parameter to credential deletion methods to track reason for disabling
- Changed thinking level parsing to use `parseEffort()` from local thinking module instead of `parseThinkingLevel()` from pi-ai
- Changed model list display to show supported thinking efforts (e.g., "low,medium,high") instead of yes/no reasoning indicator
- Changed footer and status line to check `model.thinking` instead of `model.reasoning` for thinking level display
- Changed thinking selector to work with `Effort` type instead of `ThinkingLevel` for available levels
- Changed model resolver to return `undefined` for thinking level instead of `"off"` when no thinking is specified
- Changed compaction reasoning parameters to use `Effort` enum values instead of string literals
- Changed RPC types to use `Effort` for cycling thinking levels and `ThinkingLevel | undefined` for session state
- Changed theme thinking border color function to accept both `ThinkingLevel` and `Effort` types
- Changed context usage coloring in footer and status line to use token-aware thresholds instead of fixed percentages
- Changed compaction to preserve OpenAI remote compaction state and encrypted reasoning across sessions
- Changed compaction to skip emitting kept messages when using OpenAI remote compaction with preserved history
- Changed session context to include `serviceTier` field for tracking active service tier across session branches
- Changed `compact()` function to accept `remoteInstructions` option for custom remote compaction prompts
- Changed model registry to apply hardcoded policies (gpt-5.4 context window) consistently across all model loading paths

### Fixed

- Fixed OpenAI remote compaction to correctly append incremental responses instead of replacing entire history
- Fixed thinking level display logic in main.ts to correctly check for undefined instead of "off"
- Fixed model registry to preserve explicit thinking configuration on runtime-registered models
- Fixed usage limit reset time calculation to use absolute `resetsAt` timestamps instead of deprecated `resetInMs` field
- Fixed compaction summary message creation to no longer be automatically added to chat during compaction (now handled by session manager)
- Fixed Kagi web search errors to surface the provider's beta-access message and clarified that Kagi search requires Search API beta access

## [13.9.2] - 2026-03-05

### Added

- Support for Python code execution messages with output display and error handling
- Support for mode change entries in session exports
- Support for TTSR injection and session initialization entries in tree filtering

### Changed

- Updated label lookup to use `targetId` field instead of `parentId` for label references
- Changed model change entry display to use `model` field instead of separate `provider` and `modelId` fields
- Simplified model change rendering by removing OpenAI code provider bridge prompt display
- Updated searchable text extraction to include Python code from `pythonExecution` messages

### Removed

- Removed `openai-codeInjectionInfo` from session data destructuring
- Removed OpenAI code provider-specific bridge prompt UI from model change entries

### Fixed

- Auto-corrected off-by-one range start errors in hashline edits that would duplicate preceding lines

## [13.9.0] - 2026-03-05

### Added

- Added `read.defaultLimit` setting to configure default number of lines returned by read tool when no limit is specified (default: 300 lines)
- Added preset options for read default limit (200, 300, 500, 1000, 5000 lines) in settings UI

### Changed

- Updated read tool prompt to distinguish between default limit and maximum limit per call
- Moved `ThinkingLevel` type from `@gajae-code/agent-core` to `@gajae-code/ai` for centralized thinking level definitions
- Replaced local thinking level validation with `parseThinkingLevel()` and `ALL_THINKING_LEVELS` from `@gajae-code/ai`
- Updated thinking level option providers to use `THINKING_MODE_DESCRIPTIONS` from `@gajae-code/ai` for consistent descriptions
- Renamed `RoleThinkingMode` type to `ThinkingMode` and changed default value from `'default'` to `'inherit'` for clarity
- Replaced `formatThinkingEffortLabel()` utility with `formatThinking()` from `@gajae-code/ai`
- Renamed `extractExplicitThinkingLevel()` to `extractExplicitThinkingSelector()` in model resolver
- Updated thinking level clamping to use `getAvailableThinkingLevel()` from `@gajae-code/ai`

### Removed

- Removed `thinking-effort-label.ts` utility file (functionality moved to `@gajae-code/ai`)
- Removed local `VALID_THINKING_LEVELS` constant definitions across multiple files
- Removed `isValidThinkingLevel()` function (replaced by `parseThinkingLevel()` from `@gajae-code/ai`)
- Removed `parseThinkingLevel()` helper from discovery module (now uses centralized version from `@gajae-code/ai`)

### Fixed

- Fixed provider session state not being cleared when branching or navigating tree history, preventing resource leaks with openai-code provider sessions

## [13.8.0] - 2026-03-04

### Added

- Added `buildCompactHashlineDiffPreview()` function to generate compact diff previews for model-visible tool responses, collapsing long unchanged runs and consecutive additions/removals to show edit shape without full file content
- Added project-level discovery for `.agent/` and `.agents/` directories, walking up from cwd to repo root (matching behavior of other providers like `.gjc`, `.anthropic-model`, `.openai-code`). Applies to skills, rules, prompts, commands, context files (AGENTS.md), and system prompts (SYSTEM.md)

### Changed

- Changed edit tool response to include diff summary with line counts (+added -removed) and a compact diff preview instead of warnings-only output
- Limited auto context promotion to models with explicit `contextPromotionTarget`; models without a configured target now compact on overflow instead of switching to arbitrary larger models ([#282](https://github.com/can1357/gajae-code/issues/282))

### Fixed

- Fixed `:thinking` suffix in `modelRoles` config values silently breaking model resolution (e.g., `slow: anthropic/anthropic-model-opus-4-6:high`) and being stripped on Ctrl+P role cycling

## [13.7.6] - 2026-03-04

### Added

- Exported `dedupeParseErrors` utility function to deduplicate parse error messages while preserving order

### Fixed

- Reduced duplicate parse error messages when multiple patterns fail on the same file
- Normalized parse error output in ast-grep to remove pattern-specific prefixes and show only file-level errors

## [13.7.4] - 2026-03-04

### Added

- Added `fetch.useKagiSummarizer` setting to toggle Kagi Universal Summarizer usage in the fetch tool.

### Fixed

- Fixed incorrect message history reference in session title generation that could cause missing or stale titles on first message
- Added startup check requiring Bun 1.3.7+ for JSONL session parsing (`Bun.JSONL.parseChunk`) and clear upgrade guidance so `/resume` and `--resume` do not silently report missing sessions on older Bun runtimes

## [13.7.3] - 2026-03-04

### Added

- Added Kagi Universal Summarizer integration for URL summarization, now prioritized before Jina and other methods
- Added Kagi Universal Summarizer support for YouTube video summaries when credentials are available
- Exported `searchWithKagi` and `summarizeUrlWithKagi` functions from new `web/kagi` module for direct API access
- Added `KagiApiError` exception class for Kagi API-specific error handling

### Changed

- Updated hashline prompt documentation with clearer operation syntax and improved examples showing full edit structure with path and edits array
- Refactored `href` Handlebars helper to return JSON-quoted strings for safer embedding in JSON blocks within prompts
- Improved `hashlineParseText` to correctly preserve blank lines and trailing empty strings in array input while stripping trailing newlines from string input
- Optimized duplicate line detection in range replacements to use trimmed comparison, reducing false positives from whitespace differences
- Refactored Kagi search provider to use shared Kagi API utilities from `web/kagi` module
- Changed HTML-to-text rendering priority order to try Kagi first, then Jina, Trafilatura, and Lynx

### Fixed

- Fixed `isEscapedTabAutocorrectEnabled` environment variable parsing to use switch statement for clearer logic and consistent default behavior

## [13.7.2] - 2026-03-04

### Added

- Added support for direct OAuth provider login via `/login <provider>` command (e.g., `/login kagi`)
- Added optional `providerId` parameter to `showOAuthSelector()` to enable direct provider selection without UI selector

### Changed

- Simplified web search result formatting to omit empty sections and metadata when not present

## [13.7.0] - 2026-03-03

### Fixed

- Fixed `ask` timeout handling to auto-select the recommended option instead of aborting the turn, while preserving explicit user-cancel abort behavior ([#266](https://github.com/can1357/gajae-code/issues/266))

## [13.6.2] - 2026-03-03

### Fixed

- Fixed LM Studio API key retrieval to use configured provider name instead of hardcoded 'lm-studio'
- Fixed resource content handling to properly check for empty text values (null/undefined)
- Fixed resource refresh tracking to prevent stale promise reuse when server connection changes
- Fixed update target resolution to properly handle cases where binary path cannot be resolved

## [13.6.1] - 2026-03-03

### Fixed

- Fixed `gjc update` silently succeeding without actually updating the binary when the update channel (bun global vs compiled binary) doesn't match the installation method ([#247](https://github.com/can1357/gajae-code/issues/247))
- Added post-update verification that checks the resolved `gjc` binary reports the expected version, with actionable warnings on mismatch
- `gjc update` now detects when the `gjc` in PATH is not managed by bun and falls back to binary replacement instead of updating the wrong location

## [13.6.0] - 2026-03-03

### Added

- Added `mcp://` internal URL protocol for reading MCP server resources directly via the read tool (e.g., `read(path="mcp://resource-uri")`)
- Added LM Studio integration to the model registry and discovery flow.
- Added support for authenticating with LM Studio using the `/login lm-studio` command.
- Added `fuse-projfs` task isolation mode for Windows ProjFS-backed overlays.
- Added `/mcp registry search <keyword>` integration with Smithery, including interactive result selection, editable server naming before deploy, Smithery `configSchema` prompts, and immediate runtime reload so selected MCP tools are available without restarting
- Added OAuth failure fallback in `/mcp registry search` deploy flow to prompt for manual bearer tokens and validate them before saving configuration
- Added Smithery auth support for `/mcp registry search` with cached API key login (`/mcp registry login`, `/mcp registry logout`) and automatic login prompt/retry on auth or rate-limit responses

### Changed

- Updated MCP resource update notifications to recommend using `read(path="mcp://<uri>")` instead of the deprecated `read_resource` tool
- Updated Anthropic Foundry environment variable documentation and CLI help text to the canonical names: `ANTHROPIC_MODEL_CODE_USE_FOUNDRY`, `ANTHROPIC_MODEL_CODE_CLIENT_CERT`, and `ANTHROPIC_MODEL_CODE_CLIENT_KEY`
- Documented Foundry-specific Anthropic runtime configuration (`FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, `NODE_EXTRA_CA_CERTS`) in environment variable reference docs
- `fuse-overlay` task isolation now targets `fuse-overlayfs` on Unix hosts only; on Windows it falls back to `worktree` with a `<system-notification>` suggesting `fuse-projfs`.
- `fuse-projfs` now performs Windows ProjFS preflight checks and falls back to `worktree` when host or repository prerequisites are unavailable.
- Cross-repo patch capture now uses the platform null device (`NUL` on Windows, `/dev/null` elsewhere) for `git diff --no-index`.

### Removed

- Removed `read_resource` tool; MCP resource reading is now integrated into the `read` tool via `mcp://` URLs

### Fixed

- Fixed MCP resource subscription handling to prevent unsubscribing when notifications are re-enabled after being disabled
- Fixed LM Studio base URL validation to preserve invalid configured URLs instead of silently falling back to localhost
- Fixed URI template matching to correctly handle expressions that expand to empty strings

## [13.5.6] - 2026-03-01

### Changed

- Updated OAuth client name from 'gajae-code MCP' to 'OpenAI code' for dynamic client registration

### Fixed

- Fixed exit_plan_mode handler to abort active agent turn before opening plan approval selector, ensuring proper session cleanup

## [13.5.5] - 2026-03-01

### Added

- Added Kagi web search provider (Search API v0) with related searches support and automatic `KAGI_API_KEY` detection

## [13.5.4] - 2026-03-01

### Added

- Added `authServerUrl` field to `AuthDetectionResult` to capture OAuth server metadata from `Mcp-Auth-Server` headers
- Added `extractMcpAuthServerUrl()` function to parse and validate `Mcp-Auth-Server` URLs from error messages
- Added support for `/.well-known/oauth-protected-resource` discovery endpoint to resolve authorization servers
- Added recursive auth server discovery to follow `authorization_servers` references when discovering OAuth endpoints

- Added `gjc agents unpack` CLI subcommand to export bundled subagent definitions to `~/.gjc/agent/agents` by default, with `--project` support for `./.gjc/agents`

### Changed

- Enhanced `discoverOAuthEndpoints()` to accept optional `authServerUrl` parameter and query both auth server and resource server for OAuth metadata
- Improved OAuth metadata extraction to handle additional field name variations (`clientId`, `default_client_id`, `public_client_id`)
- Refactored OAuth endpoint discovery logic into reusable `findEndpoints()` helper for consistent metadata parsing across multiple sources
- Task subagents now strip inherited `AGENTS.md` context files and the task tool prompt no longer warns against repeating AGENTS guidance, aligning subagent context with explicit task inputs ([#233](https://github.com/can1357/gajae-code/issues/233))

### Fixed

- Fixed MCP OAuth discovery to honor `Mcp-Auth-Server` metadata and resolve authorization endpoints from the declared auth server, restoring Figma MCP login URLs with `client_id` ([#235](https://github.com/can1357/gajae-code/issues/235))

## [13.5.3] - 2026-03-01

### Added

- Auto-include `ast_grep` and `ast_edit` tools when their text-based counterparts (`grep`, `edit`) are requested and the AST tools are enabled
- Enforced tool decision in plan mode—agent now requires calling either `ask` or `exit_plan_mode` when a turn ends without a required tool call
- Auto-correction of escaped tab indentation in edits (enabled by default, controllable via `PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS` environment variable)
- Warning when suspicious Unicode escape placeholder `\uDDDD` is detected in edit content

### Changed

- Updated bash tool description to conditionally show `ast_grep` and `ast_edit` guidance based on tool availability in the session
- Replaced timeout-based cancellation with AbortSignal-based cancellation in the `ask` tool for more reliable user interaction handling
- Updated `ask` tool to distinguish between user-initiated cancellation and timeout-driven auto-selection, with only user cancellation aborting the turn
- Updated hashline documentation to clarify that `\t` in JSON represents a real tab character, not a literal backslash-t sequence

### Fixed

- Fixed race condition in dialog overlay handling where multiple concurrent resolutions could occur
- Cancelling the `ask` tool now aborts the current turn instead of returning a normal cancelled selection, while timeout-driven auto-cancel still returns without aborting

## [13.5.2] - 2026-03-01

### Added

- Added `checkpoint` tool to create context checkpoints before exploratory work, allowing you to investigate with many intermediate tool calls and minimize context cost afterward
- Added `rewind` tool to end an active checkpoint and replace intermediate exploration messages with a concise investigation report
- Added `checkpoint.enabled` setting to control availability of the checkpoint and rewind tools
- Added `render_mermaid` tool to convert Mermaid graph source into ASCII diagram output
- Added `renderMermaid.enabled` setting to control availability of the render_mermaid tool

### Changed

- Changed Mermaid rendering from PNG images to ASCII diagrams in theme rendering
- Changed `prerenderMermaid()` function to synchronously render ASCII instead of asynchronously rendering PNG

## [13.5.0] - 2026-03-01

### Added

- Added `hlinejsonref` Handlebars helper for embedding hashline references inside JSON blocks in prompts
- Added `librarian` agent for researching external libraries and APIs by reading source code
- Added `oracle` agent for deep reasoning on debugging, architecture decisions, and technical advice
- Added `dependencies` and `risks` output fields to explore agent for better context handoff
- Added support for `lsp`, `fetch`, `web_search`, and `ast_grep` tools to explore, plan, and reviewer agents

### Changed

- Enhanced hashline tool documentation with explicit prohibition on formatting-only edits
- Added mandatory rule requiring indentation in `lines` to match surrounding context exactly from `read` output
- Changed explore agent output field `query` to `summary` with expanded description for findings and conclusions

## [13.4.1] - 2026-03-01

### Fixed

- Pending resolve reminders now trigger as soon as a preview action is queued, before the next assistant turn, with regression coverage in `agent-session-resolve-reminder` tests

## [13.4.0] - 2026-03-01

### Breaking Changes

- `ast_grep` parameter `pattern` (string) replaced by `patterns` (string[])
- `ast_edit` parameters `pattern` + `rewrite` replaced by `ops: Array<{ pat: string; out: string }>`

### Added

- Added `resolve` tool to apply or discard pending preview actions with required reasoning
- AST edit now registers pending actions after preview, allowing explicit apply/discard workflow via `resolve` tool
- Custom tools can register pending actions via `pushPendingAction(action)` in `CustomToolAPI`, enabling the `resolve` workflow for custom preview-apply flows
- `deferrable?: boolean` field added to `AgentTool`, `CustomTool`, and `ToolDefinition` interfaces; tools that set it signal they may stage pending actions
- `HIDDEN_TOOLS` and `ResolveTool` exported from `@gajae-code/coding-agent` SDK for manual tool composition
- `PendingActionStore` now uses a LIFO stack (`push`/`peek`/`pop`); multiple deferrable tools can stage actions that resolve in reverse order of registration
- Added `gemini`, `openai-code`, and `synthetic` as supported values for the `providers.webSearch` setting
- `ast_grep` tool now accepts a `patterns` array (replaces single `pattern`); multiple patterns run in one native pass and results are merged before offset/limit
- `ast_edit` tool now accepts an `ops` array of `{ pat, out }` entries (replaces `pattern` + `rewrite`); duplicate patterns are rejected upfront
- AST find output now uses `>>` prefix on match-start lines and pads line numbers; directory-tree grouping with `# dir` / `## └─ file` headers for directory-scoped searches
- AST replace output now renders diff-style (`-before` / `+after`) change previews grouped by directory
- Both AST tools now report `scopePath`, `files`, and per-file match/replacement counts in tool details
- Task item `id` max length raised from 32 to 48 characters
- Anthropic web search provider now uses `buildAnthropicSearchHeaders` (dedicated search header builder separate from inference headers)
- Gemini web search provider: endpoint fallback (daily → sandbox) with retry on 429/5xx
- Gemini web search now injects Antigravity system instruction and aligned request metadata (`requestType`, `userAgent`, `requestId`) for Antigravity credentials
- `buildGeminiRequestTools()` helper for composable Gemini tool configuration (googleSearch, codeExecution, urlContext)
- Web search schema exposes `max_tokens`, `temperature`, and `num_search_results` as tool parameters
- Web search provider fallback: when an explicit provider is unavailable, resolves the auto chain instead of returning empty results

### Changed

- Simplified `resolve` tool output rendering to use inline highlighted format instead of boxed layout
- Updated `resolve` tool to parse source tool name from label using colon separator for cleaner display
- `resolve` tool is now conditionally injected: included only when at least one active tool has `deferrable: true` (previously always included)
- `discoverAndLoadCustomTools` / `loadCustomTools` accept an optional `pendingActionStore` parameter to wire `pushPendingAction` for custom tools
- AST edit tool no longer accepts `preview` parameter; all AST edit calls now return previews by default
- AST edit workflow changed: preview is always shown, then use `resolve` tool to apply or discard changes
- Agent now suggests calling `resolve` tool after AST edit preview with system reminder
- `ast_grep`: `include_meta` parameter removed; metavariable captures are now always included in output
- `ast_edit`: `dry_run` renamed to `preview`; `max_files` removed from schema and capped globally via `$PI_MAX_AST_FILES` (default 1000); `max_replacements` renamed to `limit`
- `ast_grep` and `ast_edit`: parse errors in tool output are now capped at `PARSE_ERRORS_LIMIT` (20); excess errors are summarised as `N / total parse issues` rather than flooding the context
- Updated `ast_grep` and `ast_edit` tool prompt examples to use concise, idiomatic patterns

### Removed

- Removed `normativeRewrite` setting that rewrote tool call arguments to normalized format in session history
- Removed `buildNormativeUpdateInput()` helper and normative patch transformation logic

### Fixed

- `ast_edit` no longer rejects empty `out` values; an empty string now deletes matched nodes
- `ast_edit` no longer trims `pat` and `out` values, preserving intentional whitespace
- `gemini_image` tool: corrected `responseModalities` values from `'Image'`/`'Text'` to uppercase `'IMAGE'`/`'TEXT'` matching the API enum

## [13.3.14] - 2026-02-28

### Added

- Expanded AST tool language support from 7 to all 25 ast-grep tree-sitter languages (Bash, C, C++, C#, CSS, Elixir, Go, Haskell, HCL, HTML, Java, JavaScript, JSON, Kotlin, Lua, Nix, PHP, Python, Ruby, Rust, Scala, Solidity, Swift, TSX, TypeScript, YAML)
- AST find now emits all lines of multiline matches with hashline tags (LINE#HASH:content) consistent with read/grep output
- Added AST pattern syntax reference (metavariables, wildcards, variadics) to system prompt
- Added examples and scoping guidance to ast-grep and ast-edit tool prompts
- Added `provider-schema-compatibility.test.ts`: integration test that instantiates every builtin and hidden tool, runs their parameter schemas through `adaptSchemaForStrict`, `sanitizeSchemaForGoogle`, and `prepareSchemaForCCA`, and asserts zero violations against each provider's compatibility rules

### Fixed

- Non-code files (.md, .zip, .bin, .gitignore, etc.) are now silently skipped by AST tools instead of producing misleading parse errors
- Fixed `grep` path wildcard handling so file patterns passed via `path` (for example `schema-review-*.test.ts`) are resolved as glob filters instead of failing path existence checks

## [13.3.11] - 2026-02-28

### Fixed

- Restored inline rendering for `read` tool image results in assistant transcript components, including streaming and rebuilt session history paths.
- Fixed shell-escaped read paths (for example, pasted `\ `-escaped screenshot filenames) by resolving unescaped fallback candidates before macOS filename normalization variants.

## [13.3.8] - 2026-02-28

### Added

- Added `ast_grep` tool for structural code search using AST matching via ast-grep, enabling syntax-aware pattern discovery across codebases
- Added `ast_edit` tool for structural AST-aware rewrites via ast-grep, enabling safe syntax-level codemods without text-based fragility
- Added `astGrep.enabled` and `astEdit.enabled` settings to control availability of AST tools
- Added system prompt guidance to prefer AST tools over bash text manipulation (grep/sed/awk/perl) for syntax-aware operations
- Extracted prompt formatting logic into reusable `formatPromptContent()` utility with configurable render phases and formatting options
- Added `type_definition` action to navigate to symbol type definitions with source context
- Added `implementation` action to find concrete implementations of symbols with source context
- Added `code_actions` action to list and apply language server code fixes, refactors, and import suggestions
- Added `symbol` parameter to automatically resolve column position by searching for substring on target line
- Added `occurrence` parameter to disambiguate repeated `symbol` matches on the same line
- Added source code context display (3 lines) for definition, type definition, and implementation results
- Added context display for first 50 references with remaining references shown location-only to balance detail and performance
- Added support for glob patterns in `file` parameter for diagnostics action (e.g., `src/**/*.ts`)
- Added `waitForIdle()` method to ensure prompt completion waits for all deferred recovery work (TTSR continuations, context promotions, compaction retries) to fully settle
- Added `getLastAssistantMessage()` method to retrieve the most recent assistant message from session state without manual array indexing
- Implemented TTSR resume gate to ensure `prompt()` blocks until TTSR interrupt continuations complete, preventing race conditions between TTSR injections and subsequent prompts
- Added `tools.maxTimeout` setting to enforce a global timeout ceiling across all tool calls

### Changed

- Replaced `globSync` from `glob` package with native `Bun.Glob` API for glob pattern matching
- Replaced `fileTypeFromBuffer` from `file-type` package with inline MIME type detection for JPEG, PNG, GIF, and WebP formats
- Reduced MIME type sniffing buffer size from 4100 bytes to 12 bytes for improved performance
- Changed mermaid cache key type from `string` to `bigint` for more efficient hashing
- Replaced `smol-toml` dependency with native `Bun.TOML.parse()` for TOML parsing, reducing external dependencies
- Replaced `node-html-parser` dependency with `linkedom` for HTML parsing, improving performance and reducing bundle size
- Updated HTML parsing API calls from `node-html-parser` to `linkedom` across all web scrapers (arXiv, IACR, Go pkg, Read the Docs, Twitter, Wikipedia)
- Changed element text extraction from `.text` property to `.textContent` property for compatibility with linkedom DOM API
- Optimized document link extraction to use regex-based parsing with deduplication and a 20-link limit instead of full DOM traversal
- Unified `path` parameter in ast_grep and ast_edit tools to accept files, directories, or glob patterns directly, eliminating the separate `glob` parameter
- Removed `strictness` parameter from ast_grep and ast_edit tools
- Removed `fail_on_parse_error` parameter from ast_edit tool (now always false)
- Updated ast_grep and ast_edit prompt guidance to clarify that `path` accepts glob patterns and no longer requires separate glob specification
- Refactored prompt template rendering to use unified `formatPromptContent()` function with phase-aware formatting (pre-render vs post-render)
- Updated `format-prompts.ts` script to use centralized prompt formatting utility instead of inline implementation
- Replaced `column` parameter with `symbol` parameter for more intuitive position specification
- Removed `files` parameter; use glob patterns in `file` parameter instead
- Removed `end_line` and `end_character` parameters; range operations now use single position
- Changed `include_declaration` parameter to always be true for references (removed from API)
- Updated LSP client capabilities to advertise support for `typeDefinition` and `implementation` requests
- Improved definition results to include source context alongside location information
- Refactored deferred continuation scheduling to use centralized post-prompt task tracking instead of raw `setTimeout()` calls, improving reliability of concurrent recovery operations
- Updated subagent executor to explicitly await `waitForIdle()` after each prompt and reminder, ensuring terminal assistant state is determined only after all background work completes
- Replaced `#waitForRetry()` with `#waitForPostPromptRecovery()` to handle both retry and TTSR resume gates, ensuring prompt completion waits for all post-prompt recovery operations
- Introduced structured post-prompt recovery task tracking in `AgentSession` and added explicit session completion APIs (`waitForIdle()`, `getLastAssistantMessage()`) for callers that need deterministic turn finalization
- Updated intent field parameter name from `agent__intent` to `_i` for cleaner tool call contracts
- Refined intent parameter guidance to require concise 2-6 word sentences in present participle form
- Centralized per-tool timeout constants and clamping into `tool-timeouts.ts`

### Removed

- Removed `file-type` dependency, reducing external dependencies
- Removed `glob` dependency in favor of native `Bun.Glob` API
- Removed `ignore` dependency and ignore file handling utilities
- Removed `marked` dependency
- Removed `zod` dependency
- Removed `ms` and `@types/ms` dev dependencies
- Removed `rootDir` and `ignoreMatcher` parameters from `loadFilesFromDir()` (kept for API compatibility)
- Removed `smol-toml` dependency from package.json
- Removed `node-html-parser` dependency from package.json
- Removed `files` array parameter for batch file operations
- Removed `column`, `end_line`, and `end_character` parameters in favor of symbol-based positioning
- Removed `include_declaration` parameter from references action

### Fixed

- Fixed TTSR violations during subagent execution aborting the entire subagent run; `#waitForPostPromptRecovery()` now also awaits agent idle after TTSR/retry gates resolve, preventing `prompt()` from returning while a fire-and-forget `agent.continue()` is still streaming
- Fixed deferred TTSR/context-promotion continuations still racing `prompt()` completion by tracking compaction checks and deferred `agent.continue()` tasks under a shared post-prompt recovery orchestrator
- Fixed subagent reminder/finalization sequencing to await session-level idle recovery between prompts before determining terminal assistant stop state
- Fixed `code_actions` apply mode to execute command-based actions via `workspace/executeCommand`
- Fixed diagnostics glob detection to recognize bracket character class patterns (e.g., `src/[ab].ts`)
- Fixed LSP render metadata sanitization for `symbol` values to prevent tab/newline layout breakage
- Fixed LSP diagnostics glob requests that appeared stuck by capping glob expansion and shortening per-file diagnostic waits in batch mode
- Fixed workspace symbol search to query all configured LSP servers and filter out non-matching results
- Fixed `references`/`rename`/`hover` symbol targeting to error when `symbol` is missing on the line or `occurrence` is out of bounds
- Fixed `reload` without a file to reload all active configured language servers instead of only the first server
- Fixed `todo_write` task normalization to auto-activate the first remaining task and include explicit remaining-items output in tool results, removing the need for an immediate follow-up start update

## [13.3.7] - 2026-02-27

### Breaking Changes

- Removed `preloadedSkills` option from `CreateAgentSessionOptions`; skills are no longer inlined into system prompts
- Removed `skills` field from Task schema; subagents now always inherit the session skill set instead of per-task skill selection
- Removed Task tool per-task `tasks[].skills` support; subagents now always inherit the session skill set
- Removed `preloadedSkills` system prompt plumbing and template sections; skills are no longer inlined as a separate preloaded block

### Changed

- Refactored schema reference resolution to inline all `$ref` definitions instead of preserving them at the root level, eliminating unresolved references in tool parameters
- Added `lenientArgValidation` flag to SubmitResultTool to allow the agent loop to bypass strict argument validation errors
- Modified schema validation to allow non-conforming output on second validation failure, enabling recovery from strict schema constraints after initial rejection
- Updated JTD-to-TypeScript conversion to gracefully fall back to 'unknown' type when conversion fails, preventing template rendering errors
- Changed JTD-to-JSON Schema conversion to normalize nested JTD fragments within JSON Schema nodes, enabling mixed schema definitions
- Changed output schema validation to gracefully fall back to unconstrained object when schema is invalid, instead of rejecting submissions
- Changed schema sanitization to remove strict-mode incompatible constraints (minLength, pattern, etc.) from tool parameters while preserving them for runtime validation
- Simplified task execution to always pass available session skills to subagents instead of resolving per-task skill lists
- Added `KILO_API_KEY` to CLI environment variable help text for Kilo Gateway provider setup ([#193](https://github.com/can1357/gajae-code/issues/193))

### Removed

- Removed preloaded skills section from system prompt templates; skills are now referenced only as available resources

### Fixed

- Fixed schema compilation validation by adding explicit AJV compilation check to catch unresolved `$ref` references and other schema errors before tool execution
- Fixed handling of circular and deeply nested output schemas to prevent stack overflow and enable successful result submission with fallback unconstrained schema
- Fixed processing of non-object output schemas (arrays, primitives, booleans) to accept valid result submissions without blocking
- Fixed handling of mixed JTD and JSON Schema output definitions to properly convert all nested JTD elements (e.g., `elements` → `items`, `int32` → `integer`)
- Fixed strict schema generation for output schemas with only required fields, enabling proper Anthropic model API compatibility
- Fixed handling of union type schemas (e.g., object|null) to normalize them into strict-mode compatible variants

## [13.3.6] - 2026-02-26

### Breaking Changes

- Changed `submit_result` tool parameter structure from top-level `data` or `error` fields to nested `result` object containing either `result.data` or `result.error`

## [13.3.5] - 2026-02-26

### Added

- Added support for setting array and record configuration values using JSON syntax

### Changed

- Increased default async max jobs limit from 15 to 100 for improved concurrent task handling

### Fixed

- Improved config display formatting to properly render arrays and objects as JSON instead of `[object Object]`
- Enhanced type display in config list output to show correct type indicators for number, array, and record settings

## [13.3.3] - 2026-02-26

### Added

- Support for `move` parameter in `computeHashlineDiff` to enable file move operations alongside content edits

### Changed

- Modified no-op detection logic to allow move-only operations when file content remains unchanged

## [13.3.1] - 2026-02-26

### Added

- Added `topP` setting to control nucleus sampling cutoff for model output diversity
- Added `topK` setting to sample from top-K tokens for controlled generation
- Added `minP` setting to enforce minimum probability threshold for token selection
- Added `presencePenalty` setting to penalize introduction of already-present tokens
- Added `repetitionPenalty` setting to penalize repeated tokens in model output

### Fixed

- Fixed skill discovery to continue loading project skills when user skills directory is missing

## [13.3.0] - 2026-02-26

### Breaking Changes

- Renamed `task.isolation.enabled` (boolean) setting to `task.isolation.mode` (enum: `none`, `worktree`, `fuse-overlay`). Existing `true`/`false` values are auto-migrated to `worktree`/`none`.

### Added

- Added `PERPLEXITY_COOKIES` env var for Perplexity web search via session cookies extracted from desktop app
- Added `fuse-overlay` isolation mode for subagents using `fuse-overlayfs` (copy-on-write overlay, no baseline patch apply needed)
- Added `task.isolation.merge` setting (`patch` or `branch`) to control how isolated task changes are integrated back. `branch` mode commits each task to a temp branch and cherry-picks for clean commit history
- Added `task.isolation.commits` setting (`generic` or `ai`) for commit messages on isolated task branches and nested repos. `ai` mode uses a smol model to generate conventional commit messages from diffs
- Nested non-submodule git repos are now discovered and handled during task isolation (changes captured and applied independently from parent repo)
- Added `task.eager` setting to encourage the agent to delegate work to subagents by default
- Added manual OAuth login flow that lets users paste redirect URLs with /login for callback-server providers and prevents overlapping logins

### Fixed

- Fixed nested repo changes being lost when tasks commit inside the isolation (baseline state is now committed before task runs, so delta correctly excludes it)
- Fixed nested repo patches conflicting when multiple tasks contribute to the same repo (baseline untracked files no longer leak into patches)
- Nested repo changes are now committed after patch application (previously left as untracked files)
- Failed tasks no longer create stale branches or capture garbage patches (gated on exit code)
- Merge failures (e.g. conflicting patches) are now non-fatal — agent output is preserved with `merge failed` status instead of `failed`
- Stale branches are cleaned up when `commitToBranch` fails
- Commit message generator filters lock files from diffs before AI summarization

## [13.2.1] - 2026-02-24

### Fixed

- Fixed changelog tools to enforce category-specific arrays and reuse the shared category list for generation
- Non-interactive environment variables (pager, editor, prompt suppression) were not applied to non-PTY bash execution, causing commands to potentially block on pagers or prompts

### Changed

- Extracted non-interactive environment config from `bash-interactive.ts` into shared `non-interactive-env.ts` module, applied consistently to all bash execution paths

## [13.2.0] - 2026-02-23

### Breaking Changes

- Made `description` field required in CustomTool interface

### Changed

- Reorganized imports from `@gajae-code/utils/dirs` to consolidate with main `@gajae-code/utils` exports for cleaner dependency management
- Renamed `loadSkillsFromDir` to `scanSkillsFromDir` with updated interface for improved clarity on skill discovery behavior
- Moved `tryParseJson` utility from local scrapers module to `@gajae-code/utils` for centralized JSON parsing
- Simplified patch module exports by consolidating type re-exports with `export * from './types'`
- Removed `emitCustomToolSessionEvent` method from AgentSession for streamlined session lifecycle management
- Changed skill discovery from recursive to non-recursive (one level deep only) for improved performance and clarity
- Simplified skill loading logic by removing recursive directory traversal and consolidating ignore rule handling

### Removed

- Removed `parseJSON` helper function from discovery module (replaced by `tryParseJson` from pi-utils)
- Removed backwards compatibility comment from `AskToolDetails.question` field
- Removed unused SSH resource cleanup functions `closeAllConnections` and `unmountAll` from session imports

## [13.1.2] - 2026-02-23

### Breaking Changes

- Removed `timeout` parameter from await tool—tool now waits indefinitely until jobs complete or the call is aborted
- Renamed `job_ids` parameter to `jobs` in await tool schema
- Removed `timedOut` field from await tool result details

### Changed

- Resolved docs index generation paths using path.resolve relative to the script directory

## [13.1.1] - 2026-02-23

### Fixed

- Fixed bash internal URL expansion to resolve `local://` targets to concrete filesystem paths, including newly created destination files for commands like `mv src.json local://dest.json`
- Fixed bash local URL resolution to create missing parent directories under the session local root before command execution, preventing `mv` destination failures for new paths

## [13.1.0] - 2026-02-23

### Breaking Changes

- Renamed `file` parameter to `path` in replace, patch, and hashline edit operations

### Added

- Added clarification in hashline edit documentation that the `end` tag must include closing braces/brackets when replacing blocks to prevent syntax errors

### Changed

- Restructured task tool documentation for clarity, moving parameter definitions into a dedicated section and consolidating guidance on context, assignments, and parallelization
- Reformatted system prompt template to use markdown headings instead of XML tags for skills, preloaded skills, and rules sections
- Renamed `deviceScaleFactor` parameter to `device_scale_factor` in browser viewport configuration for consistency with snake_case naming convention
- Moved intent field documentation from per-tool JSON schema descriptions into a single system prompt block, reducing token overhead proportional to tool count

## [13.0.1] - 2026-02-22

### Changed

- Simplified hashline edit schema to use unified `first`/`last` anchor fields instead of operation-specific field names (`tag`, `before`, `after`)
- Improved resilience of anchor resolution to degrade gracefully when anchors are missing or invalid, allowing edits to proceed with available anchors
- Updated hashline tool documentation to reflect new unified anchor syntax across all operations (replace, append, prepend, insert)

## [13.0.0] - 2026-02-22

### Added

- Added `getTodoPhases()` and `setTodoPhases()` methods to ToolSession API for managing todo state programmatically
- Added `getLatestTodoPhasesFromEntries()` export to retrieve todo phases from session history
- Added `local://` protocol for session-scoped scratch space to store large intermediate artifacts, subagent handoffs, and reusable planning artifacts
- Added `title` parameter to `exit_plan_mode` tool to specify the final plan artifact name when approving a plan
- Added `LocalProtocolHandler` for resolving `local://` URLs to session-scoped file storage
- Added `renameApprovedPlanFile` function to finalize approved plans with user-specified titles

### Changed

- Changed todo state management from file-based (`todos.json`) to in-memory session cache for improved performance and consistency
- Changed todo phases to sync from session branch history when branching or rewriting entries
- Changed `TodoWriteTool` to update session cache instead of writing to disk, with automatic persistence through session entries
- Changed XML tag from `<swarm-context>` to `<context>` in subagent prompts and task rendering
- Changed system reminder XML tags from underscore to kebab-case format (`<system-reminder>`)
- Changed plan storage from `plan://` protocol to `local://PLAN.md` for draft plans and `local://<title>.md` for finalized approved plans
- Changed plan mode to use session artifacts directory for plan storage instead of separate plans directory
- Updated system prompt to document `local://` protocol and internal URL expansion behavior
- Updated `exit_plan_mode` tool documentation to require `title` parameter and explain plan finalization workflow
- Updated `write` tool documentation to recommend `local://` for large temporary artifacts and subagent handoffs
- Updated `task` tool documentation to recommend using `local://` for large intermediate outputs in subagent context
- Replaced `docs://` protocol with `pi://` for accessing embedded documentation files
- Renamed `DocsProtocolHandler` to `PiProtocolHandler` for internal documentation URL resolution
- Removed `artifactsDir` parameter from Python executor options; artifact storage now uses `artifactPath` only
- Renamed prompt file from `read_path.md` to `read-path.md` for consistency
- Updated system prompt XML tags to use kebab-case (e.g., `system-reminder`, `system-interrupt`) for consistency
- Refactored bash tool to use `NO_PAGER_ENV` constant for environment variable management
- Updated internal URL expansion to support optional `noEscape` parameter for unescaped path resolution

### Removed

- Removed `plan://` protocol handler and related plan directory resolution logic
- Removed `PlanProtocolHandler` and `resolvePlanUrlToPath` exports from internal URLs module

### Fixed

- Fixed todo reminder XML tags from underscore to kebab-case format (`system-reminder`)

## [12.19.3] - 2026-02-22

### Added

- Added `pty` parameter to bash tool to enable PTY mode for commands requiring a real terminal (e.g., sudo, ssh, top, less)

### Changed

- Changed bash tool to use per-command PTY control instead of global virtual terminal setting

### Removed

- Removed `bash.virtualTerminal` setting; use the `pty` parameter on individual bash commands instead

## [12.19.1] - 2026-02-22

### Removed

- Removed `replaceText` edit operation from hashline mode (substring-based text replacement)
- Removed autocorrect heuristics that attempted to detect and fix line merges and formatting rewrites in hashline edits

## [12.19.0] - 2026-02-22

### Added

- Added `poll_jobs` tool to block until background jobs complete, providing an alternative to polling `read jobs://` in loops
- Added `task.maxConcurrency` setting to limit the number of concurrently executing subagent tasks
- Added support for rendering markdown output from Python cells with proper formatting and theme styling
- Added async background job execution for bash commands and tasks with `async: true` parameter
- Added `cancel_job` tool to cancel running background jobs
- Added `jobs://` internal protocol to inspect background job status and results
- Added `/jobs` slash command to display running and recent background jobs in interactive mode
- Added `async.enabled` and `async.maxJobs` settings to control background job execution
- Added background job status indicator in status line showing count of running jobs
- Added support for GitLab Duo authentication provider
- Added clearer truncation notices across tools with consistent line/size context and continuation hints

### Changed

- Updated bash and task tool guidance to recommend `poll_jobs` instead of polling `read jobs://` in loops when waiting for async results
- Improved parallel task execution to schedule multiple background jobs independently instead of batching all tasks into a single job, enabling true concurrent execution
- Enhanced task progress tracking to report per-task status (pending, running, completed, failed, aborted) with individual timing and token metrics for each background task
- Updated background task messaging to provide real-time progress counts (e.g., '2/5 finished') and distinguish between single and multiple task jobs
- Hid internal `agent__intent` parameter from tool argument displays in UI and logs to reduce visual clutter
- Updated Python tool to detect and handle markdown display output separately from plain text
- Updated bash tool to support async execution mode with streaming progress updates
- Updated task tool to support async execution mode for parallel subagent execution
- Modified subagent settings to disable async execution in child agents to prevent nesting
- Updated tool execution component to handle background async task state without spinner animation
- Changed event controller to keep background tool calls pending until async completion
- Updated status line width calculation to accommodate background job indicator
- Updated the system prompt pipeline to reduce injected environment noise and make instructions more focused on execution quality
- Updated system prompt/workflow guidance to emphasize root-cause fixes, code quality, and explicit handoff/testing expectations
- Changed default value of `todo.reminders` setting from false to true to enable todo reminders by default
- Improved truncation/output handling for large command results to reduce memory pressure and keep previews responsive
- Updated internal artifact handling so tool output artifacts stay consistent across session switches and resumes

### Removed

- Removed git context (branch, status, commit history) from system prompt — version control information is no longer injected into agent instructions

### Fixed

- Fixed task progress display to hide tool count and token metrics when zero, reducing visual clutter in status output
- Fixed Lobsters scraper to correctly parse API responses where user fields are strings instead of objects, resolving undefined user display in story listings
- Fixed artifact manager caching to properly invalidate when session file changes, preventing stale artifact references
- Fixed truncation behavior around UTF-8 boundaries and chunked output accounting
- Fixed `submit_result` schema generation to use valid JSON Schema when no explicit output schema is provided

## [12.18.1] - 2026-02-21

### Added

- Added Buffer.toBase64() polyfill for Bun compatibility to enable base64 encoding of buffers

## [12.18.0] - 2026-02-21

### Added

- Added `overlay` option to custom UI hooks to display components as bottom-centered overlays instead of replacing the editor
- Added automatic chat transcript rebuild when returning from custom or debug UI to prevent message duplication

### Changed

- Changed custom UI hook cleanup to conditionally restore editor state only when not using overlay mode
- Extracted environment variable configuration for non-interactive bash execution into reusable `NO_PAGER_ENV` constant
- Replaced custom timing instrumentation with logger.time() and logger.time() from pi-utils for consistent startup profiling
- Removed PI_DEBUG_STARTUP environment variable in favor of logger.debug() for conditional debug output
- Consolidated timing calls throughout initialization pipeline to use unified logger-based timing system

### Removed

- Deleted utils/timings.ts module - timing functionality now provided by pi-utils logger

### Fixed

- Fixed potential race condition in bash interactive component where output could be appended after the component was closed

## [12.17.2] - 2026-02-21

### Changed

- Modified bash command normalization to only apply explicit head/tail parameters from tool input, removing automatic extraction from command pipes
- Updated shell snapshot creation to use explicit timeout and kill signal configuration for more reliable process termination

### Fixed

- Fixed persistent shell session state not being reset after command abort or hard timeout, preventing stale environment variables from affecting subsequent commands
- Fixed hard timeout handling to properly interrupt long-running commands that exceed the grace period beyond the configured timeout

## [12.17.1] - 2026-02-21

### Added

- Added `filterBrowser` option to filter out browser automation MCP servers when builtin browser tool is enabled
- Added `isBrowserMCPServer()` function to detect browser automation MCP servers by name, URL, or command patterns
- Added `filterBrowserMCPServers()` function to remove browser MCP servers from loaded configurations
- Added `BrowserFilterResult` type for browser MCP server filtering results

## [12.17.0] - 2026-02-21

### Added

- Added timeout protection (5 seconds) for system prompt preparation with graceful fallback to minimal context on timeout

### Changed

- Replaced glob-based AGENTS.md discovery with depth-limited directory traversal (depth 1-4) for improved performance and control
- Refactored system prompt preparation to parallelize file loading operations with a 5-second timeout to prevent startup hangs
- Unified `renderCall` signatures to `(args, options, theme)` across all tool renderers and extension types

## [12.16.0] - 2026-02-21

### Added

- Added `peekApiKey` method to AuthStorage for non-blocking API key retrieval during model discovery without triggering OAuth token refresh
- Exported `finalizeSubprocessOutput` function to handle subprocess output finalization with submit_result validation
- Exported `SubmitResultItem` interface for type-safe submit_result tool data extraction
- Added automatic reminders when subagent stops without calling submit_result tool (up to 3 reminders before aborting)
- Added system warnings when subagent calls submit_result with null/undefined data or exits without calling submit_result after reminders

### Changed

- Changed model refresh behavior to support configurable strategies: uses 'online' mode when listing models and 'online-if-uncached' mode otherwise for improved performance
- Changed default thinking level from 'off' to 'high' for improved reasoning and planning
- Changed model discovery to use non-blocking API key peek instead of full key retrieval, improving performance by avoiding unnecessary OAuth token refreshes
- Simplified submit_result termination logic to immediately abort on successful tool execution instead of waiting for message_end event
- Updated submit_result tool to only terminate on successful execution (when isError is false), allowing retries on tool errors
- Refactored subprocess output finalization logic into dedicated `finalizeSubprocessOutput` function for better testability and maintainability
- Improved handling of missing submit_result calls by automatically aborting with exit code 1 after 3 reminder prompts

### Fixed

- Fixed submit_result retry behavior to properly handle tool execution errors and allow the subagent to retry before aborting
- Fixed submit_result tool extraction to properly validate status field and only accept 'success' or 'aborted' results

## [12.15.1] - 2026-02-20

### Changed

- Replaced nerd font pie-chart spinner with clock-outline icons for smoother looping
- Moved status icon to front of code-cell headers in formatHeader

### Fixed

- Fixed ReadToolGroupComponent to show status icon before title instead of trailing
- Fixed bash-interactive status badge to dim only bracket characters, not the enclosed text

## [12.15.0] - 2026-02-20

### Added

- Added `includeDisabled` parameter to `listAuthCredentials()` to optionally retrieve disabled credentials
- Added `disableAuthCredential()` method for soft-deleting auth credentials while preserving database records

### Changed

- Updated browser tool prompt to bias towards `observe` over `screenshot` by default
- Changed auth credential removal to use soft-delete (disable) instead of hard-delete when OAuth refresh fails, keeping credentials in database for audit purposes
- Changed default value of `tools.intentTracing` setting from false to true

## [12.14.1] - 2026-02-19

### Fixed

- Fixed `gjc stats` failing on npm/bun installs by including required stats build files in published `@gajae-code/stats` package ([#113](https://github.com/can1357/gajae-code/pull/113) by [@masonc15](https://github.com/masonc15))

## [12.14.0] - 2026-02-19

### Added

- Support for `docs://` internal URL protocol to access embedded documentation files (e.g., `docs://sdk.md`)
- Added `generate-docs-index` npm script to automatically index and embed documentation files at build time
- Support for executable tool files (.ts, .js, .sh, .bash, .py) in custom tools discovery alongside markdown files
- Display streamed tool intent in working message during agent execution
- Added `tools.intentTracing` setting to enable intent tracing, which asks the agent to describe the intent of each tool call before executing it
- Support for file deletion in hashline edit mode via `delete: true` parameter
- Support for file renaming/moving in hashline edit mode via `rename` parameter
- Optional content-replace edit variant in hashline mode (enabled via `PI_HL_REPLACETXT=1` environment variable)
- Support for grepping internal URLs (artifact://) by resolving them to their backing files

### Changed

- System prompt now identifies agent as operating inside Gajae Code harness and instructs reading docs:// URLs for gjc/pi topics
- Tool discovery now accepts executable script extensions (.ts, .js, .sh, .bash, .py) in addition to .json and .md files
- Updated bash and read tool documentation to reference `docs://` URL support
- Hashline format separator changed from pipe (`|`) to colon (`:`) for improved readability (e.g., `LINE#ID:content` instead of `LINE#ID|content`)
- Hashline hash representation changed from 4-character base36 to 2-character hexadecimal for more compact line references
- Hashline edit API: renamed `delete` parameter to `rm` for consistency with standard file operations
- Hashline edit API: renamed `rename` parameter to `mv` for consistency with standard file operations
- Hashline edit API: content-replace operations now require explicit `op: "replaceText"` field to distinguish from other edit types
- Hashline documentation terminology updated: references to 'anchors' replaced with 'tags' for clearer semantics
- Intent tracing now uses `_intent` field name in tool schemas
- Hashline edit API: renamed `set` operation to `target`/`new_content` for clearer semantics
- Hashline edit API: renamed `set_range` operation to `first`/`last`/`new_content`
- Hashline edit API: renamed `insert` operation fields from `body` to `inserted_lines` and made `inserted_lines` required non-empty
- Hashline edit API: flattened `replace` operation to top-level fields (`old_text`, `new_text`, `all`) when enabled
- Hashline edit validation now provides more specific error messages indicating which variant is expected

### Fixed

- Grep tool now properly handles internal URL resolution when searching artifact paths
- Working message intent updates now fall back to tool execution events when streamed tool arguments omit the intent field

## [12.13.0] - 2026-02-19

### Breaking Changes

- Removed automatic line relocation when hash references become stale; edits with mismatched line hashes now fail with an error instead of silently relocating to matching lines elsewhere in the file

### Added

- Added `ssh` command for managing SSH host configurations (add, list, remove)
- Added `/ssh` slash command in interactive mode to manage SSH hosts with subcommands
- Added support for SSH host configuration at project and user scopes (.gjc/ssh.json and ~/.gjc/agent/ssh.json)
- Added `--host`, `--user`, `--port`, `--key`, `--desc`, `--compat`, and `--scope` flags for SSH host configuration
- Added discovery of SSH hosts from project configuration files alongside manually configured hosts
- Added NanoGPT as a login provider (`/login nanogpt`) with API key prompt flow linking to `https://nano-gpt.com/api` ([#111](https://github.com/can1357/gajae-code/issues/111))

### Changed

- Updated hashline reference format from `LINE:HASH` to `LINE#ID` throughout the codebase for improved clarity
- Renamed hashline edit operations: `set_line` → `set`, `replace_lines` → `set_range`, `insert_after` → `insert` with support for `before` and `between` anchors
- Changed hashline edit `body` field from string to array of strings for clearer multiline handling
- Updated handlebars helpers: renamed `hashline` to `href` and added `hline` for formatted line output
- Improved insert operation to support `before`, `after`, and `between` (both anchors) positioning modes
- Made autocorrect heuristics (boundary echo stripping, indent restoration) conditional on `PI_HL_AUTOCORRECT` environment variable
- Updated SSH host discovery to load from managed gjc config paths (.gjc/ssh.json and ~/.gjc/agent/ssh.json) in addition to legacy root-level ssh.json and .ssh.json files
- Improved terminal output handling in interactive bash sessions to ensure all queued writes complete before returning results

### Fixed

- Fixed insert-between operation to properly validate adjacent anchor lines and strip boundary echoes from both sides
- Fixed terminal output handling to properly queue and serialize writes, preventing dropped or corrupted output in interactive bash sessions

## [12.12.1] - 2026-02-19

### Added

- Added Kimi (Moonshot) as a web search provider with OAuth and API key support ([#110](https://github.com/can1357/gajae-code/pull/110) by [@oglassdev](https://github.com/oglassdev))

### Changed

- Changed web search auto-resolve priority to prefer Perplexity first

### Fixed

- Fixed Mermaid pre-render failures from repeatedly re-triggering background renders (freeze loop) and restored resilient rendering when diagram conversion/callbacks fail ([#109](https://github.com/can1357/gajae-code/issues/109)).

## [12.12.0] - 2026-02-19

### Added

- Display streaming text preview during agent specification generation to show real-time progress
- Added `onRequestRender` callback to agent dashboard for triggering UI updates during async operations
- Added agent creation flow (press N in dashboard) to generate custom agents from natural language descriptions
- Added ability to save generated agents to project or user scope with automatic identifier and system prompt generation
- Added scope toggle (Tab) during agent creation to choose between project-level and user-level agent storage
- Added agent regeneration (R key) to refine generated specifications without restarting the creation flow
- Added model suggestions in model override editor to help users discover available models
- Added success notices to confirm agent creation and model override updates

### Changed

- Updated agent creation flow to show review screen before generation completes, improving UX feedback
- Changed generation status hint to display "Generating..." while specification is being created
- Improved system prompt preview formatting with text wrapping and line truncation indicators

### Fixed

- Fixed interactive-mode editor height to stay bounded and resize-aware, preventing off-screen cursor drift during long prompt/history navigation ([#99](https://github.com/can1357/gajae-code/issues/99)).

## [12.11.3] - 2026-02-19

### Fixed

- Fixed model selector search initialization to apply the latest live query after asynchronous model loading.
- Fixed OpenAI code provider session lifecycle on model switches and history rewrites to clear stale session metadata before continuing the conversation.

## [12.11.0] - 2026-02-19

### Added

- Support for Synthetic model provider in web search command
- Model sorting by priority field and version number in model selector for improved model ranking
- Support for Synthetic model provider with API key authentication
- Support for Hugging Face model provider with API key authentication
- Support for NVIDIA model provider with API key authentication
- Support for Ollama model provider with optional API key authentication
- Support for Cloudflare AI Gateway model provider with API key authentication
- Support for Qwen Portal model provider with API key authentication
- Support for LiteLLM model provider with API key authentication
- Support for Moonshot model provider with API key authentication
- Support for Qianfan model provider with API key authentication
- Support for Together model provider with API key authentication
- Support for Venice model provider with API key authentication
- Support for vLLM model provider with API key authentication
- Support for Xiaomi model provider with API key authentication

### Changed

- Refactored custom model building logic into reusable `buildCustomModel` function for consistency across provider configurations
- Replaced generic error with AgentBusyError when attempting to send messages while agent is processing
- Added automatic retry logic with idle waiting when agent is busy during prompt operations, with 30-second timeout

### Fixed

- Fixed model discovery to use default refresh mode instead of explicit 'online' parameter

## [12.10.1] - 2026-02-18

### Added

- Added `/login` support for Cerebras and Synthetic API-key providers

## [12.10.0] - 2026-02-18

### Breaking Changes

- Changed keyless provider auth sentinel from `"<no-auth>"` to `kNoAuth` (`"N/A"`) for `ModelRegistry.getApiKey()` and `ModelRegistry.getApiKeyForProvider()`

### Added

- Added `--no-rules` CLI flag to disable rules discovery and loading
- Added `sessionDir` option to RpcClientOptions for specifying agent session directory
- Added `Symbol.dispose` method to RpcClient for resource cleanup support
- Added `rules` option to CreateAgentSessionOptions for explicit rule configuration
- Added `sessionDir` option to RpcClientOptions for specifying agent session directory
- Added `Symbol.dispose` method to RpcClient for resource cleanup support
- Added `autocompleteMaxVisible` setting to configure the number of items shown in the autocomplete dropdown (3-20, default 5) ([#98](https://github.com/can1357/gajae-code/pull/98) by [@masonc15](https://github.com/masonc15))
- Added `condition` and `scope` fields to rule frontmatter for advanced TTSR matching and stream filtering
- Added `ttsr.interruptMode` setting to control when TTSR rules interrupt mid-stream vs inject warnings after completion
- Added support for loading rules, prompts, commands, context files (AGENTS.md), and system prompts (SYSTEM.md) from ~/.agent/ directory (with fallback to ~/.agents/)
- Added scoped stream buffering for TTSR matching to isolate prose, thinking, and tool argument streams
- Added file-path-aware TTSR scope matching for tool calls with glob patterns (e.g., `tool:edit(*.ts)`)
- Added legacy field support: `ttsr_trigger` and `ttsrTrigger` are accepted as fallback for `condition`

### Changed

- Changed TTSR injection tracking to record all turns where rules were injected (instead of only the last turn) to support repeat-after-gap mode across resumed sessions
- Changed TTSR injection messages to use custom message type with metadata instead of synthetic user messages for better session tracking
- Changed TTSR rule injection to persist injected rule names in session state for restoration when resuming sessions
- Changed model discovery to automatically discover built-in provider models (Anthropic, OpenAI, Groq, Cerebras, Xai, Mistral, OpenCode, OpenRouter, Vercel AI Gateway, Kimi Code, GitHub Copilot, Google, Cursor, Google Antigravity, Google Gemini CLI, OpenAI code provider) when credentials are configured
- Changed `getModel()` and `getModels()` imports to `getBundledModel()` and `getBundledModels()` across test utilities
- Changed TTSR rule matching from single `ttsrTrigger` regex to multiple `condition` patterns with scope filtering
- Changed TTSR buffer management to use per-stream-key buffers instead of a single global buffer
- Changed rule discovery to use unified `buildRuleFromMarkdown` helper across all providers (builtin, cline, cursor, windsurf, agents)
- Changed TTSR injection to defer warnings until stream completion when `interruptMode` is not `always`
- Changed `TtsrManager.addRule()` to return boolean indicating successful registration instead of void

### Fixed

- Fixed TTSR repeat-after-gap mode to correctly calculate gaps when rules are restored from previous sessions
- Fixed TTSR matching to respect tool-specific scope filters, preventing cross-tool rule contamination
- Fixed path normalization in TTSR glob matching to handle both relative and absolute path variants

## [12.9.0] - 2026-02-17

### Added

- Added OpenCode discovery provider to load configuration from ~/.config/opencode/ and .opencode/ directories
- Added support for loading MCP servers from opencode.json mcp key
- Added support for loading skills from ~/.config/opencode/skills/ and .opencode/skills/
- Added support for loading slash commands from ~/.config/opencode/commands/ and .opencode/commands/
- Added support for loading extension modules (plugins) from ~/.config/opencode/plugins/ and .opencode/plugins/
- Added support for loading context files (AGENTS.md) from ~/.config/opencode/
- Added support for loading settings from opencode.json configuration files

### Changed

- Improved path display in status line to strip both `/work/` and `~/Projects/` prefixes when abbreviating paths
- Refactored session directory naming to use single-dash format for home-relative paths and double-dash format for absolute paths, with automatic migration of legacy session directories on first access

## [12.8.2] - 2026-02-17

### Changed

- Changed system environment context to use built-in `os` values for distro, kernel, and CPU model instead of native system-info data
- Changed environment info generation to stop including unavailable native system detail fallbacks

### Removed

- Removed the `Disk` field from generated environment information

## [12.8.0] - 2026-02-16

### Changed

- Improved `/changelog` performance by displaying only the most recent 3 versions by default, with a `--full` flag for the complete history ([#85](https://github.com/can1357/gajae-code/pull/85) by [@tctev](https://github.com/tctev))
- Centralized builtin slash command definitions and handlers into a shared registry, replacing the large input-controller if-chain dispatch

## [12.7.0] - 2026-02-16

### Added

- Added abort signal support to LSP file operations (`ensureFileOpen`, `refreshFile`) for cancellable file synchronization
- Added abort signal propagation through LSP request handlers (definition, references, hover, symbols, rename) enabling operation cancellation
- Added `shouldBypassAutocompleteOnEscape` callback to custom editor for context-aware escape key handling during active operations
- Added `contextPromotionTarget` model configuration option to specify a custom target model for context promotion
- Added automatic context promotion feature that switches to a larger-context model when approaching context limits
- Added `contextPromotion.enabled` setting to control automatic model promotion (enabled by default)
- Added `contextPromotion.thresholdPercent` setting to configure the context usage threshold for triggering promotion (default 90%)
- Added Brave web search provider as an alternative search option with recency filtering support
- Added `BRAVE_API_KEY` environment variable support for Brave web search authentication
- Added pagination support for fetching GitHub issue comments, allowing retrieval of all comments beyond the initial 50-comment limit
- Added comment count display showing partial results when not all comments could be fetched (e.g., '5 of 10 comments')
- Added secret obfuscation: env vars matching secret patterns and `secrets.json` entries are replaced with placeholders before sending to LLM providers, deobfuscated in tool call arguments
- Added `secrets.enabled` setting to toggle secret obfuscation
- Added full regex literal support for `secrets.json` entries (`"/pattern/flags"` syntax with escaped `/` handling, automatic `g` flag enforcement)

### Changed

- Changed context promotion to trigger on context overflow instead of a configurable threshold, promoting to a larger model before attempting compaction
- Changed context promotion behavior to retry immediately on the promoted model without compacting, providing faster recovery from context limits
- Changed default grep context lines from 1 before/3 after to 0 before/0 after for more focused search results
- Changed escape key handling in custom editor to allow bypassing autocomplete dismissal when specified by parent controller
- Changed workspace diagnostics to support abort signals for cancellable diagnostic runs
- Changed LSP request cancellation to send `$/cancelRequest` notification to language servers when operations are aborted
- Changed input controller to bypass autocomplete on escape when loading animations, streaming, compacting, or running external processes
- Changed context promotion logic to use configured `contextPromotionTarget` when available, allowing per-model promotion customization
- Updated session compaction reserve token calculation to enforce a minimum 15% context window floor, ensuring more predictable compaction behavior regardless of configuration
- Improved session compaction to limit file operation summaries to 20 files per category, with indication of omitted files when exceeded
- Updated CLI update mechanism to support multiple native addon variants per platform, enabling fallback to baseline versions when modern variants are unavailable
- Updated web search provider priority order to include Brave (Exa → Brave → Jina → Perplexity → Anthropic → Gemini → OpenAI code → Z.AI)
- Extended recency filter support to Brave provider alongside Perplexity
- Changed GitHub issue comment fetching to use paginated API requests with 100 comments per page instead of single request with 50-comment limit

### Removed

- Removed `contextPromotion.thresholdPercent` setting as context promotion now triggers only on overflow

### Fixed

- Fixed LSP operations to properly respect abort signals and throw `ToolAbortError` when cancelled
- Fixed workspace diagnostics process cleanup to remove abort event listeners in finally block
- Fixed PTY-backed bash execution to enforce timeout completion when detached child processes keep the PTY stream open ([#88](https://github.com/can1357/gajae-code/issues/88))

## [12.5.1] - 2026-02-15

### Added

- Added `repeatToolDescriptions` setting to render full tool descriptions in the system prompt instead of a tool name list

## [12.5.0] - 2026-02-15

### Breaking Changes

- Replaced `theme` setting with `theme.dark` and `theme.light` (auto-migrated)

### Added

- Added `previewTheme()` function for non-destructive theme preview during settings browsing
- Added animated microphone icon with color cycling during voice recording
- Added support for discovering skills via symbolic links in skill directories
- Added `abort_and_prompt` RPC command for atomic abort-and-reprompt without race conditions ([#357](https://github.com/can1357/gajae-code/pull/357))
- Added automatic dark/light theme switching via SIGWINCH with separate `theme.dark`/`theme.light` settings, replacing the single `theme` setting ([#65](https://github.com/can1357/gajae-code/issues/65))
- Added speech-to-text (STT) feature with `Alt+H` keybinding and `/stt` slash command
- Added cross-platform audio recording: SoX, FFmpeg, arecord (Linux), PowerShell mciSendString (Windows fallback)
- Added recording tool fallback chain — automatically tries each available tool in order
- Added Python openai-whisper integration for transcription with automatic `pip install`
- Added custom WAV-to-numpy pipeline in `transcribe.py` bypassing ffmpeg dependency
- Added STT settings: `stt.enabled`, `stt.language`, `stt.modelName`
- Added STT status line segment showing recording/transcribing state
- Added `/stt` command with `on`, `off`, `status`, `setup` subcommands
- Added auto-download of recording tools (best-effort FFmpeg via winget on Windows)
- Added interactive debug log viewer with selection, copy, and expand/collapse controls
- Added inline filtering and count display to the debug log viewer
- Added pid filter toggle and load-older pagination controls to the debug log viewer
- Enabled loading older debug logs from archived files in viewer
- Added file hyperlinks for debug report paths in viewer

### Changed

- Changed theme preview to support asynchronous theme loading with request deduplication to prevent race conditions
- Enhanced theme preview cancellation to restore the previously active theme instead of the last selected value
- Refactored file discovery to use native glob with gitignore support instead of manual directory traversal, improving performance and consistency
- Updated dependencies: glob to ^13.0.3, marked to ^17.0.2, puppeteer to ^24.37.3
- Optimized skill and file discovery using native glob (Rust ignore crate) — reduces startup time by ~80% (1254ms → 6ms for skills)
- Enhanced hashline reference parsing to handle prefixes like `>>>` and `>>` in line references
- Strengthened type safety in hashline edit formatting with defensive null checks for incomplete edits
- Changed STT status messages to display via state change callbacks instead of explicit status calls
- Changed cursor visibility behavior during voice recording to hide hardware and terminal cursors

### Removed

- Removed dedicated STT status line segment in favor of animated cursor-based feedback

### Fixed

- Fixed theme preview updates being applied out-of-order when rapidly browsing theme options
- Fixed skill discovery to correctly extract skill names from directory paths when frontmatter name is missing
- Fixed `session.abort()` not clearing `promptInFlight` flag due to microtask ordering, which blocked subsequent prompts
- Sanitized debug log display to strip control codes, normalize tabs, and trim width

## [12.4.0] - 2026-02-14

### Changed

- Moved `sanitizeText` function from `@gajae-code/utils` to `@gajae-code/natives` for better code organization
- Replaced internal `#normalizeOutput` methods with `sanitizeText` utility function in bash and Python execution components
- Added line length clamping (4000 characters) to bash and Python execution output to prevent display of excessively long lines
- Modified memory storage to isolate memories by project working directory, preventing cross-project memory contamination

### Fixed

- Fixed bash interactive tool to gracefully handle malformed output chunks by normalizing them before display
- Fixed fetch tool incorrectly treating HTML content as plain text or markdown
- Fixed output truncation notice displaying incorrect byte limit when maxBytes differs from outputBytes
- Fixed Cloudflare returning corrupted bytes when compression is negotiated in web scraper requests

## [12.3.0] - 2026-02-14

### Added

- Added autonomous memory extraction and consolidation system with configurable settings
- Added `/memory` slash command with subcommands: `view`, `clear`, `reset`, `enqueue`, `rebuild`
- Added memory injection payload that automatically includes learned context in system prompts
- Added two-phase memory pipeline: Stage 1 extracts durable knowledge from session history, Phase 2 consolidates into reusable skills and guidance
- Added memory storage layer with SQLite-backed job queue for distributed memory processing
- Added configurable memory settings: concurrency limits, lease timeouts, token budgets, and rollout age constraints

### Changed

- Modified system prompt building to inject memory guidance when memories are enabled
- Changed `resolvePromptInput` to handle multiline input and improve error handling for file reads

## [12.2.0] - 2026-02-13

### Added

- Added `providerSessionState` property to AgentSession for managing provider-scoped transport and session caches
- Added automatic cleanup of provider session state resources on session disposal
- Added `providers.openaiWebsockets` setting to prefer websocket transport for OpenAI code provider models
- Added provider details display in session info showing authentication mode, transport, and connection settings
- Added automatic prewarm of OpenAI code provider websocket connections on session creation for improved performance
- Added real-time authentication validation in OAuth provider selector with visual status indicators (checking, valid, invalid)
- Added `validateAuth` and `requestRender` options to OAuthSelectorComponent for custom authentication validation and UI refresh callbacks

### Changed

- Changed `providers.openaiWebsockets` setting from boolean to enum with values "auto", "off", "on" for more granular websocket policy control (auto uses model defaults, on forces websocket, off disables it)
- Enhanced provider details display to include live provider session state information
- Enhanced session info output to display active provider configuration and authentication details
- Replaced `process.cwd()` with `getProjectDir()` throughout codebase for improved project directory detection and handling
- Made `SessionManager.list()` async to support asynchronous session discovery operations
- Preserved internal whitespace and indentation in bash command normalization to support heredocs and indentation-sensitive scripts
- Improved git context loading performance with configurable timeouts and parallel status/commit queries
- Enhanced git context reliability with better error handling for timeout and command failures
- Changed OAuth provider selector to display live authentication status instead of static login state
- Changed logout flow to refresh OAuth provider authentication state before showing selector

### Fixed

- Improved error reporting in fetch tool to include HTTP status codes when URL fetching fails
- Fixed fetch tool to preserve actual response metadata (finalUrl, contentType) instead of defaults when requests fail

## [12.1.0] - 2026-02-13

### Added

- Filesystem scan cache invalidation helpers (`invalidateFsScanAfterWrite`, `invalidateFsScanAfterDelete`, `invalidateFsScanAfterRename`) to properly invalidate shared caches after file mutations
- Named discovery profile for file mention candidates to standardize cache visibility and ignore semantics across callers
- Comprehensive `models.yml` provider integration guide documenting custom model registration, provider overrides, API adapters, merge behavior, and practical integration patterns for Ollama, vLLM, LM Studio, and proxy endpoints
- Anthropic Code marketplace plugin discovery: automatically loads skills, commands, hooks, tools, and agents from `~/.anthropic-model/plugins/cache/` based on `installed_plugins.json` registry ([#48](https://github.com/can1357/gajae-code/issues/48))

### Changed

- Moved directory path utilities from `src/config.ts` to `@gajae-code/utils/dirs` for shared use across packages
- Updated imports throughout codebase to use centralized directory path functions from `@gajae-code/utils/dirs`
- Updated interactive bash terminal UI label from 'InteractiveTerm' to 'Console' for clarity
- Enhanced bash execution environment with comprehensive non-interactive defaults for pagers, editors, and package managers to prevent command blocking and interactive prompts
- Updated custom models configuration to use `~/.gjc/agent/models.yml` (YAML format) while maintaining backward compatibility with legacy `models.json`

## [12.0.0] - 2026-02-12

### Added

- Added `getAllServerNames()` method to MCPManager for enumerating all known servers

### Changed

- Changed default edit mode from `patch` to `hashline` for more precise code modifications
- Changed `readHashLines` setting default from false to true to enable hash line reading by default

### Fixed

- Fixed `gjc setup` crashing with uncaught exception when no component argument provided; now shows help ([#35](https://github.com/can1357/gajae-code/issues/35))
- Fixed `/mcp list` showing "No MCP servers configured" when servers are loaded from discovery sources like `.anthropic-model.json`, `.cursor/mcp.json`, `.vscode/mcp.json` ([#34](https://github.com/can1357/gajae-code/issues/34))
- Fixed model selector sorting to show newest models first within each provider instead of alphabetical; `-latest` aliases now appear before dated versions ([#37](https://github.com/can1357/gajae-code/issues/37))

## [11.14.4] - 2026-02-12

### Added

- Exported `renderPromptTemplate` function for programmatic prompt template rendering
- Exported `computeLineHash` function from patch utilities
- Added `./cli` export path for direct CLI module access

### Changed

- Replaced jsdom with linkedom for improved HTML parsing performance and reduced memory footprint

### Removed

- Removed @types/jsdom dependency

## [11.14.1] - 2026-02-12

### Changed

- Improved Bun binary detection to check `Bun.env.PI_CGJCILED` environment variable
- Enhanced Bun package manager update to install specific version instead of latest
- Added post-update verification for Bun installations to warn if expected version was not installed

### Fixed

- Fixed Bun update process to properly handle version pinning and report installation mismatches

## [11.14.0] - 2026-02-12

### Added

- Added SwiftLint linter client with JSON reporter support for Swift file linting
- Added `--no-pty` flag to disable PTY-based interactive bash execution
- Added `PI_NO_PTY` environment variable to disable PTY-based interactive bash execution
- Added `bash.virtualTerminal` setting to control PTY-backed interactive execution for bash commands
- Added interactive PTY-based bash execution with real-time terminal rendering and input forwarding
- Added sourcekit-lsp language server support for Swift files

### Changed

- Changed `bash.virtualTerminal` default from `on` to `off` for standard non-interactive bash execution
- Changed SwiftLint configuration to use `lint` command with JSON reporter instead of `analyze` for improved diagnostic parsing
- Changed diff line format from space-separated (`+123 content`) to pipe-delimited (`+123|content`) for improved parsing reliability
- Changed bash tool to use interactive PTY execution by default when UI is available, falling back to standard execution when disabled

## [11.13.1] - 2026-02-12

### Added

- Added `/move` slash command to move session to a different working directory
- Added `moveTo()` method to SessionManager for relocating sessions with file migration and header updates
- Added `refreshSlashCommandState()` method to reload slash commands and autocomplete when working directory changes
- Added `setSlashCommands()` method to AgentSession for updating file-based slash commands
- Added OAuth authentication support for Perplexity web search via `www.perplexity.ai/rest/sse/perplexity_ask` endpoint
- Added automatic OAuth token refresh with 5-minute expiry buffer for Perplexity authentication
- Added `authMode` field to search responses to indicate authentication method used (oauth or api_key)
- Added display of authentication mode in search result output
- Added support for streaming SSE responses from Perplexity OAuth API with proper event merging

### Changed

- Changed Perplexity provider to support both API key and OAuth authentication methods
- Changed `isAvailable()` method to async to check for both API key and OAuth token availability
- Changed error message to guide users to set PERPLEXITY_API_KEY or login via OAuth
- Changed `callPerplexity` to `callPerplexityApi` to clarify it uses the API key endpoint

## [11.13.0] - 2026-02-12

### Breaking Changes

- Removed support for `.pi` configuration directory alias; use `.gjc` instead

### Added

- Added `openPath` utility function to centralize cross-platform URL and file path opening

### Changed

- Refactored browser/file opening across multiple modules to use unified `openPath` utility for improved maintainability

## [11.12.0] - 2026-02-11

### Added

- Added `resolveFileDisplayMode` utility to centralize file display mode resolution across tools (read, grep, file mentions)
- Added automatic hashline formatting to @file mentions when hashline mode is active
- Added `replace` hashline edit operation for substr-style fuzzy text replacement without line references, with optional `all` flag for replace-all behavior
- Added `noopEdits` array to `applyHashlineEdits` return value to report edits that produced no changes, including edit index, location, and current content for diagnostics
- Added validation to detect and reject hashline edits using wrong-format fields (`old_text`/`new_text` from replace mode, `diff` from patch mode) with helpful error messages
- Added `additionalProperties: true` to all hashline edit schemas (`single`, `range`, `insertAfter`, and root) to tolerate extra fields from models
- Added whitespace normalization in line reference parsing to tolerate spaces around colons (e.g., `5 : ab` now parses as `5:ab`)
- Added `remaps` property to `HashlineMismatchError` providing quick-fix mapping of stale line references to corrected hashes
- Added warnings detection in `applyHashlineEdits` to alert users when edits affect significantly more lines than expected, indicating possible unintended reformatting
- Added diagnostic output showing target line content when an edit produces no changes, helping users identify hash mismatches or incorrect replacement content
- Added `{{hashline}}` Handlebars helper to compute accurate `LINE:HASH` references for prompt examples and documentation
- Added deduplication of identical hashline edits targeting the same line(s) in a single call
- Added `replacement` as accepted alias for `content` in `insertAfter` operations
- Added graceful degradation of `range` edits with missing `end` field to single-line edits
- Added `additionalProperties: true` to hashline edit schemas to tolerate extra fields from models

### Changed

- Reverted hashline display format from `LINE:HASH  content` (two spaces) back to `LINE:HASH|content` (pipe separator) for consistency with legacy format
- Changed hashline display format from `LINE:HASH| content` to `LINE:HASH  content` (two spaces instead of pipe separator) for improved readability
- Removed `lines` and `hashes` parameters from `read` tool—file display mode (line numbers, hashlines) now determined automatically by settings and edit mode
- Simplified `read` tool prompt to reflect automatic display mode detection based on configuration
- Updated `grep` tool to respect file display mode settings, showing hashline-prefixed output when hashline mode is active
- Renamed hashline edit operation keys from `single`/`range`/`insertAfter` to `set_line`/`replace_lines`/`insert_after` for clearer semantics
- Renamed hashline edit fields: `loc` → `anchor`, `replacement` → `new_text`, `content` → `text` for consistency across all operation types
- Separated hashline anchor-based edits (`set_line`, `replace_lines`, `insert_after`) from content-replace edits (`replace`) in application pipeline
- Improved no-op edit diagnostics to use `noopEdits` array from `applyHashlineEdits`, providing precise line-by-line comparison when replacements match current content
- Enhanced error messages for wrong-format hashline edits to guide users toward correct operation syntax
- Strengthened hashline prompt guidance to emphasize that `replacement` must differ from current line content and clarify no-op error recovery procedures
- Improved hashline prompt to clarify atomicity: all edits in one call are validated against the original file state, with line numbers and hashes referring to the pre-edit state
- Added explicit instruction in hashline prompt to preserve exact whitespace and formatting when replacing lines, changing only the targeted token/expression
- Added guidance in hashline prompt for swap operations: use two `single` operations in one call rather than attempting to account for line number shifts
- Strengthened anti-reformatting instructions in hashline prompt to reduce formatting-only failures
- Improved no-op error recovery guidance in hashline prompt to prevent infinite retry loops
- Renamed hashline edit operation keys from `replaceLine`/`replaceLines` to `single`/`range` for clearer semantics
- Renamed hashline edit field `content` to `replacement` in `single` and `range` operations to distinguish from `insertAfter.content`
- Improved no-op edit diagnostics to show specific line-by-line comparisons when replacements match current content, helping users identify hash mismatches or formatting issues
- Enhanced no-op error messages to distinguish between literally identical replacements and content normalized back by heuristics
- Reverted hash algorithm from 3-character base-36 back to 2-character hexadecimal for line references
- Enhanced range validation during hashline edits to detect and reject relocations that change the scope of affected lines
- Improved wrapped-line restoration logic to only attempt merging when source lines exhibit continuation patterns
- Updated hashline tool documentation to emphasize direction-locking mutations and clarify recovery procedures for hash mismatches
- Changed `applyHashlineEdits` return type to include optional `warnings` array for reporting suspicious edit patterns
- Improved hash relocation logic to recompute touched lines after hash-based line number adjustments, preventing incorrect merge heuristics
- Enhanced error messages for no-op edits to include preview of target lines with their current hashes and content
- Changed hashline edit format from `src`/`dst` object structure to direct operation schemas (`replaceLine`, `replaceLines`, `insertAfter`)
- Changed hash algorithm from 2-character hexadecimal to 3-character base-36 alphanumeric for improved readability and collision resistance
- Improved hash mismatch handling to automatically relocate stale line references when the hash uniquely identifies a moved line
- Changed `HashlineEdit` from `src`/`dst` format to direct operation schemas: `replaceLine`, `replaceLines`, `insertAfter`
- Changed hash algorithm from hexadecimal (base-16) to base-36 alphanumeric for shorter, more readable line references
- Increased maximum wrapped-line restoration from 6 to 10 lines to handle longer reflowed statements
- Updated prompt examples to use `{{hashline}}` Handlebars helper for generating correct line references in tool instructions

### Removed

- Removed `insertBefore` hashline edit operation for inserting content before a line
- Removed `substr` hashline edit operation for substring-based line replacement
- Removed `insertBefore` and `substr` hashline edit variants

### Fixed

- Fixed `parseLineRef` to handle both legacy pipe-separator format (`LINE:HASH| content`) and new two-space format (`LINE:HASH  content`) for backward compatibility
- Fixed resource leak in browser query handler by properly disposing owned proxy elements for non-winning candidates
- Fixed script evaluation to support async functions and await expressions in browser evaluate operations
- Fixed `range` edits with missing `end` field to gracefully degrade to single-line edits instead of crashing
- Fixed `insertAfter` operations to accept both `content` and `replacement` field names for consistency with other edit types
- Fixed deduplication logic to correctly identify and remove identical hashline edits targeting the same line(s) in a single call
- Fixed range-based edits to prevent invalid mutations when hash relocation changes the number of lines in the target range
- Fixed multi-edit application to use original file state for all anchor references, preventing incorrect line numbers when earlier edits change file length

## [11.10.4] - 2026-02-10

### Added

- Hashline diff computation with `computeHashlineDiff` function for preview rendering of hashline-mode edits
- Streaming preview display for hashline edits in tool execution UI showing edit sources and destinations
- Streaming hash line computation with progress updates via `onUpdate` callback in read tool
- Optional `onCollectedLine` callback parameter to `streamLinesFromFile` for line collection tracking

### Changed

- Edit tool renderer now displays computed preview diffs for hashline operations before execution
- Read tool now streams hash lines incrementally instead of computing them all at once, improving responsiveness for large files
- Refactored hash line formatting to use async `streamHashLinesFromLines` for better performance

## [11.10.3] - 2026-02-10

### Added

- Exported `./patch/*` subpath for direct access to patch utilities

## [11.10.2] - 2026-02-10

### Added

- Exported `streamHashLinesFromUtf8` and `streamHashLinesFromLines` functions for streaming hashline-formatted output with configurable chunking
- Added `HashlineStreamOptions` interface to control streaming behavior (startLine, maxChunkLines, maxChunkBytes)
- Added `streamHashLinesFromUtf8` function to incrementally format content with hash lines from a UTF-8 byte stream
- Added `streamHashLinesFromLines` function to incrementally format content with hash lines from an iterable of lines

### Changed

- Updated hashline format to use 2-character hex hashes instead of 4-character hashes for more compact line references
- Modified `computeLineHash` to normalize whitespace in line content and removed line number from hash seed for consistency
- Improved CLI argument parsing to explicitly handle `--help`, `--version`, and subcommand detection instead of prefix-based routing

### Removed

- Removed `@types/diff` dev dependency
- Removed AggregateError unwrapping from console.warn in CLI initialization

## [11.10.1] - 2026-02-10

### Changed

- Migrated CLI framework from oclif to lightweight pi-utils CLI runner
- Replaced oclif command registration with explicit command entries in cli.ts
- Changed default root command name from 'index' to 'launch'
- Updated all command imports to use @gajae-code/utils/cli instead of @oclif/core

### Removed

- Removed @oclif/core and @oclif/plugin-autocomplete dependencies
- Removed oclif configuration from package.json
- Removed custom oclif help renderer (oclif-help.ts)

## [11.10.0] - 2026-02-10

### Breaking Changes

- Changed `HashlineEdit.src` from string format (e.g., `"5:ab"`, `"5:ab..9:ef"`) to structured `SrcSpec` object with discriminated union types (`{ kind: "single", ref: "..." }`, `{ kind: "range", start: "...", end: "..." }`, etc.)
- Changed `HashlineEdit` API from `old: string | string[]` / `new: string | string[]` to `src: string` / `dst: string`; src uses range syntax `"5:ab"` (single), `"5:ab..9:ef"` (range), `"5:ab.."` (insert after), or `"..5:ab"` (insert before)
- Removed support for comma and newline-separated line reference lists in hashline edits; use range syntax instead
- Removed `after` field from `HashlineEdit`; insert-after is now expressed via open range syntax `src: "5:ab.."`
- Changed `HashlineEdit` API from `old: string | string[]` / `new: string | string[]` to `src: string` / `dst: string`; multi-line content uses `\n`-separated strings, empty string `""` for insert/delete operations
- Replaced `edit.patchMode` boolean setting with `edit.mode` enum; existing `edit.patchMode: true` configurations should use `edit.mode: patch`
- Changed `getEditModelVariants()` return type from `Record<string, "patch" | "replace">` to `Record<string, EditMode | null>`
- Removed `after` field from `HashlineEdit`; insert-after is now expressed via open range syntax `src: "5:ab.."`
- Changed `HashlineEdit.src` from newline-separated line ref lists to range syntax: `"5:ab"` (single), `"5:ab..9:ef"` (range), `"5:ab.."` (insert after); comma and newline-separated lists are no longer supported

### Added

- Added substring-based source matching for hashline edits when line reference format is invalid, allowing fallback to unique substring search within the file
- Added automatic detection and repair of single-line merges where models absorb adjacent lines, preventing content duplication
- Added normalization of unicode-confusable hyphens (en-dash, em-dash, etc.) to ASCII hyphens when edits would otherwise be no-ops
- Added heuristics to restore original indentation and preserve wrapped line formatting in hashline edits
- Added abort signal support to MCP server connection and tool listing operations, allowing requests to be cancelled via Escape key during testing
- Added `MCPRequestOptions` interface with `signal` property to support request cancellation via AbortSignal
- Added abort signal support to MCP tool execution, allowing requests to be cancelled via Escape-to-interrupt or other abort mechanisms
- Added `HashlineMismatchError` class that displays grep-style output with `>>>` markers showing correct `LINE:HASH` references when hash validation fails
- Added `HashMismatch` type to represent individual hash mismatches with line number, expected hash, and actual hash
- Added hashline edit mode for line-addressed edits using content hashes (LINE:HASH format) with integrity verification
- Added `readHashLines` setting to include line hashes in read output for hashline edit mode
- Added `edit.mode` setting (enum: replace, patch, hashline) to select edit tool variant, replacing `edit.patchMode` boolean
- Added `hashes` parameter to read tool to output line hashes in format `LINE:HASH| content`
- Added automatic hash line output when using hashline edit mode or `readHashLines` setting is enabled
- Added `computeLineHash`, `formatHashLines`, `parseLineRef`, `validateLineRef`, and `applyHashlineEdits` functions for hashline operations
- Added `HashlineEdit` and `HashlineInput` types for structured hashline edit operations
- Added `normalizeEditMode` function to validate and normalize edit mode strings
- Added subcommand definitions for `/mcp` command with 10 subcommands (add, list, remove, test, reauth, unauth, enable, disable, reload, help) including usage hints for argument completion
- Added inline hint support for slash commands with simple arguments (`/export [path]`, `/compact [focus instructions]`, `/handoff [focus instructions]`)
- Added subcommand dropdown completion for `/browser` command (headless, visible modes)
- Added `SubcommandDef` interface for declarative subcommand definitions with name, description, and usage hints
- Added `subcommands` and `inlineHint` properties to `BuiltinSlashCommand` interface for enhanced command metadata
- Added `getArgumentCompletions` and `getInlineHint` functions to materialized slash commands for autocomplete and ghost text hints
- Added `temperature` setting to control sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)
- Added temperature option selector in settings UI with preset values (Default, 0, 0.2, 0.5, 0.7, 1)

### Changed

- Relaxed comma validation in `src` to allow trailing content after line references (e.g., `14:abexport function foo()`), while still rejecting inputs that appear to contain multiple line refs
- Improved `parseLineRef` to accept hash prefixes shorter than the full hash length, allowing partial hash matches
- Enhanced error message for hash mismatches to guide users toward re-reading the file and using updated LINE:HASH references
- Updated hashline tool documentation to clarify that accidental trailing text after LINE:HASH will be extracted, and to discourage merging multiple lines into single-line replacements
- Treated same-line ranges (e.g., `5:ab..5:cd`) as single-line replacements instead of range operations
- Enhanced hashline edit robustness with heuristics to strip anchor line echoes and range boundary echoes that models may copy into replacement content
- Improved whitespace preservation in hashline edits to handle mismatched line counts using loose matching strategy
- Strengthened hashline edit validation to reject malformed src specs (embedded newlines, commas, invalid ranges)
- Enhanced MCP connection timeout handling to properly respect abort signals and distinguish between timeout and user-initiated cancellation
- Improved MCP test command UI to show cancellation hint (esc to cancel) and handle graceful cancellation without blocking cleanup
- Updated HTTP transport session termination to use AbortSignal.timeout() for reliable cleanup with timeout protection
- Enhanced bash executor to properly handle abort signals by registering abort event listeners and cleaning up resources in finally block
- Improved bash tool error handling to distinguish between user-initiated aborts (via AbortSignal) and other cancellations, throwing ToolAbortError for aborted requests
- Enhanced MCP request handling to propagate abort signals through HTTP, SSE, and stdio transports with proper cleanup
- Improved stdio transport request handling to use Promise.withResolvers for cleaner async flow and better abort signal integration
- Updated HTTP transport to combine operation abort signals with timeout signals using AbortSignal.any() for unified cancellation
- Modified SSE response parsing to support abort signals and distinguish between timeout and user-initiated cancellation
- Improved hashline edit robustness by automatically stripping `LINE:HASH|` display prefixes and unified-diff `+` markers that models may copy into replacement content
- Enhanced replace edits to preserve original whitespace on lines where only whitespace differs, preventing spurious formatting diffs when models reformat code
- Enhanced system prompt to display tool descriptions alongside tool names for improved clarity on available capabilities
- Reduced hash length from 4 to 2 hex characters (16-bit hashes) for more concise line references
- Updated `HashlineEdit` type to accept `string | string[]` for `old` and `new` fields, allowing single-line edits without array wrapping
- Enhanced `parseLineRef` to strip display-format suffix (e.g., `5:ab| content` → `5:ab`), allowing models to copy full read output format
- Improved `validateLineRef` to throw `HashlineMismatchError` with context lines instead of generic error, providing grep-style output with correct hashes
- Modified hash computation to strip trailing carriage returns before hashing for consistent line hash values
- Renamed `HashlineEdit` fields from `src`/`dst` to `old`/`new` for clarity in replace, delete, and insert operations
- Enhanced hash validation in `applyHashlineEdits` to collect all mismatches before throwing, providing comprehensive error reporting with context lines
- Changed `edit.patchMode` boolean setting to `edit.mode` enum (replace, patch, hashline) with default value patch
- Changed edit tool to support three modes (replace, patch, hashline) instead of two, with dynamic mode selection based on model and settings
- Changed read tool to prioritize hash lines over line numbers when both are requested
- Changed `getEditVariantForModel` to return `EditMode | null` and removed hardcoded Kimi model detection
- Renamed `settingsInstance` parameter to `settings` in `CreateAgentSessionOptions` for consistency
- Updated all internal references from `settingsInstance` to `settings` throughout SDK and components

### Fixed

- Fixed substring source matching to reject ambiguous matches and provide helpful error messages showing all occurrences
- Fixed substring source matching to require exactly one matching line in the file
- Fixed MCP test command to properly clean up connections even when cancelled or aborted, preventing resource leaks

## [11.9.0] - 2026-02-10

### Added

- Added `/mcp` slash command for runtime MCP server management (add, list, remove, enable, disable, test, reauth)
- Added interactive multi-step wizard for adding MCP servers with transport auto-detection
- Added OAuth auto-discovery and authentication flow for MCP servers requiring authorization
- Added MCP config file writer for persisting server configurations at user and project level
- Added `enabled` and `timeout` fields to MCP server configuration
- Added runtime MCP manager reload and active tool registry rebind without restart
- Added MCP command guide documentation

### Changed

- Replaced `setTimeout` with `Bun.sleep()` for improved performance in file lock retry logic
- Refactored component invalidation handling to use dedicated helper function for cleaner code
- Improved error handling in worktree baseline application to use `isEnoent()` utility instead of file existence checks
- Updated bash tool to use standard Node.js `fs.promises.stat()` with `isEnoent()` error handling
- Replaced `tmpdir()` named import with `os` namespace import for consistency
- Migrated logging from `chalk` and `console.error` to structured logger from `@gajae-code/utils`

### Fixed

- Improved browser script evaluation to handle both expression and statement forms, fixing evaluation failures for certain script types
- Fixed unsafe OAuth endpoint extraction that could redirect token exchange to attacker-controlled URLs
- Fixed PKCE code verifier stored via untyped property; now uses typed private field
- Fixed refresh token fallback incorrectly using access token when no refresh token provided
- Fixed MCP config files written with default permissions; now enforces 0o700/0o600 for secret protection
- Fixed add wizard ignoring user-chosen environment variable name and auth header name
- Fixed reauth endpoint discovery misclassifying non-OAuth servers as discovery failures
- Fixed resolved OAuth tokens leaking into connection config, causing cache churn on token rotation
- Fixed unvalidated type assertions for `enabled`/`timeout` config fields from user-controlled JSON
- Fixed uncaught exceptions in `/mcp add` quick-add flow crashing the interactive loop
- Fixed greedy `/mcp` prefix match routing `/mcpfoo` to MCP controller
- Fixed stdio transport timeout timer leak keeping process alive after request completion

### Removed

- Removed `GrepOperations` interface from public API exports
- Removed `GrepToolOptions` interface from public API exports
- Removed unused `_options` parameter from `GrepTool` constructor

## [11.8.1] - 2026-02-10

### Added

- Added current date to system prompt context in YYYY-MM-DD format for date-aware agent reasoning
- Added file size display in UI when files are skipped due to size limits
- Added support for gigabyte (GB) file size formatting in truncate utility

### Changed

- Changed skipped file messages to include file size information for better visibility into why files were excluded
- Changed file processing to skip reading files exceeding 5MB (text) or 25MB (images) and include them as path-only references instead
- Changed @mention auto-reading to skip files exceeding 5MB (text) or 25MB (images) to prevent out-of-memory issues with large files
- Clarified that subagents automatically inherit full system prompt including AGENTS.md, context files, and skills — do not repeat project rules or conventions in task context
- Updated task context guidance to focus on session-specific information subagents lack, eliminating redundant documentation of project constraints already available to them
- Refined constraints template to emphasize task-specific rules and session decisions rather than global project conventions
- Expanded anti-patterns section to explicitly flag redundant context that wastes tokens by repeating AGENTS.md rules, project constraints, and tool preferences

### Fixed

- Fixed bash tool hanging when commands spawn background jobs by properly detecting foreground process completion
- Fixed bash tool occasionally hanging after command completion when background jobs keep stdout/stderr open
- Fixed crash when auto-reading @mentions for very large files by skipping content injection with an explicit "skipped" note
- Improved bash tool output draining after foreground completion to reduce tail output truncation

## [11.8.0] - 2026-02-10

### Added

- Added `ctx.reload()` method to extension command context to reload extensions, skills, prompts, and themes from disk
- Added `ctx.ui.pasteToEditor()` method to paste text into the editor with proper handling (e.g., large paste markers in interactive mode)
- Added extension UI sub-protocol for RPC mode enabling dialog methods (`select`, `confirm`, `input`, `editor`) and fire-and-forget UI methods via client communication
- Added support for tilde (`~`) expansion in custom skill directory paths
- Added example extension demonstrating `ctx.reload()` usage with both command and LLM-callable tool patterns

### Changed

- Changed `ctx.hasUI` behavior: now `true` in RPC mode (previously `false`), with dialog methods working via extension UI sub-protocol
- Changed warning output for invalid CLI arguments to use structured logging instead of console.error
- Changed help text to indicate command-specific help is available via `<command> --help`
- Changed tool result event handlers to chain like middleware, allowing each handler to see and modify results from previous handlers with partial patch support

### Fixed

- Fixed archive extraction security vulnerability by validating that extracted paths do not escape the extraction directory
- Fixed archive format validation to reject unsupported formats before extraction attempt
- Fixed archive extraction error handling to provide clear error messages on failure

## [11.7.0] - 2026-02-07

### Changed

- Enhanced error messages for failed Python cells to include full combined output context instead of just the error message
- Updated error cell output styling to use error color theme instead of standard tool output color for better visual distinction

### Fixed

- Improved error handling in Python cell execution to preserve and display combined output from previous cells when an error occurs
- Fixed tab character rendering in Python tool output display to properly format whitespace in cell output and status events

## [11.6.1] - 2026-02-07

### Fixed

- Fixed potential crash when rendering results with undefined details.results

## [11.6.0] - 2026-02-07

### Fixed

- Fixed task tool renderer not sanitizing tabs, causing visual holes in TUI output
- Fixed task tool expanded view showing redundant `<swarm_context>` block that is shared across all tasks
- Fixed assistant message spacer appearing before tool executions when no visible content follows thinking block
- Fixed extension runner `emit()` type safety with narrowed event/result types
- Fixed extension runner `tool_result` event chaining across multiple extensions via dedicated `emitToolResult()`
- Fixed queued messages not delivered after auto-compaction completes

### Added

- Added `/quit` slash command as alias for `/exit`
- Added per-model overrides (`modelOverrides`) in `models.json` for customizing built-in model properties
- Added `mergeCustomModels` to merge custom models with built-ins by provider+id instead of replacing

## [11.5.2] - 2026-02-07

### Fixed

- Fixed TUI crash when ask tool renders long user input exceeding terminal width by using Text component for word wrapping instead of raw line output
- Fixed TUI crash when todo_write tool renders long todo content exceeding terminal width by using Text component for word wrapping instead of truncation

## [11.5.0] - 2026-02-06

### Added

- Added terminal breadcrumb tracking to remember the last session per terminal, enabling `--continue` to work correctly with concurrent sessions in different terminals

### Changed

- Changed screenshot format to always use PNG instead of supporting JPEG with quality parameter
- Changed default extract_readable format from text to markdown
- Changed screenshot storage to use temporary directory with Snowflake IDs instead of artifacts directory
- Changed ResizedImage interface to return buffer as Uint8Array with lazy-loaded base64 data getter for improved memory efficiency

### Removed

- Removed JPEG quality parameter from screenshot options
- Removed format selection for screenshots (now PNG only)
- Removed ability to save screenshots to custom paths or artifacts directory

## [11.4.1] - 2026-02-06

### Fixed

- Fixed tab character display in error messages and bash tool output by properly replacing tabs with spaces

## [11.4.0] - 2026-02-06

### Added

- Visualize leading whitespace (indentation) in diff output with dim glyphs—tabs display as `→` and spaces as `·` for improved readability

### Fixed

- Fixed patch applicator to correctly handle context-only hunks (pure context lines between @@ markers) without altering indentation in tab-indented files
- Fixed indentation conversion logic to infer tab width from space-to-tab patterns using linear regression (ax+b model) when pattern uses spaces and actual file uses tabs
- Fixed tab character rendering in tool output previews and code cell displays, ensuring tabs are properly converted to spaces for consistent terminal display
- Fixed `newSession()` to properly await session manager operations, ensuring new session is fully initialized before returning
- Fixed session formatting to use XML structure for tools and tool invocations instead of YAML, improving compatibility with structured output parsing

## [11.3.0] - 2026-02-06

### Added

- Added resumption hint printed to stderr on session exit showing command to resume the session (e.g., `Resume this session with anthropic-model --resume <session-id>`)
- New `BlobStore` class for content-addressed storage of large binary data (images) externalized from session files
- New `getBlobsDir()` function to get path to blob store directory
- Support for externalizing large images to blob store during session persistence, reducing JSONL file size
- New blob reference format (`blob:sha256:<hash>`) for tracking externalized image data in sessions
- Exported `ModeChangeEntry` type for tracking agent mode transitions
- Support for restoring plan mode state when resuming sessions
- New `appendModeChange()` method in SessionManager to record mode transitions
- New `mode` and `modeData` fields in SessionContext to track active agent mode
- Support for `PI_PACKAGE_DIR` environment variable to override package directory (useful for Nix/Guix store paths)
- New keybindings for session management: `newSession`, `tree`, `fork`, and `resume` actions
- Support for shell command execution in configuration values (API keys, headers) using `!` prefix, with result caching
- New `clearOnShrink` display setting to control whether empty rows are cleared when content shrinks
- New `SlashCommandInfo`, `SlashCommandLocation`, and `SlashCommandSource` types for extension slash command discovery
- New `getCommands()` method in ExtensionAPI to retrieve available slash commands
- New `switchSession()` action in ExtensionCommandContext to switch between sessions
- New `SwitchSessionHandler` type for extension session switching handlers
- New `getSystemPrompt()` method in ExtensionUIContext to access current system prompt
- New `getToolsExpanded()` and `setToolsExpanded()` methods in ExtensionUIContext for tool output expansion control
- New `WriteToolCallEvent` type for write tool call events
- New `isToolCallEventType()` type guard for tool call events
- Support for image content in RPC `steer` and `followUp` commands
- New `GitSource` type and `parseGitUrl()` function for parsing git URLs in plugin system
- Tool input types exported: `BashToolInput`, `FindToolInput`, `GrepToolInput`, `ReadToolInput`, `WriteToolInput`
- Support for `@` prefix normalization in file paths (strips leading `@` character)
- New `parentSessionPath` field in SessionInfo to track forked session origins
- Skill file relative path resolution against skill directory in system prompt
- Support for Termux/Android package installation guidance for missing tools
- Support for puppeteer query handlers (aria/, text/, xpath/, pierce/) in selector parameters across all browser actions
- Automatic normalization of legacy p- prefixed selectors (p-aria/, p-text/, p-xpath/, p-pierce/) to modern puppeteer query handler syntax
- Improved click action with intelligent element selection that prioritizes visible, actionable candidates and retries until timeout
- Enhanced actionability checking for click operations, validating visibility, pointer events, opacity, viewport intersection, and element occlusion

### Changed

- Modified `--resume` flag to accept optional session ID or path (e.g., `--resume abc123` or `--resume /path/to/session.jsonl`), with session picker shown when no value provided
- Consolidated `--session` flag as an alias for `--resume` with value for improved CLI consistency
- Removed read tool grouping reset logic that was breaking grouping when text or thinking blocks appeared between tool calls
- Image persistence now externalizes images ≥1KB to content-addressed blob store instead of compressing inline
- Session loading now automatically resolves blob references back to base64 image data
- Session forking now resolves blob references in copied entries to ensure data integrity
- Screenshot tool now automatically compresses images for API content using the same resizing logic as pasted images, reducing payload size while maintaining quality
- Improved text truncation across tool renderers to respect terminal width constraints and prevent output overflow
- Enhanced render caching to include width parameter for accurate cache invalidation when terminal width changes
- HTML export filter now treats `mode_change` entries as settings entries alongside model changes and thinking level changes
- Replaced ellipsis string (`...`) with Unicode ellipsis character (`…`) throughout UI text and truncation logic for improved typography
- Improved render performance by introducing caching for tool output blocks and search results to avoid redundant text width and padding computations
- Enhanced read tool grouping to reset when non-tool content (text/thinking blocks) appears between read calls, preventing unintended coalescing
- Improved string preview formatting in scalar values to show line counts and truncation indicators for multi-line strings
- Refactored tool execution component to use shared mutable render state for spinner frames and expansion state, reducing closure overhead
- Enhanced error handling in tool renderers with logging for renderer failures instead of silent fallbacks
- Made shell command execution in configuration values asynchronous to prevent blocking the TUI
- Improved `@` prefix normalization to only strip leading `@` for well-known path syntaxes (absolute paths, home directory, internal URL shorthands) to avoid mangling literal paths
- Enhanced git URL parsing to strip credentials from repository URLs and validate URL-encoded hash fragments
- Improved null data handling in task submission to preserve agent output when `submit_result` is called with null/undefined data, enabling fallback text extraction instead of discarding output
- Updated default model IDs across providers: Anthropic model Sonnet 4.5 → Anthropic model Opus 4.6, Gemini 2.5 Pro → Gemini 3 Pro variants, and others
- Made model definition fields optional with sensible defaults for local models (Ollama, LM Studio, etc.)
- Modified custom tool execute signature to reorder parameters: `(toolCallId, params, signal, onUpdate, ctx)` instead of `(toolCallId, params, onUpdate, ctx, signal)`
- Changed `--version` and `--list-models` flags to exit with `process.exit(0)` instead of returning
- Improved `--export` flag to exit with `process.exit(0)` on success
- Enhanced tree selector to preserve last selected ID across filter changes
- Modified tree navigation to use real leaf ID instead of skipping metadata entries
- Improved footer path truncation logic to prevent invalid truncation at boundary
- Enhanced model selector to display selected model name when no matches found
- Improved RPC client `steer()` and `followUp()` methods to accept optional image content
- Updated extension loader to check for explicit extension entries in root directory before discovering subdirectories
- Removed line limiting in custom message component when collapsed
- Improved API key resolution to support shell command execution via `resolveConfigValue()`
- Enhanced session branching to preserve parent session path reference
- Updated selector parameter descriptions to document support for CSS selectors and puppeteer query handlers
- Modified viewport handling in headless mode to respect custom viewport parameters while disabling viewport in headed mode for better window management
- Improved click action to use specialized text query handler logic with retry mechanism for better reliability with dynamic content

### Fixed

- Fixed background color stability in output blocks when inner content contains SGR reset sequences, preventing background color from being cleared mid-line
- Fixed spurious ellipsis appended to output lines that were already padded to terminal width by trimming trailing spaces before truncation check
- Fixed config file parsing to properly handle missing files instead of treating them as errors
- Fixed truncation indicator in truncate tool to use ellipsis character (…) instead of verbose '[truncated]' suffix
- Fixed concurrent shell command execution by de-duplicating in-flight requests for the same command
- Fixed git URL parsing to properly handle URL-encoded characters in hash fragments and reject invalid encodings
- Fixed task executor to properly handle agents calling `submit_result` with null data by treating it as missing and attempting to extract output from conversation text rather than silently failing
- Fixed HTML export template to safely handle invalid argument types in tool rendering
- Fixed path shortening in HTML export to handle non-string paths
- Fixed custom message rendering to properly display full content without artificial line limits
- Fixed tree navigation to only restore editor text when editor is empty
- Fixed session creation to properly track parent session when forking
- Fixed thinking level initialization to only append change entry for new sessions without existing thinking entries
- Fixed tool expansion state management to properly propagate through UI context
- Fixed click action to properly handle text/ query handlers with timeout and retry logic instead of failing immediately
- Fixed viewport application to only apply when in headless mode or when explicitly requested, preventing conflicts in headed browser mode

### Security

- Added support for shell command execution in configuration values with caching to enable secure credential resolution patterns

## [11.2.1] - 2026-02-05

### Fixed

- Fixed CLI invocation with flags only (e.g. `pi --model=openai-code`) to route to the default command instead of erroring

## [11.2.0] - 2026-02-05

### Added

- Added `gjc commit` command to generate commit messages and update changelogs with `--push`, `--dry-run`, `--no-changelog`, and model override flags
- Added `gjc config` command to manage configuration settings with actions: list, get, set, reset, path
- Added `gjc grep` command to test grep tool with pattern matching, glob filtering, context lines, and output modes
- Added `gjc jupyter` command to manage the shared Jupyter gateway with status and kill actions
- Added `gjc plugin` command to manage plugins with install, uninstall, list, link, doctor, features, config, enable, and disable actions
- Added `gjc setup` command to install dependencies for optional features like Python
- Added `gjc shell` command for interactive shell console with working directory and timeout configuration
- Added `gjc stats` command to view usage statistics with dashboard server, JSON output, and summary options
- Added `gjc update` command to check for and install updates with force and check-only modes
- Added `gjc web-search` command (alias `gjc q`) to test web search providers with provider selection, recency filtering, and result limits
- Migrated CLI from custom argument parser to oclif framework for improved command structure and help system
- Added `gjc q` CLI subcommand for testing web search providers with query, provider, recency, and limit options
- Added web search provider information API with authentication requirements and provider metadata
- Added support for `hour` recency filter option in Perplexity web search
- Support for image file mentions—images are now automatically detected, resized, and attached when referenced with @filepath syntax
- Image dimension information displayed in file mention UI to show image properties alongside text files

### Changed

- Refactored web search provider system to use individual provider classes in separate files for improved maintainability
- Moved `SearchProvider` base class and `SearchParams` interface to dedicated `providers/base.ts` module
- Updated web search execution to pass `maxOutputTokens`, `numSearchResults`, and `temperature` parameters to providers
- Changed Perplexity search context size from 'high' to 'medium' and added search classifier, reasoning effort, and language preference settings
- Increased Perplexity default max tokens from 4096 to 8192 for more comprehensive responses
- Updated Anthropic and Gemini search providers to support `max_tokens` and `temperature` parameters for finer control over response generation
- Simplified `AuthStorage.create()` to accept direct agent.db path
- Renamed web search types and exports for consistency: `WebSearchProvider` → `SearchProviderId`, `WebSearchResponse` → `SearchResponse`, `WebSearchTool` → `SearchTool`, and related functions
- Refactored web search provider system to use centralized provider registry with `getSearchProvider()` and `resolveProviderChain()` for improved provider management
- Updated web search system prompt to emphasize comprehensive, detailed answers with concrete data and specific examples over brevity
- Simplified Exa API key discovery to check environment variables only, removing .env file fallback logic
- Refactored `ModelRegistry` instantiation to use direct constructor instead of `discoverModels()` helper function across codebase
- Refactored CLI entry point to use oclif command framework instead of custom subcommand routing
- Reorganized subcommands into individual command files under `src/commands/` directory for better maintainability
- Updated extension flag handling to parse raw arguments directly instead of using custom flag definitions
- Refactored web search provider definitions into centralized provider-info module for better maintainability
- Updated web search result rendering to support long-form answers with text wrapping in CLI mode
- Removed related questions section from web search result rendering
- Updated Perplexity API types to support extended message content formats including images, files, and PDFs
- Updated Perplexity search to use 'pro' search type for improved search quality and relevance
- File mention messages now support both text content and image attachments, with optional line count for text files
- Updated file mention processing to respect image auto-resize settings

### Removed

- Removed legacy auth.json file—credentials are stored exclusively in agent.db

### Fixed

- Fixed type handling in model selector error message display to properly convert error objects to strings
- Fixed web search to use search results when Perplexity API returns no citations, ensuring search results are always available to users
- Fixed model switches deferred during streaming to apply correctly when the stream completes, preventing model changes from being lost
- Fixed plan mode toggles during streaming to inject plan-mode context immediately, preventing file edits while in plan mode
- Fixed plan mode model switches during streaming to defer model changes until the current turn completes

## [11.1.0] - 2026-02-05

### Added

- Added `sortDiagnostics()` utility function to sort diagnostics by severity, location, and message for consistent output ordering
- Added `task.isolation.enabled` setting to control whether subagents run in isolated git worktrees
- Added dynamic task schema that conditionally includes `isolated` parameter based on isolation setting
- Added `openInEditor()` utility function to centralize external editor handling with support for custom file extensions and stdio configuration
- Added `getEditorCommand()` utility function to retrieve the user's preferred editor from $VISUAL or $EDITOR environment variables

### Changed

- Changed diagnostic output to sort results by severity (errors first), then by file location and message for improved readability
- Changed task tool to validate isolation setting and reject `isolated` parameter when isolation is disabled
- Changed task API to use `assignment` field instead of `args` for per-task instructions, with shared `context` prepended to every task
- Changed task template rendering to use structured context/assignment separation with `<swarm_context>` wrapper instead of placeholder-based substitution
- Changed task item schema to require `assignment` string (complete per-task instructions) instead of optional `args` object
- Changed `TaskItem` to remove `args` field and add `assignment` field for clearer per-task instruction semantics
- Changed agent frontmatter to use `thinking-level` field name instead of `thinkingLevel` for consistency
- Refactored task rendering to display full task text instead of args in progress and result views
- Changed `SubmenuSettingDef.getOptions()` method to `options` getter property for cleaner API access
- Converted static option providers from functions to direct array definitions for improved performance
- Added `createSubmenuSettingDef()` helper function to support both static and dynamic option providers
- Modified `setThinkingLevel()` API to accept optional `persist` parameter (defaults to false) for controlling whether thinking level changes are saved to settings
- Refactored hook editor and input controller to use shared external editor utilities, reducing code duplication

### Removed

- Removed `context` parameter from `ExecutorOptions` — context now prepended at template level before task execution
- Removed `args` field from `AgentProgress` and `SingleResult` interfaces
- Removed placeholder-based template rendering in favor of structured context/assignment model

## [11.0.3] - 2026-02-05

### Added

- Added new subcommands to help text: `commit` for AI-assisted git commits, `stats` for AI usage statistics dashboard, and `jupyter` for managing the shared Jupyter gateway
- Added `grep` subcommand to help text for testing the grep tool
- Added `browser` tool documentation for browser automation using Puppeteer
- Added `todo_write` tool documentation for managing todo and task lists
- Added documentation for additional LLM provider API keys (Groq, Cerebras, xAI, OpenRouter, Mistral, z.ai, MiniMax, OpenCode, Cursor, Vercel AI Gateway) in environment variables reference
- Added documentation for cloud provider configuration (AWS Bedrock, Google Vertex AI) in environment variables reference
- Added documentation for search provider API keys (Perplexity, Anthropic Search) in environment variables reference
- Added documentation for model override environment variables (`PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL`) in CLI help text
- Added comprehensive environment variables reference documentation at `docs/environment-variables.md` covering API keys, configuration, debugging, and testing variables
- Added theme system with 44 customizable color tokens, two built-in themes (dark/light), and auto-detection based on terminal background
- Added `/theme` command to interactively select and switch between themes
- Added support for custom themes in `~/.pi/agent/themes/*.json` with live editing - changes apply immediately when files are saved
- Added `userMessageText` theme token for customizing user message text color
- Added `toolTitle` and `toolOutput` theme tokens for separate coloring of tool execution box titles and output

### Changed

- Updated help text to reflect expanded tool availability - default now enables all tools instead of just read, bash, edit, write
- Updated available tools list in help documentation to include python, notebook, task, fetch, web_search, browser, and ask
- Simplified main description in help text from 'AI coding assistant with read, bash, edit, write tools' to 'AI coding assistant'
- Updated `--tools` option documentation to clarify default behavior and list all available tools
- Changed all environment variable access from `process.env` to `Bun.env` throughout the codebase for Bun runtime compatibility
- Updated documentation to reference `Bun.env` instead of `process.env` in examples and comments

### Fixed

- Fixed `Text` component to properly implement `invalidate()` method, ensuring theme changes apply correctly to all UI elements
- Fixed `TruncatedText` component to properly pad all lines to exactly match the specified width, preventing rendering artifacts
- Fixed `TruncatedText` component to stop at the first newline and only display the first line
- Fixed invalid or malformed themes to fall back gracefully to dark theme instead of crashing the application

## [11.0.2] - 2026-02-05

### Fixed

- Fixed role model cycling to expand role aliases (e.g., roles pointing at `pi/plan`) so slow/default/smol cycles resolve correctly

## [11.0.0] - 2026-02-05

### Added

- Added UI dropdown options for `task.maxRecursion Depth` setting with presets (Unlimited, None, Single, Double, Triple)
- Added UI dropdown options for `grep.contextBefore` setting with presets (0-5 lines)
- Added UI dropdown options for `grep.contextAfter` setting with presets (0-10 lines)
- Added `task.maxRecursionDepth` setting to control how many levels deep subagents can spawn their own subagents (0=none, 1=one level, 2=two levels, -1=unlimited)
- Added support for nested task artifact naming with parent task prefixes (e.g., "0-Auth.1-Subtask") to organize hierarchical task outputs
- Added `taskDepth` and `parentTaskPrefix` options to `CreateAgentSessionOptions` for tracking subagent recursion depth and organizing nested artifacts
- Added `task.maxConcurrency` setting to control concurrent limit for subagents (default: 32)
- Added UI options for task concurrency configuration with presets from unlimited to 64 tasks
- Added support for loading skills from `~/.agents/skills`

### Changed

- Simplified `task.maxRecursionDepth` description in settings UI to remove specific value examples
- Made thinking level persistence optional via `persist` parameter in `setThinkingLevel()` method, allowing temporary thinking level changes without saving to settings
- Updated thinking level cycling to no longer persist changes to settings, enabling quick iteration through thinking levels without modifying user preferences
- Replaced nanoid with Snowflake for ID generation throughout codebase for improved performance and collision resistance
- Updated session ID format in documentation from nanoid to snowflake hex string (e.g., "a1b2c3d4e5f60001")
- Renamed environment variable prefix from `GJC_` to `PI_` throughout codebase (e.g., `GJC_DEBUG_STARTUP` → `PI_DEBUG_STARTUP`, `GJC_PYTHON_GATEWAY_URL` → `PI_PYTHON_GATEWAY_URL`)
- Removed `env` setting from configuration schema; environment variables are no longer automatically applied from settings
- Changed `venvPath` property in PythonRuntime from nullable to optional (returns `undefined` instead of `null`)
- Simplified notification settings from protocol-specific options (bell, osc99, osc9) to simple on/off toggle for `completion.notify` and `ask.notify`
- Moved notification protocol detection and sending to `TERMINAL` API from local utility functions
- Changed task tool spawns configuration from "explore" to "\*" to allow subagents to spawn any agent type
- Changed system prompt to enable parallel delegation guidance for all agents (removed coordinator-only restriction)
- Changed task tool to automatically disable itself when maximum recursion depth is reached, preventing infinite nesting
- Changed task concurrency from hardcoded constant to configurable setting via `task.maxConcurrency`
- Changed concurrency limit calculation to support unlimited concurrency when set to 0

### Removed

- Removed nanoid dependency from package.json
- Removed `terminal-notify.ts` utility module with `detectNotificationProtocol()`, `sendNotification()`, and `isNotificationSuppressed()` functions
- Removed `MAX_PARALLEL_TASKS` constant and associated task count validation limit

### Fixed

- Fixed MCP tool name generation to properly sanitize server and tool names, preventing invalid characters and duplicate prefixes in tool identifiers
- Fixed task ID display formatting to show hierarchical structure for nested tasks (e.g., "0.1 Auth>Subtask" instead of "0-Auth.1-Subtask")
- Improved frontmatter parsing error messages to include source context for better debugging

## [10.6.1] - 2026-02-04

### Added

- Added `commit` model role for dedicated commit message generation
- Exported `resolveModelOverride` function from model resolver for external use

### Changed

- Updated model role resolution to accept optional `roleOrder` parameter for custom role priority
- Made `tag` and `color` properties optional in `ModelRoleInfo` interface
- Updated model selector to safely handle roles without tag or color definitions
- Refactored role label display to use centralized `MODEL_ROLES` registry instead of hardcoded strings
- Refactored model role system to use centralized `MODEL_ROLES` registry with consistent tag, name, and color definitions
- Simplified model role resolution to use `MODEL_ROLE_IDS` array instead of hardcoded role checks
- Updated model selector to dynamically generate menu actions from `MODEL_ROLES` registry

### Removed

- Removed support for `gjc/` model role prefix; use `pi/` prefix instead

## [10.6.0] - 2026-02-04

### Breaking Changes

- Removed `output_mode` parameter from grep tool—results now always use content mode with formatted match output
- Renamed grep context parameters from `context_pre`/`context_post` to `pre`/`post`
- Removed `n` (show line numbers) parameter—line numbers are now always displayed in grep results

### Added

- Added Jina as a web search provider option alongside Exa, Perplexity, and Anthropic
- Added support for Jina Reader API integration with automatic provider detection when JINA_API_KEY is configured

### Changed

- Reformatted grep output to display matches grouped by file with numbered match headers and aligned context lines
- Updated grep output to use `>>` prefix for match lines and aligned spacing for context lines for improved readability
- Changed multiline matching to automatically enable when pattern contains literal newlines (`
`)
- Split grep context parameter into separate `context_pre` and `context_post` options for independent control of lines before and after matches
- Updated grep tool to use configurable default context settings from `grep.contextBefore` and `grep.contextAfter` configuration
- Added configurable grep context defaults and reduced the default to 1 line before, 3 lines after
- Enabled the browser tool by default

### Removed

- Removed `filesWithMatches` and `count` output modes from grep tool

## [10.5.0] - 2026-02-04

### Breaking Changes

- Changed `ask` tool to require `questions` array parameter; single-question mode with `question`, `options`, `multi`, and `recommended` parameters is no longer supported
- Removed support for local Python kernel gateway startup; shared gateway is now required

### Added

- Added browser tool powered by Ulixee Hero with support for navigation, DOM interaction, screenshots, and readable content extraction
- Added `/browser` command to toggle browser headless vs visible mode in interactive sessions
- Added `browser.enabled` and `browser.headless` settings to control browser automation behavior
- Added Python prelude caching to improve startup performance by storing compiled prelude helpers and module metadata
- Added `GJC_DEBUG_STARTUP` environment variable for conditional startup performance debugging output
- Added autonomous memory system with storage, memory tools, and context injection

### Changed

- Updated task tool guidance to enforce small, well-defined task scope with maximum 3-5 files per task to prevent timeouts and improve parallel execution
- Updated browser viewport to use 1.25x device scale factor for improved rendering on high-DPI displays
- Modified device pixel ratio detection to respect actual screen capabilities instead of forcing 1x ratio
- Updated system prompt guidance to state assumptions and proceed without asking for confirmation, reducing unnecessary round-trips
- Tightened `ask` tool conditions to require multiple approaches with significantly different tradeoffs before prompting user
- Strengthened `ask` tool guidance to default to action and only ask when genuinely blocked by decisions with materially different outcomes
- Changed refactor workflow to automatically remove now-unused elements and note removals instead of asking for confirmation
- Enforced exclusive concurrency mode for all file-modifying tools (edit, write, bash, python, ssh, todo-write) to prevent concurrent execution conflicts
- Updated `ask` tool guidance to prioritize proactive problem-solving and default to action, asking only when truly blocked by decisions that materially change scope or behavior
- Changed Python kernel initialization to require shared gateway mode; local gateway startup has been removed
- Changed shared gateway error handling to retry on server errors (5xx status codes) before failing

### Fixed

- Fixed glob search returning no results when all files are ignored by gitignore by automatically retrying without gitignore filtering

## [10.3.2] - 2026-02-03

### Added

- Added `renderCall` and `renderResult` methods to MCP tools for structured TUI display of tool calls and results
- Added new `mcp/render.ts` module providing JSON tree rendering for MCP tool output with collapsible/expandable views

### Changed

- Updated `renderResult` signature in custom tools and extensions to accept optional `args` parameter for context-aware rendering
- Changed environment variable from `ENV_AGENT_DIR` constant to hardcoded `GJC_CODING_AGENT_DIR` string in config and CLI help text
- Fixed method binding in extension and hook tool wrappers to preserve `this` context for `renderCall` and `renderResult` methods

## [10.3.1] - 2026-02-03

### Fixed

- Fixed timeout handling in LSP write-through operations to properly clear formatter and diagnostics results when operations exceed the 10-second timeout

## [10.3.0] - 2026-02-03

### Removed

- Removed `shellForceBasic` setting that forced bash/sh shell selection
- Removed `bash.persistentShell` experimental setting for shell session reuse

## [10.2.3] - 2026-02-02

### Added

- Added `find.enabled`, `grep.enabled`, `ls.enabled`, `notebook.enabled`, `fetch.enabled`, `web_search.enabled`, `lsp.enabled`, and `calc.enabled` settings to control availability of individual tools
- Added conditional tool documentation in system prompt that dynamically lists only enabled specialized tools
- Added `todos.enabled` setting to control availability of the todo_write tool for task tracking
- Added `tools` field to agent frontmatter for declaring agent-specific tool capabilities

### Changed

- Consolidated `symbols` action to handle both file-based document symbols and workspace symbol search (query-based)
- Consolidated `diagnostics` action to handle both single-file and workspace-wide diagnostics (no file = workspace)
- Simplified `reload` action to gracefully reload language server with fallback to kill
- Updated LSP tool documentation to reflect simplified operation set and consolidated actions
- Reorganized settings tabs from 8 to 9 tabs with clearer categorization: Display, Agent, Input, Tools, Config, Services, Bash, LSP, and TTSR
- Moved behavior-related settings to new Agent tab for better organization
- Moved input/interaction settings to new Input tab
- Moved tool configuration settings to new Config tab
- Moved provider and service settings to new Services tab
- Added visual icons to settings tabs using theme symbols for improved UI clarity
- Changed default settings tab from Behavior to Display on startup
- Updated `read` tool to handle directory paths by returning formatted listings with modification times instead of redirecting to `ls`
- Updated tool documentation to reflect that `read` now handles both files and directories
- Updated system prompt tool precedence section to conditionally display only available specialized tools based on enabled settings
- Renamed todo completion settings from `todoCompletion.*` to `todos.reminders.*` and `todos.enabled` for clearer organization
- Updated todo reminder logic to check both `todos.reminders` and `todos.enabled` settings independently

### Removed

- Removed Rust-analyzer specific LSP operations: `flycheck`, `expand_macro`, `ssr`, `runnables`, `related_tests`, and `reload_workspace`
- Removed `workspace_diagnostics` action; use `diagnostics` without file parameter instead
- Removed `workspace_symbols` action; use `symbols` with query parameter and no file instead
- Removed `actions`, `incoming_calls`, and `outgoing_calls` LSP operations
- Removed `replacement`, `kind`, `action_index`, `end_line`, and `end_character` parameters from LSP tool
- Removed Python prelude helper functions: `pwd()`, `mkdir()`, `ls()`, `head()`, `tail()`, `sh()`, `cat()`, `touch()`, `wc()`, `basenames()`, and `batch()`
- Removed type guard functions (`isBashToolResult`, `isReadToolResult`, `isEditToolResult`, `isWriteToolResult`, `isGrepToolResult`, `isFindToolResult`, `isLsToolResult`) from public API exports
- Removed `ls` tool—directory listing is now handled by the `read` tool
- Removed `ls.enabled` setting and related configuration options
- Removed `bashInterceptor.simpleLs` setting that redirected simple `ls` commands to the dedicated tool
- Removed project tree snapshot generation from system prompt (unused feature)

### Fixed

- Fixed tool parameter schemas displaying internal TypeBox metadata fields in system prompt

## [10.2.1] - 2026-02-02

### Breaking Changes

- Removed `strippedRedirect` field from `NormalizedCommand` interface returned by `normalizeBashCommand()`
- Removed automatic stripping of `2>&1` stderr redirections from bash command normalization

## [10.1.0] - 2026-02-01

### Added

- Added work scheduling profiler to debug menu for analyzing CPU scheduling patterns over the last 30 seconds
- Added support for work profile data in report bundles including folded stacks, summary, and flamegraph visualization

## [10.0.0] - 2026-02-01

### Added

- Added `shell` subcommand for interactive shell console testing with brush-core
- Added `--cwd` / `-C` option to set working directory for shell commands
- Added `--timeout` / `-t` option to configure per-command timeout in milliseconds
- Added `--no-snapshot` option to skip sourcing snapshot from user shell

### Fixed

- `find` now returns a single match when given a file path instead of failing with "not a directory"

## [9.8.0] - 2026-02-01

### Breaking Changes

- Removed persistent shell session support; bash execution now uses native bindings via brush-core for improved reliability

### Added

- Added `sessionKey` option to bash executor to isolate shell sessions per agent instance
- Added shell snapshot support for bash execution to preserve shell state across commands
- Added `onChunk` callback support for streaming command output in real-time

### Changed

- Refactored bash executor to queue output chunks asynchronously for improved reliability
- Updated bash executor to pass environment variables separately as `sessionEnv` to native bindings
- Migrated system information collection to use native bindings from brush-core instead of shell command execution
- Updated CPU information to report core count alongside model name
- Simplified OS version reporting to use Node.js built-in APIs
- Migrated bash command execution from ptree-based persistent sessions to native shell bindings with streaming support
- Simplified bash executor to use brush-core native API instead of managing long-lived shell processes
- Routed clipboard copy and image paste through native arboard bindings instead of shell commands
- Embedded native addon payload for compiled binaries and extract to `~/.gjc/natives/<version>` on first run

### Removed

- Removed shell configuration from environment information display
- Removed `shell-session.ts` module providing persistent shell session management
- Removed shell session test suite for persistent execution patterns

## [9.6.2] - 2026-02-01

### Changed

- Replaced hardcoded ellipsis strings with Unicode ellipsis character (…) throughout rendering code
- Removed `format.ellipsis` symbol from theme configuration; ellipsis now uses literal Unicode character
- Updated `truncate()` function to `truncateToWidth()` with simplified API accepting default ellipsis parameter
- Simplified `formatMoreItems()` function signature by removing theme parameter dependency

### Removed

- Removed `format.ellipsis` symbol key from theme symbol maps (Unicode, Nerd, and ASCII presets)
- Removed `ellipsis` property from `SymbolTheme` type

## [9.6.1] - 2026-02-01

### Fixed

- Fixed output handling to prioritize text/markdown over text/plain when both are available, ensuring Markdown content is displayed correctly
- Fixed bash command normalization to preserve newlines in heredocs and multiline commands

## [9.6.0] - 2026-02-01

### Breaking Changes

- Replaced `SettingsManager` class with new `Settings` singleton providing sync get/set API with background persistence
- Changed settings access from method calls (e.g., `getTheme()`) to path-based access (e.g., `settings.get("theme")`)
- Removed `settingsManager` parameter from `CreateAgentSessionOptions` in favor of `settingsInstance`
- Removed `loadSettings()` export from public API
- Removed example file `examples/sdk/10-settings.ts` demonstrating old SettingsManager API

### Added

- New `Settings` singleton class with sync get/set operations and background persistence
- Added `Settings.isolated()` factory for creating isolated settings instances in tests
- Added `Settings.init()` for initializing global settings instance
- Added `settings` global export for convenient access to settings singleton
- New `settings-schema.ts` providing unified, type-safe settings definitions with UI metadata
- Added "none" option to `doubleEscapeAction` setting to disable double-escape behavior entirely ([#973](https://github.com/badlogic/pi-mono/issues/973) by [@juanibiapina](https://github.com/juanibiapina))

### Changed

- Unified settings schema into single source of truth with `settings-schema.ts` replacing scattered definitions
- Refactored settings CLI to use new schema-based path resolution instead of SETTINGS_DEFS
- Updated config command examples to use new nested path syntax (e.g., `compaction.enabled` instead of `autoCompact`)
- Changed `InteractiveModeContext.settingsManager` to `InteractiveModeContext.settings`
- Updated all internal settings access throughout codebase to use new `settings.get()` and `settings.set()` API
- Moved `DEFAULT_BASH_INTERCEPTOR_RULES` from settings-manager to bash-interceptor module

### Removed

- Deleted `settings-manager.ts` (2035 lines) - functionality replaced by new Settings singleton
- Removed `SettingsManager.create()`, `SettingsManager.acquire()`, and `SettingsManager.inMemory()` factory methods
- Removed individual getter/setter methods from settings API (e.g., `getTheme()`, `setTheme()`, `getCompactionSettings()`)

### Fixed

- Respect .gitignore, .ignore, and .fdignore files when scanning package resources for skills, prompts, themes, and extensions

## [9.5.1] - 2026-02-01

### Changed

- Changed persistent shell from opt-out to opt-in (default: off) for improved reliability; enable via Settings > Bash > Persistent shell or `GJC_SHELL_PERSIST=1`
- Added new "Bash" settings tab grouping shell-related settings (force basic shell, persistent shell, interceptor, intercept ls)

## [9.5.0] - 2026-02-01

### Added

- Added `head` and `tail` parameters to bash tool to limit output lines without breaking streaming
- Added automatic normalization of bash commands to extract `| head -n N` and `| tail -n N` patterns into native parameters
- Added `maxResults` parameter to find tool to limit result set at the native layer
- Added context-structure template showing required sections (Goal, Constraints, Existing Code, API Contract) with examples of good vs bad context
- Added explicit dependency test: 'Can agent B write correct code without seeing agent A's output?' to determine sequencing
- Added detailed phased execution pattern with four phases (Foundation, Parallel Implementation, Integration, Dependent Layer) and WASM-to-N-API migration example
- Added table of dependency patterns that must be sequential (API creation before bindings, interface definition before implementation, etc.)
- Added phased execution guidance for migrations and refactors to prevent parallel work on dependent layers
- Added example demonstrating phased execution pattern for porting WASM to N-API with sequential foundation, parallel implementation, integration, and dependent layer phases

### Changed

- Improved find tool performance by delegating mtime-based sorting to native layer instead of post-processing results in JavaScript
- Simplified find tool result processing by removing redundant filesystem stat calls when native metadata is available
- Updated bash tool documentation to recommend using `head` and `tail` parameters instead of piping through head/tail commands
- Updated binary build process to exclude worker files from compilation, reducing binary size
- Modified update mechanism to download and install native addon alongside CLI binary for platform-specific functionality
- Updated find tool to emit streaming match updates via callback, allowing real-time progress feedback during file searches
- Modified find tool to use native match metadata (mtime, fileType) from WASM layer instead of redundant filesystem stats, improving performance
- Restructured Task tool documentation to emphasize context quality and explicit API contracts for subagent success
- Updated task execution guidance to require structured context with Goal, Constraints, Existing Code, and API Contract sections
- Reorganized parallelization rules with explicit dependency patterns and phased execution guidance for migrations
- Clarified that response format requirements must go in schema parameter, never in context descriptions
- Centralized Python runtime resolution into shared `ipy/runtime.ts` module, removing duplicate code from kernel and gateway coordinator

### Removed

- Removed Nushell language server configuration from LSP defaults

### Fixed

- Fixed race condition in shell session where command completion could occur before stream data was fully processed
- Fixed Python gateway spawning console window on Windows by using windowless Python interpreter (pythonw.exe)

## [9.4.0] - 2026-01-31

### Changed

- Migrated environment variable handling to use centralized `getEnv()` and `getEnvApiKey()` utilities from pi-ai package for consistent API key resolution across web search providers and image tools
- Simplified web search error messages to remove provider-specific configuration hints
- Replaced manual space padding with `padding()` utility function from pi-tui across UI components for consistent whitespace handling
- Improved rendering performance for Python cell output by implementing caching in the table and cell results renderers
- Updated task tool documentation to clarify that subagents can access parent conversation context via a searchable file, reducing need to repeat information in context parameter
- Updated plan mode prompt to guide model toward using `edit` tool for incremental plan updates instead of defaulting to `write`

### Removed

- Removed environment variable denylist that blocked API keys from being passed to subprocesses; API keys are now controlled via allowlist only

## [9.3.1] - 2026-01-31

### Added

- Added `getCompactContext()` API to retrieve parent conversation context for subagents, excluding system prompts and tool results
- Added automatic `submit_result` tool injection for subagents with explicit tool lists
- Added `contextFile` parameter to pass parent conversation context to subagent sessions

### Changed

- Updated subagent system prompt to reference parent conversation context file when available
- Enhanced subagent system prompt formatting with clearer backtick notation for tool and parameter names

### Removed

- Removed schema override notification from task summary prompt

## [9.2.5] - 2026-01-31

### Changed

- Clarified that user instructions about delegation override tool-use defaults
- Updated coordinator guidance to emphasize Task tool preference for substantial work with improved emphasis on context window limitations
- Enhanced `context` parameter documentation to require self-contained information for subagents, including file contents and user requirements

## [9.2.4] - 2026-01-31

### Fixed

- Prevented interactive commands from blocking on stdin by redirecting from /dev/null in POSIX and Fish shell sessions

## [9.2.3] - 2026-01-31

### Added

- Persistent shell session support for bash tool with environment variable preservation across commands
- New `shellForceBasic` setting to force bash/sh even if user's default shell is different (default: true)
- New `GJC_SHELL_PERSIST` environment variable to control persistent shell behavior (set to 0 to disable)

### Changed

- Bash tool now reuses a persistent shell session by default on Unix systems for improved performance and state preservation
- Replaced Bun file APIs with Node.js `fs` module for better cross-runtime compatibility
- LSP configuration loading is now synchronous instead of async
- Shell snapshot generation now sanitizes `BASH_ENV` and `ENV` variables to prevent shell exit issues
- Shell snapshot caching now per-shell-binary instead of global to avoid cross-shell contamination
- System prompt restructured with coordinator-specific guidance for parallel task delegation
- Bash tool now reuses a persistent shell session by default on Unix. Set `GJC_SHELL_PERSIST=0` to disable or fall back to per-command execution on Windows/unsupported shells.
- Added a shellForceBasic setting to force bash/sh and keep environment changes across bash commands (default: true).

### Fixed

- Shell snapshots now filter unsafe bash options (onecmd, monitor, restricted) to prevent session exits
- Git branch detection in status line now works synchronously without race conditions
- Shell session initialization properly restores trap handlers and shell functions after command execution
- Sanitized `BASH_ENV`/`ENV` during persistent shell startup and snapshot creation to prevent basic shells from exiting immediately.
- Cached shell snapshots per shell binary to avoid sourcing zsh snapshots in bash sessions.
- Filtered unsafe bash options (onecmd/monitor/restricted) out of shell snapshots to prevent session exits.

## [9.2.2] - 2026-01-31

### Added

- Added grep CLI subcommand (`gjc grep`) for testing pattern matching
- Added fuzzy matching for model resolution with scoring and ranking fallback
- Added 'Open: artifact folder' menu option to debug selector for quick access to session artifacts
- Added Kimi API format setting for selecting between OpenAI and Anthropic formats
- Added OpenAI code and Gemini web search providers with OAuth and grounding support
- Added /debug command with interactive menu for profiling, heap snapshots, session dumps, and diagnostics
- Added configurable ask timeout and notification settings
- Added gitignore-aware project tree scanning with ripgrep integration
- Added project tree visualization to system prompts with configurable depth and entry limits
- Added reset() method to CountdownTimer with integration into HookSelectorComponent
- Added custom message support to AgentSession via promptCustomMessage() method
- Added skill message component for rendering /skill command messages as compact entries
- Added model preference matching system for intelligent model selection based on usage history
- Added designer agent with UI/UX review and accessibility audit capabilities
- Added model-specific edit variant configuration for patch/replace modes
- Added automatic browser opening when stats dashboard starts
- Added model statistics table and TTFT/throughput metrics to stats dashboard
- Added artifact allocation for truncated fetch responses to preserve full content
- Added 30-second timeout to ask tool with auto-selection of recommended option
- Added recommended parameter (0-indexed) to ask tool for specifying default option
- Added JTD to TypeScript converter for rendering schemas in system prompts
- Added tools list to system prompt for better agent awareness
- Added synthetic message flag for system-injected prompts
- Added session compaction enhancements with auto-continue, tool pruning, and remote endpoint support
- Added detection and rendering of missing complete tool warning in subagent output
- Added outline UI components for bordered list containers
- Added macOS NFD normalization and curly quote variant resolution for file paths
- Enhanced session compaction with dynamic token ratio adjustment and improved summary preservation

### Changed

- Simplified find tool API by consolidating path and pattern parameters
- Replaced bulk file loading with streaming for read tool to reduce memory overhead
- Migrated grep and find tools to WASM-based implementation
- Replaced ripgrep-based file listing with glob-based file discovery for project scans
- Updated minimum Bun runtime requirement to >=1.3.7
- Renamed task parameter from output to schema
- Renamed complete tool to submit_result for clarity and consistency
- Improved output preview logic: shows full output for ≤30 lines, truncates to 10 lines for larger output

### Fixed

- Enhanced error reporting with debug stack trace when DEBUG env is set
- Improved OAuth token refresh error handling to distinguish transient vs definitive failures
- Added windowsHide option to child process spawn calls to prevent console windows on Windows
- External edits to config.yml are now preserved when gjc reloads or saves settings
- Exposed LSP server startup errors in session display and logs
- Improved error handling and security in agent storage initialization with restrictive file permissions
- Fixed LSP server display showing unknown when server warmup fails
- Preserved null timeout when user disables ask timeout setting
- Removed incorrect timeout unit conversion logic in cursor, fetch, gemini-image, and ssh tools
- Blocked /fork command while streaming to prevent split session logs

## [9.0.0] - 2026-01-29

### Fixed

- External edits to `config.yml` are now preserved when gjc reloads or saves unrelated settings. Previously, editing config.yml directly (e.g., removing a package from `packages` array) would be silently reverted on next gjc startup when automatic setters like `setLastChangelogVersion()` triggered a save. ([#1046](https://github.com/badlogic/pi-mono/pull/1046) by [@nicobailonMD](https://github.com/nicobailonMD))

## [8.13.0] - 2026-01-29

### Added

- Added `/debug` command with interactive menu for bug report generation:
  - `Report: performance issue` - CPU profiling with reproduction flow
  - `Report: dump session` - Immediate session bundle creation
  - `Report: memory issue` - Heap snapshot with bundle
  - `View: recent logs` - Display last 50 log entries
  - `View: system info` - Show environment details
  - `Clear: artifact cache` - Remove old session artifacts

### Fixed

- Fixed LSP server errors not being visible in `/session` output or logs when startup fails

## [8.12.7] - 2026-01-29

### Fixed

- Fixed LSP servers showing as "unknown" in status display when server warmup fails
- Fixed Read tool loading entire file into memory when offset/limit was specified

## [8.12.2] - 2026-01-28

### Changed

- Replaced ripgrep-based file listing with fs.glob for project scans and find/read tooling

## [8.11.14] - 2026-01-28

### Changed

- Rendered /skill command messages as compact skill entries instead of full prompt text

## [8.8.8] - 2026-01-28

### Added

- Added `/fork` command to create a new session with the exact same state (entries and artifacts) as the current session

### Changed

- Renamed the `complete` tool to `submit_result` for subagent result submission

## [8.6.0] - 2026-01-27

### Added

- Added `plan` model role for specifying the model used by the plan agent
- Added `--plan` CLI flag and `GJC_PLAN_MODEL` environment variable for ephemeral plan model override
- Added plan model selection in model selector UI with PLAN badge

### Changed

- Task tool subagents now execute in-process instead of using worker threads

### Fixed

- Queued skill commands as follow-ups when the agent is already streaming to avoid load failures
- Deduplicated repeated review findings in subagent progress rendering
- Restored MCP proxy tool timeout handling to prevent subagent hangs

## [8.5.0] - 2026-01-27

### Added

- Added subagent support for preloading skill contents into the system prompt instead of listing available skills
- Added session init entries to capture system prompt, task, tools, and output schema for subagent session logs

### Fixed

- Reduced Task tool progress update overhead to keep the UI responsive during high-volume streaming output
- Fixed subagent session logs dropping pre-assistant entries (user/task metadata) before the first assistant response

### Removed

- Removed enter-plan-mode tool

## [8.4.5] - 2026-01-26

### Added

- Model usage tracking to record and retrieve most recently used models
- Model sorting in selector based on usage history

### Changed

- Renamed `head_limit` parameter to `limit` in grep and find tools for consistency
- Added `context` as an alias for the `c` context parameter in grep tool
- Made hidden files inclusion configurable in find tool via `hidden` parameter (defaults to true)
- Added support for reading ignore patterns from .gitignore and .ignore files in find tool

### Fixed

- Respected .gitignore rules when filtering find tool results by glob pattern

## [8.4.2] - 2026-01-25

### Changed

- Clarified and condensed plan mode prompts for improved clarity and consistency

## [8.4.1] - 2026-01-25

### Added

- Added core plan mode with plan file approval workflow and tool gating
- Added plan:// internal URLs for plan file access and subagent plan-mode system prompt
- Added plan mode toggle shortcut with paused status indicator

### Fixed

- Fixed plan reference injection and workflow prompt parameters for plan mode
- Fixed tool downloads hanging on slow/blocked GitHub by adding timeouts and zip extraction fallback
- Fixed missing UI notification when tools are downloaded or installed on demand

## [8.4.0] - 2026-01-25

### Added

- Added extension API to set working/loading messages during streaming
- Added task worker propagation of context files, skills, and prompt templates
- Added subagent option to skip Python preflight checks when Python tooling is unused
- Model field now accepts string arrays for fallback model prioritization

### Changed

- Merged patch application warnings into edit tool diagnostics output
- Cached Python prelude docs for subagent workers to avoid repeated warmups
- Simplified image placeholders inserted on paste to match Anthropic model-style markers

### Fixed

- Rewrote empty or corrupted session files to restore valid headers
- Improved patch applicator ambiguity errors with match previews and overlap detection
- Fixed Task tool agent model resolution to honor comma-separated model lists

## [8.3.0] - 2026-01-25

### Changed

- Added request parameter tracking to LSP tool rendering for better diagnostics visibility
- Added async diff computation and Kitty protocol support to tool execution rendering
- Refactored patch applicator with improved fuzzy matching (7-pass sequence matching with Levenshtein distance) and indentation adjustment
- Added inline rendering flag to bash and fetch tool renderers
- Extracted constants for preview formatting to improve code maintainability
- Exposed mergeCallAndResult and inline rendering options from tools to their wrappers
- Added timeout validation and normalization for tool timeout parameters

### Fixed

- Fixed output block border rendering (bottom-right corner was missing)
- Added background control parameter to output block rendering

## [8.2.2] - 2026-01-24

### Removed

- Removed git utility functions (\_git, git_status, git_diff, git_log, git_show, git_file_at, git_branch, git_has_changes) from IPython prelude

## [8.2.0] - 2026-01-24

### Added

- Added `gjc commit` command to generate conventional commits with changelog updates
- Added agentic commit mode with commit-specific tools and `--legacy` fallback
- Added configurable settings for map-reduce analysis including concurrency, timeout, file thresholds, and token limits
- Added support for excluding YAML lock files (`.lock.yml`, `.lock.yaml`, `-lock.yml`, `-lock.yaml`) from commit analysis
- Added new TUI component library with reusable rendering utilities including code cells, file lists, tree lists, status lines, and output blocks
- Added renderCodeCell component for displaying code with optional output sections, supporting syntax highlighting and status indicators
- Added renderFileList component for rendering file/directory listings with language icons and metadata
- Added renderTreeList component for hierarchical tree-based item rendering with expand/collapse support
- Added renderStatusLine component for standardized tool status headers with icons, descriptions, and metadata
- Added renderOutputBlock component for bordered output containers with structured sections
- Added renderOutputBlock to Bash tool for improved output formatting with status indicators
- Added `--legacy` flag to `gjc commit` for using the deterministic pipeline instead of agentic mode
- Added split commit support to automatically create multiple atomic commits for unrelated changes
- Added git hunk inspection tools for fine-grained diff analysis in commit generation
- Added commit message validation with filler word and meta phrase detection
- Added automatic unicode normalization in commit summaries
- Added real-time progress output to agentic commit mode showing thinking status, tool calls, and completion summary
- Added hunk-level staging support in split commits allowing partial file changes per commit
- Added dependency ordering for split commits ensuring commits are applied in correct sequence
- Added circular dependency detection with validation errors for split commit plans
- Added parallel file analysis with cross-file context awareness via `analyze_files` tool
- Added AGENTS.md context file discovery for commit generation
- Added progress indicators during changelog generation and model resolution
- Added propose_changelog tool for agent-provided changelog entries in agentic commit workflow
- Added fallback commit generation when agentic mode fails, using file pattern analysis and heuristic-based type inference
- Added trivial change detection to automatically classify whitespace-only and import-reorganization commits
- Added support for pre-computed file observations in commit agent to skip redundant analyze_files calls
- Added diff content caching with smart file prioritization to optimize token usage in large changesets
- Added lock file filtering (17 patterns including Cargo.lock, package-lock.json, bun.lock) from commit analysis
- Added changelog deletion support to remove outdated entries via the changelog proposal interface
- Added support for pre-computed changelog entries in commit agent to display existing unreleased sections for potential deletion
- Added `ExistingChangelogEntries` interface to track changelog sections by path for changelog proposal context
- Added conditional `analyze_files` skipping in commit agent when pre-analyzed observations are provided
- Added guidance to commit agent prompts instructing subagents to write files directly instead of returning changes for manual application
- Added mermaid diagram rendering with terminal graphics support (Kitty/iTerm2) for markdown output
- Added renderMermaidToPng utility for converting mermaid code blocks to terminal-displayable PNG images via mmdc CLI
- Added mermaid block extraction with content-addressed hashing for deduplication and cache lookup
- Added background mermaid pre-rendering in assistant messages for responsive diagram display
- Added two-level mermaid caching with pending deduplication to prevent redundant renders
- Added Python kernel session pooling with MAX_KERNEL_SESSIONS limit and automatic eviction of oldest sessions
- Added automatic idle kernel session cleanup timer (5-minute timeout, 30-second interval)
- Added types/assets/index.d.ts for global TypeScript module declarations supporting `.md`, `.py`, and `.wasm?raw` imports
- Added bunfig.toml loader configuration for importing markdown, Python, and WASM files as text modules
- Added color manipulation utilities (hexToHsv, hsvToHex, shiftHue) to pi-utils for accessible theme adjustments
- Added color-blind mode setting for improved accessibility
- Added filesystem error type guards (isEnoent, isEacces, isPerm, isEnotempty, isFsError, hasFsCode) to pi-utils for safe error handling
- Added tarball installation test Dockerfile to validate npm publish/install flow

### Changed

- Changed changelog diff truncation limit to be configurable via settings
- Changed tool result rendering to use new TUI component library across multiple tools (bash, calculator, fetch, find, grep, ls, notebook, python, read, ssh, write, lsp, web search) for consistent output formatting
- Changed Bash tool output rendering to use renderOutputBlock with proper section handling and width-aware truncation
- Changed Python tool output rendering to use renderCodeCell component for code cell display with status indicators
- Changed Read tool output rendering to use renderCodeCell with syntax highlighting and warnings display
- Changed Write tool output rendering to use renderCodeCell for code display with streaming preview support
- Changed Fetch tool output rendering to use renderOutputBlock with metadata and content preview sections
- Changed LSP tool output rendering to use renderStatusLine and renderOutputBlock for structured output display
- Changed Web Search result rendering to use renderOutputBlock with answer, sources, related questions, and metadata sections
- Changed Find, Grep, and Ls tools to use renderFileList and renderTreeList for consistent file/item listing
- Changed Calculator tool result rendering to use renderTreeList for result item display
- Changed Notebook and TodoWrite tools to use new TUI rendering components for consistent output format
- Refactored render-utils to move tree-related utilities to TUI module (getTreeBranch, getTreeContinuePrefix)
- Changed import organization in sdk.ts for consistency
- Changed tool result rendering to merge call and result displays, showing tool arguments (command, pattern, query, path) in result headers for Bash, Calculator, Fetch, Find, Grep, Ls, LSP, Notebook, Read, SSH, TodoWrite, Web Search, and Write tools
- Changed Read tool title to display line range when offset or limit arguments are provided
- Changed worker instantiation to use direct URL import instead of pre-bundled worker files
- Changed `gjc commit` to use agentic mode by default with tool-based git inspection
- Changed agentic commit progress output to show real-time thinking previews and structured tool argument details
- Changed agentic commit progress output to display full multi-line assistant messages and render tool arguments with tree-style formatting for improved readability
- Changed agentic commit progress output to render assistant messages as formatted Markdown with proper word wrapping
- Changed output block border color to reflect state (error, success, warning) for improved visual feedback
- Changed LSP hover rendering to display documentation text before code blocks in both collapsed and expanded views
- Changed Write tool to show streaming preview of content being written with syntax highlighting
- Changed Read tool to display resolved path information when reading from URLs or symlinks
- Changed Calculator tool result display to show both expression and output (e.g., `2+2 = 4`) instead of just the result
- Changed Python tool output to group status information under a labeled section for clearer organization
- Changed SSH tool output to apply consistent styling to non-ANSI output lines
- Changed Todo Write tool to respect expanded/collapsed state and use standard preview limits
- Changed Web Search related questions to respect expanded/collapsed state instead of always showing all items
- Changed empty and error state rendering across multiple tools (Find, Grep, Ls, Notebook, Calculator, Ask) to include consistent status headers
- Changed split commit to support hunk selectors (all, indices, or line ranges) instead of whole-file staging
- Changed `analyze_file` tool to `analyze_files` for batch parallel analysis of multiple files
- Switched agentic commit from auto-generated changelogs to agent-proposed entries with validation and retry logic
- Commit agent now resolves a separate smaller model for commit generation instead of reusing the primary model
- Normalized code formatting and indentation across tool renderers and UI components
- Changed git-file-diff tool to prioritize files by type and respect token budget limits with intelligent truncation
- Changed git-overview tool to filter and report excluded lock files separately from staged files
- Changed analyze-file tool to include file type inference and enriched related files with line counts
- Changed propose-changelog tool to support optional deletion entries for removing existing changelog items
- Changed commit agent to accept pre-computed file observations and format them into session prompts
- Changed changelog skip condition in `applyChangelogProposals` to also check for empty deletions object
- Changed `createCommitTools()` to build tools array incrementally with conditional `analyze_files` inclusion based on `enableAnalyzeFiles` flag
- Changed system prompt guidance to clarify that pre-computed observations prevent redundant `analyze_files` calls
- Removed map-reduce preprocessing phase from commit agent for faster iteration
- Changed commit agent to process full diff text directly instead of pre-computed file observations
- Changed commit agent initialization to load settingsManager, authStorage, modelRegistry, and stagedFiles in parallel
- Changed commit agent prompt to remove pre-computed observations guidance and encourage direct analyze_files usage
- Changed AuthStorage from constructor-based instantiation to async factory method (AuthStorage.create())
- Changed Python kernel resource management with gateway shutdown on session disposal
- Updated TypeScript configuration for better publish-time configuration handling with tsconfig.publish.json
- Updated TypeScript and Bun configuration for monorepo-wide build consistency and reduced boilerplate
- Removed WASM base64 encoding build script; imports now use Bun loader with `wasm?raw` query parameter
- Unified TypeScript checking pipeline with tsgo-based configuration instead of per-package tsconfig.publish.json boilerplate
- Refactored scanDirectoryForSkills to use async/await with concurrent directory scanning via Promise.all
- Improved error logging in settings manager for config file access failures
- Migrated node module imports from named to namespace imports across all packages for consistency with project guidelines
- Improved filesystem error handling in extension loader with additional type guards (isEacces, hasFsCode) for permission and EPERM errors
- Changed model discovery to synchronous file operations for more immediate initialization

### Fixed

- Fixed database busy errors during concurrent access by adding retry logic with exponential backoff when opening storage
- Find tool now rejects searches from root directory and enforces a 5-second timeout on fd operations
- Commit command now exits cleanly with exit code 0 on success
- Handle undefined code parameter in code cell renderer
- Fixed indentation formatting in split-commit tool function signature
- Fixed changelog application to process proposals containing only deletion entries without additions
- Fixed indentation formatting in Python tool output renderer
- Fixed Python kernel resource management with proper timing instrumentation for performance monitoring
- Fixed model discovery to re-check file existence after JSON to YAML migration
- Fixed branch change callbacks in footer component to properly update state after git resolution
- Added guard clause in plugin-settings to prevent null reference when settings list is undefined
- Fixed agent task discovery to support symlinks and improved error handling for file access failures

## [8.0.0] - 2026-01-23

### Added

- Added antigravity provider support for image generation with Google Cloud authentication
- Added support for google-antigravity API credentials in model registry
- Added antigravity-specific request handling with SSE streaming
- Added projectId parameter to antigravity credentials parsing
- Added antigravity provider to preferred image provider selection
- Added list-limit utility for consistent result limiting across tools
- Added output-utils module with tail buffer and artifact allocation helpers
- Added tool-result module for standardized tool result construction
- Added truncation summary options to OutputMetaBuilder for better output tracking
- Added artifact storage system for truncated tool outputs with artifact:// URL protocol
- Added structured output metadata system with fluent OutputMetaBuilder for consistent notices
- Added standardized tool error types (ToolError, MultiError, ToolAbortError) for better error handling
- Added internal URL routing system with protocol handlers:
- `agent://<id>` - access agent output artifacts
- `agent://<id>/<path>` and `agent://<id>?q=<query>` - JSON extraction from agent outputs
- `skill://<name>` and `skill://<name>/<path>` - read skill files and relative paths
- `rule://<name>` - read rule content
- URL resolution includes filesystem path in output for bash/python interop
- Added fetch tool for URL content retrieval with enhanced processing capabilities
- Added `isolated` option to task tool for git worktree execution with automatic patch generation and application
- Added format-prompts script to standardize prompt file formatting

### Changed

- Updated default line limit from 4000 to 3000 lines for output truncation
- Reordered truncation notice to show offset continuation before artifact reference
- Applied meta notice wrapper to all tools in createTools function
- Updated test expectations to reflect new 3000 line limit
- Removed output tool from schema validation test list
- Replaced inline output truncation notices with structured metadata system across all tools
- Updated bash, python, and ssh executors to track detailed output statistics (total lines/bytes vs output lines/bytes)
- Modified artifact storage to use pre-allocated paths instead of inline file writing
- Changed message format to use meta field instead of fullOutputPath for truncation information
- Updated interactive components to display truncation metadata from structured format
- Standardized tool result building with new ToolResultBuilder for consistent metadata handling
- Simplified Python gateway coordination by removing reference counting and client tracking
- Updated Python gateway to use global shared instance instead of per-process coordination
- Modified Python kernel initialization to set working directory and environment per kernel
- Updated interactive status display to show Python and venv paths instead of client count
- Changed system prompt to clarify CHECKPOINT step 0 timing
- Updated Python environment warming to use await instead of void for proper error handling
- Updated interactive mode shutdown to use postmortem.quit instead of process.exit
- Updated bash tool documentation to clarify specialized tool usage
- Updated task tool documentation to escape placeholder syntax in examples
- Updated Python environment warming to use await instead of void for proper error handling
- Updated interactive mode shutdown to use postmortem.quit instead of process.exit
- Updated bash tool documentation to clarify specialized tool usage
- Updated task tool documentation to escape placeholder syntax in examples
- Updated all tools to use structured metadata instead of inline notices for truncation, limits, and diagnostics
- Replaced manual error formatting with ToolError.render() and standardized error handling
- Enhanced bash and python executors to save full output as artifacts when truncated
- Improved abort signal handling across <caution>ith consistent ToolAbortError
- Renamed task parameter from `vars` to `args` throughout task tool interface and updated template rendering to support built-in `{{id}}` and `{{description}}` placeholders
- Simplified todo-write tool by removing active_form parameter, using single content field for task descriptions
- Updated system prompt structure with `<important>` and `<avoid>` tags, clearer critical sections, and standardized whitespace handling
- Renamed web_fetch tool to fetch and removed internal URL handling (use read tool instead)
- Standardized tool parameter names from camelCase to snake_case across edit, grep, python, and todo-write tools
- Unified timeout parameters across all tools with auto-conversion from milliseconds and reasonable clamping (1s-3600s for bash/ssh, 1s-600s for python/gemini-image)
- Simplified web-search tool by removing advanced parameters (`max_tokens`, `model`, `search_domain_filter`, `search_context_size`, `return_related_questions`) and using `recency` instead of `search_recency_filter`
- Restructured tool documentation with standardized `<instruction>`, `<output>`, `<critical>`, and `<avoid>` sections across all 18 tools
- Updated find tool to always sort results by modification time
- Updated bash prompt to use `cwd` parameter instead of `workdir`
- Improved output truncation limits: bash to 50KB/2000 lines, python to 100KB
- Removed model parameter from task and gemini-image tools to use session/provider defaults
- Improved MCP tool name handling with explicit server and tool name properties
- Marked read tool as non-abortable to improve performance
- Converted dynamic imports to static imports in installer and exa tools

### Removed

- Removed output tool (replaced by `agent://` URLs via read tool)
- Removed web_fetch tool (replaced by fetch tool)

### Fixed

- Fixed Python kernel environment initialization for external and shared gateways
- Fixed gateway status reporting to include Python and virtual environment paths
- Fixed inconsistent error formatting across tools by standardizing on ToolError types
- Fixed timeout parameter handling to auto-convert milliseconds to seconds and clamp to reasonable ranges
- Fixed whitespace formatting in json-query.ts comment
- Fixed interactive shutdown to await postmortem cleanup so Python kernel gateways are terminated
- Fixed shared Python gateway reuse across working directories by initializing kernel cwd and env per kernel
- Fixed Python gateway coordination to use a single global gateway without ref counting

## [7.0.0] - 2026-01-21

### Added

- Added usage report deduplication to prevent duplicate account entries
- Added debug logging for usage fetch operations to aid diagnostics
- Added provider sorting in usage display by total usage amount
- Added `isolated` parameter to task tool for running each task in separate git worktrees
- Added git worktree management for isolated task execution with patch generation
- Added patch application system that applies changes only when all patches are valid
- Added working directory information to environment info display
- Added `/usage` command to display provider usage and limits
- Added support for multiple usage providers beyond OpenAI code
- Added usage report caching with configurable TTL
- Added visual usage bars and account aggregation in usage display
- Added `fetchUsageReports()` method to agent session
- Added `output()` function to read task/agent outputs by ID with support for multiple formats and queries
- Added session file support to Python executor for accessing task outputs
- Added support for jq-like queries when reading JSON outputs
- Added offset and limit parameters for reading specific line ranges from outputs
- Added "." and "c" shortcuts to continue agent without sending visible message
- Added debug logging for usage fetch results to aid /usage diagnostics

### Changed

- Updated discoverSkills function to return object with skills property
- Enhanced usage report merging to combine limits and metadata from duplicate accounts
- Improved OAuth credential handling to preserve existing fields when updating
- Removed cd function from Python prelude to encourage using cwd parameter
- Updated task tool to generate and apply patches when running in isolated mode
- Enhanced task tool rendering to display isolated execution status and patch paths
- Updated system prompt structure and formatting for better readability
- Reorganized tool hierarchy and discipline sections
- Added parallel work guidance for task-based workflows
- Enhanced verification and integration methodology sections
- Updated skills and rules formatting for cleaner presentation
- Added stronger emphasis on completeness and quality standards
- Refactored usage tracking from OpenAI code-specific to generic provider system
- Updated usage limit detection to work with multiple provider APIs
- Changed usage cache to use persistent storage instead of in-memory only
- Limited diagnostic messages to 50 items to prevent overwhelming output when processing files with many issues
- Changed `/dump` command to include complete agent context: system prompt, model config, available tools with schemas, and all message types (bash/python executions, custom messages, branch summaries, compaction summaries, file mentions)
- Changed `/dump` format to use YAML instead of JSON for tool schemas and arguments (more readable)

### Fixed

- Fixed TypeScript error in bash executor by properly typing caught exception
- Fixed usage display ordering to show providers with lowest usage first
- Fixed task tool result rendering to show fallback text when no results are available
- Fixed external editor to work properly on Unix systems by correctly handling terminal I/O
- Fixed external editor to show warning message when it fails to open instead of silently failing
- Fixed find tool to properly handle no matches case without treating as error
- Fixed find tool to wait for fd exit so error messages no longer report exit null
- Fixed read tool to properly handle no matches case without treating as error
- Fixed orphaned Python kernel gateway processes not being killed on process exit
- Fixed /usage provider ordering to sort by aggregate usage (most used last)
- Fixed /usage account dedupe to collapse identical accounts using usage metadata

## [6.9.69] - 2026-01-21

### Added

- Added cell-by-cell status tracking with duration and exit code for Python execution
- Added syntax highlighting for Python code in execution display
- Added template system with {{placeholders}} for task tool context
- Added task variables support for filling context placeholders
- Added enhanced task progress display with variable values
- Added concurrent work handling guidance in system prompt
- Added extension system support for user Python execution events
- Added Python mode border color theming across all themes
- Added Python execution indicator to welcome screen help text
- Added `gjc stats` command for viewing AI usage statistics dashboard
- Added support for JSON output and console summary of usage statistics
- Added configurable port option for stats dashboard server
- Added multi-cell Python execution with sequential processing in persistent kernel
- Added cell titles for better Python code organization and debugging
- Added `$` command prefix for user-initiated Python execution in shared kernel
- Added `$$` prefix variant for Python execution excluded from LLM context

### Changed

- Updated Python execution to display cells in bordered blocks with status indicators
- Changed task tool to use template-based context instead of simple concatenation
- Enhanced Python execution component with proper syntax highlighting
- Improved patch applicator to preserve exact indentation when intended
- Updated task tool schema to require vars instead of task field
- Updated Python execution component to use pythonMode theming instead of bashMode
- Enhanced UI helpers to handle pending Python components properly
- Changed Python tool to use `cells` array instead of single `code` parameter
- Renamed `workdir` parameter to `cwd` in Bash and Python tools for consistency
- Updated Python tool to display cell-by-cell output when multiple cells are provided

### Fixed

- Fixed indentation preservation for exact matches and indentation-only patches
- Fixed Python execution status updates to show real-time cell progress
- Fixed indentation adjustment logic to handle edge cases with mixed indentation levels
- Fixed patch indentation normalization for fuzzy matches, tab/space diffs, and ambiguous context alignment

## [6.9.0] - 2026-01-21

### Removed

- Removed Git tool and all related functionality
- Removed voice control and TTS features
- Removed worktree management system
- Removed bundled wt custom command
- Removed voice-related settings and configuration options
- Removed @gajae-code/pi-git-tool dependency

## [6.8.5] - 2026-01-21

### Breaking Changes

- Changed timeout parameter from seconds to milliseconds in Python tool
- Updated PythonExecutorOptions interface to use timeoutMs instead of timeout

### Changed

- Updated default timeout to 30000ms (30 seconds) for Python tool
- Improved streaming output handling and buffer management

## [6.8.4] - 2026-01-21

### Changed

- Updated output sink to properly handle large outputs
- Improved error message formatting in SSH executor
- Updated web fetch timeout bounds and conversion

### Fixed

- Fixed output truncation handling in streaming output
- Fixed timeout handling in web fetch tool
- Fixed async stream dumping in executors

## [6.8.3] - 2026-01-21

### Changed

- Updated keybinding system to normalize key IDs to lowercase
- Changed label edit shortcut from 'l' to 'Shift+L' in tree selector
- Changed output file extension from `.out.md` to `.md` for artifacts

### Removed

- Removed bundled worktree command from custom commands loader

### Fixed

- Fixed keybinding case sensitivity issues by normalizing all key IDs
- Fixed task artifact path handling and simplified file structure

## [6.8.2] - 2026-01-21

### Fixed

- Improved error messages when multiple text occurrences are found by showing line previews and context
- Enhanced patch application to better handle duplicate content in context lines
- Added occurrence previews to help users disambiguate between multiple matches
- Fixed cache invalidation for streaming edits to prevent stale data
- Fixed file existence check for prompt templates directory
- Fixed bash output streaming to prevent premature stream closure
- Fixed LSP client request handling when signal is already aborted
- Fixed git apply operations with stdin input handling

### Security

- Updated Anthropic authentication to handle manual code input securely

## [6.8.1] - 2026-01-20

### Fixed

- Fixed unhandled promise rejection when tool execution fails by adding missing `.catch()` to floating `.finally()` chain in `createAbortablePromise`

## [6.8.0] - 2026-01-20

### Added

- Added streaming abort setting to control edit tool behavior when patch preview fails

### Changed

- Replaced internal logger with @gajae-code/utils logger across all modules
- Updated process spawning to use cspawn and ptree utilities from pi-utils
- Migrated file operations to use async fs/promises and Bun file APIs
- Refactored promise handling to use Promise.withResolvers and utility functions
- Updated timeout and abort handling to use standardized utility functions
- Refactored authentication login method to use OAuthController interface instead of individual callbacks

### Fixed

- Fixed Python package installation to handle async operations properly
- Fixed streaming output truncation to use consistent column limits
- Fixed shell command execution to properly handle process cleanup and timeouts
- Fixed SSH connection management to properly await async operations
- Fixed voice supervisor process cleanup to use proper async handling
- Added automatic regex pattern validation in grep tool to handle invalid patterns by switching to literal mode

### Security

- Updated temporary file cleanup to use secure async removal methods

## [6.7.67] - 2026-01-19

### Added

- Added normative rewrite setting to control tool call argument normalization in session history
- Added read line numbers setting to prepend line numbers to read tool output by default
- Added streaming preview for edit and write tools with spinner animation
- Added automatic anchor derivation for normative patches when anchors not specified

### Changed

- Enhanced edit and write tool renderers to show streaming content preview
- Updated read tool to respect default line numbers setting
- Improved normative patch anchor handling to support undefined anchors

## [6.7.0] - 2026-01-19

### Added

- Normative patch generation to canonicalize edit tool output with tool call argument rewriting for session history
- Patch matching fallback variants: trimmed context, collapsed duplicates, single-line reduction, comment-prefix normalization
- Extended anchor syntax: ellipsis placeholders, `top of file`/`start of file`, `@@ line N`, nested `@@` anchors, space-separated hierarchical contexts
- Relaxed fuzzy threshold fallback and unique substring acceptance for context matching
- Added `--no-title` flag to disable automatic session title generation
- Environment variables for edit tool configuration (GJC_EDIT_VARIANT, GJC_EDIT_FUZZY, GJC_EDIT_FUZZY_THRESHOLD)
- Configurable fuzzy matching threshold setting (0.85 lenient to 0.98 strict)
- Apply-patch mode for edit tool (`edit.patchMode` setting) with create, update, delete, and rename operations
- Added MCP tool caching for faster startup with cached tool definitions

### Changed

- Patch applicator now supports normalized input, implicit context lines, and improved indentation adjustment
- Patch operation schema uses 'op' instead of 'operation' and 'rename' instead of 'moveTo'
- Fuzzy matching tries comment-prefix normalized matches before unicode normalization
- Updated patch prompts with clearer anchor selection rules and verbatim context requirements
- Changed default behavior of read tool to omit line numbers by default
- Changed default edit tool mode to use apply-patch format instead of oldText/newText
- Converted tool implementations from factory functions to class-based architecture
- Refactored edit tool with modular patch architecture (moved from `edit/` to `patch/` module)
- Enhanced patch parsing: unified diff format, patch-envelope patches, nested anchors, multi-file markers
- Improved fuzzy matching with multiple match tracking, ambiguity detection, and out-of-order hunk processing
- Better diff rendering: smarter truncation, optional line numbers, trailing newline preservation
- Improved error messages with hierarchical context display using `>` separator
- Centralized output sanitization in streaming-output module
- Enhanced MCP startup with deferred tool loading and cached fallback

### Fixed

- Patch application handles repeated context blocks, preserves original indentation on fuzzy match
- Ambiguous context matching resolves duplicates using adjacent @@ anchor positioning
- Patch parser handles bare \*\*\* terminators, model hallucination markers, line hint ranges
- Function context matching handles signatures with and without empty parentheses
- Fixed session title generation to respect GJC_NO_TITLE environment variable
- Fixed Python module discovery to use import.meta.dir for ES module compatibility
- Fixed LSP writethrough batching to flush when delete operations complete a batch
- Fixed line number validation, BOM detection, and trailing newline preservation in patches
- Fixed hierarchical context matching and space-separated anchor parsing
- Fixed fuzzy matching to avoid infinite loops when `allowFuzzy` is disabled
- Fixed tool completion logic to only mark tools as complete when streaming is not aborted or in error state
- Fixed MCP tool path formatting to correctly display provider information

## [6.2.0] - 2026-01-19

### Changed

- Improved LSP batching to coalesce formatting and diagnostics for parallel edits
- Updated edit and write tools to support batched LSP operations

### Fixed

- Coalesced LSP formatting/diagnostics for parallel edits so only the final write triggers LSP across touched files

## [6.1.0] - 2026-01-19

### Added

- Added lspmux integration for LSP server multiplexing to reduce startup time and memory usage
- Added LSP tool proxy support for subagent workers
- Updated LSP status command to show lspmux connection state
- Added maxdepth and mindepth parameters to find function for depth-controlled file search
- Added counter function to count occurrences and sort by frequency
- Added basenames function to extract base names from paths

### Changed

- Simplified rust-analyzer default configuration by removing custom initOptions and settings

## [6.0.0] - 2026-01-19

### Added

- Added Cursor and OpenAI code provider OAuth providers
- Added Windows installer bash shell auto-configuration
- Added dedicated TTSR settings tab (separated from Voice/TTS)

### Fixed

- Fixed TTSR abbreviation expansion from TTSR to Time Traveling Stream Rules

## [5.8.0] - 2026-01-19

### Changed

- Updated WASM loading to use streaming for development environments with base64 fallback
- Added scripts directory to published package files

## [5.7.68] - 2026-01-18

### Changed

- Updated WASM loading to use base64-encoded WASM for better compatibility with compiled binaries

### Fixed

- Fixed WASM loading issues in compiled binary builds

## [5.7.67] - 2026-01-18

### Changed

- Replaced external photon-node dependency with vendored WebAssembly implementation
- Updated image processing to use local photon library for better performance

## [5.6.70] - 2026-01-18

### Added

- Added support for loading Python prelude extension modules from user and project directories
- Added automatic discovery of Python modules from `.gjc/modules` and `.pi/modules` directories
- Added prioritized module loading with project-level modules overriding user-level modules

## [5.6.7] - 2026-01-18

### Added

- Added Python shared gateway setting to enable resource-efficient kernel reuse across sessions
- Added Python tool cancellation support with proper timeout and cleanup handling
- Added enhanced Python prelude helpers including file operations, text processing, and Git utilities
- Added Python tool documentation rendering with categorized helper functions
- Added session-scoped Python kernel isolation with workdir-aware session IDs
- Added structured status events for Python prelude functions with TUI rendering
- Added status event display system with operation icons and formatted descriptions
- Added support for rich output using IPython.display.display() in Python tool
- Added setup subcommand to install dependencies for optional features
- Added Python setup component to install Jupyter kernel dependencies
- Added setup command help with component and option documentation
- Added Python tool dependency check in help output
- Added file locking mechanism for shared Python gateway to prevent race conditions
- Added Python gateway status monitoring with URL, PID, client count, and uptime information
- Added comprehensive Git helpers to Python prelude including status, diff, log, show, branch, and file operations
- Added line-based operations to Python prelude including line extraction, deletion, insertion, and pattern matching
- Added automatic categorization system for Python prelude functions with discoverable documentation
- Added enhanced `/status` command display showing Python gateway, LSP servers, and MCP server connections
- Added shared Python gateway coordinator for resource-efficient kernel management across sessions
- Added Python shared gateway setting with session-scoped kernel reuse and fallback behavior
- Added automatic idle shutdown for shared Python gateway after 30 seconds of inactivity
- Added environment filtering for shared Python gateway to exclude sensitive API keys
- Added virtual environment detection and automatic PATH configuration for Python gateway
- Added IPython-backed Python tool with streaming output, image/JSON rendering, and Jupyter kernel gateway integration
- Added Python prelude with 30+ shell-like utility functions for file operations
- Added Python tool exposure settings with session-scoped kernel reuse and fallback behavior
- Added streaming output system with automatic spill-to-disk for large outputs
- Added extension input interception with source metadata and command argument completion
- Added extension command context `compact()` helper plus context usage accessors
- Added ExtensionAPI `setLabel()` for extension and entry labels
- Added startup quiet setting to suppress welcome screen and startup messages
- Added support for auto-discovering APPEND_SYSTEM.md files
- Added support for piped input in non-interactive mode (auto-print mode)
- Added global session listing across all project directories with enhanced search metadata
- Added session fork prompt when resolving sessions from other projects
- Added key hint formatting utilities plus public exports for getShellConfig/getAgentDir/VERSION
- Added bash tool timeout display in tool output
- Added fuzzy text normalization for improved edit diff matching
- Added $@ argument slicing syntax in prompt templates
- Added configurable keybindings for expand tools and dequeue actions
- Added process title update on CLI startup

### Changed

- Updated Python tool description to display categorized helper functions with improved formatting
- Enhanced Python kernel startup to use shared gateway by default for better resource utilization
- Improved Python prelude functions to emit structured status events instead of text output
- Updated agent prompts to use bash tool instead of exec for git operations
- Changed default Python tool mode from ipy-only to both to enable shell execution
- Enhanced Python gateway coordination with Windows environment support and stale process cleanup
- Updated Python prelude functions to emit structured status events instead of text output
- Enhanced Python tool renderer to display status events alongside output
- Improved Python tool output formatting with status event integration
- Improved shared Python gateway coordination with environment validation and stale process cleanup
- Updated Python prelude to rename `bash()` function to `sh()` for consistency
- Changed default Python tool mode from "ipy-only" to "both" to enable both IPython and shell execution
- Enhanced Python gateway metadata tracking to include Python path and virtual environment information
- Improved Python kernel startup to use shared gateway by default for better resource utilization
- Updated Python tool to support proxy execution mode for worker processes
- Enhanced Python kernel availability checking with faster validation
- Optimized Python environment warming to avoid blocking during tool initialization
- Reorganized settings interface into behavior, tools, display, voice, status, lsp, and exa tabs
- Migrated environment variables from PI* to GJC* prefix with automatic migration
- Updated model selector to use TabBar component for provider navigation
- Changed role badges to inverted style with colored backgrounds
- Added support for /models command alias in addition to /model
- Improved error retry detection to include fetch failures
- Enhanced session selector search and overflow handling
- Updated skill command execution to include skill path metadata
- Surfaced loaded prompt templates during initialization
- Updated compaction summarization to use serialized prompt text
- Cleaned up Python prelude `sh()` and `run()` output to only show stdout/stderr without noisy metadata

### Fixed

- Fixed Python kernel cancellation handling and WebSocket cleanup for in-flight executions
- Fixed Python tool session scoping to include workdir and honor sharedGateway settings
- Fixed gist sharing output draining to avoid truncated URLs
- Fixed streaming output byte accounting and UTF-8 decoder flushing
- Fixed Python prelude integration tests to detect virtual environments and cover helper exports
- Fixed Python kernel cancellation/timeout handling and WebSocket close cleanup for in-flight executions
- Fixed Python output byte accounting and UTF-8 decoder flushing in streaming output
- Fixed shared Python gateway coordination (Windows env allowlist, lock staleness, refcount recovery)
- Fixed Python tool session scoping to include workdir and honor sharedGateway settings
- Fixed subagent Python proxy session isolation and cancellation/timeout propagation
- Fixed print-mode cleanup to dispose Python sessions before exit
- Fixed gist share output draining to avoid truncated URLs
- Fixed explore agent tool list to use bash for git operations
- Fixed Python prelude integration tests to detect venv-only Python and cover helper exports

### Security

- Enhanced Python gateway environment filtering to exclude sensitive API keys and Windows system paths

## [5.5.0] - 2026-01-18

### Changed

- Updated task execution guidelines to improve prompt framing and parallelization instructions

## [5.4.2] - 2026-01-16

### Changed

- Updated model resolution to accept pre-serialized settings for better performance
- Improved system prompt guidance for position-addressed vs content-addressed file edits
- Enhanced edit tool documentation with clear use cases for bash alternatives

## [5.3.0] - 2026-01-15

### Changed

- Expanded bash tool guidance to explicitly list appropriate use cases including file operations, build commands, and process management

## [5.2.1] - 2026-01-14

### Fixed

- Fixed stale diagnostic results by tracking diagnostic versions before file sync operations
- Fixed race condition where LSP diagnostics could return outdated results after file modifications

## [5.2.0] - 2026-01-14

### Added

- Added `withLines` parameter to read tool for optional line number output (default: true, cat -n format)

### Changed

- Changed find/grep/ls tool output to render inline without background box for cleaner visual flow

### Fixed

- Fixed task tool abort to return partial results instead of failing (completed tasks preserved, cancelled tasks shown as skipped)
- Fixed TUI crash when bash output metadata lines exceed terminal width on narrow terminals
- Fixed find tool not matching `**/filename` patterns (was incorrectly using `--full-path` for glob depth wildcards)

## [5.1.1] - 2026-01-14

### Fixed

- Fixed clipboard image paste getting stuck on Wayland when no image is present (was falling back to X11 and timing out)

## [5.1.0] - 2026-01-14

### Changed

- Updated light theme colors for WCAG AA compliance (4.5:1 contrast against white background)
- Changed dequeue hint text from "restore" to "edit all queued messages"

### Fixed

- Fixed session selector staying open when current folder has no sessions (shows hint to press Tab)
- Fixed print mode JSON output to emit session header at start
- Fixed "database is locked" SQLite errors when running subagents by serializing settings to workers instead of opening the database
- Fixed `/new` command to create a new session file (previously reused the same file when `--session` was specified)
- Fixed session selector page up/down navigation

## [5.0.1] - 2026-01-12

### Changed

- Replaced wasm-vips with Photon for more stable WASM image processing
- Added graceful fallback to original images when image resizing fails
- Added error handling for image conversion failures in interactive mode to prevent crashes
- Replace wasm-vips with Photon for more stable WASM image processing (fixes worker thread crashes)

## [5.0.0] - 2026-01-12

### Added

- Implemented `xhigh` thinking level for Anthropic models with increased reasoning limits

## [4.8.3] - 2026-01-12

### Changed

- Replace sharp with wasm-vips for cross-platform image processing without native dependencies

## [4.8.0] - 2026-01-12

### Fixed

- Move `sharp` to optional dependencies with all platform binaries to fix arm64 runtime errors

## [4.7.0] - 2026-01-12

### Added

- Add `gjc config` subcommand for managing settings (`list`, `get`, `set`, `reset`, `path`)
- Add `todoCompletion` setting to warn agent when it stops with incomplete todos (up to 3 reminders)
- Add multi-part questions support to `ask` tool via `questions` array parameter

### Changed

- Updated multi-select cursor behavior in `ask` tool to stay on the toggled option instead of jumping to top
- Single-file reads now render inline (e.g., `Read AGENTS.md:23`) instead of tree structure

### Fixed

- Subagent model resolution now respects explicit provider prefix (e.g., `zai/glm-4.7` no longer matches `cerebras/zai-glm-4.7`)
- Auto-compaction now skips to next model candidate when retry delay exceeds 30 seconds

## [4.6.0] - 2026-01-12

### Added

- Add `/skill:name` slash commands for quick skill access (toggle via `skills.enableSkillCommands` setting)
- Add `cwd` to SessionInfo for session list display
- Add custom summarization instructions option in tree selector
- Add Alt+Up (dequeue) to restore all queued messages at once
- Add `shutdownRequested` and `checkShutdownRequested()` for extension-initiated shutdown

### Fixed

- Component `invalidate()` now properly rebuilds content on theme changes
- Force full re-render after returning from external editor

## [4.4.8] - 2026-01-12

### Changed

- Changed review finding priority format from numeric (0-3) to string labels (P0-P3) for clearer severity indication
- Replaced Type.Union with Type.Literal patterns with StringEnum helper across tool schemas for cleaner enum definitions

## [4.4.5] - 2026-01-11

### Changed

- Removed `format: "date-time"` from timestamp type conversion in JTD to JSON Schema transformation
- Reorganized system prompt to display context, environment, and tools sections before discipline guidelines
- Updated system prompt to show file paths more clearly in output
- Improved YAML frontmatter parsing with better error messages including source file information

### Fixed

- Fixed frontmatter parsing to properly report source location when YAML parsing fails

## [4.4.4] - 2026-01-11

### Added

- Added `todo_write` tool for creating and managing structured task lists during coding sessions
- Added persistent todo panel above the editor that displays task progress
- Added `Ctrl+T` keybinding to toggle todo list expansion
- Added grouped display for consecutive Read tool calls, showing multiple file reads in a compact tree view
- Added `todo_write` tool and persistent todo panel above the editor

### Changed

- Changed `Ctrl+Enter` to insert a newline when not streaming (previously `Alt+Enter`)
- Changed `Ctrl+T` from toggling thinking block visibility to toggling todo list expansion
- Changed system prompt to use more direct, field-oriented language with emphasis on verification and assumptions
- Changed temporary model selector keybinding from Ctrl+Y to Alt+P
- Changed expand hint text from "Ctrl+O to expand" to "Ctrl+O for more"
- Changed Read tool result display to hide content by default, showing only file path and status
- Changed `Ctrl+T` to toggle todo panel expansion

### Removed

- Removed `yaml` package dependency in favor of Bun's built-in YAML parser

### Fixed

- Fixed Alt+Enter to insert a newline when not streaming, instead of submitting the message
- Fixed Alt+Enter inserting a new line when not streaming instead of submitting a message
- Fixed Cursor provider to avoid advertising the Edit tool, relying on full-file Write operations instead
- Fixed prompt template loading to strip leading HTML comment metadata blocks

## [4.3.2] - 2026-01-11

### Changed

- Increased default bash output preview from 5 to 10 lines when collapsed
- Updated expanded bash output view to show full untruncated output when available

## [4.3.1] - 2026-01-11

### Changed

- Expanded system prompt with defensive reasoning guidance and assumption checks
- Allowed agent frontmatter to override subagent thinking level, clamped to model capabilities

### Fixed

- Ensured reviewer agents use structured output schemas and include reported findings in task outputs

## [4.3.0] - 2026-01-11

### Added

- Added Cursor provider support with browser-based OAuth authentication
- Added default model configuration for Cursor provider (anthropic-model-sonnet-4-5)
- Added execution bridge for Cursor tool calls including read, ls, grep, write, delete, shell, diagnostics, and MCP operations

### Fixed

- Improved fuzzy matching accuracy for edit operations when file and target have inconsistent indentation patterns

## [4.2.3] - 2026-01-11

### Changed

- Changed default for `hidden` option in find tool from `false` to `true`, now including hidden files by default

### Fixed

- Fixed serialized auth storage initialization so OAuth refreshes in subagents don't crash

## [4.2.2] - 2026-01-11

### Added

- Added persistent cache storage for OpenAI code usage data that survives application restarts
- Added `--no-lsp` to disable LSP tools, formatting, diagnostics, and warmup for a session

### Changed

- Changed `SettingsManager.create()` to be async, requiring `await` when creating settings managers
- Changed `loadSettings()` to be async, requiring `await` when loading settings
- Changed `discoverSkills()` to be async, requiring `await` when discovering skills
- Changed `loadSlashCommands()` to be async, requiring `await` when loading slash commands
- Changed `buildSystemPrompt()` to be async, requiring `await` when building system prompts
- Changed `loadSkills()` to be async, requiring `await` when loading skills
- Changed `loadProjectContextFiles()` to be async, requiring `await` when loading context files
- Changed `getShellConfig()` to be async, requiring `await` when getting shell configuration
- Changed capability provider `load()` methods to be async-only, removing synchronous `loadSync` API
- Updated `plan` agent with enhanced structured planning process, parallel exploration via `explore` agent spawning, and improved output format with examples
- Removed `planner` agent command template, consolidating planning functionality into the `plan` agent

## [4.2.1] - 2026-01-11

### Added

- Added automatic discovery and listing of AGENTS.md files in the system prompt, providing agents with an authoritative list of project-specific instruction files without runtime searching
- Added `planner` built-in agent for comprehensive implementation planning with slow model

### Changed

- Refactored skill discovery to use unified `loadSkillsFromDir` helper across all providers, reducing code duplication
- Updated skill discovery to scan only `skills/*/SKILL.md` entries instead of recursive walks in OpenAI code provider
- Added guidance to Task tool documentation to isolate file scopes when assigning tasks to prevent agent conflicts
- Updated Task tool documentation to emphasize that subagents have no access to conversation history and require all relevant context to be explicitly passed
- Revised task agent prompt to clarify that subagents have full tool access and can make file edits, run commands, and create files
- OpenAI code provider: updated to use bundled system prompt from upstream
- Changed `complete` tool to make `data` parameter optional when aborting, while still requiring it for successful completions
- Skills discovery now scans only `skills/*/SKILL.md` entries instead of recursive walks

### Removed

- Removed `architect-plan`, `implement`, and `implement-with-critic` built-in agent commands

### Fixed

- Fixed editor border rendering glitch after canceling slash command autocomplete
- Fixed login/logout credential path message to reference agent.db
- Removed legacy auth.json file—credentials are stored exclusively in agent.db
- Removed legacy auth.json file—credentials are stored exclusively in agent.db

## [4.2.0] - 2026-01-10

### Added

- Added `/dump` slash command to copy the full session transcript to the clipboard
- Added automatic Nerd Fonts detection for terminals like iTerm, WezTerm, Kitty, Ghostty, and Alacritty to set appropriate symbol preset
- Added `NERD_FONTS` environment variable override (`1` or `0`) to manually control Nerd Fonts symbol preset
- Added Handlebars templating engine for prompt template rendering with `{{arg}}` helper for positional arguments
- Added support for custom share scripts at ~/.gjc/agent/share.ts to replace default GitHub Gist sharing

### Changed

- Changed rules system to use `read` tool for loading rule content instead of dedicated `rulebook` tool
- Separated `/export` and `/dump` commands—`/export` now only exports to HTML file, while `/dump` copies session transcript to clipboard
- Updated `/export` command to no longer accept `--copy` flag (use `/dump` instead)
- Changed prompt template rendering to use Handlebars instead of simple string replacement
- Updated prompt layout optimization to normalize indentation and collapse excessive blank lines
- Changed auth migration to merge credentials per-provider instead of skipping when any credentials exist in database
- Migrated settings and auth credential storage from JSON files to SQLite database (agent.db)
- Updated credential migration message to reference agent.db instead of auth.json
- Renamed Glob tool references to Find tool throughout prompts and documentation
- Updated project context formatting to use XML-style tags for clearer structure
- Refined bash tool guidance to prefer dedicated tools (read/grep/find/ls) over bash for file operations
- Updated system prompt with clearer tone guidelines emphasizing directness and conciseness
- Revised workflow instructions to require explicit planning for non-trivial tasks
- Enhanced verification guidance to prefer external feedback loops like tests and linters
- Added explicit alignment and prohibited behavior sections to improve response quality

### Removed

- Removed `rulebook` tool - rules are now loaded via the `read` tool instead of a dedicated tool

### Fixed

- Fixed message submission lag caused by synchronous history database writes by deferring DB operations with setImmediate

### Security

- Hardened file permissions on agent database directory (700) and database file (600) to restrict access

## [4.1.0] - 2026-01-10

### Added

- Added persistent prompt history with SQLite-backed storage and Ctrl+R search

### Fixed

- Fixed credential blocking logic to correctly check for remaining available credentials instead of always returning true

## [4.0.1] - 2026-01-10

### Added

- Added usage limit error detection to enable automatic credential switching when OpenAI code accounts hit rate limits
- Added OpenAI code usage API integration to proactively check account limits before credential selection
- Added credential backoff tracking to temporarily skip rate-limited accounts during selection
- Multi-credential usage-aware selection for OpenAI code provider OAuth accounts with automatic fallback when rate limits are reached
- Consistent session-to-credential hashing (FNV-1a) for stable credential assignment across sessions
- OpenAI code usage API integration to detect and cache rate limit status per account
- Automatic mid-session credential switching when usage limits are hit

### Changed

- Changed credential selection to use deterministic FNV-1a hashing for consistent session-to-credential mapping
- Changed OAuth credential resolution to try credentials in priority order, skipping blocked ones

## [4.0.0] - 2026-01-10

### Added

- Exported `InteractiveModeOptions` type for programmatic SDK usage
- Exported additional UI components for extensions: `ArminComponent`, `AssistantMessageComponent`, `BashExecutionComponent`, `BranchSummaryMessageComponent`, `CompactionSummaryMessageComponent`, `CustomEditor`, `CustomMessageComponent`, `FooterComponent`, `ExtensionEditorComponent`, `ExtensionInputComponent`, `ExtensionSelectorComponent`, `LoginDialogComponent`, `ModelSelectorComponent`, `OAuthSelectorComponent`, `SessionSelectorComponent`, `SettingsSelectorComponent`, `ShowImagesSelectorComponent`, `ThemeSelectorComponent`, `ThinkingSelectorComponent`, `ToolExecutionComponent`, `TreeSelectorComponent`, `UserMessageComponent`, `UserMessageSelectorComponent`
- Exported `renderDiff`, `truncateToVisualLines`, and related types for extension use
- `setFooter()` and `setHeader()` methods on `ExtensionUIContext` for custom footer/header components
- `setEditorComponent()` method on `ExtensionUIContext` for custom editor components
- `supportsUsageInStreaming` model config option to control `stream_options: { include_usage: true }` behavior
- Terminal setup documentation for Kitty keyboard protocol configuration (Ghostty, wezterm, Windows Terminal)
- Documentation for paid Cloud Code Assist subscriptions via `GOOGLE_CLOUD_PROJECT` env var
- Environment variables reference section in README
- `--no-tools` flag to disable all built-in tools, enabling extension-only setups
- `--no-extensions` flag to disable extension discovery while still allowing explicit `-e` paths
- `blockImages` setting to prevent images from being sent to LLM providers
- `thinkingBudgets` setting to customize token budgets per thinking level
- `PI_SKIP_VERSION_CHECK` environment variable to disable new version notifications at startup
- Anthropic OAuth support via `/login` to authenticate with Anthropic model Pro/Max subscription
- OpenCode Zen provider support via `OPENCODE_API_KEY` env var and `opencode/<model-id>` syntax
- Session picker (`pi -r`) and `--session` flag support searching/resuming by session ID (UUID prefix)
- Session ID forwarding to LLM providers for session-based caching (used by OpenAI code provider for prompt caching)
- `dequeue` keybinding (`Alt+Up`) to restore queued steering/follow-up messages back into the editor
- Pluggable operations for built-in tools enabling remote execution via SSH or other transports (`ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`, `GrepOperations`, `FindOperations`)
- `/model <search>` pre-filters the model selector or auto-selects on exact match; use `provider/model` syntax to disambiguate
- Managed binaries directory (`~/.gjc/bin/`) for fd and rg tools
- `FooterDataProvider` for custom footers with `getGitBranch()`, `getExtensionStatuses()`, and `onBranchChange()`
- `ctx.ui.custom()` accepts `{ overlay: true }` option for floating modal components
- `ctx.ui.getAllThemes()`, `ctx.ui.getTheme(name)`, `ctx.ui.setTheme(name | Theme)` for theme management
- `setActiveTools()` for dynamic tool management
- `setModel()`, `getThinkingLevel()`, `setThinkingLevel()` methods for runtime model and thinking level changes
- `ctx.shutdown()` for requesting graceful shutdown
- `pi.sendUserMessage()` for sending user messages from extensions
- Extension UI dialogs (`select`, `confirm`, `input`) support `timeout` option with live countdown display
- Extension UI dialogs accept optional `AbortSignal` to programmatically dismiss dialogs
- Async extension factories for dynamic imports and lazy-loaded dependencies
- `user_bash` event for intercepting user `!`/`!!` commands
- Built-in renderers used automatically for tool overrides without custom `renderCall`/`renderResult`
- `InteractiveMode`, `runPrintMode()`, `runRpcMode()` exported for building custom run modes
- Copy link button on messages for deep linking to specific entries
- OpenAI code injection info display showing system prompt modifications
- URL parameter support for `leafId` and `targetId` deep linking
- Wayland clipboard support for `/copy` command using wl-copy with xclip/xsel fallback

### Changed

- Bash tool output truncation now recalculates on terminal resize instead of using cached width
- Web search tool headers updated to match Anthropic Code client format for better compatibility
- `discoverSkills()` return type documented as `{ skills: Skill[], warnings: SkillWarning[] }` in SDK docs
- Default model for OpenCode provider changed from `anthropic-model-sonnet-4-5` to `anthropic-model-opus-4-5`
- Terminal color mode detection defaults to truecolor for modern terminals instead of 256color
- System prompt restructured with XML tags and clearer instructions format
- `before_agent_start` event receives `systemPrompt` in the event object and returns `systemPrompt` (full replacement) instead of `systemPromptAppend`
- `discoverSkills()` returns `{ skills: Skill[], warnings: SkillWarning[] }` instead of `Skill[]`
- `ctx.ui.custom()` factory signature changed from `(tui, theme, done)` to `(tui, theme, keybindings, done)`
- `ExtensionRunner.initialize()` signature changed from options object to positional params `(actions, contextActions, commandContextActions?, uiContext?)`

### Fixed

- Wayland clipboard copy (`wl-copy`) no longer blocks when the process doesn't exit promptly
- Empty `--tools` flag now correctly enables all built-in tools instead of disabling them
- Bash tool handles spawn errors gracefully instead of crashing the agent
- Components properly rebuild their content on theme change via `invalidate()` override
- `setTheme()` triggers a full rerender so previously rendered components update with new theme colors
- Session ID updates correctly when branching sessions
- External edits to `settings.json` while pi is running are preserved when pi saves settings
- Default thinking level from settings applies correctly when `enabledModels` is configured
- LM Studio compatibility for OpenAI Responses tool strict mapping
- Symlinked directories in `prompts/` folders are followed when loading prompt templates
- String `systemPrompt` in `createAgentSession()` works as a full replacement instead of having context files and skills appended
- Update notification for bun binary installs shows release download URL instead of npm command
- ESC key works during "Working..." state after auto-retry
- Abort messages show correct retry attempt count
- Antigravity provider returning 429 errors despite available quota
- Malformed thinking text in Gemini/Antigravity responses where thinking content appeared as regular text
- `--no-skills` flag correctly prevents skills from loading in interactive mode
- Overflow-based compaction skips if error came from a different model or was already handled
- OpenAI code provider context window reduced from 400k to 272k tokens to match OpenAI code CLI defaults
- Context overflow detection recognizes `context_length_exceeded` errors
- Key presses no longer dropped when input is batched over SSH
- Clipboard image support works on Alpine Linux and other musl-based distros
- Queued steering/follow-up messages no longer wipe unsent editor input
- OAuth token refresh failure no longer crashes app at startup
- Status bar shows correct git branch when running in a git worktree
- Ctrl+V clipboard image paste works on Wayland sessions
- Extension directories in `settings.json` respect `package.json` manifests

## [3.37.0] - 2026-01-10

### Changed

- Improved bash command display to show relative paths for working directories within the current directory, and hide redundant `cd` prefix when working directory matches current directory

## [3.36.0] - 2026-01-10

### Added

- Added `calc` tool for basic mathematical calculations with support for arithmetic operators, parentheses, and hex/binary/octal literals
- Added support for multiple API credentials per provider with round-robin distribution across sessions
- Added file locking for auth.json to prevent concurrent write corruption
- Added clickable OAuth login URL display in terminal
- Added `workdir` parameter to bash tool to execute commands in a specific directory without requiring `cd` commands

### Changed

- Updated bash tool rendering to display working directory context when `workdir` parameter is used

### Fixed

- Fixed completion notification to only send when interactive mode is in foreground
- Improved completion notification message to include session title when available

## [3.35.0] - 2026-01-09

### Added

- Added retry logic with exponential backoff for auto-compaction failures
- Added fallback to alternative models when auto-compaction fails with the primary model
- Added support for `pi/<role>` model aliases in task tool (e.g., `pi/slow`, `pi/default`)
- Added visual cycle indicator when switching between role models showing available roles
- Added automatic model inheritance for subtasks when parent uses default model
- Added `--` separator in grep tool to prevent pattern interpretation as flags

### Changed

- Changed role model cycling to remember last selected role instead of matching current model
- Changed edit tool to merge call and result displays into single block
- Changed model override behavior to persist in settings when explicitly set via CLI

### Fixed

- Fixed retry-after parsing from error messages supporting multiple header formats (retry-after, retry-after-ms, x-ratelimit-reset)
- Fixed image attachments being dropped when steering/follow-up messages are queued during streaming
- Fixed image auto-resize not applying to clipboard images before sending
- Fixed clipboard image attachments being dropped when steering/follow-up messages are queued while streaming
- Fixed clipboard image attachments ignoring the auto-resize setting before sending

## [3.34.0] - 2026-01-09

### Added

- Added caching for system environment detection to improve startup performance
- Added disk usage information to automatic environment detection in system prompt
- Added `compat` option for SSH hosts to wrap commands in a POSIX shell on Windows systems
- Added automatic working directory handling for PowerShell and cmd.exe on Windows SSH hosts
- Added automatic environment detection to system prompt including OS, distro, kernel, CPU, GPU, shell, terminal, desktop environment, and window manager information
- Added SSH tool with project ssh.json/.ssh.json discovery, persistent connections, and optional sshfs mounts
- Added SSH host OS/shell detection with compat mode and persistent host info cache

### Changed

- Changed GPU detection on Linux to prioritize discrete GPUs (NVIDIA, AMD) over integrated graphics and skip server management adapters
- Changed SSH host info cache to use versioned format for automatic refresh on schema changes
- Changed SSH compat shell detection to actively probe for bash/sh availability on Windows hosts
- Changed SSH tool description to show detected shell type and available commands per host

## [3.33.0] - 2026-01-08

### Added

- Added `env` support in `settings.json` for automatically setting environment variables on startup
- Added environment variable management methods to SettingsManager (get/set/clear)

### Fixed

- Fixed bash output previews to recompute on resize, preventing TUI line width overflow crashes
- Fixed session title generation to retry alternate smol models when the primary model errors or is rate-limited
- Fixed file mentions to resolve extensionless paths and directories, using read tool truncation limits for injected content
- Fixed interactive UI to show auto-read file mention indicators
- Fixed task tool tree rendering to use consistent tree connectors for progress, findings, and results
- Fixed last-branch tree connector symbol in the TUI
- Fixed output tool previews to use compact JSON when outputs are formatted with leading braces

## [3.32.0] - 2026-01-08

### Added

- Added progress indicator when starting LSP servers at session startup
- Added bundled `/init` slash command available by default

### Changed

- Changed LSP server warmup to use a 5-second timeout, falling back to lazy initialization for slow servers

### Fixed

- Fixed Task tool subagent model selection to inherit explicit CLI `--model` overrides

## [3.31.0] - 2026-01-08

### Added

- Added temporary model selection: `Ctrl+Y` opens model selector for session-only model switching (not persisted to settings)
- Added `setModelTemporary()` method to AgentSession for ephemeral model changes
- Added empty Enter to flush queued messages: pressing Enter with empty editor while streaming aborts current stream
- Added auto-chdir to temp directories when starting in home unless `--allow-home` is set
- Added upfront diff parsing and filtering for code review command to exclude lock files, generated code, and binary assets

### Fixed

- Fixed auto-chdir to only use existing directories and fall back to `tmpdir()`
- Added automatic reviewer agent count recommendation based on diff weight and file count
- Added file grouping guidance for parallel review distribution across multiple agents
- Added diff preview mode for large changesets that exceed size thresholds
- Added in-memory session storage implementation for testing and ephemeral sessions
- Added `createToolUIKit` helper to consolidate common UI formatting utilities across tool renderers
- Added configurable bash interceptor rules via `bashInterceptor.patterns` setting for custom command blocking
- Added `bashInterceptor.simpleLs` setting to control interception of bare ls commands
- Added LSP server configuration via external JSON defaults file for easier customization
- Added abort signal propagation to web scrapers for improved cancellation handling
- Added `diagnosticsVersion` tracking to LSP client for more reliable diagnostic polling
- Added 80+ specialized web scrapers for structured content extraction from popular sites including GitHub, GitLab, npm, PyPI, crates.io, Wikipedia, YouTube, Stack Overflow, Hacker News, Reddit, arXiv, PubMed, and many more
- Added site-specific API integrations for package registries (npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages)
- Added scrapers for social platforms (Mastodon, Bluesky, Lemmy, Lobsters, Dev.to, Discourse)
- Added scrapers for academic sources (arXiv, bioRxiv, PubMed, Semantic Scholar, ORCID, CrossRef, IACR)
- Added scrapers for security databases (NVD, OSV, CISA KEV)
- Added scrapers for documentation sites (MDN, Read the Docs, RFC Editor, W3C, SPDX, tldr, cheat.sh)
- Added scrapers for media platforms (YouTube, Vimeo, Spotify, Discogs, MusicBrainz)
- Added scrapers for AI/ML platforms (Hugging Face, Ollama)
- Added scrapers for app stores and marketplaces (VS Code Marketplace, JetBrains Marketplace, Firefox Add-ons, Open VSX, Flathub, F-Droid, Snapcraft)
- Added scrapers for business data (SEC EDGAR, OpenCorporates, CoinGecko)
- Added scrapers for reference sources (Wikipedia, Wikidata, OpenLibrary, Choose a License)

### Changed

- Changed `Ctrl+P` to cycle through role models (slow → default → smol) instead of all available models
- Changed `Shift+Ctrl+P` to cycle role models temporarily (not persisted)
- Changed Extension Control Center to scale with terminal height instead of fixed 25-line limit
- Changed review command to parse git diff upfront and provide structured context to reviewer agents
- Changed session persistence to use structured logging instead of console.error for persistence failures
- Changed find tool to use fd command for .gitignore discovery instead of Bun.Glob for better abort handling
- Changed LSP config loading to only mark overrides when servers are actually defined
- Changed task tool to require explicit task `id` field instead of auto-generating names from agent type
- Changed grep and find tools to use native Bun file APIs instead of Node.js fs module for improved performance
- Changed YouTube scraper to use async command execution with proper stream handling
- Improved rust-analyzer diagnostic polling to use version-based stability detection instead of time-based delays
- Changed theme icons for extension types to use Unicode symbols (✧, ⚒) instead of text abbreviations (SK, TL, MCP)
- Changed task tool to use short CamelCase task IDs instead of agent-based naming (e.g., 'SessionStore' instead of 'explore_0')
- Changed task tool to accept single `agent` parameter at top level instead of per-task agent specification
- Changed reviewer agent to use `complete` tool instead of `submit_review` for finishing reviews
- Changed theme icons for extensions to use Unicode symbols instead of text abbreviations
- Changed LSP file type matching to support exact filename matches in addition to extensions
- Improved rust-analyzer diagnostic polling to use version-based stability detection
- Refactored web-fetch tool to use modular scraper architecture for improved maintainability

### Removed

- Removed `submit_review` tool - reviewers now finish via `complete` tool with structured output

### Fixed

- Fixed session persistence to call fsync before renaming temp file for durability
- Fixed duplicate persistence error logging by tracking whether error was already reported
- Fixed byte counting in task output truncation to correctly handle multi-byte Unicode characters
- Fixed parallel task execution to propagate abort signals and fail fast on first error
- Fixed task worker abort handling to properly clean up on cancellation
- Fixed parallel task execution to fail fast on first error instead of waiting for all workers
- Fixed byte counting in task output truncation to handle multi-byte Unicode characters correctly

## [3.30.0] - 2026-01-07

### Added

- Added environment variable configuration for task limits: `GJC_TASK_MAX_PARALLEL`, `GJC_TASK_MAX_CONCURRENCY`, `GJC_TASK_MAX_OUTPUT_BYTES`, `GJC_TASK_MAX_OUTPUT_LINES`, and `GJC_TASK_MAX_AGENTS_IN_DESCRIPTION`
- Added specialized web-fetch handlers for 50+ platforms including GitHub, GitLab, npm, PyPI, crates.io, Stack Overflow, Wikipedia, arXiv, PubMed, Hacker News, Reddit, Mastodon, Bluesky, and many more
- Added automatic yt-dlp installation for YouTube transcript extraction
- Added YouTube video support with automatic transcript extraction via yt-dlp

### Changed

- Changed task executor to gracefully handle worker termination with proper cleanup and timeout handling

### Fixed

- Fixed Lobsters front page handler to use correct API endpoint (`/hottest.json` instead of invalid `.json`)
- Fixed task worker error handling to prevent hanging on worker crashes, uncaught errors, and unhandled rejections
- Fixed double-stringified JSON output from subagents being returned as escaped strings instead of parsed objects
- Fixed markitdown tool installation to use automatic tool installer instead of requiring manual installation

## [3.25.0] - 2026-01-07

### Added

- Added `complete` tool for structured subagent output with JSON schema validation
- Added `query` parameter to output tool for jq-like JSON querying
- Added `output_schema` parameter to task tool for structured subagent completion
- Added JTD (JSON Type Definition) to JSON Schema converter for schema flexibility
- Added memorable two-word task identifiers (e.g., SwiftFalcon) for better task tracking

### Changed

- Changed task output IDs from `agent_index` format to memorable names for easier reference
- Changed subagent completion flow to require explicit `complete` tool call with retry reminders
- Simplified worker agent system prompt to be more concise and focused

## [3.24.0] - 2026-01-07

### Added

- Added `ToolSession` interface to unify tool creation with session context including cwd, UI availability, and rulebook rules
- Added Bun Worker-based execution for subagent tasks, replacing subprocess spawning for improved performance and event streaming
- Added `toolNames` option to filter which built-in tools are included in agent sessions
- Added `BUILTIN_TOOLS` registry constant for programmatic access to available tool factories
- Added unit tests for `createTools` function covering tool filtering and conditional tool creation

### Changed

- Changed subagent execution from spawning separate `gjc` processes to running in Bun Workers with direct event streaming
- Changed tool factories to accept `ToolSession` parameter instead of separate cwd and options arguments
- Changed `createTools` to return tools as a Map and support conditional tool creation based on session context
- Changed system prompt builder to dynamically generate tool descriptions from the tool registry
- Changed task tool description to be generated from a template with dynamic agent list injection
- Changed tool creation to use a unified `ToolSession` interface instead of separate parameters for cwd, options, and callbacks
- Changed `createTools` to return tools as a Map instead of an array for consistent tool registry access
- Changed system prompt builder to receive tool registry Map for dynamic tool description generation
- Changed subprocess usage tracking to accumulate incrementally from message_end events rather than parsing stored events after completion

### Removed

- Removed `browser` embedded agent from task tool agent discovery
- Removed `recursive` property from agent definitions
- Removed environment variables `GJC_NO_SUBAGENTS`, `GJC_BLOCKED_AGENT`, and `GJC_SPAWNS` for subagent control
- Removed pre-instantiated tool exports (`readTool`, `bashTool`, `editTool`, `writeTool`, `grepTool`, `findTool`, `lsTool`) in favor of factory functions
- Removed `createCodingTools` and `createReadOnlyTools` helper functions
- Removed `codingTools` and `readOnlyTools` convenience exports
- Removed `wrapToolsWithExtensions` function from extensions API
- Removed `hidden` property support from custom tools
- Removed subagent and question custom tool examples

### Fixed

- Fixed memory accumulation in task subprocess by streaming events directly to disk instead of storing in memory
- Fixed session persistence to exclude transient streaming data (partialJson, jsonlEvents) that was causing unnecessary storage bloat
- Fixed createTools respecting explicit tool lists instead of returning all non-hidden tools

## [3.21.0] - 2026-01-06

### Changed

- Switched from local `@gajae-code/ai` to upstream `@gajae-code/ai` package

### Added

- Added `webSearchProvider` setting to override auto-detection priority (Exa > Perplexity > Anthropic)
- Added `imageProvider` setting to override auto-detection priority (OpenRouter > Gemini)
- Added `git.enabled` setting to enable/disable the structured git tool
- Added `offset` and `limit` parameters to Output tool for paginated reading of large outputs
- Added provider fallback chain for web search that tries all configured providers before failing
- Added `SearchProviderError` class with HTTP status for actionable provider error messages
- Added bash interceptor rule to block git commands when structured git tool is enabled
- Added validation requiring `message` parameter for git commit operations (prevents interactive editor)
- Added output ID hints in multi-agent Task results pointing to Output tool for full logs
- Added fuzzy matching support for `all: true` mode in edit tool, enabling replacement of similar text blocks with whitespace differences
- Added `all` parameter to edit tool for replacing all occurrences instead of requiring unique matches
- Added OpenRouter support for image generation when `OPENROUTER_API_KEY` is set
- Added ImageMagick fallback for image processing when sharp module is unavailable
- Added slash commands to the extensions inspector panel for visibility and management
- Added support for file-based slash commands from `commands/` directories
- Added `$ARGUMENTS` placeholder for slash command argument substitution, aligning with Anthropic model and OpenAI code conventions

### Changed

- Refactored tool renderers to be co-located with their respective tool implementations for improved code organization
- Changed web search to try all configured providers in sequence with fallback before reporting errors
- Changed default Anthropic web search model from `anthropic-model-sonnet-4-5-20250514` to `anthropic-model-haiku-4-5`
- Changed read tool to show first 50KB of oversized lines instead of directing users to bash sed
- Changed web_fetch to use `Bun.which()` instead of spawning `which`/`where` for command detection
- Changed web_fetch to check Content-Length header before downloading to reject oversized files early
- Changed generate_image tool to save images to temp files and report paths instead of inline base64
- Changed system prompt with tool usage guidance (ground answers with tools, minimize context, iterate on results)
- Changed Task tool prompt with plan-then-execute guidance and output tool hints
- Changed edit tool success message to report count when replacing multiple occurrences with `all: true`
- Changed default image generation model to `gemini-3-pro-image-preview`
- Changed error message for multiple occurrences to suggest using `all: true` option
- Changed web_fetch tool label from `web_fetch` to `Web Fetch` for improved display
- Changed argument substitution order in slash commands to process positional args ($1, $2) before wildcards ($@, $ARGUMENTS) to prevent re-substitution issues
- Changed image tool name from `gemini_image` to `generate_image` with label `GenerateImage`

### Fixed

- Fixed read tool markitdown truncation message using broken template string (missing `${` around format call)
- Fixed web_fetch URL normalization order to run before special handlers
- Fixed TUI image display for generate_image tool by sourcing images from details.images in addition to content blocks
- Fixed context file preview in inspector panel to display content correctly instead of attempting async file reads
- Fixed Linux ARM64 installs failing on fresh Debian when the `sharp` module is unavailable during session image compression

## [3.20.1] - 2026-01-06

### Fixed

- Fixed find tool failing to match patterns with path separators (e.g., `reports/**`) by enabling full-path matching in fd

### Changed

- Changed multi-task display to show task descriptions instead of agent names when available
- Changed ls tool to show relative modification times (e.g., "2d ago", "just now") for each entry

## [3.20.0] - 2026-01-06

### Added

- Added extensions API with auto-discovery (`.gjc/extensions`) and `--extension`/`-e` loading for custom tools, commands, and lifecycle hooks
- Added prompt templates loaded from global and project `.gjc/prompts` directories with `/template` expansion in the input box
- Built-in provider overrides in `models.json`: override just `baseUrl` to route a built-in provider through a proxy while keeping all its models, or define `models` to fully replace the provider
- Shell commands without context contribution: use `!!command` to execute a bash command that is shown in the TUI and saved to session history but excluded from LLM context. Useful for running commands you don't want the AI to see
- Added VoiceSupervisor class for realtime voice mode using OpenAI Realtime API with continuous mic streaming and semantic VAD turn detection
- Added VoiceController class for steering user input and deciding presentation of assistant responses
- Added echo suppression and noise floor filtering for microphone input during voice playback
- Added fallback transcript handling when realtime assistant produces no tool call or audio output
- Added voice progress notifications that speak partial results after 15 seconds of streaming
- Added platform-specific audio tool detection with helpful installation instructions for missing tools
- Added realtime voice mode using OpenAI gpt-5-realtime with continuous mic streaming, interruptible input, and supervisor-controlled spoken updates
- Added `gemini_image` tool for Gemini Nano Banana image generation when `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) is set
- Added `description` field to task tool for displaying short user-facing summaries in progress output
- Added `getApiKeyForProvider()` method to ModelRegistry for retrieving API keys by provider name
- Added voice settings configuration for transcription model, TTS model, voice, and audio format
- Added shared render utilities module with standardized formatting functions for truncation, byte/token/duration display, and tree rendering
- Added `resolveGjcCommand()` helper to resolve subprocess command from environment or entry point
- Added `/background` (or `/bg`) command to detach UI and continue agent execution in the background
- Added completion notification system with configurable methods (bell, osc99, osc9, auto, off) when agent finishes
- Added `completionNotification` setting to configure how the agent notifies on completion
- Added `GJC_NOTIFICATIONS` environment variable to suppress notifications globally
- Added `/wt` slash command for git worktree management with create, list, merge, remove, status, spawn, and parallel operations
- Added worktree library with collapse strategies (simple, merge-base, rebase) for merging changes between worktrees
- Added worktree session tracking for managing agent tasks across isolated worktrees
- Added structured git tool with safety guards, caching, and GitHub operations
- Added `cycleRoleModels()` method to cycle through configured role-based models in a fixed order with deduplication
- Added language-specific file icons to LSP diagnostics output showing file locations
- Added language-specific file icon to edit tool header display

### Changed

- Changed voice mode toggle from Caps Lock to Ctrl+Y with auto-send on silence behavior
- Changed default TTS model from gpt-4o-mini-tts to tts-1
- Changed voice mode description to reflect realtime input/output with auto-send on silence
- Updated hotkeys help to show Ctrl+Y for voice mode toggle instead of Caps Lock
- Voice mode now uses OpenAI Realtime (gpt-5-realtime) with Ctrl+Y toggle and auto-send on silence
- Updated web search tool to support `auto` as explicit provider option for auto-detection
- Standardized tool result rendering across grep, find, ls, notebook, ask, output, and web search tools with consistent tree formatting and expand hints
- Updated grep and find tool output to display language-specific icons for files and folder icons for directories
- Updated file listing to display language-specific icons based on file extension instead of generic file icons

### Fixed

- Fixed task tool race condition where subprocess stdout events were skipped due to `resolved` flag being set before stream readers finished, causing completed tasks to display "0 tools · 0 tokens"
- `/model` selector now opens instantly instead of waiting for OAuth token refresh. Token refresh is deferred until a model is actually used
- Fixed cross-platform browser opening to work on Windows (via cmd /c start) and fail gracefully when unavailable

## [3.15.1] - 2026-01-05

### Added

- Added 65 new built-in color themes including dark variants (abyss, aurora, cavern, copper, cosmos, eclipse, ember, equinox, lavender, lunar, midnight, nebula, rainforest, reef, sakura, slate, solstice, starfall, swamp, taiga, terminal, tundra, twilight, volcanic), light variants (aurora-day, canyon, cirrus, coral, dawn, dunes, eucalyptus, frost, glacier, haze, honeycomb, lagoon, lavender, meadow, mint, opal, orchard, paper, prism, sand, savanna, soleil, wetland, zenith), and material themes (alabaster, amethyst, anthracite, basalt, birch, graphite, limestone, mahogany, marble, obsidian, onyx, pearl, porcelain, quartz, sandstone, titanium)

### Fixed

- Fixed status line end cap rendering to properly apply background colors and use correct powerline separator characters

## [3.15.0] - 2026-01-05

### Added

- Added spinner type variants (status and activity) with distinct animation frames per symbol preset
- Added animated spinner for task tool progress display during subagent execution
- Added language/file type icons for read tool output with support for 35+ file types
- Added async cleanup registry for graceful session flush on SIGINT, SIGTERM, and SIGHUP signals
- Added subagent token usage aggregation to session statistics and task tool results
- Added streaming NDJSON writer for session persistence with proper backpressure handling
- Added `flush()` method to SessionManager for explicit control over pending write completion
- Added `/exit` slash command to exit the application from interactive mode
- Added fuzzy path matching suggestions when read tool encounters file-not-found errors, showing closest matches using Levenshtein distance
- Added `status.shadowed` symbol for theme customization to properly indicate shadowed extension state
- Added Biome CLI-based linter client as alternative to LSP for more reliable diagnostics
- Added LinterClient interface for pluggable formatter/linter implementations
- Added status line segment editor for arranging and toggling status line components
- Added status line presets (default, minimal, compact, developer, balanced) for quick configuration
- Added status line separator styles (powerline, powerline-thin, arrow, slash, pipe, space)
- Added configurable status line segments including time, hostname, and subagent count
- Added symbol customization via theme overrides for icons, separators, and glyphs
- Added 30+ built-in color themes including Catppuccin, Dracula, Nord, Gruvbox, Tokyo Night, and more
- Added configurable status line with customizable segments, presets, and separators
- Added status line segment editor for arranging and toggling status line components
- Added symbol preset setting to switch between Unicode, Nerd Font, and ASCII glyphs
- Added file size limit (20MB) for image files to prevent memory issues during serialization

### Changed

- Changed `isError` property in tool result events to be optional instead of required
- Changed `SessionManager.open()` and `SessionManager.continueRecent()` to async methods for proper initialization
- Changed session file writes to use atomic rename pattern with fsync for crash-safe persistence
- Changed read tool display to show file type icons and metadata inline with path
- Changed `AgentSession.dispose()` to async method that flushes pending writes before cleanup
- Changed read tool result display to hide content by default with expand hint, showing only metadata until expanded
- Changed diagnostics display to group messages by file with tree structure and severity icons
- Changed diff stats formatting to use colored +/- indicators with slash separators
- Changed session persistence to use streaming writes instead of synchronous file appends for better performance
- Changed read tool to automatically redirect to ls when given a directory path instead of a file
- Changed tool description prompts to be more concise with clearer usage guidelines and structured formatting
- Moved tool description prompts from inline strings to external markdown files in `src/prompts/tools/` directory for better maintainability
- Changed Exa web search provider from MCP protocol to direct REST API for simpler integration
- Changed web search result rendering to handle malformed response data with fallback text display
- Changed compaction prompts to preserve tool outputs, command results, and repository state in context summaries
- Changed init prompt to include runtime/tooling preferences section and improved formatting guidelines
- Changed reviewer prompt to require evidence-backed findings anchored to diff hunks with stricter suggestion block formatting
- Changed system prompt to include explicit core behavior guidelines for task completion and progress updates
- Changed task prompt to emphasize end-to-end task completion and tool verification
- Moved all prompt templates from inline strings to external markdown files in `src/prompts/` directory for better maintainability
- Changed tool result renderers to use structured tree layouts with consistent expand hints and truncation indicators
- Changed grep, find, and ls tools to show scope path and detailed truncation reasons in output
- Changed web search and web fetch result rendering to display structured metadata sections with bounded content previews
- Changed task/subagent progress rendering to use badge-style status labels and structured output sections
- Changed notebook tool to display cell content preview with line counts
- Changed ask tool result to show checkbox-style selection indicators
- Changed output tool to include provenance metadata and content previews for retrieved outputs
- Changed collapsed tool views to show consistent "Ctrl+O to expand" hints with remaining item counts
- Changed Biome integration to use CLI instead of LSP to avoid stale diagnostics issues
- Changed hardcoded UI symbols throughout codebase to use theme-configurable glyphs
- Changed tree drawing characters to use theme-defined box-drawing symbols
- Changed status line rendering to support left/right segment positioning with separators
- Changed hardcoded UI symbols to use theme-configurable glyphs throughout the interface
- Changed tree drawing characters to use theme-defined box-drawing symbols
- Changed CLI image attachments to resize if larger than 2048px (fit within 1920x1080) and convert >2MB images to JPEG

### Removed

- Removed custom renderers for ls, find, and grep tools in favor of generic tool display

### Fixed

- Fixed spinner animation crash when spinner frames array is empty by adding length check
- Fixed session persistence to properly await all queued writes before closing or switching sessions
- Fixed session persistence to truncate oversized content blocks before writing to prevent memory exhaustion
- Fixed extension list and inspector panel to use correct symbols for disabled and shadowed states instead of reusing unrelated status icons
- Fixed token counting for subagent progress to handle different usage object formats (camelCase and snake_case)
- Fixed image file handling by adding 20MB size limit to prevent memory issues during serialization
- Fixed session persistence to truncate oversized entries before writing JSONL to prevent out-of-memory errors

## [3.14.0] - 2026-01-04

### Added

- Added `getUsageStatistics()` method to SessionManager for tracking cumulative token usage and costs across session messages

### Changed

- Changed status line to display usage statistics more efficiently by using centralized session statistics instead of recalculating from entries

## [3.9.1337] - 2026-01-04

### Changed

- Changed default for `lsp.formatOnWrite` setting from `true` to `false`
- Updated status line thinking level display to use emoji icons instead of abbreviated text
- Changed auto-compact indicator from "(auto)" text to icon

### Fixed

- Fixed status line not updating token counts and cost after starting a new session
- Fixed stale diagnostics persisting after file content changes in LSP client

## [3.8.1337] - 2026-01-04

### Added

- Added automatic browser opening after exporting session to HTML
- Added automatic browser opening after sharing session as a Gist

### Fixed

- Fixed session titles not persisting to file when set before first flush

## [3.7.1337] - 2026-01-04

### Added

- Added `EditMatchError` class for structured error handling in edit operations
- Added `utils` module export with `once` and `untilAborted` helper functions
- Added in-memory LSP content sync via `syncContent` and `notifySaved` client methods

### Changed

- Refactored LSP integration to use writethrough callbacks for edit and write tools, improving performance by syncing content in-memory before disk writes
- Simplified FileDiagnosticsResult interface with renamed fields: `diagnostics` → `messages`, `hasErrors` → `errored`, `serverName` → `server`
- Session title generation now triggers before sending the first message rather than after agent work begins

### Fixed

- Fixed potential text decoding issues in bash executor by using streaming TextDecoder instead of Buffer.toString()

## [3.5.1337] - 2026-01-03

### Added

- Added session header and footer output in text mode showing version, model, provider, thinking level, and session ID
- Added Extension Control Center dashboard accessible via `/extensions` command for unified management of all providers and extensions
- Added ability to enable/disable individual extensions with persistent settings
- Added three-column dashboard layout with sidebar tree, extension list, and inspector panel
- Added fuzzy search filtering for extensions in the dashboard
- Added keyboard navigation with Tab to cycle panes, j/k for navigation, Space to toggle, Enter to expand/collapse

### Changed

- Redesigned Extension Control Center from 3-column layout to tabbed interface with horizontal provider tabs and 2-column grid
- Replaced sidebar tree navigation with provider tabs using TAB/Shift+TAB cycling

### Fixed

- Fixed title generation flag not resetting when starting a new session

## [3.4.1337] - 2026-01-03

### Added

- Added Time Traveling Stream Rules (TTSR) feature that monitors agent output for pattern matches and injects rule reminders mid-stream
- Added `ttsr_trigger` frontmatter field for rules to define regex patterns that trigger mid-stream injection
- Added TTSR settings for enabled state, context mode (keep/discard partial output), and repeat mode (once/after-gap)

### Fixed

- Fixed excessive subprocess spawns by caching git status for 1 second in the footer component

## [3.3.1337] - 2026-01-03

### Changed

- Improved `/status` command output formatting to use consistent column alignment across all sections
- Updated version update notification to suggest `gjc update` instead of manual npm install command

## [3.1.1337] - 2026-01-03

### Added

- Added `spawns` frontmatter field for agent definitions to control which sub-agents can be spawned
- Added spawn restriction enforcement preventing agents from spawning unauthorized sub-agents

### Fixed

- Fixed duplicate skill loading when the same SKILL.md file was discovered through multiple paths

## [3.0.1337] - 2026-01-03

### Added

- Added unified capability-based discovery system for loading configuration from multiple AI coding tools (Anthropic Code, Cursor, Windsurf, Gemini, OpenAI code, Cline, GitHub Copilot, VS Code)
- Added support for discovering MCP servers, rules, skills, hooks, tools, slash commands, prompts, and context files from tool-specific config directories
- Added Discovery settings tab in interactive mode to enable/disable individual configuration providers
- Added provider source attribution showing which tool contributed each configuration item
- Added support for Cursor MDC rule format with frontmatter (description, globs, alwaysApply)
- Added support for Windsurf rules from .windsurf/rules/\*.md and global_rules.md
- Added support for Cline rules from .clinerules file or directory
- Added support for GitHub Copilot instructions with applyTo glob patterns
- Added support for Gemini extensions and system.md customization files
- Added support for OpenAI code AGENTS.md and config.toml settings
- Added automatic migration of `PI_*` environment variables to `GJC_*` equivalents for backwards compatibility
- Added multi-path config discovery supporting `.gjc`, `.pi`, and `.anthropic-model` directories with priority ordering
- Added `getConfigDirPaths()`, `findConfigFile()`, and `readConfigFile()` functions for unified config resolution
- Added documentation for config module usage patterns

### Changed

- Changed MCP tool name parsing to use last underscore separator for better server name handling
- Changed /config output to show provider attribution for discovered items
- Renamed CLI binary from `pi` to `gjc` and updated all command references
- Changed config directory from `.pi` to `.gjc` with fallback support for legacy paths
- Renamed environment variables from `PI_*` to `GJC_*` prefix (e.g., `GJC_SMOL_MODEL`, `GJC_SLOW_MODEL`)
- Changed model role alias prefix from `pi/` to `gjc/` (e.g., `gjc/slow` instead of `pi/slow`)

## [2.1.1337] - 2026-01-03

### Added

- Added `gjc update` command to check for and install updates from GitHub releases or via bun

### Changed

- Changed HTML export to use compile-time bundled templates via Bun macros for improved performance
- Changed `exportToHtml` and `exportFromFile` functions to be async
- Simplified build process by embedding assets (themes, templates, agents, commands) directly into the binary at compile time
- Removed separate asset copying steps from build scripts

## [2.0.1337] - 2026-01-03

### Added

- Added shell environment snapshot to preserve user aliases, functions, and shell options when executing bash commands
- Added support for `GJC_BASH_NO_CI`, `GJC_BASH_NO_LOGIN`, and `GJC_SHELL_PREFIX` environment variables for shell customization
- Added zsh support alongside bash for shell detection and configuration

### Changed

- Changed shell detection to prefer user's `$SHELL` when it's bash or zsh, with improved fallback path resolution
- Changed Edit tool to reject `.ipynb` files with guidance to use NotebookEdit tool instead

## [1.500.0] - 2026-01-03

### Added

- Added provider tabs to model selector with Tab/Arrow navigation for filtering models by provider
- Added context menu to model selector for choosing model role (Default, Smol, Slow) instead of keyboard shortcuts
- Added LSP diagnostics display in tool execution output showing errors and warnings after file edits
- Added centralized file logger with daily rotation to `~/.gjc/logs/` for debugging production issues
- Added `logger` property to hook and custom tool APIs for error/warning/debug logging
- Added `output` tool to read full agent/task outputs by ID when truncated previews are insufficient
- Added `task` tool to reviewer agent, enabling parallel exploration of large codebases during reviews
- Added subprocess tool registry for extracting and rendering tool data from subprocess agents in real-time
- Added combined review result rendering showing verdict and findings in a tree structure
- Auto-read file mentions: Reference files with `@path/to/file.ext` syntax in prompts to automatically inject their contents, eliminating manual Read tool calls
- Added `hidden` property for custom tools to exclude them from default tool list unless explicitly requested
- Added `explicitTools` option to `createAgentSession` for enabling hidden tools by name
- Added example review tools (`report_finding`, `submit_review`) with structured findings accumulation and verdict rendering
- Added `/review` example command for interactive code review with branch comparison, uncommitted changes, and commit review modes
- Custom TypeScript slash commands: Create programmable commands at `~/.gjc/agent/commands/[name]/index.ts` or `.gjc/commands/[name]/index.ts`. Commands export a factory returning `{ name, description, execute(args, ctx) }`. Return a string to send as LLM prompt, or void for fire-and-forget actions. Full access to `HookCommandContext` for UI dialogs, session control, and shell execution.
- Anthropic model command directories: Markdown slash commands now also load from `~/.anthropic-model/commands/` and `.anthropic-model/commands/` (parallel to existing `.gjc/commands/` support)
- `commands.enableAnthropic modelUser` and `commands.enableAnthropic modelProject` settings to disable Anthropic model command directory loading
- `/export --copy` option to copy entire session as formatted text to clipboard

### Changed

- Changed model selector keyboard shortcuts from S/L keys to a context menu opened with Enter
- Changed model role indicators from symbols (✓ ⚡ 🧠) to labeled badges ([ DEFAULT ] [ SMOL ] [ SLOW ])
- Changed model list sorting to include secondary sort by model ID within each provider
- Changed silent error suppression to log warnings and debug info for tool errors, theme loading, and command loading failures
- Changed Task tool progress display to show agent index (e.g., `reviewer(0)`) for easier Output tool ID derivation
- Changed Task tool output to only include file paths when Output tool is unavailable, providing Read tool fallback
- Changed Task tool output references to use simpler ID format (e.g., `reviewer_0`) with line/char counts for Output tool integration
- Changed subagent recursion prevention from blanket blocking to same-agent blocking. Non-recursive agents can now spawn other agent types (e.g., reviewer can spawn explore agents) but cannot spawn themselves.
- Changed `/review` command from markdown to interactive TypeScript with mode selection menu (branch comparison, uncommitted changes, commit review, custom)
- Changed bundled commands to be overridable by user/project commands with same name
- Changed subprocess termination to wait for message_end event to capture accurate token counts
- Changed token counting in subprocess to accumulate across messages instead of overwriting
- Updated bundled `reviewer` agent to use structured review tools with priority-based findings (P0-P3) and formal verdict submission
- Task tool now streams artifacts in real-time: input written before spawn, session jsonl written by subprocess, output written at completion

### Removed

- Removed separate Exa error logger in favor of centralized logging system
- Removed `findings_count` parameter from `submit_review` tool - findings are now counted automatically
- Removed artifacts location display from task tool output

### Fixed

- Fixed race condition in event listener iteration by copying array before iteration to prevent mutation during callbacks
- Fixed potential memory leak from orphaned abort controllers by properly aborting existing controllers before replacement
- Fixed stream reader resource leak by adding proper `releaseLock()` calls in finally blocks
- Fixed hook API methods throwing clear errors when handlers are not initialized instead of silently failing
- Fixed LSP client race conditions with concurrent client creation and file operations using proper locking
- Fixed Task tool progress display showing stale data by cloning progress objects before passing to callbacks
- Fixed Task tool missing final progress events by waiting for readline to close before resolving
- Fixed RPC mode race condition with concurrent prompt commands by serializing execution
- Fixed pre-commit hook race condition causing `index.lock` errors when GitKraken/IDE git integrations detect file changes during formatting
- Fixed Task tool output artifacts (`out.md`) containing duplicated text from streaming updates
- Fixed Task tool progress display showing repeated nearly-identical lines during streaming
- Fixed Task tool subprocess model selection ignoring agent's configured model and falling back to settings default. The `--model` flag now accepts `provider/model` format directly.
- Fixed Task tool showing "done + succeeded" when aborted; now correctly displays "⊘ aborted" status

## [1.341.0] - 2026-01-03

### Added

- Added interruptMode setting to control when queued messages are processed during tool execution.
- Implemented getter and setter methods in SettingsManager for interrupt mode persistence.
- Exposed interruptMode configuration in interactive settings UI with immediate/wait options.
- Wired interrupt mode through AgentSession and SDK to enable runtime configuration.
- Model roles: Configure different models for different purposes (default, smol, slow) via `/model` selector
- Model selector key bindings: Enter sets default, S sets smol, L sets slow, Escape closes
- Model selector shows role markers: ✓ for default, ⚡ for smol, 🧠 for slow
- `pi/<role>` model aliases in Task tool agent definitions (e.g., `model: pi/smol, haiku, flash, mini`)
- Smol model auto-discovery using priority chain: haiku > flash > mini
- Slow model auto-discovery using priority chain: gpt-5.2-openai-code > openai-code > gpt > opus > pro
- CLI args for model roles: `--smol <model>` and `--slow <model>` (ephemeral, not persisted)
- Env var overrides: `GJC_SMOL_MODEL` and `GJC_SLOW_MODEL`
- Title generation now uses configured smol model from settings
- LSP diagnostics on edit: Edit tool can now return LSP diagnostics after editing code files. Disabled by default to avoid noise during multi-edit sequences. Enable via `lsp.diagnosticsOnEdit` setting.
- LSP workspace diagnostics: New `lsp action=workspace_diagnostics` command checks the entire project for errors. Auto-detects project type and uses appropriate checker (rust-analyzer/cargo for Rust, tsc for TypeScript, go build for Go, pyright for Python).
- LSP local binary resolution: LSP servers installed in project-local directories are now discovered automatically. Checks `node_modules/.bin/` for Node.js projects, `.venv/bin/`/`venv/bin/` for Python projects, and `vendor/bundle/bin/` for Ruby projects before falling back to `$PATH`.
- LSP format on write: Write tool now automatically formats code files using LSP after writing. Uses the language server's built-in formatter (e.g., rustfmt for Rust, gofmt for Go). Controlled via `lsp.formatOnWrite` setting (enabled by default).
- LSP diagnostics on write: Write tool now returns LSP diagnostics (errors/warnings) after writing code files. This gives immediate feedback on syntax errors and type issues. Controlled via `lsp.diagnosticsOnWrite` setting (enabled by default).
- LSP server warmup at startup: LSP servers are now started at launch to avoid cold-start delays when first writing files.
- LSP server status in welcome banner: Shows which language servers are active and ready.
- Edit fuzzy match setting: Added `edit.fuzzyMatch` setting (enabled by default) to control whether the edit tool accepts high-confidence fuzzy matches for whitespace/indentation differences. Toggle via `/settings`.
- Multi-server LSP diagnostics: Diagnostics now query all applicable language servers for a file type. For TypeScript/JavaScript projects with Biome, this means both type errors (from tsserver) and lint errors (from Biome) are reported together.
- Comprehensive LSP server configurations for 40+ languages including Rust, Go, Python, Java, Kotlin, Scala, Haskell, OCaml, Elixir, Ruby, PHP, C#, Lua, Nix, and many more. Each server includes sensible defaults for args, settings, and init options.
- Extended LSP config file search paths: Now searches for `lsp.json`, `.lsp.json` in project root and `.gjc/` subdirectory, plus user-level configs in `~/.gjc/` and home directory.

### Changed

- LSP settings moved to dedicated "LSP" tab in `/settings` for better organization
- Improved grep tool description to document pagination options (`headLimit`, `offset`) and clarify recursive search behavior
- LSP idle timeout now disabled by default. Configure via `idleTimeoutMs` in lsp.json to auto-shutdown inactive servers.
- Model settings now use role-based storage (`modelRoles` map) instead of single `defaultProvider`/`defaultModel` fields. Supports multiple model roles (default, small, etc.)
- Session model persistence now uses `"provider/modelId"` string format with optional role field

### Fixed

- Recent sessions now show in welcome banner (was never wired up).
- Auto-generated session titles: Sessions are now automatically titled based on the first message using a small model (Haiku/GPT-4o-mini/Flash). Titles are shown in the terminal window title, recent sessions list, and --resume picker. The resume picker shows title with dimmed first message preview below.

## [1.340.0] - 2026-01-03

### Changed

- Replaced vendored highlight.js and marked.js with CDN-hosted versions for smaller exports
- Added runtime minification for HTML, CSS, and JS in session exports
- Session share URL now uses gistpreview.github.io instead of shittycodingagent.ai

## [1.339.0] - 2026-01-03

### Added

- MCP project config setting to disable loading `.mcp.json`/`mcp.json` from project root
- Support for both `mcp.json` and `.mcp.json` filenames (prefers `mcp.json` if both exist)
- Automatic Exa MCP server filtering with API key extraction for native integration

## [1.338.0] - 2026-01-03

### Added

- Bash interceptor setting to block shell commands that have dedicated tools (disabled by default, enable via `/settings`)

### Changed

- Refactored settings UI to declarative definitions for easier maintenance
- Shell detection now respects `$SHELL` environment variable before falling back to bash/sh
- Tool binary detection now uses `Bun.which()` instead of spawning processes

### Fixed

- CLI help text now accurately lists all default tools

## [1.337.1] - 2026-01-02

### Added

- MCP support and plugin system for external tool integration
- Git context to system prompt for repo awareness
- Bash interception to guide tool selection
- Fuzzy matching to handle indentation variance in edit tool
- Specialized Exa tools with granular toggles
- `/share` command for exporting conversations to HTML
- Edit diff preview before tool execution

### Changed

- Renamed package scope to @gajae-code for consistent branding
- Simplified toolset and enhanced navigation
- Improved process cleanup with tree kill
- Updated CI/CD workflows for GitHub Actions with provenance-signed npm publishing

### Fixed

- Template string interpolation in image read output
- Prevented full re-renders during write tool streaming
- Edit tool failing on files with UTF-8 BOM

## [1.337.0] - 2026-01-02

Initial release under @gajae-code scope. See previous releases at [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## [0.31.1] - 2026-01-02

### Fixed

- Model selector no longer allows negative index when pressing arrow keys before models finish loading ([#398](https://github.com/badlogic/pi-mono/pull/398) by [@mitsuhiko](https://github.com/mitsuhiko))
- Type guard functions (`isBashToolResult`, etc.) now exported at runtime, not just in type declarations ([#397](https://github.com/badlogic/pi-mono/issues/397))

## [0.31.0] - 2026-01-02

This release introduces session trees for in-place branching, major API changes to hooks and custom tools, and structured compaction with file tracking.

### Session Tree

Sessions now use a tree structure with `id`/`parentId` fields. This enables in-place branching: navigate to any previous point with `/tree`, continue from there, and switch between branches while preserving all history in a single file.

**Existing sessions are automatically migrated** (v1 → v2) on first load. No manual action required.

New entry types: `BranchSummaryEntry` (context from abandoned branches), `CustomEntry` (hook state), `CustomMessageEntry` (hook-injected messages), `LabelEntry` (bookmarks).

See [docs/session.md](docs/session.md) for the file format and `SessionManager` API.

### Hooks Migration

The hooks API has been restructured with more granular events and better session access.

**Type renames:**

- `HookEventContext` → `HookContext`
- `HookCommandContext` is now a new interface extending `HookContext` with session control methods

**Event changes:**

- The monolithic `session` event is now split into granular events: `session_start`, `session_before_switch`, `session_switch`, `session_before_branch`, `session_branch`, `session_before_compact`, `session_compact`, `session_shutdown`
- `session_before_switch` and `session_switch` events now include `reason: "new" | "resume"` to distinguish between `/new` and `/resume`
- New `session_before_tree` and `session_tree` events for `/tree` navigation (hook can provide custom branch summary)
- New `before_agent_start` event: inject messages before the agent loop starts
- New `context` event: modify messages non-destructively before each LLM call
- Session entries are no longer passed in events. Use `ctx.sessionManager.getEntries()` or `ctx.sessionManager.getBranch()` instead

**API changes:**

- `pi.send(text, attachments?)` → `pi.sendMessage(message, triggerTurn?)` (creates `CustomMessageEntry`)
- New `pi.appendEntry(customType, data?)` for hook state persistence (not in LLM context)
- New `pi.registerCommand(name, options)` for custom slash commands (handler receives `HookCommandContext`)
- New `pi.registerMessageRenderer(customType, renderer)` for custom TUI rendering
- New `ctx.isIdle()`, `ctx.abort()`, `ctx.hasQueuedMessages()` for agent state (available in all events)
- New `ctx.ui.editor(title, prefill?)` for multi-line text editing with Ctrl+G external editor support
- New `ctx.ui.custom(component)` for full TUI component rendering with keyboard focus
- New `ctx.ui.setStatus(key, text)` for persistent status text in footer (multiple hooks can set their own)
- New `ctx.ui.theme` getter for styling text with theme colors
- `ctx.exec()` moved to `pi.exec()`
- `ctx.sessionFile` → `ctx.sessionManager.getSessionFile()`
- New `ctx.modelRegistry` and `ctx.model` for API key resolution

**HookCommandContext (slash commands only):**

- `ctx.waitForIdle()` - wait for agent to finish streaming
- `ctx.newSession(options?)` - create new sessions with optional setup callback
- `ctx.branch(entryId)` - branch from a specific entry
- `ctx.navigateTree(targetId, options?)` - navigate the session tree

These methods are only on `HookCommandContext` (not `HookContext`) because they can deadlock if called from event handlers that run inside the agent loop.

**Removed:**

- `hookTimeout` setting (hooks no longer have timeouts; use Ctrl+C to abort)
- `resolveApiKey` parameter (use `ctx.modelRegistry.getApiKey(model)`)

See [docs/hooks.md](docs/hooks.md) and [examples/hooks/](examples/hooks/) for the current API.

### Custom Tools Migration

The custom tools API has been restructured to mirror the hooks pattern with a context object.

**Type renames:**

- `CustomAgentTool` → `CustomTool`
- `ToolAPI` → `CustomToolAPI`
- `ToolContext` → `CustomToolContext`
- `ToolSessionEvent` → `CustomToolSessionEvent`

**Execute signature changed:**

```typescript
// Before (v0.30.2)
execute(toolCallId, params, signal, onUpdate)

// After
execute(toolCallId, params, onUpdate, ctx, signal?)
```

The new `ctx: CustomToolContext` provides `sessionManager`, `modelRegistry`, `model`, and agent state methods:

- `ctx.isIdle()` - check if agent is streaming
- `ctx.hasQueuedMessages()` - check if user has queued messages (skip interactive prompts)
- `ctx.abort()` - abort current operation (fire-and-forget)

**Session event changes:**

- `CustomToolSessionEvent` now only has `reason` and `previousSessionFile`
- Session entries are no longer in the event. Use `ctx.sessionManager.getBranch()` or `ctx.sessionManager.getEntries()` to reconstruct state
- Reasons: `"start" | "switch" | "branch" | "tree" | "shutdown"` (no separate `"new"` reason; `/new` triggers `"switch"`)
- `dispose()` method removed. Use `onSession` with `reason: "shutdown"` for cleanup

See [docs/custom-tools.md](docs/custom-tools.md) and [examples/custom-tools/](examples/custom-tools/) for the current API.

### SDK Migration

**Type changes:**

- `CustomAgentTool` → `CustomTool`
- `AppMessage` → `AgentMessage`
- `sessionFile` returns `string | undefined` (was `string | null`)
- `model` returns `Model | undefined` (was `Model | null`)
- `Attachment` type removed. Use `ImageContent` from `@gajae-code/ai` instead. Add images directly to message content arrays.

**AgentSession API:**

- `branch(entryIndex: number)` → `branch(entryId: string)`
- `getUserMessagesForBranching()` returns `{ entryId, text }` instead of `{ entryIndex, text }`
- `reset()` → `newSession(options?)` where options has optional `parentSession` for lineage tracking
- `newSession()` and `switchSession()` now return `Promise<boolean>` (false if cancelled by hook)
- New `navigateTree(targetId, options?)` for in-place tree navigation

**Hook integration:**

- New `sendHookMessage(message, triggerTurn?)` for hook message injection

**SessionManager API:**

- Method renames: `saveXXX()` → `appendXXX()` (e.g., `appendMessage`, `appendCompaction`)
- `branchInPlace()` → `branch()`
- `reset()` → `newSession(options?)` with optional `parentSession` for lineage tracking
- `createBranchedSessionFromEntries(entries, index)` → `createBranchedSession(leafId)`
- `SessionHeader.branchedFrom` → `SessionHeader.parentSession`
- `saveCompaction(entry)` → `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?)`
- `getEntries()` now excludes the session header (use `getHeader()` separately)
- `getSessionFile()` returns `string | undefined` (undefined for in-memory sessions)
- New tree methods: `getTree()`, `getBranch()`, `getLeafId()`, `getLeafEntry()`, `getEntry()`, `getChildren()`, `getLabel()`
- New append methods: `appendCustomEntry()`, `appendCustomMessageEntry()`, `appendLabelChange()`
- New branch methods: `branch(entryId)`, `branchWithSummary()`

**ModelRegistry (new):**

`ModelRegistry` is a new class that manages model discovery and API key resolution. It combines built-in models with custom models from `models.json` and resolves API keys via `AuthStorage`.

```typescript
import { discoverAuthStorage, discoverModels } from "@gajae-code/coding-agent";

const authStorage = discoverAuthStorage(); // ~/.gjc/agent/auth.json
const modelRegistry = discoverModels(authStorage); // + ~/.gjc/agent/models.json

// Get all models (built-in + custom)
const allModels = modelRegistry.getAll();

// Get only models with valid API keys
const available = await modelRegistry.getAvailable();

// Find specific model
const model = modelRegistry.find("anthropic", "anthropic-model-sonnet-4-20250514");

// Get API key for a model
const apiKey = await modelRegistry.getApiKey(model);
```

This replaces the old `resolveApiKey` callback pattern. Hooks and custom tools access it via `ctx.modelRegistry`.

**Renamed exports:**

- `messageTransformer` → `convertToLlm`
- `SessionContext` alias `LoadedSession` removed

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/) for the current API.

### RPC Migration

**Session commands:**

- `reset` command → `new_session` command with optional `parentSession` field

**Branching commands:**

- `branch` command: `entryIndex` → `entryId`
- `get_branch_messages` response: `entryIndex` → `entryId`

**Type changes:**

- Messages are now `AgentMessage` (was `AppMessage`)
- `prompt` command: `attachments` field replaced with `images` field using `ImageContent` format

**Compaction events:**

- `auto_compaction_start` now includes `reason` field (`"threshold"` or `"overflow"`)
- `auto_compaction_end` now includes `willRetry` field
- `compact` response includes full `CompactionResult` (`summary`, `firstKeptEntryId`, `tokensBefore`, `details`)

See [docs/rpc.md](docs/rpc.md) for the current protocol.

### Structured Compaction

Compaction and branch summarization now use a structured output format:

- Clear sections: Goal, Progress, Key Information, File Operations
- File tracking: `readFiles` and `modifiedFiles` arrays in `details`, accumulated across compactions
- Conversations are serialized to text before summarization to prevent the model from "continuing" them

The `before_compact` and `before_tree` hook events allow custom compaction implementations. See [docs/compaction.md](docs/compaction.md).

### Interactive Mode

**`/tree` command:**

- Navigate the full session tree in-place
- Search by typing, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press `l` to label entries as bookmarks
- Selecting a branch switches context and optionally injects a summary of the abandoned branch

**Entry labels:**

- Bookmark any entry via `/tree` → select → `l`
- Labels appear in tree view and persist as `LabelEntry`

**Theme changes (breaking for custom themes):**

Custom themes must add these new color tokens or they will fail to load:

- `selectedBg`: background for selected/highlighted items in tree selector and other components
- `customMessageBg`: background for hook-injected messages (`CustomMessageEntry`)
- `customMessageText`: text color for hook messages
- `customMessageLabel`: label color for hook messages (the `[customType]` prefix)

Total color count increased from 46 to 50. See [docs/theme.md](docs/theme.md) for the full color list and copy values from the built-in dark/light themes.

**Settings:**

- `enabledModels`: allowlist models in `settings.json` (same format as `--models` CLI)

### Added

- `ctx.ui.setStatus(key, text)` for hooks to display persistent status text in the footer ([#385](https://github.com/badlogic/pi-mono/pull/385) by [@prateekmedia](https://github.com/prateekmedia))
- `ctx.ui.theme` getter for styling status text and other output with theme colors
- `/share` command to upload session as a secret GitHub gist and get a shareable URL via shittycodingagent.ai ([#380](https://github.com/badlogic/pi-mono/issues/380))
- HTML export now includes a tree visualization sidebar for navigating session branches ([#375](https://github.com/badlogic/pi-mono/issues/375))
- HTML export supports keyboard shortcuts: Ctrl+T to toggle thinking blocks, Ctrl+O to toggle tool outputs
- HTML export supports theme-configurable background colors via optional `export` section in theme JSON ([#387](https://github.com/badlogic/pi-mono/pull/387) by [@mitsuhiko](https://github.com/mitsuhiko))
- HTML export syntax highlighting now uses theme colors and matches TUI rendering
- **Snake game example hook**: Demonstrates `ui.custom()`, `registerCommand()`, and session persistence. See [examples/hooks/snake.ts](examples/hooks/snake.ts).
- **`thinkingText` theme token**: Configurable color for thinking block text. ([#366](https://github.com/badlogic/pi-mono/pull/366) by [@paulbettner](https://github.com/paulbettner))

### Changed

- **Entry IDs**: Session entries now use short 8-character hex IDs instead of full UUIDs
- **API key priority**: `ANTHROPIC_OAUTH_TOKEN` now takes precedence over `ANTHROPIC_API_KEY`
- HTML export template split into separate files (template.html, template.css, template.js) for easier maintenance

### Fixed

- HTML export now properly sanitizes user messages containing HTML tags like `<style>` that could break DOM rendering
- Crash when displaying bash output containing Unicode format characters like U+0600-U+0604 ([#372](https://github.com/badlogic/pi-mono/pull/372) by [@HACKE-RC](https://github.com/HACKE-RC))
- **Footer shows full session stats**: Token usage and cost now include all messages, not just those after compaction. ([#322](https://github.com/badlogic/pi-mono/issues/322))
- **Status messages spam chat log**: Rapidly changing settings (e.g., thinking level via Shift+Tab) would add multiple status lines. Sequential status updates now coalesce into a single line. ([#365](https://github.com/badlogic/pi-mono/pull/365) by [@paulbettner](https://github.com/paulbettner))
- **Toggling thinking blocks during streaming shows nothing**: Pressing Ctrl+T while streaming would hide the current message until streaming completed.
- **Resuming session resets thinking level to off**: Initial model and thinking level were not saved to session file, causing `--resume`/`--continue` to default to `off`. ([#342](https://github.com/badlogic/pi-mono/issues/342) by [@aliou](https://github.com/aliou))
- **Hook `tool_result` event ignores errors from custom tools**: The `tool_result` hook event was never emitted when tools threw errors, and always had `isError: false` for successful executions. Now emits the event with correct `isError` value in both success and error cases. ([#374](https://github.com/badlogic/pi-mono/issues/374) by [@nicobailon](https://github.com/nicobailon))
- **Edit tool fails on Windows due to CRLF line endings**: Files with CRLF line endings now match correctly when LLMs send LF-only text. Line endings are normalized before matching and restored to original style on write. ([#355](https://github.com/badlogic/pi-mono/issues/355) by [@Pratham-Dubey](https://github.com/Pratham-Dubey))
- **Edit tool fails on files with UTF-8 BOM**: Files with UTF-8 BOM marker could cause "text not found" errors since the LLM doesn't include the invisible BOM character. BOM is now stripped before matching and restored on write. ([#394](https://github.com/badlogic/pi-mono/pull/394) by [@prathamdby](https://github.com/prathamdby))
- **Use bash instead of sh on Unix**: Fixed shell commands using `/bin/sh` instead of `/bin/bash` on Unix systems. ([#328](https://github.com/badlogic/pi-mono/pull/328) by [@dnouri](https://github.com/dnouri))
- **OAuth login URL clickable**: Made OAuth login URLs clickable in terminal. ([#349](https://github.com/badlogic/pi-mono/pull/349) by [@Cursivez](https://github.com/Cursivez))
- **Improved error messages**: Better error messages when `apiKey` or `model` are missing. ([#346](https://github.com/badlogic/pi-mono/pull/346) by [@ronyrus](https://github.com/ronyrus))
- **Session file validation**: `findMostRecentSession()` now validates session headers before returning, preventing non-session JSONL files from being loaded
- **Compaction error handling**: `generateSummary()` and `generateTurnPrefixSummary()` now throw on LLM errors instead of returning empty strings
- **Compaction with branched sessions**: Fixed compaction incorrectly including entries from abandoned branches, causing token overflow errors. Compaction now uses `sessionManager.getPath()` to work only on the current branch path, eliminating 80+ lines of duplicate entry collection logic between `prepareCompaction()` and `compact()`
- **enabledModels glob patterns**: `--models` and `enabledModels` now support glob patterns like `github-copilot/*` or `*sonnet*`. Previously, patterns were only matched literally or via substring search. ([#337](https://github.com/badlogic/pi-mono/issues/337))

## [0.30.2] - 2025-12-26

### Changed

- **Consolidated migrations**: Moved auth migration from `AuthStorage.migrateLegacy()` to new `migrations.ts` module.

## [0.30.1] - 2025-12-26

### Fixed

- **Sessions saved to wrong directory**: In v0.30.0, sessions were being saved to `~/.gjc/agent/` instead of `~/.gjc/agent/sessions/<encoded-cwd>/`, breaking `--resume` and `/resume`. Misplaced sessions are automatically migrated on startup. ([#320](https://github.com/badlogic/pi-mono/issues/320) by [@aliou](https://github.com/aliou))
- **Custom system prompts missing context**: When using a custom system prompt string, project context files (AGENTS.md), skills, date/time, and working directory were not appended. ([#321](https://github.com/badlogic/pi-mono/issues/321))

## [0.30.0] - 2025-12-25

### Breaking Changes

- **SessionManager API**: The second parameter of `create()`, `continueRecent()`, and `list()` changed from `agentDir` to `sessionDir`. When provided, it specifies the session directory directly (no cwd encoding). When omitted, uses default (`~/.gjc/agent/sessions/<encoded-cwd>/`). `open()` no longer takes `agentDir`. ([#313](https://github.com/badlogic/pi-mono/pull/313))

### Added

- **`--session-dir` flag**: Use a custom directory for sessions instead of the default `~/.gjc/agent/sessions/<encoded-cwd>/`. Works with `-c` (continue) and `-r` (resume) flags. ([#313](https://github.com/badlogic/pi-mono/pull/313) by [@scutifer](https://github.com/scutifer))
- **Reverse model cycling and model selector**: Shift+Ctrl+P cycles models backward, Ctrl+L opens model selector (retaining text in editor). ([#315](https://github.com/badlogic/pi-mono/pull/315) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.29.1] - 2025-12-25

### Added

- **Automatic custom system prompt loading**: GJC now auto-loads `SYSTEM.md` files to replace the default system prompt. Project-local `.gjc/SYSTEM.md` takes precedence over global `~/.gjc/agent/SYSTEM.md`. CLI `--system-prompt` flag overrides both. ([#309](https://github.com/badlogic/pi-mono/issues/309))
- **Unified `/settings` command**: New settings menu consolidating thinking level, theme, queue mode, auto-compact, show images, hide thinking, and collapse changelog. Replaces individual `/thinking`, `/queue`, `/theme`, `/autocompact`, and `/show-images` commands. ([#310](https://github.com/badlogic/pi-mono/issues/310))

### Fixed

- **Custom tools/hooks with typebox subpath imports**: Fixed jiti alias for `@sinclair/typebox` to point to package root instead of entry file, allowing imports like `@sinclair/typebox/compiler` to resolve correctly. ([#311](https://github.com/badlogic/pi-mono/issues/311) by [@kim0](https://github.com/kim0))

## [0.29.0] - 2025-12-25

### Breaking Changes

- **Renamed `/clear` to `/new`**: The command to start a fresh session is now `/new`. Hook event reasons `before_clear`/`clear` are now `before_new`/`new`. Merry Christmas [@mitsuhiko](https://github.com/mitsuhiko)! ([#305](https://github.com/badlogic/pi-mono/pull/305))

### Added

- **Auto-space before pasted file paths**: When pasting a file path (starting with `/`, `~`, or `.`) after a word character, a space is automatically prepended. ([#307](https://github.com/badlogic/pi-mono/pull/307) by [@mitsuhiko](https://github.com/mitsuhiko))
- **Word navigation in input fields**: Added Ctrl+Left/Right and Alt+Left/Right for word-by-word cursor movement. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))
- **Full Unicode input**: Input fields now accept Unicode characters beyond ASCII. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))

### Fixed

- **Readline-style Ctrl+W**: Now skips trailing whitespace before deleting the preceding word, matching standard readline behavior. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))

## [0.28.0] - 2025-12-25

### Changed

- **Credential storage refactored**: API keys and OAuth tokens are now stored in `~/.gjc/agent/auth.json` instead of `oauth.json` and `settings.json`. Existing credentials are automatically migrated on first run. ([#296](https://github.com/badlogic/pi-mono/issues/296))

- **SDK API changes** ([#296](https://github.com/badlogic/pi-mono/issues/296)):
  - Added `AuthStorage` class for credential management (API keys and OAuth tokens)
  - Added `ModelRegistry` class for model discovery and API key resolution
  - Added `discoverAuthStorage()` and `discoverModels()` discovery functions
  - `createAgentSession()` now accepts `authStorage` and `modelRegistry` options
  - Removed `configureOAuthStorage()`, `defaultGetApiKey()`, `findModel()`, `discoverAvailableModels()`
  - Removed `getApiKey` callback option (use `AuthStorage.setRuntimeApiKey()` for runtime overrides)
  - Use `getModel()` from `@gajae-code/ai` for built-in models, `modelRegistry.find()` for custom models + built-in models
  - See updated [SDK documentation](docs/sdk.md) and [README](README.md)

- **Settings changes**: Removed `apiKeys` from `settings.json`. Use `auth.json` instead. ([#296](https://github.com/badlogic/pi-mono/issues/296))

### Fixed

- **Duplicate skill warnings for symlinks**: Skills loaded via symlinks pointing to the same file are now silently deduplicated instead of showing name collision warnings. ([#304](https://github.com/badlogic/pi-mono/pull/304) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.27.9] - 2025-12-24

### Fixed

- **Model selector and --list-models with settings.json API keys**: Models with API keys configured in settings.json (but not in environment variables) now properly appear in the /model selector and `--list-models` output. ([#295](https://github.com/badlogic/pi-mono/issues/295))

## [0.27.8] - 2025-12-24

### Fixed

- **API key priority**: OAuth tokens now take priority over settings.json API keys. Previously, an API key in settings.json would trump OAuth, causing users logged in with a plan (unlimited tokens) to be billed via PAYG instead.

## [0.27.7] - 2025-12-24

### Fixed

- **Thinking tag leakage**: Fixed Anthropic model mimicking literal `</thinking>` tags in responses. Unsigned thinking blocks (from aborted streams) are now converted to plain text without `<thinking>` tags. The TUI still displays them as thinking blocks. ([#302](https://github.com/badlogic/pi-mono/pull/302) by [@nicobailon](https://github.com/nicobailon))

## [0.27.6] - 2025-12-24

### Added

- **Compaction hook improvements**: The `before_compact` session event now includes:
  - `previousSummary`: Summary from the last compaction (if any), so hooks can preserve accumulated context
  - `messagesToKeep`: Messages that will be kept after the summary (recent turns), in addition to `messagesToSummarize`
  - `resolveApiKey`: Function to resolve API keys for any model (checks settings, OAuth, env vars)
  - Removed `apiKey` string in favor of `resolveApiKey` for more flexibility

- **SessionManager API cleanup**:
  - Renamed `loadSessionFromEntries()` to `buildSessionContext()` (builds LLM context from entries, handling compaction)
  - Renamed `loadEntries()` to `getEntries()` (returns defensive copy of all session entries)
  - Added `buildSessionContext()` method to SessionManager

## [0.27.5] - 2025-12-24

### Added

- **HTML export syntax highlighting**: Code blocks in markdown and tool outputs (read, write) now have syntax highlighting using highlight.js with theme-aware colors matching the TUI.
- **HTML export improvements**: Render markdown server-side using marked (tables, headings, code blocks, etc.), honor user's chosen theme (light/dark), add image rendering for user messages, and style code blocks with TUI-like language markers. ([@scutifer](https://github.com/scutifer))

### Fixed

- **Ghostty inline images in tmux**: Fixed terminal detection for Ghostty when running inside tmux by checking `GHOSTTY_RESOURCES_DIR` env var. ([#299](https://github.com/badlogic/pi-mono/pull/299) by [@nicobailon](https://github.com/nicobailon))

## [0.27.4] - 2025-12-24

### Fixed

- **Symlinked skill directories**: Skills in symlinked directories (e.g., `~/.gjc/agent/skills/my-skills -> /path/to/skills`) are now correctly discovered and loaded.

## [0.27.3] - 2025-12-24

### Added

- **API keys in settings.json**: Store API keys in `~/.gjc/agent/settings.json` under the `apiKeys` field (e.g., `{ "apiKeys": { "anthropic": "sk-..." } }`). Settings keys take priority over environment variables. ([#295](https://github.com/badlogic/pi-mono/issues/295))

### Fixed

- **Allow startup without API keys**: Interactive mode no longer throws when no API keys are configured. Users can now start the agent and use `/login` to authenticate. ([#288](https://github.com/badlogic/pi-mono/issues/288))
- **`--system-prompt` file path support**: The `--system-prompt` argument now correctly resolves file paths (like `--append-system-prompt` already did). ([#287](https://github.com/badlogic/pi-mono/pull/287) by [@scutifer](https://github.com/scutifer))

## [0.27.2] - 2025-12-23

### Added

- **Skip conversation restore on branch**: Hooks can return `{ skipConversationRestore: true }` from `before_branch` to create the branched session file without restoring conversation messages. Useful for checkpoint hooks that restore files separately. ([#286](https://github.com/badlogic/pi-mono/pull/286) by [@nicobarray](https://github.com/nicobarray))

## [0.27.1] - 2025-12-22

### Fixed

- **Skill discovery performance**: Skip `node_modules` directories when recursively scanning for skills. Fixes ~60ms startup delay when skill directories contain npm dependencies.

### Added

- **Startup timing instrumentation**: Set `GJC_TIMING=1` to see startup performance breakdown (interactive mode only).

## [0.27.0] - 2025-12-22

### Breaking

- **Session hooks API redesign**: Merged `branch` event into `session` event. `BranchEvent`, `BranchEventResult` types and `pi.on("branch", ...)` removed. Use `pi.on("session", ...)` with `reason: "before_branch" | "branch"` instead. `AgentSession.branch()` returns `{ cancelled }` instead of `{ skipped }`. `AgentSession.reset()` and `switchSession()` now return `boolean` (false if cancelled by hook). RPC commands `reset`, `switch_session`, and `branch` now include `cancelled` in response data. ([#278](https://github.com/badlogic/pi-mono/issues/278))

### Added

- **Session lifecycle hooks**: Added `before_*` variants (`before_switch`, `before_clear`, `before_branch`) that fire before actions and can be cancelled with `{ cancel: true }`. Added `shutdown` reason for graceful exit handling. ([#278](https://github.com/badlogic/pi-mono/issues/278))

### Fixed

- **File tab completion display**: File paths no longer get cut off early. Folders now show trailing `/` and removed redundant "directory"/"file" labels to maximize horizontal space. ([#280](https://github.com/badlogic/pi-mono/issues/280))

- **Bash tool visual line truncation**: Fixed bash tool output in collapsed mode to use visual line counting (accounting for line wrapping) instead of logical line counting. Now consistent with bash-execution.ts behavior. Extracted shared `truncateToVisualLines` utility. ([#275](https://github.com/badlogic/pi-mono/issues/275))

## [0.26.1] - 2025-12-22

### Fixed

- **SDK tools respect cwd**: Core tools (bash, read, edit, write, grep, find, ls) now properly use the `cwd` option from `createAgentSession()`. Added tool factory functions (`createBashTool`, `createReadTool`, etc.) for SDK users who specify custom `cwd` with explicit tools. ([#279](https://github.com/badlogic/pi-mono/issues/279))

## [0.26.0] - 2025-12-22

### Added

- **SDK for programmatic usage**: New `createAgentSession()` factory with full control over model, tools, hooks, skills, session persistence, and settings. Philosophy: "omit to discover, provide to override". Includes 12 examples and comprehensive documentation. ([#272](https://github.com/badlogic/pi-mono/issues/272))

- **Project-specific settings**: Settings now load from both `~/.gjc/agent/settings.json` (global) and `<cwd>/.gjc/settings.json` (project). Project settings override global with deep merge for nested objects. Project settings are read-only (for version control). ([#276](https://github.com/badlogic/pi-mono/pull/276))

- **SettingsManager static factories**: `SettingsManager.create(cwd?, agentDir?)` for file-based settings, `SettingsManager.inMemory(settings?)` for testing. Added `applyOverrides()` for programmatic overrides.

- **SessionManager static factories**: `SessionManager.create()`, `SessionManager.open()`, `SessionManager.continueRecent()`, `SessionManager.inMemory()`, `SessionManager.list()` for flexible session management.

## [0.25.4] - 2025-12-22

### Fixed

- **Syntax highlighting stderr spam**: Fixed cli-highlight logging errors to stderr when markdown contains malformed code fences (e.g., missing newlines around closing backticks). Now validates language identifiers before highlighting and falls back silently to plain text. ([#274](https://github.com/badlogic/pi-mono/issues/274))

## [0.25.3] - 2025-12-21

### Added

- **Gemini 3 preview models**: Added `gemini-3-pro-preview` and `gemini-3-flash-preview` to the google-gemini-cli provider. ([#264](https://github.com/badlogic/pi-mono/pull/264) by [@LukeFost](https://github.com/LukeFost))

- **External editor support**: Press `Ctrl+G` to edit your message in an external editor. Uses `$VISUAL` or `$EDITOR` environment variable. On successful save, the message is replaced; on cancel, the original is kept. ([#266](https://github.com/badlogic/pi-mono/pull/266) by [@aliou](https://github.com/aliou))

- **Process suspension**: Press `Ctrl+Z` to suspend gjc and return to the shell. Resume with `fg` as usual. ([#267](https://github.com/badlogic/pi-mono/pull/267) by [@aliou](https://github.com/aliou))

- **Configurable skills directories**: Added granular control over skill sources with `enableOpenAI codeUser`, `enableAnthropic modelUser`, `enableAnthropic modelProject`, `enablePiUser`, `enablePiProject` toggles, plus `customDirectories` and `ignoredSkills` settings. ([#269](https://github.com/badlogic/pi-mono/pull/269) by [@nicobailon](https://github.com/nicobailon))

- **Skills CLI filtering**: Added `--skills <patterns>` flag for filtering skills with glob patterns. Also added `includeSkills` setting and glob pattern support for `ignoredSkills`. ([#268](https://github.com/badlogic/pi-mono/issues/268))

## [0.25.2] - 2025-12-21

### Fixed

- **Image shifting in tool output**: Fixed an issue where images in tool output would shift down (due to accumulating spacers) each time the tool output was expanded or collapsed via Ctrl+O.

## [0.25.1] - 2025-12-21

### Fixed

- **Gemini image reading broken**: Fixed the `read` tool returning images causing flaky/broken responses with Gemini models. Images in tool results are now properly formatted per the Gemini API spec.

- **Tab completion for absolute paths**: Fixed tab completion producing `//tmp` instead of `/tmp/`. Also fixed symlinks to directories (like `/tmp`) not getting a trailing slash, which prevented continuing to tab through subdirectories.

## [0.25.0] - 2025-12-20

### Added

- **Interruptible tool execution**: Queuing a message while tools are executing now interrupts the current tool batch. Remaining tools are skipped with an error result, and your queued message is processed immediately. Useful for redirecting the agent mid-task. ([#259](https://github.com/badlogic/pi-mono/pull/259) by [@steipete](https://github.com/steipete))

- **Google Gemini CLI OAuth provider**: Access Gemini 2.0/2.5 models for free via Google Cloud Code Assist. Login with `/login` and select "Google Gemini CLI". Uses your Google account with rate limits.

- **Google Antigravity OAuth provider**: Access Gemini 3, Anthropic model (sonnet/opus thinking models), and GPT-OSS models for free via Google's Antigravity sandbox. Login with `/login` and select "Antigravity". Uses your Google account with rate limits.

### Changed

- **Model selector respects --models scope**: The `/model` command now only shows models specified via `--models` flag when that flag is used, instead of showing all available models. This prevents accidentally selecting models from unintended providers. ([#255](https://github.com/badlogic/pi-mono/issues/255))

### Fixed

- **Connection errors not retried**: Added "connection error" to the list of retryable errors so Anthropic connection drops trigger auto-retry instead of silently failing. ([#252](https://github.com/badlogic/pi-mono/issues/252))

- **Thinking level not clamped on model switch**: Fixed TUI showing xhigh thinking level after switching to a model that doesn't support it. Thinking level is now automatically clamped to model capabilities. ([#253](https://github.com/badlogic/pi-mono/issues/253))

- **Cross-model thinking handoff**: Fixed error when switching between models with different thinking signature formats (e.g., GPT-OSS to Anthropic model thinking models via Antigravity). Thinking blocks without signatures are now converted to text with `<thinking>` delimiters.

## [0.24.5] - 2025-12-20

### Fixed

- **Input buffering in iTerm2**: Fixed Ctrl+C, Ctrl+D, and other keys requiring multiple presses in iTerm2. The cell size query response parser was incorrectly holding back keyboard input.

## [0.24.4] - 2025-12-20

### Fixed

- **Arrow keys and Enter in selector components**: Fixed arrow keys and Enter not working in model selector, session selector, OAuth selector, and other selector components when Caps Lock or Num Lock is enabled. ([#243](https://github.com/badlogic/pi-mono/issues/243))

## [0.24.3] - 2025-12-19

### Fixed

- **Footer overflow on narrow terminals**: Fixed footer path display exceeding terminal width when resizing to very narrow widths, causing rendering crashes. /arminsayshi

## [0.24.2] - 2025-12-20

### Fixed

- **More Kitty keyboard protocol fixes**: Fixed Backspace, Enter, Home, End, and Delete keys not working with Caps Lock enabled. The initial fix in 0.24.1 missed several key handlers that were still using raw byte detection. Now all key handlers use the helper functions that properly mask out lock key bits. ([#243](https://github.com/badlogic/pi-mono/issues/243))

## [0.24.1] - 2025-12-19

### Added

- **OAuth and model config exports**: Scripts using `AgentSession` directly can now import `getAvailableModels`, `getApiKeyForModel`, `findModel`, `login`, `logout`, and `getOAuthProviders` from `@gajae-code/coding-agent` to reuse OAuth token storage and model resolution. ([#245](https://github.com/badlogic/pi-mono/issues/245))

- **xhigh thinking level for gpt-5.2 models**: The thinking level selector and shift+tab cycling now show xhigh option for gpt-5.2 and gpt-5.2-openai-code models (in addition to gpt-5.1-openai-code-max). ([#236](https://github.com/badlogic/pi-mono/pull/236) by [@theBucky](https://github.com/theBucky))

### Fixed

- **Hooks wrap custom tools**: Custom tools are now executed through the hook wrapper, so `tool_call`/`tool_result` hooks can observe, block, and modify custom tool executions (consistent with hook type docs). ([#248](https://github.com/badlogic/pi-mono/pull/248) by [@nicobailon](https://github.com/nicobailon))

- **Hook onUpdate callback forwarding**: The `onUpdate` callback is now correctly forwarded through the hook wrapper, fixing custom tool progress updates. ([#238](https://github.com/badlogic/pi-mono/pull/238) by [@nicobailon](https://github.com/nicobailon))

- **Terminal cleanup on Ctrl+C in session selector**: Fixed terminal not being properly restored when pressing Ctrl+C in the session selector. ([#247](https://github.com/badlogic/pi-mono/pull/247) by [@aliou](https://github.com/aliou))

- **OpenRouter models with colons in IDs**: Fixed parsing of OpenRouter model IDs that contain colons (e.g., `openrouter:meta-llama/llama-4-scout:free`). ([#242](https://github.com/badlogic/pi-mono/pull/242) by [@aliou](https://github.com/aliou))

- **Global AGENTS.md loaded twice**: Fixed global AGENTS.md being loaded twice when present in both `~/.gjc/agent/` and the current directory. ([#239](https://github.com/badlogic/pi-mono/pull/239) by [@aliou](https://github.com/aliou))

- **Kitty keyboard protocol on Linux**: Fixed keyboard input not working in Ghostty on Linux when Num Lock is enabled. The Kitty protocol includes Caps Lock and Num Lock state in modifier values, which broke key detection. Now correctly masks out lock key bits when matching keyboard shortcuts. ([#243](https://github.com/badlogic/pi-mono/issues/243))

- **Emoji deletion and cursor movement**: Backspace, Delete, and arrow keys now correctly handle multi-codepoint characters like emojis. Previously, deleting an emoji would leave partial bytes, corrupting the editor state. ([#240](https://github.com/badlogic/pi-mono/issues/240))

## [0.24.0] - 2025-12-19

### Added

- **Subagent orchestration example**: Added comprehensive custom tool example for spawning and orchestrating sub-agents with isolated context windows. Includes scout/planner/reviewer/worker agents and workflow commands for multi-agent pipelines. ([#215](https://github.com/badlogic/pi-mono/pull/215) by [@nicobailon](https://github.com/nicobailon))

- **`getMarkdownTheme()` export**: Custom tools can now import `getMarkdownTheme()` from `@gajae-code/coding-agent` to use the same markdown styling as the main UI.

- **`pi.exec()` signal and timeout support**: Custom tools and hooks can now pass `{ signal, timeout }` options to `pi.exec()` for cancellation and timeout handling. The result includes a `killed` flag when the process was terminated.

- **Kitty keyboard protocol support**: Shift+Enter, Alt+Enter, Shift+Tab, Ctrl+D, and all Ctrl+key combinations now work in Ghostty, Kitty, WezTerm, and other modern terminals. ([#225](https://github.com/badlogic/pi-mono/pull/225) by [@kim0](https://github.com/kim0))

- **Dynamic API key refresh**: OAuth tokens (GitHub Copilot, Anthropic OAuth) are now refreshed before each LLM call, preventing failures in long-running agent loops where tokens expire mid-session. ([#223](https://github.com/badlogic/pi-mono/pull/223) by [@kim0](https://github.com/kim0))

- **`/hotkeys` command**: Shows all keyboard shortcuts in a formatted table.

- **Markdown table borders**: Tables now render with proper top and bottom borders.

### Changed

- **Subagent example improvements**: Parallel mode now streams updates from all tasks. Chain mode shows all completed steps during streaming. Expanded view uses proper markdown rendering with syntax highlighting. Usage footer shows turn count.

- **Skills standard compliance**: Skills now adhere to the [Agent Skills standard](https://agentskills.io/specification). Validates name (must match parent directory, lowercase, max 64 chars), description (required, max 1024 chars), and frontmatter fields. Warns on violations but remains lenient. Prompt format changed to XML structure. Removed `{baseDir}` placeholder in favor of relative paths. ([#231](https://github.com/badlogic/pi-mono/issues/231))

### Fixed

- **JSON mode stdout flush**: Fixed race condition where `gjc --mode json` could exit before all output was written to stdout, causing consumers to miss final events.

- **Symlinked tools, hooks, and slash commands**: Discovery now correctly follows symlinks when scanning for custom tools, hooks, and slash commands. ([#219](https://github.com/badlogic/pi-mono/pull/219), [#232](https://github.com/badlogic/pi-mono/pull/232) by [@aliou](https://github.com/aliou))

### Breaking Changes

- **Custom tools now require `index.ts` entry point**: Auto-discovered custom tools must be in a subdirectory with an `index.ts` file. The old pattern `~/.gjc/agent/tools/mytool.ts` must become `~/.gjc/agent/tools/mytool/index.ts`. This allows multi-file tools to import helper modules. Explicit paths via `--tool` or `settings.json` still work with any `.ts` file.

- **Hook `tool_result` event restructured**: The `ToolResultEvent` now exposes full tool result data instead of just text. ([#233](https://github.com/badlogic/pi-mono/pull/233))
  - Removed: `result: string` field
  - Added: `content: (TextContent | ImageContent)[]` - full content array
  - Added: `details: unknown` - tool-specific details (typed per tool via discriminated union on `toolName`)
  - `ToolResultEventResult.result` renamed to `ToolResultEventResult.text` (removed), use `content` instead
  - Hook handlers returning `{ result: "..." }` must change to `{ content: [{ type: "text", text: "..." }] }`
  - Built-in tool details types exported: `BashToolDetails`, `ReadToolDetails`, `GrepToolDetails`, `FindToolDetails`, `LsToolDetails`, `TruncationResult`
  - Type guards exported for narrowing: `isBashToolResult`, `isReadToolResult`, `isEditToolResult`, `isWriteToolResult`, `isGrepToolResult`, `isFindToolResult`, `isLsToolResult`

## [0.23.4] - 2025-12-18

### Added

- **Syntax highlighting**: Added syntax highlighting for markdown code blocks, read tool output, and write tool content. Uses cli-highlight with theme-aware color mapping and VS Code-style syntax colors. ([#214](https://github.com/badlogic/pi-mono/pull/214) by [@svkozak](https://github.com/svkozak))

- **Intra-line diff highlighting**: Edit tool now shows word-level changes with inverse highlighting when a single line is modified. Multi-line changes show all removed lines first, then all added lines.

### Fixed

- **Gemini tool result format**: Fixed tool result format for Gemini 3 Flash Preview which strictly requires `{ output: value }` for success and `{ error: value }` for errors. Previous format using `{ result, isError }` was rejected by newer Gemini models. ([#213](https://github.com/badlogic/pi-mono/issues/213), [#220](https://github.com/badlogic/pi-mono/pull/220))

- **Google baseUrl configuration**: Google provider now respects `baseUrl` configuration for custom endpoints or API proxies. ([#216](https://github.com/badlogic/pi-mono/issues/216), [#221](https://github.com/badlogic/pi-mono/pull/221) by [@theBucky](https://github.com/theBucky))

- **Google provider FinishReason**: Added handling for new `IMAGE_RECITATION` and `IMAGE_OTHER` finish reasons. Upgraded @google/genai to 1.34.0.

## [0.23.3] - 2025-12-17

### Fixed

- Check for compaction before submitting user prompt, not just after agent turn ends. This catches cases where user aborts mid-response and context is already near the limit.

### Changed

- Improved system prompt documentation section with clearer pointers to specific doc files for custom models, themes, skills, hooks, custom tools, and RPC.

- Cleaned up documentation:
  - `theme.md`: Added missing color tokens (`thinkingXhigh`, `bashMode`)
  - `skills.md`: Rewrote with better framing and examples
  - `hooks.md`: Fixed timeout/error handling docs, added import aliases section
  - `custom-tools.md`: Added intro with use cases and comparison table
  - `rpc.md`: Added missing `hook_error` event documentation
  - `README.md`: Complete settings table, condensed philosophy section, standardized OAuth docs

- Hooks loader now supports same import aliases as custom tools (`@sinclair/typebox`, `@gajae-code/ai`, `@gajae-code/tui`, `@gajae-code/coding-agent`).

### Breaking Changes

- **Hooks**: `turn_end` event's `toolResults` type changed from `AppMessage[]` to `ToolResultMessage[]`. If you have hooks that handle `turn_end` events and explicitly type the results, update your type annotations.

## [0.23.2] - 2025-12-17

### Fixed

- Fixed Anthropic model models via GitHub Copilot re-answering all previous prompts in multi-turn conversations. The issue was that assistant message content was sent as an array instead of a string, which Copilot's Anthropic model adapter misinterpreted. Also added missing `Openai-Intent: conversation-edits` header and fixed `X-Initiator` logic to check for any assistant/tool message in history. ([#209](https://github.com/badlogic/pi-mono/issues/209))

- Detect image MIME type via file magic (read tool and `@file` attachments), not filename extension.

- Fixed markdown tables overflowing terminal width. Tables now wrap cell contents to fit available width instead of breaking borders mid-row. ([#206](https://github.com/badlogic/pi-mono/pull/206) by [@kim0](https://github.com/kim0))

## [0.23.1] - 2025-12-17

### Fixed

- Fixed TUI performance regression caused by Box component lacking render caching. Built-in tools now use Text directly (like v0.22.5), and Box has proper caching for custom tool rendering.

- Fixed custom tools failing to load from `~/.gjc/agent/tools/` when gjc is installed globally. Module imports (`@sinclair/typebox`, `@gajae-code/tui`, `@gajae-code/ai`) are now resolved via aliases.

## [0.23.0] - 2025-12-17

### Added

- **Custom tools**: Extend gjc with custom tools written in TypeScript. Tools can provide custom TUI rendering, interact with users via `gjc.ui` (select, confirm, input, notify), and maintain state across sessions via `onSession` callback. See [docs/custom-tools.md](docs/custom-tools.md) and [examples/custom-tools/](examples/custom-tools/). ([#190](https://github.com/badlogic/pi-mono/issues/190))

- **Hook and tool examples**: Added `examples/hooks/` and `examples/custom-tools/` with working examples. Examples are now bundled in npm and binary releases.

### Breaking Changes

- **Hooks**: Replaced `session_start` and `session_switch` events with unified `session` event. Use `event.reason` (`"start" | "switch" | "clear"`) to distinguish. Event now includes `entries` array for state reconstruction.

## [0.22.5] - 2025-12-17

### Fixed

- Fixed `--session` flag not saving sessions in print mode (`-p`). The session manager was never receiving events because no subscriber was attached.

## [0.22.4] - 2025-12-17

### Added

- `--list-models [search]` CLI flag to list available models with optional fuzzy search. Shows provider, model ID, context window, max output, thinking support, and image support. Only lists models with configured API keys. ([#203](https://github.com/badlogic/pi-mono/issues/203))

### Fixed

- Fixed tool execution showing green (success) background while still running. Now correctly shows gray (pending) background until the tool completes.

## [0.22.3] - 2025-12-16

### Added

- **Streaming bash output**: Bash tool now streams output in real-time during execution. The TUI displays live progress with the last 5 lines visible (expandable with ctrl+o). ([#44](https://github.com/badlogic/pi-mono/issues/44))

### Changed

- **Tool output display**: When collapsed, tool output now shows the last N lines instead of the first N lines, making streaming output more useful.

- Updated `@gajae-code/ai` with X-Initiator header support for GitHub Copilot, ensuring agent calls are not deducted from quota. ([#200](https://github.com/badlogic/pi-mono/pull/200) by [@kim0](https://github.com/kim0))

### Fixed

- Fixed editor text being cleared during compaction. Text typed while compaction is running is now preserved. ([#179](https://github.com/badlogic/pi-mono/issues/179))
- Improved RGB to 256-color mapping for terminals without truecolor support. Now correctly uses grayscale ramp for neutral colors and preserves semantic tints (green for success, red for error, blue for pending) instead of mapping everything to wrong cube colors.
- `/think off` now actually disables thinking for all providers. Previously, providers like Gemini with "dynamic thinking" enabled by default would still use thinking even when turned off. ([#180](https://github.com/badlogic/pi-mono/pull/180) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.22.2] - 2025-12-15

### Changed

- Updated `@gajae-code/ai` with interleaved thinking enabled by default for Anthropic Anthropic model 4 models.

## [0.22.1] - 2025-12-15

_Dedicated to Peter's shoulder ([@steipete](https://twitter.com/steipete))_

### Changed

- Updated `@gajae-code/ai` with interleaved thinking support for Anthropic models.

## [0.22.0] - 2025-12-15

### Added

- **GitHub Copilot support**: Use GitHub Copilot models via OAuth login (`/login` -> "GitHub Copilot"). Supports both github.com and GitHub Enterprise. Models are sourced from models.dev and include Anthropic model, GPT, Gemini, Grok, and more. All models are automatically enabled after login. ([#191](https://github.com/badlogic/pi-mono/pull/191) by [@cau1k](https://github.com/cau1k))

### Fixed

- Model selector fuzzy search now matches against provider name (not just model ID) and supports space-separated tokens where all tokens must match

## [0.21.0] - 2025-12-14

### Added

- **Inline image rendering**: Terminals supporting Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images now render images inline in tool output. Aspect ratio is preserved by querying terminal cell dimensions on startup. Toggle with `/show-images` command or `terminal.showImages` setting. Falls back to text placeholder on unsupported terminals or when disabled. ([#177](https://github.com/badlogic/pi-mono/pull/177) by [@nicobailon](https://github.com/nicobailon))

- **Gemini 3 Pro thinking levels**: Thinking level selector now works with Gemini 3 Pro models. Minimal/low map to Google's LOW, medium/high map to Google's HIGH. ([#176](https://github.com/badlogic/pi-mono/pull/176) by [@markusylisiurunen](https://github.com/markusylisiurunen))

### Fixed

- Fixed read tool failing on macOS screenshot filenames due to Unicode Narrow No-Break Space (U+202F) in timestamp. Added fallback to try macOS variant paths and consolidated duplicate expandPath functions into shared path-utils.ts. ([#181](https://github.com/badlogic/pi-mono/pull/181) by [@nicobailon](https://github.com/nicobailon))

- Fixed double blank lines rendering after markdown code blocks ([#173](https://github.com/badlogic/pi-mono/pull/173) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.20.1] - 2025-12-13

### Added

- **Exported skills API**: `loadSkillsFromDir`, `formatSkillsForPrompt`, and related types are now exported for use by other packages (e.g., mom).

## [0.20.0] - 2025-12-13

### Breaking Changes

- **GJC skills now use `SKILL.md` convention**: GJC skills must now be named `SKILL.md` inside a directory, matching OpenAI code CLI format. Previously any `*.md` file was treated as a skill. Migrate by renaming `~/.gjc/agent/skills/foo.md` to `~/.gjc/agent/skills/foo/SKILL.md`.

### Added

- Display loaded skills on startup in interactive mode

## [0.19.1] - 2025-12-12

### Fixed

- Documentation: Added skills system documentation to README (setup, usage, CLI flags, settings)

## [0.19.0] - 2025-12-12

### Added

- **Skills system**: Auto-discover and load instruction files on-demand. Supports Anthropic Code (`~/.anthropic-model/skills/*/SKILL.md`), OpenAI code CLI (`~/.openai-code/skills/`), and GJC-native formats (`~/.gjc/agent/skills/`, `.gjc/skills/`). Skills are listed in system prompt with descriptions, agent loads them via read tool when needed. Supports `{baseDir}` placeholder. Disable with `--no-skills` or `skills.enabled: false` in settings. ([#169](https://github.com/badlogic/pi-mono/issues/169))

- **Version flag**: Added `--version` / `-v` flag to display the current version and exit. ([#170](https://github.com/badlogic/pi-mono/pull/170))

## [0.18.2] - 2025-12-11

### Added

- **Auto-retry on transient errors**: Automatically retries requests when providers return overloaded, rate limit, or server errors (429, 500, 502, 503, 504). Uses exponential backoff (2s, 4s, 8s). Shows retry status in TUI with option to cancel via Escape. Configurable in `settings.json` via `retry.enabled`, `retry.maxRetries`, `retry.baseDelayMs`. RPC mode emits `auto_retry_start` and `auto_retry_end` events. ([#157](https://github.com/badlogic/pi-mono/issues/157))

- **HTML export line numbers**: Read tool calls in HTML exports now display line number ranges (e.g., `file.txt:10-20`) when offset/limit parameters are used, matching the TUI display format. Line numbers appear in yellow color for better visibility. ([#166](https://github.com/badlogic/pi-mono/issues/166))

### Fixed

- **Branch selector now works with single message**: Previously the branch selector would not open when there was only one user message. Now it correctly allows branching from any message, including the first one. This is needed for checkpoint hooks to restore state from before the first message. ([#163](https://github.com/badlogic/pi-mono/issues/163))

- **In-memory branching for `--no-session` mode**: Branching now works correctly in `--no-session` mode without creating any session files. The conversation is truncated in memory.

- **Git branch indicator now works in subdirectories**: The footer's git branch detection now walks up the directory hierarchy to find the git root, so it works when running gjc from a subdirectory of a repository. ([#156](https://github.com/badlogic/pi-mono/issues/156))

## [0.18.1] - 2025-12-10

### Added

- **Mistral provider**: Added support for Mistral AI models. Set `MISTRAL_API_KEY` environment variable to use.

### Fixed

- Fixed print mode (`-p`) not exiting after output when custom themes are present (theme watcher now properly stops in print mode) ([#161](https://github.com/badlogic/pi-mono/issues/161))

## [0.18.0] - 2025-12-10

### Added

- **Hooks system**: TypeScript modules that extend agent behavior by subscribing to lifecycle events. Hooks can intercept tool calls, prompt for confirmation, modify results, and inject messages from external sources. Auto-discovered from `~/.gjc/agent/hooks/*.ts` and `.gjc/hooks/*.ts`. Thanks to [@nicobailon](https://github.com/nicobailon) for the collaboration on the design and implementation. ([#145](https://github.com/badlogic/pi-mono/issues/145), supersedes [#158](https://github.com/badlogic/pi-mono/pull/158))

- **`pi.send()` API**: Hooks can inject messages into the agent session from external sources (file watchers, webhooks, CI systems). If streaming, messages are queued; otherwise a new agent loop starts immediately.

- **`--hook <path>` CLI flag**: Load hook files directly for testing without modifying settings.

- **Hook events**: `session_start`, `session_switch`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `tool_call` (can block), `tool_result` (can modify), `branch`.

- **Hook UI primitives**: `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`, `ctx.ui.notify()` for interactive prompts from hooks.

- **Hooks documentation**: Full API reference at `docs/hooks.md`, shipped with npm package.

## [0.17.0] - 2025-12-09

### Changed

- **Simplified compaction flow**: Removed proactive compaction (aborting mid-turn when threshold approached). Compaction now triggers in two cases only: (1) overflow error from LLM, which compacts and auto-retries, or (2) threshold crossed after a successful turn, which compacts without retry.

- **Compaction retry uses `Agent.continue()`**: Auto-retry after overflow now uses the new `continue()` API instead of re-sending the user message, preserving exact context state.

- **Merged turn prefix summary**: When a turn is split during compaction, the turn prefix summary is now merged into the main history summary instead of being stored separately.

### Added

- **`isCompacting` property on AgentSession**: Check if auto-compaction is currently running.

- **Session compaction indicator**: When resuming a compacted session, displays "Session compacted N times" status message.

### Fixed

- **Block input during compaction**: User input is now blocked while auto-compaction is running to prevent race conditions.

- **Skip error messages in usage calculation**: Context size estimation now skips both aborted and error messages, as neither have valid usage data.

## [0.16.0] - 2025-12-09

### Breaking Changes

- **New RPC protocol**: The RPC mode (`--mode rpc`) has been completely redesigned with a new JSON protocol. The old protocol is no longer supported. See [`docs/rpc.md`](docs/rpc.md) for the new protocol documentation and [`test/rpc-example.ts`](test/rpc-example.ts) for a working example. Includes `RpcClient` TypeScript class for easy integration. ([#91](https://github.com/badlogic/pi-mono/issues/91))

### Changed

- **README restructured**: Reorganized documentation from 30+ flat sections into 10 logical groups. Converted verbose subsections to scannable tables. Consolidated philosophy sections. Reduced size by ~60% while preserving all information.

## [0.15.0] - 2025-12-09

### Changed

- **Major code refactoring**: Restructured codebase for better maintainability and separation of concerns. Moved files into organized directories (`core/`, `modes/`, `utils/`, `cli/`). Extracted `AgentSession` class as central session management abstraction. Split `main.ts` and `tui-renderer.ts` into focused modules. See `DEVELOPMENT.md` for the new code map. ([#153](https://github.com/badlogic/pi-mono/issues/153))

## [0.14.2] - 2025-12-08

### Added

- `/debug` command now includes agent messages as JSONL in the output

### Fixed

- Fix crash when bash command outputs binary data (e.g., `curl` downloading a video file)

## [0.14.1] - 2025-12-08

### Fixed

- Fix build errors with tsgo 7.0.0-dev.20251208.1 by properly importing `ReasoningEffort` type

## [0.14.0] - 2025-12-08

### Breaking Changes

- **Custom themes require new color tokens**: Themes must now include `thinkingXhigh` and `bashMode` color tokens. The theme loader provides helpful error messages listing missing tokens. See built-in themes (dark.json, light.json) for reference values.

### Added

- **OpenAI compatibility overrides in models.json**: Custom models using `openai-completions` API can now specify a `compat` object to override provider quirks (`supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `maxTokensField`). Useful for LiteLLM, custom proxies, and other non-standard endpoints. ([#133](https://github.com/badlogic/pi-mono/issues/133), thanks @fink-andreas for the initial idea and PR)

- **xhigh thinking level**: Added `xhigh` thinking level for OpenAI openai-code-max models. Cycle through thinking levels with Shift+Tab; `xhigh` appears only when using a openai-code-max model. ([#143](https://github.com/badlogic/pi-mono/issues/143))

- **Collapse changelog setting**: Add `"collapseChangelog": true` to `~/.gjc/agent/settings.json` to show a condensed "Updated to vX.Y.Z" message instead of the full changelog after updates. Use `/changelog` to view the full changelog. ([#148](https://github.com/badlogic/pi-mono/issues/148))

- **Bash mode**: Execute shell commands directly from the editor by prefixing with `!` (e.g., `!ls -la`). Output streams in real-time, is added to the LLM context, and persists in session history. Supports multiline commands, cancellation (Escape), truncation for large outputs, and preview/expand toggle (Ctrl+O). Also available in RPC mode via `{"type":"bash","command":"..."}`. ([#112](https://github.com/badlogic/pi-mono/pull/112), original implementation by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.13.2] - 2025-12-07

### Changed

- **Tool output truncation**: All tools now enforce consistent truncation limits with actionable notices for the LLM. ([#134](https://github.com/badlogic/pi-mono/issues/134))
  - **Limits**: 2000 lines OR 50KB (whichever hits first), never partial lines
  - **read**: Shows `[Showing lines X-Y of Z. Use offset=N to continue]`. If first line exceeds 50KB, suggests bash command
  - **bash**: Tail truncation with temp file. Shows `[Showing lines X-Y of Z. Full output: /tmp/...]`
  - **grep**: Pre-truncates match lines to 500 chars. Shows match limit and line truncation notices
  - **find/ls**: Shows result/entry limit notices
  - TUI displays truncation warnings in yellow at bottom of tool output (visible even when collapsed)

## [0.13.1] - 2025-12-06

### Added

- **Flexible Windows shell configuration**: The bash tool now supports multiple shell sources beyond Git Bash. Resolution order: (1) custom `shellPath` in settings.json, (2) Git Bash in standard locations, (3) any bash.exe on PATH. This enables Cygwin, MSYS2, and other bash environments. Configure with `~/.gjc/agent/settings.json`: `{"shellPath": "C:\\cygwin64\\bin\\bash.exe"}`.

### Fixed

- **Windows binary detection**: Fixed Bun compiled binary detection on Windows by checking for URL-encoded `%7EBUN` in addition to `$bunfs` and `~BUN` in `import.meta.url`. This ensures the binary correctly locates supporting files (package.json, themes, etc.) next to the executable.

## [0.12.15] - 2025-12-06

### Fixed

- **Editor crash with emojis/CJK characters**: Fixed crash when pasting or typing text containing wide characters (emojis like ✅, CJK characters) that caused line width to exceed terminal width. The editor now uses grapheme-aware text wrapping with proper visible width calculation.

## [0.12.14] - 2025-12-06

### Added

- **Double-Escape Branch Shortcut**: Press Escape twice with an empty editor to quickly open the `/branch` selector for conversation branching.

## [0.12.13] - 2025-12-05

### Changed

- **Faster startup**: Version check now runs in parallel with TUI initialization instead of blocking startup for up to 1 second. Update notifications appear in chat when the check completes.

## [0.12.12] - 2025-12-05

### Changed

- **Footer display**: Token counts now use M suffix for millions (e.g., `10.2M` instead of `10184k`). Context display shortened from `61.3% of 200k` to `61.3%/200k`.

### Fixed

- **Multi-key sequences in inputs**: Inputs like model search now handle multi-key sequences identically to the main prompt editor. ([#122](https://github.com/badlogic/pi-mono/pull/122) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Line wrapping escape codes**: Fixed underline style bleeding into padding when wrapping long URLs. ANSI codes now attach to the correct content, and line-end resets only turn off underline (preserving background colors). ([#109](https://github.com/badlogic/pi-mono/issues/109))

### Added

- **Fuzzy search models and sessions**: Implemented a simple fuzzy search for models and sessions (e.g., `openai-codemax` now finds `gpt-5.1-openai-code-max`). ([#122](https://github.com/badlogic/pi-mono/pull/122) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Prompt History Navigation**: Browse previously submitted prompts using Up/Down arrow keys when the editor is empty. Press Up to cycle through older prompts, Down to return to newer ones or clear the editor. Similar to shell history and Anthropic Code's prompt history feature. History is session-scoped and stores up to 100 entries. ([#121](https://github.com/badlogic/pi-mono/pull/121) by [@nicobailon](https://github.com/nicobailon))
- **`/resume` Command**: Switch to a different session mid-conversation. Opens an interactive selector showing all available sessions. Equivalent to the `--resume` CLI flag but can be used without restarting the agent. ([#117](https://github.com/badlogic/pi-mono/pull/117) by [@hewliyang](https://github.com/hewliyang))

## [0.12.11] - 2025-12-05

### Changed

- **Compaction UI**: Simplified collapsed compaction indicator to show warning-colored text with token count instead of styled banner. Removed redundant success message after compaction. ([#108](https://github.com/badlogic/pi-mono/issues/108))

### Fixed

- **Print mode error handling**: `-p` flag now outputs error messages and exits with code 1 when requests fail, instead of silently producing no output.
- **Branch selector crash**: Fixed TUI crash when user messages contained Unicode characters (like `✔` or `›`) that caused line width to exceed terminal width. Now uses proper `truncateToWidth` instead of `substring`.
- **Bash output escape sequences**: Fixed incomplete stripping of terminal escape sequences in bash tool output. `stripAnsi` misses some sequences like standalone String Terminator (`ESC \`), which could cause rendering issues when displaying captured TUI output.
- **Footer overflow crash**: Fixed TUI crash when terminal width is too narrow for the footer stats line. The footer now truncates gracefully instead of overflowing.

### Added

- **`authHeader` option in models.json**: Custom providers can set `"authHeader": true` to automatically add `Authorization: Bearer <apiKey>` header. Useful for providers that require explicit auth headers. ([#81](https://github.com/badlogic/pi-mono/issues/81))
- **`--append-system-prompt` Flag**: Append additional text or file contents to the system prompt. Supports both inline text and file paths. Complements `--system-prompt` for layering custom instructions without replacing the base system prompt. ([#114](https://github.com/badlogic/pi-mono/pull/114) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Thinking Block Toggle**: Added `Ctrl+T` shortcut to toggle visibility of LLM thinking blocks. When toggled off, shows a static "Thinking..." label instead of full content. Useful for reducing visual clutter during long conversations. ([#113](https://github.com/badlogic/pi-mono/pull/113) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.12.10] - 2025-12-04

### Added

- Added `gpt-5.1-openai-code-max` model support

## [0.12.9] - 2025-12-04

### Added

- **`/copy` Command**: Copy the last agent message to clipboard. Works cross-platform (macOS, Windows, Linux). Useful for extracting text from rendered Markdown output. ([#105](https://github.com/badlogic/pi-mono/pull/105) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.12.8] - 2025-12-04

- Fix: Use CTRL+O consistently for compaction expand shortcut (not CMD+O on Mac)

## [0.12.7] - 2025-12-04

### Added

- **Context Compaction**: Long sessions can now be compacted to reduce context usage while preserving recent conversation history. ([#92](https://github.com/badlogic/pi-mono/issues/92), [docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md#context-compaction))
  - `/compact [instructions]`: Manually compact context with optional custom instructions for the summary
  - `/autocompact`: Toggle automatic compaction when context exceeds threshold
  - Compaction summarizes older messages while keeping recent messages (default 20k tokens) verbatim
  - Auto-compaction triggers when context reaches `contextWindow - reserveTokens` (default 16k reserve)
  - Compacted sessions show a collapsible summary in the TUI (toggle with `o` key)
  - HTML exports include compaction summaries as collapsible sections
  - RPC mode supports `{"type":"compact"}` command and auto-compaction (emits compaction events)
- **Branch Source Tracking**: Branched sessions now store `branchedFrom` in the session header, containing the path to the original session file. Useful for tracing session lineage.

## [0.12.5] - 2025-12-03

### Added

- **Forking/Rebranding Support**: All branding (app name, config directory, environment variable names) is now configurable via `ompConfig` in `package.json`. Forks can change `ompConfig.name` and `ompConfig.configDir` to rebrand the CLI without code changes. Affects CLI banner, help text, config paths, and error messages. ([#95](https://github.com/badlogic/pi-mono/pull/95))

### Fixed

- **Bun Binary Detection**: Fixed Bun compiled binary failing to start after Bun updated its virtual filesystem path format from `%7EBUN` to `$bunfs`. ([#95](https://github.com/badlogic/pi-mono/pull/95))

## [0.12.4] - 2025-12-02

### Added

- **RPC Termination Safeguard**: When running as an RPC worker (stdin pipe detected), the CLI now exits immediately if the parent process terminates unexpectedly. Prevents orphaned RPC workers from persisting indefinitely and consuming system resources.

## [0.12.3] - 2025-12-02

### Fixed

- **Rate limit handling**: Anthropic rate limit errors now trigger automatic retry with exponential backoff (base 10s, max 5 retries). Previously these errors would abort the request immediately.
- **Usage tracking during retries**: Retried requests now correctly accumulate token usage from all attempts, not just the final successful one. Fixes artificially low token counts when requests were retried.

## [0.12.2] - 2025-12-02

### Changed

- Removed support for gpt-4.5-preview and o3 models (not yet available)

## [0.12.1] - 2025-12-02

### Added

- **Models**: Added support for OpenAI's new models:
  - `gpt-4.1` (128K context)
  - `gpt-4.1-mini` (128K context)
  - `gpt-4.1-nano` (128K context)
  - `o3` (200K context, reasoning model)
  - `o4-mini` (200K context, reasoning model)

## [0.12.0] - 2025-12-02

### Added

- **`-p, --print` Flag**: Run in non-interactive batch mode. Processes input message or piped stdin without TUI, prints agent response directly to stdout. Ideal for scripting, piping, and CI/CD integration. Exits after first response.
- **`-P, --print-streaming` Flag**: Like `-p`, but streams response tokens as they arrive. Use `--print-streaming --no-markdown` for raw unformatted output.
- **`--print-turn` Flag**: Continue processing tool calls and agent turns until the agent naturally finishes or requires user input. Combine with `-p` for complete multi-turn conversations.
- **`--no-markdown` Flag**: Output raw text without Markdown formatting. Useful when piping output to tools that expect plain text.
- **Streaming Print Mode**: Added internal `printStreaming` option for streaming output in non-TUI mode.
- **RPC Mode `print` Command**: Send `{"type":"print","content":"text"}` to get formatted print output via `print_output` events.
- **Auto-Save in Print Mode**: Print mode conversations are automatically saved to the session directory, allowing later resumption with `--continue`.
- **Thinking level options**: Added `--thinking-off`, `--thinking-minimal`, `--thinking-low`, `--thinking-medium`, `--thinking-high` flags for directly specifying thinking level without the selector UI.

### Changed

- **Simplified RPC Protocol**: Replaced the `prompt` wrapper command with direct message objects. Send `{"role":"user","content":"text"}` instead of `{"type":"prompt","message":"text"}`. Better aligns with message format throughout the codebase.
- **RPC Message Handling**: Agent now processes raw message objects directly, with `timestamp` auto-populated if missing.

## [0.11.9] - 2025-12-02

### Changed

- Change Ctrl+I to Ctrl+P for model cycling shortcut to avoid collision with Tab key in some terminals

## [0.11.8] - 2025-12-01

### Fixed

- Absolute glob patterns (e.g., `/Users/foo/**/*.ts`) are now handled correctly. Previously the leading `/` was being stripped, causing the pattern to be interpreted relative to the current directory.

## [0.11.7] - 2025-12-01

### Fixed

- Fix read path traversal vulnerability. Paths are now validated to prevent reading outside the working directory or its parents. The `read` tool can read from `cwd`, its ancestors (for config files), and all descendants. Symlinks are resolved before validation.

## [0.11.6] - 2025-12-01

### Fixed

- Fix `--system-prompt <path>` allowing the path argument to be captured by the message collection, causing "file not found" errors.

## [0.11.5] - 2025-11-30

### Fixed

- Fixed fatal error "Cannot set properties of undefined (setting '0')" when editing empty files in the `edit` tool.
- Simplified `edit` tool output: Shows only "Edited file.txt" for successful edits instead of verbose search/replace details.
- Fixed fatal error in footer rendering when token counts contain NaN values due to missing usage data.

## [0.11.4] - 2025-11-30

### Fixed

- Fixed chat rendering crash when messages contain preformatted/styled text (e.g., thinking traces with gray italic styling). The markdown renderer now preserves existing ANSI escape codes when they appear before inline elements.

## [0.11.3] - 2025-11-29

### Fixed

- Fix file drop functionality for absolute paths

## [0.11.2] - 2025-11-29

### Fixed

- Fixed TUI crash when pasting content containing tab characters. Tabs are now converted to 4 spaces before insertion.
- Fixed terminal corruption after exit when shell integration sequences (OSC 133) appeared in bash output. These sequences are now stripped along with other ANSI codes.

## [0.11.1] - 2025-11-29

### Added

- Added `fd` integration for file path autocompletion. Now uses `fd` for faster fuzzy file search

### Fixed

- Fixed keyboard shortcuts Ctrl+A, Ctrl+E, Ctrl+K, Ctrl+U, Ctrl+W, and word navigation (Option+Arrow) not working in VS Code integrated terminal and some other terminal emulators

## [0.11.0] - 2025-11-29

### Added

- **File-based Slash Commands**: Create custom reusable prompts as `.txt` files in `~/.gjc/slash-commands/`. Files become `/filename` commands with first-line descriptions. Supports `{{selection}}` placeholder for referencing selected/attached content.
- **`/branch` Command**: Create conversation branches from any previous user message. Opens a selector to pick a message, then creates a new session file starting from that point. Original message text is placed in the editor for modification.
- **Unified Content References**: Both `@path` in messages and `--file path` CLI arguments now use the same attachment system with consistent MIME type detection.
- **Drag & Drop Files**: Drop files onto the terminal to attach them to your message. Supports multiple files and both text and image content.

### Changed

- **Model Selector with Search**: The `/model` command now opens a searchable list. Type to filter models by name, use arrows to navigate, Enter to select.
- **Improved File Autocomplete**: File path completion after `@` now supports fuzzy matching and shows file/directory indicators.
- **Session Selector with Search**: The `--resume` and `--session` flags now open a searchable session list with fuzzy filtering.
- **Attachment Display**: Files added via `@path` are now shown as "Attached: filename" in the user message, separate from the prompt text.
- **Tab Completion**: Tab key now triggers file path autocompletion anywhere in the editor, not just after `@` symbol.

### Fixed

- Fixed autocomplete z-order issue where dropdown could appear behind chat messages
- Fixed cursor position when navigating through wrapped lines in the editor
- Fixed attachment handling for continued sessions to preserve file references

## [0.10.6] - 2025-11-28

### Changed

- Show base64-truncated indicator for large images in tool output

### Fixed

- Fixed image dimensions not being read correctly from PNG/JPEG/GIF files
- Fixed PDF images being incorrectly base64-truncated in display
- Allow reading files from ancestor directories (needed for monorepo configs)

## [0.10.5] - 2025-11-28

### Added

- Full multimodal support: attach images (PNG, JPEG, GIF, WebP) and PDFs to prompts using `@path` syntax or `--file` flag

### Fixed

- `@`-references now handle special characters in file names (spaces, quotes, unicode)
- Fixed cursor positioning issues with multi-byte unicode characters in editor

## [0.10.4] - 2025-11-28

### Fixed

- Removed padding on first user message in TUI to improve visual consistency.

## [0.10.3] - 2025-11-28

### Added

- Added RPC mode (`--rpc`) for programmatic integration. Accepts JSON commands on stdin, emits JSON events on stdout. See [RPC mode documentation](https://github.com/nicobailon/pi-mono/blob/main/packages/coding-agent/README.md#rpc-mode) for protocol details.

### Changed

- Refactored internal architecture to support multiple frontends (TUI, RPC) with shared agent logic.

## [0.10.2] - 2025-11-26

### Added

- Added thinking level persistence. Default level stored in `~/.gjc/settings.json`, restored on startup. Per-session overrides saved in session files.
- Added model cycling shortcut: `Ctrl+I` cycles through available models (or scoped models with `-m` flag).
- Added automatic retry with exponential backoff for transient API errors (network issues, 500s, overload).
- Cumulative token usage now shown in footer (total tokens used across all messages in session).
- Added `--system-prompt` flag to override default system prompt with custom text or file contents.
- Footer now shows estimated total cost in USD based on model pricing.

### Changed

- Replaced `--models` flag with `-m/--model` supporting multiple values. Specify models as `provider/model@thinking` (e.g., `anthropic/anthropic-model-sonnet-4-20250514@high`). Multiple `-m` flags scope available models for the session.
- Thinking level border now persists visually after selector closes.
- Improved tool result display with collapsible output (default collapsed, expand with `Ctrl+O`).

## [0.10.1] - 2025-11-25

### Added

- Add custom model configuration via `~/.gjc/models.json`

## [0.10.0] - 2025-11-25

Initial public release.

### Added

- Interactive TUI with streaming responses
- Conversation session management with `--continue`, `--resume`, and `--session` flags
- Multi-line input support (Shift+Enter or Option+Enter for new lines)
- Tool execution: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `think`
- Thinking mode support for Anthropic model with visual indicator and `/thinking` selector
- File path autocompletion with `@` prefix
- Slash command autocompletion
- `/export` command for HTML session export
- `/model` command for runtime model switching
- `/session` command for session statistics
- Model provider support: Anthropic (Anthropic model), OpenAI, Google (Gemini)
- Git branch display in footer
- Message queueing during streaming responses
- OAuth integration for Gmail and Google Calendar access
- HTML export with syntax highlighting and collapsible sections
