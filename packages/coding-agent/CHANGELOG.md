# Changelog

## [Unreleased]

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
