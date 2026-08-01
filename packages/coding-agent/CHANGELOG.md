# Changelog

## [Unreleased]
### Added

- Added the paginated public SDK query `providers.list/active` (Q29), returning deterministic, deduplicated `{ provider, connectionKind }` descriptors for locally eligible providers without exposing credentials or performing remote health probes.

### Added

- Notification settings now expose first-class Telegram, Discord, and Slack configuration, desired-intent toggles, provider-local quarantine and repair guidance, explicit `keep | replace | remove` secret actions, provider-specific health/test diagnostics, and truthful saved-but-runtime-degraded outcomes. The global master preserves provider credentials and intent, `GJC_NOTIFICATIONS=0` suppresses only automatic generic-session admission, and blocked Telegram ownership uses an isolated chat-only endpoint so verified Discord or Slack siblings can continue without exposing the shared endpoint.
- `/import-session codex [session-id ...]` imports selected Codex histories, or every Codex history bound to the current workspace when IDs are omitted, into resumable native v5 sessions. Imports stream through bounded sanitization and quarantine, preserve source provenance, publish atomically and idempotently, support transcripts above 64 MiB through memory-guard checkpointing, and remain unavailable to ACP/remote clients.

### Fixed

- Ordinary `ask` selectors now bound long question premises and page through every premise row without skipping rows hidden by overflow indicators (#3675).
- First-event timeout retries now require a typed, content-free failure from the current clean attempt scope, preventing prior or stale extension activity from suppressing or admitting a later request (#3553).
- Managed session preparation now preserves native `content_too_large` storage failures as `artifact_capacity_exceeded` instead of misreporting `binding_invalid: prepare:store`.
- The issue-1979 Korean prose wrap test now cleans up inherited multiplexer env vars (`TMUX`, `TMUX_PANE`, etc.) so it deterministically exercises the plain-terminal render path regardless of the CI runner's terminal session (#1979).
- The SDK operation inventory now classifies the local-only `/import-session` seam as a locked exclusion and regenerates the committed matrix, fixing the shard-5 `accepts the committed generated matrix` gate failure introduced by the Codex import command (#3714).
- The model selector's assignment menu now shows the model each role currently resolves to (`Set as EXECUTOR (Executor) — now: anthropic/claude-haiku-4-5`), distinguishing an unset default, a role that inherits the default, and a configured-but-unresolvable selector. Previously the role rows were unlabeled, so the only way to learn a role's model was to scan the whole 800+ entry model list for role badges.
## [0.12.7] - 2026-07-31

## [0.12.6] - 2026-07-31
### Added

- Added the bundled `lunamaxxing` OpenAI Codex profile, mapping every role to GPT-5.6 Luna with medium default reasoning, xhigh executor reasoning, and maximum planner/critic/architect reasoning.

### Fixed

- Settings now requests a repaint after asynchronous GJC bundle and plugin views rebuild, so loaded content and mutation results appear without an extra keypress (#3643).
- `todo_write` now rejects unsupported operation keys and treats a bare `done` or `drop` as an error instead of completing or abandoning every task (#3640).
- Deferred `agent_end` publication again settles public session readiness before slow extension handlers finish, while retaining exact cancellation leases through queued extension delivery and draining that delivery before session shutdown.
- Ultragoal validation-batch hydration now fails closed unless deferred and final-close evidence exactly matches a complete authoritative cumulative Git/CI inventory and durable batch tuple. Explicit malformed, partial, unknown, reordered, or stale receipt data is rejected; Git path capture is byte-safe, NUL-delimited, and includes untracked files; incomplete capture conservatively requires computer-control QA; shared settings and tool registries cannot use partial diffs to bypass that suite; validate/checkpoint replacement hydration is identical; and current/replacement receipts are byte-bound to ledger payloads (#3541).
- Fixture quality gates that complete intermediate Ultragoal stories now write file-backed adversarial artifact proof; skill-state hooks and computer red-team fixtures match the unconditional adversarial path check so #3543 CI stays fail-closed without weakening hydration exactness (#3543).
- Runtime settings reconciliation now validates every `web_search.fallback` entry against the declared provider enum instead of accepting unsupported or non-string array items (#3601).
- Ultragoal critic-gate, dogfood, review, durable-completion, and runtime test suites now pin `CI_DEV_CHANGED_PATHS` hermetically in their setup/teardown. Their temp checkpoints live inside the enclosing git work tree, so the CI planner's changed paths (which include computer control surface paths on branches that touch them) previously leaked into the computed change set and falsely triggered the mandatory computer red-team suite (`COMPUTER_REDTEAM_CASE_MISSING: … must include kill-switch-bypass`). The production kill-switch-bypass gate is unchanged; only the test fixtures now isolate their own contract from the host branch's diff (#3533).
- Ultragoal critic-gate, dogfood, review, durable-completion, and runtime test suites now relocate temp dirs to `os.tmpdir()` (outside the enclosing git work tree) and pin `CI_DEV_CHANGED_PATHS` to a non-computer test path. The prior in-repo temp dirs caused `computeCheckpointChangeSet` to return `captureIncomplete=true` under parallel shard load (git command timeouts), which unconditionally triggered the mandatory computer red-team suite even when no computer surface was touched. The production kill-switch-bypass gate is unchanged; the `.tmp-*` gitignore entry prevents in-repo test artifacts from polluting untracked-file inventory (#3533).
- Telegram topic delete settlement is now fence-epoch bound, two-phase, and durably route-atomic. `TopicRegistry.settleDelete` requires the caller's dispatched authority epoch to still equal both the record's own epoch and the session's current epoch, so a held earlier delete can no longer settle a newer scan/close-started fence for the same session and topic and release its quarantine; it now removes the record but deliberately *retains* the topic-id quarantine and returns a settlement token instead of publishing routes, so no colliding survivor becomes routable and no settled id becomes adoptable while the clear is still only in memory. `commitSettledDelete` publishes the rebuilt inbound routes and releases the quarantine only after the durable topic-state persist resolves, and `rollbackSettledDelete` undoes a failed persist as a compare-and-set that applies only while the post-settlement state is still exactly current, so a stale rollback can no longer resurrect a deleted record over a newer fence. A refused settlement returns no token and is therefore structurally incapable of being rolled back. Authority-epoch advancement is routed through a single saturating helper capped at `Number.MAX_SAFE_INTEGER`, and settlement fails closed (keeping the fence) on a non-safe-integer, negative, or already-saturated epoch instead of settling against an unsound comparison. Telegram's first create-compensation path now marks compensation complete only after that durable clear commits, so a failed persist leaves the fence supervised rather than stranding a cleared memory state against a `delete_pending` disk state.
- The Telegram notification self-heal reaper now reclaims abandoned publication staging files in the agent `notifications/` directory. `writeJsonAtomic` stages a sibling `<name>.<pid>.<epoch-ms>.<suffix>.tmp` and renames it over the destination; if the staging write or the rename fails, or the process dies between the two, that temp is never published and never read again. No prefix in the reaper's leak-artifact list claimed `.tmp`, so one unreachable file accumulated per failed attempt — permanently, across the roots registry, daemon state, callback aliases, seen-update ids, and the topic registry snapshot. This is most visible where a rename-blocking condition persists (a Windows `EPERM` from an antivirus or indexer holding a handle, `EACCES`, `EIO`, `ENOSPC`). Reaping is shape-matched and still bounded by the existing five-minute mtime grace window, so a temp that an in-flight publication is still staging is never removed, and reclaiming it here also recovers temps orphaned by a crash, which no writer-side unwind can reach.
- The Telegram notification self-heal reaper now reclaims abandoned publication staging files in the agent `notifications/` directory. `writeJsonAtomic` stages a sibling `<name>.<pid>.<epoch-ms>.<suffix>.tmp` and renames it over the destination; if the staging write or the rename fails, or the process dies between the two, that temp is never published and never read again. No prefix in the reaper's leak-artifact list claimed `.tmp`, so one unreachable file accumulated per failed attempt — permanently, across the roots registry, daemon state, callback aliases, seen-update ids, and the topic registry snapshot. This is most visible where a rename-blocking condition persists (a Windows `EPERM` from an antivirus or indexer holding a handle, `EACCES`, `EIO`, `ENOSPC`). Reclaiming it here also recovers temps orphaned by a crash, which no writer-side unwind can reach. Removal is fenced rather than age-only: the reaper parses the publisher PID out of the temp's own name and removes it only when that publisher is *provably dead*, so a live or slow publication keeps its staged temp however old it is, and an indeterminate liveness probe or an unparseable claim retains the file. A proven-dead temp is still bounded by the existing five-minute mtime grace window, and the deletion itself is bound to a no-follow identity capture (`dev`+`ino`+`size`+`mtime`+content digest, single-link regular files only) executed through the exact-unlink native, so a symlink is never followed and a temp replaced between capture and delete is refused instead of destroying the successor.
- The Telegram notification self-heal reaper now handles abandoned publication staging files in the agent `notifications/` directory. `writeJsonAtomic` stages a sibling `<name>.<pid>.<epoch-ms>.<suffix>.tmp` and renames it over the destination; a failed staging write or rename, or a process death between those steps, can leave an unreachable file. The reaper parses the publisher PID from the temp name and acts only when that publisher is provably dead and the existing five-minute mtime grace window has elapsed. Deletion is bound to a no-follow identity capture (`dev`+`ino`+`size`+`mtime`+content digest, single-link regular files only) through the exact-unlink native, so symlinks and same-name replacements are retained. A terminal native removal is reported as reclaimed; a typed `cleanup_pending` result is instead reported as skipped, leaves the bytes visible under a recognized exact-unlink placeholder, and later scans preserve that placeholder without pathname churn rather than claiming false removal.

### Fixed

- Canonical wrapped first-event timeouts now continue the same clean turn through bounded retries and configured fallback rotation, while preserving replay-safety, cancellation, provider-terminal policies, exact attempt diagnostics, and task/subagent retry-status truth (#3553).
- Runtime skill discovery now preserves a candidate when its exact skill name appears as a query token, so additional task-specific terms no longer discard an explicitly named skill.
### Fixed

- Managed-session deletion now immediately continues a descriptor-authorized POSIX artifact detach through exact payload scrubbing before retiring the transcript. Durable direct and replay cleanup preserve substituted successors, while fork regressions use an explicit snapshot barrier instead of scheduler timing.
- Managed-session migration keeps a definitely live holder exclusive beyond the 60-second lease without timer-dependent self-fencing, permits immediate successor acquisition only after explicit release or proven process death, and surfaces capacity/busy startup failures through fixed path/content-redacted guidance (#3508).

## [0.12.5] - 2026-07-30
### Fixed

- ACP and SDK broker session deletion no longer promotes a non-empty retained artifact quarantine to transcript deletion. `cleanup_pending` keeps transcript and exact quarantine authority across retries and restarts while payload bytes survive; root-only transcript preauthorization remains replay-bound and is revalidated after ledger persistence immediately before mutation, while ordinary completion still requires an empty identity-bound root or `artifacts_removed`.

## [0.12.5] - 2026-07-30

## [0.12.4] - 2026-07-30

## [0.12.3] - 2026-07-30

### Fixed

- The release cut no longer deletes previously released changelog headings whose body is empty. `releasedChangelogContent` ran `removeEmptyVersionEntries` before transforming `## [Unreleased]`, so cutting a release replaced the prior empty semver heading instead of inserting the new one above it — v0.12.2 dropped the `## [0.12.1] - 2026-07-29` heading from four package changelogs. Released sections are now immutable history and are always preserved.

## [0.12.2] - 2026-07-30

### Added

- `gjc ultragoal quality-gate init` scaffolds a multi-surface quality-gate template (`--surface` repeatable, `--out` required) so agents can fill evidence once and use read-only `quality-gate validate` multi-error diagnostics instead of discovering missing fields one checkpoint at a time (#3474).
- Ralplan can persist a typed `disposition` stage (`ralplan.review_conflicts.v1`) when Architect and Critic prescribe incompatible actions on the same plan target. Writes fail closed until every conflict has an explicit disposition, and source receipts must resolve against the same-pass Architect/Critic rows in the run index (#2902).
- Published bounded, redacted, hash-bound sealed perf-corpus memory evidence and an output-free replay notebook. The authenticated analysis identifies sustained heap growth on the `agent-session` and `tui` surfaces while keeping RSS/native allocation and p95 claims explicitly out of scope.
- The interactive terminal’s responsive IRC/todo work-lane contract now covers exact narrow/wide geometry, requested versus effective IRC visibility, direct-root pin ordering, todo lane bounds, remapped IRC toggles, and live composer shortcut hints.
- Managed-session startup now preserves bounded Windows ACL and identity failure classifications in path-redacted recovery guidance without broadening permissions, elevation, or unsafe fallback.

### Fixed

- Terminal input now normalizes Option/Meta navigation and psmux modified-Enter encodings through the native key parser, keeping legacy, Kitty CSI-u, and modifyOtherKeys behavior consistent.
- Ultragoal CLI replay no longer executes model-authored test source or trusts `replaySafe: true` as arbitrary command authority. Runtime replay is limited to the pinned Bun runtime for `--version` and literal `-e "console.log(...)"`; shells, interpreter code strings, path-qualified executables, tests, install/publish/network/git mutation commands, and arbitrary argv are rejected. Replay cwd/artifact files are realpath-confined, ambiguous rows fail closed, stdout and stderr are checked, and POSIX timeout cleanup signals the process group. Structured test-report fallback remains deliberately unsupported pending a separate trusted-provenance design (#3533).
- Ultragoal CLI replay evidence now reads the replay file referenced by an `executorQa.artifactRefs` entry whose `kind` is `cli-replay`. Inline, nested, and file-backed replay forms are disambiguated explicitly; mixed or malformed rows fail closed (#3533).

- Broker artifact cleanup no longer promotes a non-empty `cleanup_pending` quarantine to transcript-phase completion. The broker advances only when the retained quarantine is root-only/empty or when the lower layer returns `artifacts_removed`, so artifact bytes cannot vanish behind a success receipt (#3489).
- `gjc --worktree` / `gjc -w` launch no longer crashes with a raw uncaught `EEXIST` when the worktree bucket directory (`<repo>.gajae-code-worktrees`) is a broken symbolic link to unmounted or offloaded cold storage. The launch distinguishes dangling links and non-directory entries from valid directory symlinks or Windows junctions, reclassifies mkdir races, avoids disclosing raw link targets or unsafe shell commands, and never deletes or replaces an obstructing entry.
- POSIX parent identity reproof/fsync is now centralized before every promotable artifact-phase result, preventing a crash-window where a rename is lost after durable retirement is recorded (#3489).
- Artifact retirement, planned paths, retained authority, and transcript retry in both managed reconciliation and deletion now bind to the newest published `pendingEvidence` attempt, preventing stranded detached transcripts at paths absent from the newest receipt after a crash (#3489).
- Provider retry classification prefers the typed `stream_first_event_timeout` transport fact when present, falling back to error-message regex for message-only callers (#3496).
- Detached task receipts for in-memory parent sessions no longer advertise dead `agent://` output URIs. TaskTool allocates a session-lifetime durable artifact root under the process temp directory, persists child outputs there, authorizes parent and same-session descendants for scoped resolution, and omits the URI entirely when durable allocation fails (#3471).
- Managed-session replacement and cleanup now bind Windows destination mutation to exact native identity, keep lock acquisition/release retryable without reviving lost ownership, and report retained artifact payloads as `cleanup_pending` until only the verified root remains.
- Resuming a session no longer crashes with an unhandled rejection when another session transition is already running. The session picker dispatches resume through a void-returning callback, and `handleResumeSession` had no re-entrancy guard, so a second selection (or a resume issued while compaction, handoff, or a fork was in flight) reached `switchSession` and the `{ code: "busy" }` transition error rejected a promise nobody awaited. Resume now ignores an overlapping request with a status message, reports a busy transition as status, and still propagates every other failure. The progress lease is released on all paths.
- The interactive `Working…` indicator now remains visible and explicitly labels owner-scoped detached background work across foreground completion, provider errors, pending-submission aborts, and job completion, without resurrecting after TUI disposal (#3479).
- Activity-indicator suspension now detaches and restores the exact owned loader instead of stopping foreign transition UI; optimistic pre-init prompts still show and clear their spinner, context clear retains its eager teardown contract, and resume cancellation preserves transient state until session mutation actually begins.
- Activity-indicator stop and suspension helpers now fail safely for lightweight controller contexts with absent or partial status rails, while full interactive contexts retain exact loader detach/restore ownership.

## [0.12.1] - 2026-07-29

### Fixed

- Provider retry classification prefers the typed `stream_first_event_timeout` transport fact when present, falling back to error-message regex for message-only callers (#3496).
- Team Linux worker memory-guard replacement no longer holds the team task-mutation fence across the successor startup-ack wait, so concurrent `worker-startup-ack` can publish and selector-replacement no longer hangs under CI contention.
- Kitty/Ghostty inline images no longer remain visually pinned when transcript, pinned, or overlay rows are replaced, removed, scrolled, resized, or fully repainted. The TUI now parses only bounded named placements, soft-deletes overwritten placements from the previously committed physical frame, retains transmitted pixels, and restores placements from application scrollback without retransmitting image data.
- Reviewer `report_finding` evidence is no longer injected into caller-owned strict JTD completion data; full findings are published separately through a bounded artifact reference, and failed evidence publication now fails the task closed (#2893).
- Bash output-tail initialization now tolerates constrained `ToolSession` settings adapters that expose `get()` without `has()`, preserving the 1 KiB default and explicit head/tail overrides instead of crashing restricted and interceptor Bash execution.
- Managed-session startup failures now include their bounded preparation classification (and path-free native durability diagnostic when available), so Windows launch crashes no longer collapse to an unactionable generic error while filesystem paths and raw OS messages remain redacted (#3383).
- Single-model sessions now rotate immediately to another stored provider credential after a content-free quota or rate-limit failure, without requiring a synthetic model fallback chain. Credential rotation is replay-safe for content-free failures regardless of extension lifecycle participation, and traverses the full credential pool independent of `retry.maxRetries` (#3491).
- External credential discovery now follows `CLAUDE_CONFIG_DIR` and `CODEX_HOME` instead of always reading `~/.claude` and `~/.codex`, so importing from an account switcher (or any relocated Claude Code / Codex CLI config root) picks up the account the launching shell selected. Both variables resolve through the credential env trust boundary and must be absolute; redacted summaries name the variable, never the resolved path.
- The `acp_conformance` CI job runs again. The pinned upstream `acpx` checkout resolves its own imports (`@agentclientprotocol/sdk`, `zod`) from its own tree, but its dependencies were never installed, so the corpus runner aborted with `Cannot find module 'zod/v4'` before executing a single case. The checkout is now installed after provenance verification, and the reused warm cache still skips the reinstall.
- ACP prompt terminalization now binds each accepted execution handle to one immutable cancellation domain, reserves producer ownership before terminal publication, and quarantines only the exact run when settlement cannot be proven. The fixed 10-second fail-closed external error remains unchanged while internal diagnostics report only bounded resource kinds, hashed labels, clamped ages, and omitted counts.

### Added

- User-created Telegram forum topics can now start a GJC session by selecting the home folder, choosing a verified recent work folder, or entering an explicit folder path. The selected topic is adopted by the new session without creating or deleting a separate Telegram topic.
- The interactive terminal’s responsive IRC/todo work-lane contract now covers exact narrow/wide geometry, requested versus effective IRC visibility, direct-root pin ordering, todo lane bounds, remapped IRC toggles, and live composer shortcut hints.

### Fixed

- Detached subagents spawned by the `task` tool are resumable again. The resume gate treated a missing record-level `sessionFile` as missing context even though task and managed-persistence sessions retain the descriptor consumed by the resume runner, so persisted role agents always fell back with `context_unavailable`. Resume eligibility now accepts an owner-compatible retained descriptor while preserving `not_found`, explicit `context_unavailable`, missing-runner `no_runner`, and `resume_failed` outcomes.
- Ralplan supports opt-in automatic handoff to ultragoal or team through a durable runtime-owned final receipt, with read-only team preflight and PLANNING-STUCK dominance.
- Subagent setup failures now retain a bounded, redacted cause through live progress, async snapshots, inspect/await, and terminal receipts instead of reporting an empty generic failure.
- Telegram notification sound can be set to all, important, or none; the reference CLI exposes this with `--sound <all|important|none>`, defaulting to all. Important (ask/idle only) and none are explicit opt-ins for quieter notifications.
- First-event provider timeouts are configurable and replayed only by AgentSession with a bounded attempt budget, progress-aware safety checks, and measured exhaustion details.
### Fixed
- Telegram image delivery now converts WebP and other decodable image formats to Telegram-compatible JPEG or PNG photos, preserves MIME types for files sent with `telegram_send`, and falls back to named document uploads when conversion is unsupported or invalid.
- `bun run install:dev` now removes only Bun launchers that resolve to the current checkout's CLI wrapper before validating the managed source link, preventing `bun link` from leaving `~/.bun/bin/gjc` ahead of the new `~/.local/bin/gjc` link on `PATH`.
- A same-tree detached/resumed subagent could not read a verified `agent://`/`artifact://` reference its parent could read (`No session - agent outputs unavailable`), even though parent/child/sibling tree reads are an explicit acceptance criterion of #326: the runtime never supplied `ToolSession.getAuthorizedArtifactsDirs`, so an adopted subagent (whose own `getArtifactsDir()` intentionally collapses to `null`) reached the scoped resolver with zero authorized directories. `ToolSession` now exposes `getAuthorizedArtifactsDirs`, derived only from the session's own explicitly adopted/shared `ArtifactManager` directory, and it is threaded through `read`, `find`, `search`, `ast_grep`, and `ast_edit`'s internal-URL resolution. No registry-wide session enumeration was added; unrelated sessions, missing metadata, and integrity failures remain denied and fail-closed exactly as before (#3302).
- The auth-broker connection (`GJC_AUTH_BROKER_URL` / `GJC_AUTH_BROKER_TOKEN`) is now resolved from trusted environment sources only. `discoverAuthStorage()` turns that configuration into the `AuthStorage` used for every provider, so reading it through the merged view that includes the caller's `cwd/.env` let a repository replace the agent's credential store wholesale — serving the credentials it authenticates with and receiving the ones it writes back. Resolution now uses the non-project resolver; shell, config-file and token-file configuration is unchanged.
- Image generation now resolves its OpenAI base URL and its `GOOGLE_API_KEY` fallback from trusted environment sources only. Both were read through the merged view that includes the caller's `cwd/.env`, so a repository could plant a `.env` choosing where authenticated image requests go, or supplying the credential they authenticate with. They now use the non-project resolver; shell and user-level configuration is unchanged, and the trusted `getEnvApiKey("google")` lookup still takes precedence over the fallback.
- GJC-managed tmux sessions work on macOS again. `gjc session create` failed with `gjc_tmux_profile_tag_failed_cleanup_failed` and leaked the session it had just created, and every close path failed with `gjc_tmux_owner_unverifiable` or `managed_owner_supervisor_signal_failed`. Three non-Linux gaps fed each other: guarded mutations pinned `#{pid}` to the placeholder PID that non-Linux server probes report (which no live tmux server can match), the owner start-time proof only read `/proc`, and SIGTERM dispatch only used the pidfd/handle-backed native signal that deliberately fails closed on macOS. Guards now emit the `#{pid}` clause only for a proven PID, the start-time proof falls back to the natives process incarnation off Linux, and macOS delivers SIGTERM to the already-proved owner PID. Session identity is still pinned by session id, session name and owner generation, and Linux behaviour is unchanged.

### Changed

- Session Observer now incrementally projects append-only session messages and narrowly patches late tool results, avoiding repeated full-history transcript projection while preserving eager output parity and safe full-projection fallback for ambiguous source changes.
- Compaction now publishes complete pruned tool outputs as session artifacts transactionally, carries active goal/workflow/todo state into summaries, and skips synthetic auto-continue when no unfinished work remains.

### Fixed

- Explicit `--mcp-config` sessions now honor each server's configured connection timeout during startup instead of aborting otherwise healthy tools-only servers at the ordinary 1.75-second startup ceiling; sessions without an explicit config retain the existing bounded startup policy.

### Resume fixes

- Eager todo initialization now gives the model the actual phased `todo_write` payload shape (`ops` → `init` → `list` → `phase`/`items`) instead of instructing it to send unsupported `content`, `details`, and status fields, preventing the first forced todo call from failing validation (#3403).

### Fixed
- Fast CLI help now advertises the active `search` built-in tool instead of the retired `grep` name.
- `bun run restart:sdk-broker` no longer crashes with an uncaught `unknown broker operation` error when the live broker predates the `broker.shutdown` operation; the restart now falls back to an identity-fenced `SIGTERM` on the published broker pid, which stops that process through the same rollback path before the replacement is started.
- `bun run restart:sdk-broker --close-session-hosts` closes the broker-hosted sessions before replacing the broker, so ACP clients no longer reattach to session hosts that keep serving the source they were spawned with. Only sessions served by a `sdk session-host-internal` process are selected, and each one is closed through the live broker's verified-identity teardown.

- Coordinator MCP now reconciles canonical structured questions from every workflow stage without misclassifying row-level gate diagnostics as malformed pagination, and unwraps accepted SDK gate-answer envelopes before reporting the terminal resolution.
- Queued named tool choices are revalidated against the live model and active tool set before each request, preventing first-turn eager todo, resolve, or yield flows from sending a stale forced choice after preflight tool changes.
- Ralplan role-agent writes now resolve an existing run's immutable owner session instead of creating workflow state and artifacts under each Planner/Architect/Critic transcript session; conflicting explicit session ids fail closed, and receipts expose the owner `session_id`.
- Subagent task panels now show the fast-mode glyph for the resolved provider in both live and completed states (#3402).
- Auto-retry now strips the whole trailing run of failed assistant attempts before continuing. A turn wedged by an `invalid_prompt` repair leaves two error assistant messages behind, and dropping only the last one left an assistant tail that `agent.continue()` refuses, so the retry died with "Retry continuation failed to start" and the turn was lost.

- Session Observer now receives persisted subagent session paths on lifecycle and progress events, so active ralplan reviewer transcripts render instead of remaining at `No transcript entries yet`.
### Changed

- Bash tool output now keeps only the last 1 KiB when it exceeds the inline capture budget, reducing noisy model input and nudging callers toward focused commands and dedicated search tools. Users who explicitly configure `tools.artifactTailBytes` or `tools.artifactHeadBytes` can set the tail budget or opt into head+tail middle elision. Complete streams received by the Bash tool remain artifact-backed when storage is available; client-truncated ACP tails stay explicitly marked incomplete and cannot be reconstructed locally. Direct user `!` commands retain the existing shared executor window.

## [0.12.0] - 2026-07-28
### Resume fixes

- Status-line pull-request discovery no longer lets the background `gh pr view` process inherit the interactive TUI's stdin, preventing a misconfigured or prompting `gh` executable from stealing keystrokes; the lookup now also fails closed when `gh` is unavailable and terminates after a bounded timeout (#3354).
- Completed `!` shell commands issued during an active agent turn now leave the bottom-pinned pending surface immediately instead of obscuring the live status area until the next prompt; the completed command is still retained for normal transcript insertion.
- The typed deep-interview repair CLI (#3040 and its follow-ups) was reverted and replaced with a minimal staged-transition surface: `gjc deep-interview stage --for <transition> --input '<json>'` (or `@file`), `check`, `apply`, and `discard`. The payload is one JSON document merged losslessly into current state — no per-field flag grammar. The session resolves from `GJC_SESSION_ID`, exactly one pending draft exists per session (no `--draft-id`), and the draft records the state revision it was staged against so `apply` CAS-checks it runtime-side; a stale draft is auto-invalidated with typed recovery guidance. `check` dry-runs the identical merge `apply` performs. Validation is core-schema only (envelope shape, bounded input sizes, locked intent-contract immutability); free-form interview fields pass through untouched.
- `gjc team` workers now publish their own heartbeat while a turn or owned background job is active, so a worker inside a single long tool call is no longer reported stale and stripped of its task claim. Liveness was published only when the model remembered to call `gjc team api update-worker-heartbeat` between turns, so any tool call longer than `GJC_TEAM_HEARTBEAT_STALE_MS` (default 120s) — a build, a test suite, a large read — caused the claim file to be deleted, the `in_progress` task to be reset to `pending`, and the worker to be refused re-claim with `worker_not_live:<worker>:stale_heartbeat` while it was still running, all against a 30-minute claim lease. The worker session now publishes at a third of the stale window (minimum 1ms, capped at 30s) from the top-level session only, and `gjc team` exports the configured window into worker panes so a tightened window applies to the workers policing it too. Recovery semantics are unchanged: a worker that publishes nothing is still recovered exactly as before.
- With all-tool discovery enabled, `task.eager` now keeps the `task` tool active so its delegation instruction can actually be followed; discovery guidance now distinguishes activating a tool from executing it and directs explicit parallel/delegation requests to discover the subagent capability before claiming workers started.
- Unknown `gjc team api` operations now fail as normal CLI usage errors instead of invoking the global uncaught-exception crash reporter. JSON mode returns a compact typed receipt with the invalid operation and suggestions; text mode prints one actionable line. Common mistakes such as `heartbeat` now point to `read-worker-heartbeat` or `update-worker-heartbeat`, and operation validation runs before team-state lookup so a missing `team_name` cannot hide the actual command error.
- Memory consolidation redacts GitHub tokens. The scrubber covered AWS ids, JWTs and keyword-prefixed keys, but GitHub tokens carry none of those keywords, so they reached `MEMORY.md` and `memory_summary.md` verbatim — and the summary is injected into every later session. Now covers the same three prefixes the contribution-prep scrubber already handled.
- The native skill hook resolves its config paths through the trusted directory helpers. It read `GJC_CODING_AGENT_DIR` / `GJC_CONFIG_DIR` straight from `process.env`, which Bun populates from `cwd/.env` before any module runs, so a repository could point the hook at a directory it ships and inject its own `skills.customDirectories` — bypassing the escalation guards that already exist for exactly this.
- Workflow settings are read from the config root under home. `GJC_CONFIG_DIR` is documented as a dirname under home and `dirs.ts` implements it that way, but the ralplan, ultragoal and deep-interview settings readers used the value as a full path, so setting it to the documented form made them look under the current working directory and silently fall back to built-in defaults.
- Session resident-cache directories are now swept when the process exits abnormally. `EphemeralBlobStore` removed its directory only in `dispose()`, and the directory name embeds the pid, so a terminated run's cache could never be collected by a later run. A developer machine held seven of them from dead pids, up to 26 days old, totalling 13.4 MB of externalized session text.
- Align managed fallback abort-after-exhaustion expectations with #3257 ownership release: a subscriber abort at terminal `message_end` no longer expects a second `requestRunTerminal(cancelled)` because the logical-run owner is already cleared.
- Python eval timeout annotations now prefer the caller-configured `timeoutMs` over remaining wall-clock budget so async setup cannot flake second formatting in CI.
- Overflow maintenance now stops cleanly when no-op compaction would replay the same oversized request; the runtime status explains that `/clear` preserves the current session ID before retrying.
- The Smithery origin, API base and API key (`SMITHERY_URL`, `SMITHERY_API_URL`, `SMITHERY_API_KEY`) are now resolved from trusted environment sources only. The origin serves the CLI auth session the user is sent to, the API base receives `Authorization: Bearer <apiKey>` on every call and returns the connection records the agent consumes, and the key is that credential — all three were read through the merged view that includes the caller's `cwd/.env`. Shell, config and stored-credential paths are unchanged.
- `gjc gc` now reports and prunes stale session local roots. Every session gets its own `<tmp>/gjc-local/<session-id>` directory seeded with a migration marker, and nothing ever removed them, so machines accumulated one per session indefinitely. Only marker-only directories past a 24h grace window are eligible, so a root holding real content or belonging to a session that just started is never touched, and prune re-validates immediately before removing.
- `docs/environment-variables.md` now describes the `$env` loading order as implemented. The login shell rc files (`~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.bash_profile`, `~/.bashrc`) are a real sixth source and were missing from the list, and the page claimed `.env` files mirror `GJC_*` keys to `GJC_*` keys — a rule that is self-referential and that no code implements in either direction.
- The package no longer advertises `./extensibility/custom-commands/bundled/review`. That module was deleted when the bundled agents were trimmed to four canonical role agents (#922), but its `exports` entry stayed, so the published surface declared a subpath that fails to resolve. A test now checks every declared `exports` / `main` / `module` / `types` / `bin` target resolves to a file that exists.
- `docs/fs-scan-cache-architecture.md` now points at files that exist. It referenced a `packages/natives/src/` tree that the package does not have (its JS surface is the generated `native/index.js` / `native/index.d.ts`), the grep tool as `tools/grep.ts` when it is `tools/search.ts`, and a `src/patch/index.ts` for the hashline flows that live in `tools/ast-edit.ts`.
- Provider base URLs resolved from the environment by the model registry are now read from trusted sources only. `resolveProviderBaseUrlFromEnv()` used the merged view that includes the caller's `cwd/.env`, and it is generic — `<PROVIDER>_BASE_URL` is derived for any provider on top of the explicit `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `GOOGLE_BASE_URL` / `GEMINI_BASE_URL` aliases — so a repository could plant a `.env` that redirected authenticated traffic for every provider, including re-admitting a redirect the provider-level resolvers reject. It now uses the non-project resolver; shell and user-level configuration is unchanged.
- Web-search provider endpoints and keys are now resolved from trusted environment sources only: `KIMI_SEARCH_BASE_URL` / `MOONSHOT_SEARCH_BASE_URL`, `KIMI_SEARCH_API_KEY` / `MOONSHOT_SEARCH_API_KEY`, `XAI_SEARCH_BASE_URL`, and `ANTHROPIC_SEARCH_BASE_URL` / `ANTHROPIC_SEARCH_API_KEY`. Each provider sends its credential to the endpoint it resolves, so reading them through the merged view that includes the caller's `cwd/.env` let a repository redirect search traffic and collect the user's search credentials. Shell and user-level configuration is unchanged.
- The Exa MCP API key (`EXA_API_KEY`) is now resolved from trusted environment sources only. The key authenticates every Exa MCP call and travels in the request URL, so reading it through the merged view that includes the caller's `cwd/.env` let a repository decide which account the agent's searches run through — and therefore who could see those queries. `findApiKey()` also now returns `null` rather than `undefined` when nothing supplies a key, matching its declared type.
- The notifications channel switch and the Telegram reference client's bot credentials are now resolved from trusted environment sources only. `notificationsEnabled()` read `GJC_NOTIFICATIONS` / `GJC_NOTIFICATIONS_TOKEN` straight from the merged view that includes the caller's `cwd/.env` — unlike its siblings in `config.ts` and `session-control.ts`, which already read an injected env record — so a repository could open the session control/answer channel. The Telegram client's `GJC_TG_BOT_TOKEN` / `GJC_TG_CHAT_ID` fallbacks had the same exposure, and that client is normally run from inside a repository, so a planted bot token would have routed the session's notifications and the operator's replies to a bot the repository chose.
- SearXNG search configuration (`SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`, `SEARXNG_BASIC_USERNAME`, `SEARXNG_BASIC_PASSWORD`) is now resolved from trusted environment sources only, completing the web-search provider family. The endpoint receives the `Authorization: Basic`/`Bearer` header, so reading these through the merged view that includes the caller's `cwd/.env` let a repository redirect the search and hand over the credential. An intentionally empty username or password remains meaningful for basic auth and is still honoured when it comes from a trusted source, while an empty value planted by the project `.env` is rejected.
- The `natives-*` architecture docs no longer describe native APIs that were removed. `countTokens`, `PhotonImage.parse/resize/encode` and `projfsOverlayProbe/Start/Stop` are absent from the addon's JS surface, and `tokens.rs`, `image.rs` and `projfs_overlay.rs` are not in the crate. ProjFS now reaches users through the iso backend (`isoProbe`/`isoStart`/`isoStop` with `IsoBackendKind.Projfs`, implemented in the `pi-iso` crate), and image decode/transform/encode moved to `Bun.Image` in TypeScript.
- `docs/ooo-bridge-extension-contract.md` no longer inverts the scope of the two directory overrides. `GJC_CONFIG_DIR` is a home-relative name (`<home>/<name>`, default `~/.gjc`), not a project directory name, and `GJC_CODING_AGENT_DIR` overrides the agent directory path through `path.resolve` rather than naming a directory under `$HOME`.
- Telegram deep-interview multi-select prompts now mark each option as checked or unchecked after every selection while preserving canonical option values and numeric callback routing.
- SDK revision-store spill directories are now removed when the process exits abnormally. `close()` already removed them, but a terminated session never reaches `close()`, so the spilled snapshot payload stayed in the system temp directory — unlike the sibling `shell-snapshot` and `python-runner-artifact` caches, which already registered a postmortem sweep. Only `mkdtemp` spill directories are tracked; a caller-supplied `storageDir` is durable session storage and is never swept.
- The `ask` tool no longer rejects a JSON-string-encoded single-sided Round 0 payload before coercion; only the retired contract+review pair stays terminal, so a provider that serializes `questions` as a string no longer drives the model into an unbounded retry loop.
- Browser launch overrides (`PUPPETEER_EXECUTABLE_PATH`, `PUPPETEER_PROXY`, `PUPPETEER_PROXY_BYPASS_LOOPBACK`, `PUPPETEER_PROXY_IGNORE_CERT_ERRORS`) are now resolved from trusted environment sources only. `Bun.env` is `process.env` and the env module merges the caller's `cwd/.env` into it, so a repository could previously plant a `.env` that chose the browser binary, routed every request through its own proxy, and disabled certificate validation. Resolution now goes through the non-project resolver (launching shell plus GJC/user-owned `.env` files); shell-level configuration is unchanged.
- The tab-worker native-free import contract no longer invents import edges: its re-export scanner matched a bare `export` declaration followed anywhere later in the file by ` from "…"`, so a `from` inside a comment or string produced a phantom dependency. It now matches real re-export syntax (`export * from`, `export * as ns from`, `export { … } from`) only, and still fails on genuine barrel imports and re-exports.
- The spawned command overrides `GJC_SDK_SESSION_COMMAND` (broker session host) and `GJC_HARNESS_PROCESS_START_COMMAND` (harness process-start probe) are now resolved from trusted environment sources only. `Bun.env` is `process.env` and the env module merges the caller's `cwd/.env` into it, so a repository could previously plant a `.env` choosing which binary those paths execute. Resolution now goes through the non-project resolver (launching shell plus GJC/user-owned `.env` files); operator and test usage is unchanged, and a malformed harness override stays fatal rather than falling back to `ps`.
- macOS screenshot paths now recover the narrow no-break space before `AM`/`PM` for any following separator, so IDE-attached files such as `Screenshot … 11.23.30 PM-1785075812409.png` resolve instead of failing with `ENOENT`; word continuations like ` PMX` are left untouched.
- ACP failures now reach the client with a real JSON-RPC code instead of collapsing to an opaque `-32603 Internal error`: internal string codes with an ACP counterpart map onto auth-required, resource-not-found, and invalid-params, the rest keep their discriminator in `data`, and translation happens once at the connection boundary. An unrecognized `extMethod` now returns `-32601` rather than a resolved `{ok:false}` payload.
- ACP `Diff.path` is emitted absolute as the schema specifies, `ResourceLink.size` is forwarded only when it is a safe non-negative integer, and a failed tool update no longer overwrites `kind` with `other`, so clients keep the category they use for icons while failure stays carried by `status`.
- Interactive `/resume` no longer awaits ordinary notification-endpoint rotation after predecessor fencing when the transition is stamped `interactive_selector_resume`; lifecycle/SDK identity-control paths still await readiness and use a fail-closed control-drain orchestration that sends terminal control outcomes only after successor readiness, while uncertain predecessor stop no longer starts the successor (#2914).
- Interactive TUI `/resume` commits a status-container progress lease before inspect/migration/switch work and clears it on every exit path, with generation-scoped render-commit wait that fails open when the terminal is stopped or unavailable (#2914).
- Interactive `/resume` progress lease fails open when `statusContainer` or UI lacks child-mutation/render-commit surface, preserving headless/minimal controller contexts without weakening full TUI progress-before-switch (#3234 post-merge).
- The documented `GJC_OPENAI_CODE_WEB_SEARCH_MODEL` environment variable now overrides the OpenAI-code web-search model; it is resolved GJC-first ahead of the legacy `PI_CODEX_WEB_SEARCH_MODEL` name (previously only the legacy name was read, so the documented name was a silent no-op).
- ACP prompt completion no longer hangs clients: terminal prompt outcomes are now projected through ACP after the SDK finalizes them.
- Prompt terminalization now exposes exactly one normalized outcome per accepted prompt, preserving the terminal reason or controlled failure code across SDK and ACP clients.
- ACP clients can reconnect to a live session while replaying their MCP server declarations. The live session keeps its immutable MCP configuration instead of rejecting the reconnect as a configuration mutation.
- ACP `AskUserQuestion` now routes through the registered SDK UI provider as a schema-valid form elicitation, including selector, free-text, and navigation-control responses for Air.
- Telegram `/session_create` and cold resume no longer route macOS or other non-Linux hosts through the Linux-only managed-owner supervisor. Non-Linux launches now bind success and cleanup to the exact tmux server, native session, and live pane process identities, scrub inherited managed-owner authority, and reject children that die during launch stabilization; Linux keeps its existing owner-isolation transaction.

### Changed

- Session Observer and the main transcript viewer no longer re-project and re-layout their full transcript on every paint. Source changes still refresh through registry/session-event notifications, while navigation rebuilds only affected layout variants; deterministic counters and replacement-safety coverage preserve selection, follow-tail, raw, expanded, fullscreen, mouse, theme, width, and source-replacement behavior.

### Added

- Deterministic tests for session_switch await policy (selector defer vs default/branch await), control-drain ordering, host pre-response readiness gating, and resume progress lease-before-switch behavior (#2914).
- Added `bun run restart:sdk-broker` for authenticated, identity-checked SDK broker replacement during local Air/ACP testing.
- Added an isolated Bun memory-baseline corpus with short/soak profiles across CLI, AgentSession, blob buffers, workers, Telegram, TUI, and shared/native boundaries; reports keep RSS, heap, external buffers, process-tree endpoints, active resources, throughput, and teardown evidence separate and advisory until variance is characterized.
- Telegram per-tool activity is now opt-in and remains durably controllable with `/toolactivity on|off` or the Notifications preferences UI; disabling it suppresses tool start/completion success and error bubbles without hiding assistant, ask, or session notifications.
- `/model`, `/login`, and `/provider` now order providers through one shared ranking: providers you already have (valid auth, in-flight validation, or a configured non-OAuth provider) come first, then providers whose stored credentials failed validation, then a curated list of well-known providers with regional and device variants grouped behind their primary, then everything else by display name. In `/model` rows, role/default rank and recent usage still take precedence over provider order (#3243).
- Ralplan now bounds architect and critic re-review lanes independently through `gjc.ralplan.maxReviewPassesPerLane` (integer 1–10; default 1). Per-lane budget exhaustion emits a lane-specific `PLANNING-STUCK` exit 3, fails closed against on-disk artifact floors, and repairs crash-gap retries. Architect and critic `gjc ralplan --write` calls can optionally pass `--lane-verdict`, which drives HUD lane pass counts and the latest verdict; critic/architect prompts and the ralplan SKILL workflow now ratchet re-reviews through persisted receipts.
- Ralplan consensus review lanes now persist same-session Architect and Critic subagent metadata (`--architect-id` / `--architect-resumable`, `--critic-id` / `--critic-resumable`) and resume those reviewers by default on pass 2+ with the mandatory re-review context bundle. Unavailable reviewer context falls back to a fresh lane spawn with role-scoped fallback metadata, preserving the existing sequential re-review cadence and receipt-only contract.

## [0.11.11] - 2026-07-26

### Added

- Added cross-platform memory-pressure observability with effective host/cgroup limits, configurable GC and restart advisory thresholds, typed Linux process probes, and a Windows Job Object native probe; unsupported lifecycle actions remain advisory-only.
- Added versioned memory-guard checkpoints with strict transcript/blob validation and fail-closed cross-process writer/TTY ownership claims for future graceful restart activation.
- Ralplan consensus planning now enforces a finite planner/revision iteration budget at the native write path (default 5, configurable via `gjc.ralplan.maxIterations`). Opening another planner/revision pass past the cap fails closed with exit code 3 and an operator-visible `PLANNING-STUCK` marker instead of silent unbounded re-review; `final`/post-interview escalation remains allowed without auto-implementation. The cap also floors against on-disk `stage-*-{planner,revision}.md` artifacts so a wiped, truncated, or malformed `index.jsonl` cannot fail open after prior openers (#3165).
- Added `grok-45-eco`, `grok-45-medium`, and `grok-45-pro` built-in xAI presets for `grok-4.5`; every role stays within the model's `high` reasoning cap, while the `xai` provider recommendation remains `grok-medium` to preserve existing defaults (#3177).
- JetBrains Air ACP sessions now preserve final answers across fast prompt completion, expose tool/retry/goal/notices and session title updates, apply Air's legacy `session/set_model` preset changes through the canonical session configuration path, accept client-supplied stdio/HTTP/SSE MCP servers, reject unsupported additional directories, and reject unavailable model presets before provider dispatch.
- Mouse support can now be enabled inside tmux and screen with `mouse.enabled: true`, so the wheel scrolls GJC's virtual session viewport before multiplexer scrollback. Dragging highlights rendered terminal text and copies it to the system clipboard on release while GJC owns mouse input. Mouse support remains disabled by default to preserve native terminal or tmux scrollback and selection behavior.
- macOS queue controls are now discoverable and platform-native throughout the composer, status/help surfaces, and queue editor: Option+Q queues while busy, Option+Up/Down selects queued messages, and the queue pane documents edit/remove/reorder controls. Added Windows-to-macOS default-shortcut parity coverage and terminal guidance for Option-as-Meta, enhanced protocols, and Control-key remaps.

### Changed

- When GJC owns mouse input (`mouse.enabled: true`), mouse-wheel scrolling moves the session viewport by three rows per notch instead of a full page. PageUp/PageDown keep page-sized transcript-lane steps.
- While reviewing transcript history, the status line and composer stay fixed at the bottom. Semantic assistant/tool output and visible capped-sidebar changes show `New output — type to follow`; duplicate, elided, hidden, geometry-only, and theme-only changes do not. Ordinary typing or paste returns to live output before editing without changing editor focus.
- Telegram per-tool activity is now opt-in and remains durably controllable with `/toolactivity on|off` or the Notifications preferences UI; disabling it suppresses tool start/completion success and error bubbles without hiding assistant, ask, or session notifications.
- Model preset landing now shows explicit `Enter: apply` and `d: set as default` hints; pressing `d` applies the highlighted profile as the default while Enter keeps the session-only apply path (#3161).

### Fixed

- Session Observer now reads stable source snapshots, publishes only complete JSONL appends, validates replacement candidates, and clears stale transcript/model/tool content on source replacement, truncation, deletion, unreadability, or malformed candidates. Its transcript projection remains eager full-history work; this does not add virtualization or bounded full-history memory.
- Session-manager fork/moveTo failure-injection tests now use a platform-aware hermetic seam: retained `RecoveryFsRoot` prototype spies on Linux and the direct native/fs fallbacks off Linux, with a required hit counter so a dead injection fails closed (#3209).
- The #3216 win32 cleanup-producer regression no longer hardcodes divergent directory size `4096`; it injects `nativeRoot.size + 1` so the test stays hermetic when Linux directory size is already `4096` (post-merge Dev CI red on `79f0de870`).

- The synchronous `local://` resolver now accepts a `cleanup_pending` legacy-migration marker instead of rejecting it as unsafe. The async gate already treats that state as settled — entries are installed and content-verified, and only retirement of the legacy source is outstanding — so a managed session whose migration ended in `cleanup_pending` previously failed closed with "Unsafe local:// migration marker" on every `local://` read even though `initializeLocalRoot()` had succeeded. Both marker checks now share one settled-state definition; unrecognized marker values are still rejected. Follow-up to #3080; the asymmetry has been reachable since #2797.
- `/new`, `fork()`, handoff, `/resume`, and branch/tree-jump transitions privately prepare successor identity/transcript/artifacts and immutable managed migration authority, run verified managed `local://` readiness as the last fallible action, then synchronously adopt and publish — so no public manager/agent getter sees the successor before readiness. Pre-commit failure exact-discards staged state; cleanup authority survives dispose/shutdown; handoff/post-commit faults use committed-degraded contracts. Managed staging renames are sorted for deterministic partial-install rollback. Closes the residual #3080 manager-identity window (#3138; builds on #2797 / #2925).
- Workflow-state readers and handoff paths no longer write corrupt-state warnings straight to `process.stderr`, which painted raw bytes over the live TUI composer during interactive sessions. Warnings now route through the TUI-safe file logger while `gjc state read`/`status`/`handoff` still surface them on the structured command-result `stderr`, so corrupt state stays distinguishable from absent state for CLI/automation (#3002).
- Managed model fallback now gives each exhausted entry at most one retry with a rotated credential before advancing, so repeated quota failures cannot consume the attempts reserved for downstream models.
- Windows managed-session artifact migration now uses the native directory-tree root for retained cleanup identity both when producing `cleanup_pending` records and when validating them, avoiding Bun's zero-valued directory `lstat` metadata and false `durability_failed` results while preserving fail-closed authority checks (#2913).
- Legacy-session artifact migration now retries transient EINTR interruptions during no-replace artifact publishes and classifies exhausted interruptions as pre-mutation failures instead of surfacing `durability_failed` (#3077).
- Alibaba Token Plan first-event timeouts also match the exported lazy-stream watchdog text, preserve sticky fallback selection across later turns, avoid same-candidate auto-compaction replay, and reset attempt/overflow budgets only when an accepted queued steering/follow-up successor starts (#3026).
- Legacy auto-compaction now caps provider `Retry-After` delays at `retry.maxDelayMs` instead of sleeping for an unbounded server hint (#3156).
- Queued steering and follow-up successors now reset predecessor fallback attempt budgets and overflow-maintenance counters only after `continue()` accepts the queued turn, without clearing the sticky fallback cursor.
- Questions about `ultragoal` behavior now stay on the direct-answer path instead of being misclassified as requests to start the durable workflow.
- Workflow intent routing now requires a leading `/skill:ultragoal` for slash-command escalation and recognizes Korean object-particle requests such as `ultragoal을 사용해줘` without routing questions that merely mention the command.
- Aligned the startup GJC Forge splash border with the composer trailing gutter, including the one-row constrained fallback.
- `gjc resume` and delete no longer pay a durable (fsync-backed) lock acquisition for managed session tombstones that have nothing left to reconcile; a scope with many accumulated already-completed tombstones opens noticeably faster (#3067).
- Task output-limit environment overrides now accept only complete positive decimal safe integers; malformed, fractional, exponent-form, whitespace-padded, and precision-losing values fall back to the documented defaults instead of being partially parsed (#3175).
- Task output-limit environment overrides now honor values loaded from agent, config-root, and home dotenv files through the shared utils env loader while retaining strict positive safe-integer validation and canonical GJC-first alias precedence.
- `--thinking` now advertises the supported Effort levels and fails closed with a usage error for invalid, missing, empty, or flag-adjacent values, rather than silently ignoring a token or consuming another flag.
- MCP servers configured with a large `timeout` no longer widen the startup hang window for every consumer. The long startup ceiling now applies only to ACP lifecycle launches that supply their own MCP servers, derived from the session readiness deadline with reserved headroom; ordinary CLI/SDK `mcpConfigPath`, project, user, and plugin-bundle consumers keep the short default. An ACP launch that reaches the readiness cutoff before MCP startup now fails fast as a pending startup instead of silently falling back to the ordinary ceiling.

- SDK MCP stdio (`gjc mcp-serve sdk`) now awaits in-flight JSON-RPC handlers after stdin EOF so tools/call responses finish and WebSocket clients close before process exit; the entrypoint e2e fixture bounds child/server/temp cleanup on success and failure so the suite cannot hang for the full 60s on a stuck server.
- Shared kind-aware durable invocation reconciliation substrate for `turn.prompt` and `skill.invoke` (#3031/#3032/#3035): private `.sdk-reconciliation` store, awaitable preflight accept fence, non-hanging skill early-accept with optional `clientRef`.
- AD-L-G02 daemon session CLI e2e is less flaky under CI load: mock WebSocket servers defer `server_hello` one tick, and query failures report stdout/stderr so a non-zero exit surfaces the real SDK error instead of only `exitCode`.
## [0.11.10] - 2026-07-25
### Changed

- The built-in `claude-opus`, `opus-codex`, and `fable-opus-codex` presets now use `anthropic/claude-opus-5` instead of `anthropic/claude-opus-4-8`, with effort suffixes preserved; `packages/ai/src/models.json` was regenerated so `anthropic/claude-opus-5` resolves; non-opus roles (`anthropic/claude-sonnet-5` executor/planner overrides, codex and fable roles) are unchanged.

## [0.11.9] - 2026-07-24

### Fixed

- Restricted role-agent `bash` now accepts literal mid-word tildes, so git revision syntax such as `git diff HEAD~1` no longer has to be quoted. Bash performs tilde expansion only at the start of a word, so word-initial forms (`~`, `~/path`, `~user`) remain blocked.
- Restricted role-agent `bash` now rejects unquoted tildes at every bash expansion position inside assignment words, including the compound `name+=value` form, so `A=~`, `A+=~`, `foo=~root/bar`, `A=x:~`, `A+=x:~`, and repeated colon segments such as `a=x:~:y:~` fail closed. Tildes bash does not expand — mid-word git revisions (`HEAD~1`), non-assignment words (`--opt=~`, `1abc=~`, `a++=~`, `a+b=~`), and quoted forms — remain allowed (#3117).
- Read-only role agents (`architect`, `planner`, `critic`) now receive the `irc` coordination tool and a read-only git prefix set (`status`, `log`, `show`, `diff`, `blame`, `rev-parse`, `ls-files`) in restricted bash; mutating git and arbitrary shell stay blocked. `irc` also stays in the initial active tool set for subagents whenever the parent runtime reports IRC availability, instead of costing a discovery round-trip (#3109).
- The restricted-bash workflow guard now allows `/dev/null` redirects (so `cmd 2>/dev/null` is no longer treated as a repository write during planning phases) while keeping `/dev/stdout`, `/dev/stderr`, and `/dev/fd/<n>` blocked, failing closed on `exec` redirections, and recognizing `>|`, `>&path`, `<>`, path-qualified writers, and every `dd of=` operand (#3127).
- The vendored `insane-search` engine no longer treats a `429` as terminal: rate-limited probe and grid candidates back off (linear escalation honoring `Retry-After`, hard-capped at 30s) and continue through grid diversity and browser fallback. The backoff base from `INSANE_RATE_LIMIT_BACKOFF_S` is validated and clamped, so non-numeric, `NaN`, infinite, negative, or huge values can no longer raise, hang, or defeat a per-attempt deadline, and sleeps stay short enough to honor cancellation (#3131).
- ACP sessions now apply execution permission decisions to eval calls and to tools invoked from JavaScript or Python eval contexts, while non-ACP session behavior remains unchanged.
- Interactive prompt cancellation now reaches API-key preflight through `ModelRegistry`, allowing aborted submissions to clear immediately even while a shared credential-usage request continues in the background.
- Alibaba Token Plan canonical first-event timeouts now surface without session retry/fallback replay and are not internally retried by auto-compaction, preventing repeated provider usage (#3026).
- Delegated-task and subagent status surfaces now distinguish provider recovery from normal running, identify first-event versus idle-stream stalls, show retry budget and provider-progress age, and aggregate concurrent degradation by provider (#3071).
- Telegram notification daemon ownership hardening (#3048): Bot API outcomes now share one honest classifier so both the initiating `429` response and cooldown-suppressed calls settle retryably instead of being lost or falsely rejected, including selected acknowledgements; exclusive operator work is registered before its callback can throw; notification health degrades corrupt daemon-state JSON to a warning; root-registration ownership tokens propagate through injected and built-in ensure, rollback, reconciliation, teardown, and abandoned-startup cleanup seams, with token-bearing rows refusing tokenless cleanup while genuinely legacy rows retain root-match behavior; and initial daemon readiness is published only after the matching heartbeat sidecar rename is durable, so no waiter can attach during the proof window.
- `/new`, `fork()`, handoff, `/resume`, and branch/tree-jump transitions now complete verified managed `local://` legacy-root migration for the successor session identity *before* that identity is published to the agent, the workflow-gate emitter, or extension hooks, so no observer can resolve `local://` against an ungated root across the gate's `await` boundary. Matches cold-start `createAgentSession()` (#2797) and extends `/resume` (#2925). Sending a prompt right after `/new` no longer fails with "local:// legacy migration must complete before path resolution".

- Telegram notification topics now fence malformed successful `createForumTopic` responses per session endpoint, preventing repeated ambiguous topic creation while keeping explicit Bot API failures retryable.
- Windows managed-session resume no longer reports `durability_failed` when Bun rejects `fsync` on the read-only descriptor used to revalidate an existing canonical binding; Windows now uses an owner-writable descriptor for that durability fence while retaining no-follow and pre/post identity/content checks.
- SDK daemon CLI end-to-end tests now capture spawned child stdout and stderr through temporary files instead of pipes, removing the CI pipe teardown race that replaced the product exit contract with SIGPIPE status 141 (#3024).
- Interactive launch bootstrap is now suppressed for parser-accepted `--print=`, `--help=`, and `--version=` equals forms, keeping non-interactive output free of the warming-workspace preamble on TTYs.
- Managed legacy-session artifact migration now accepts up to 50,000 files, processes copy work in bounded batches, and reports capacity exhaustion separately from unsafe artifact topology (#2935).
- Kimi Code first-event timeouts now surface after the provider's continuous first-event wait instead of replaying the full request from zero.

- Rejected subagent schema payloads now retain their complete structured data in canonical output artifacts; inline results remain bounded while `agent://` output stays lossless (#2894).
- Managed legacy-session artifact migration now validates Windows directory roots from the native tree snapshot, tolerates only lazy metadata on plain Windows directories, and replays both clean and cleanup-pending detaches while retaining fail-closed receipt validation. Canonical binding durability sync uses a writable no-follow handle on Windows NTFS stacks that reject `FlushFileBuffers` on read-only handles (#3015, #2913).
- A single managed session tombstone that fails to reconcile (e.g. an artifact directory identity mismatch) no longer blocks resume or delete of every other session in the same managed scope; the failure is isolated to that tombstone and logged, unless it belongs to the session currently being opened, which still fails closed.
- Added Linux-only team worker memory-pressure replacement with checkpoint classification, bounded retries, deterministic target selection, and fail-closed blocked tasks; Windows and macOS remain advisory-only.

## [0.11.8] - 2026-07-23
### Added

- Keybinding configuration now keeps portable canonical text while runtime shortcut labels render platform-native, including concise MacBook glyphs in inline surfaces and glyph-plus-text accessibility labels in `/hotkeys` and `/help`; `/hotkeys` remains authoritative for effective remapped bindings.

### Added

- Plans and delegated tasks carry an authoritative repository binding (`gjc.repository_binding.v1`). Ultragoal/ralplan stamp identity at creation; task lanes stamp omitted bindings from session cwd **before** agent discovery; ralplan stage writes and handoff re-entry enforce the seed binding; declared paths must stay under the bound root; task receipts include the resolved identity; linked isolation worktrees must match the source repository (#2901).

### Fixed

- Runtime MCP OAuth credentials are now bound to their authorized server origin and token endpoint, reject redirecting refresh responses, and fail closed when legacy or changed configuration lacks an exact match.
- `/share` now keeps full-session HTML in owner-private unpredictable staging until the share handler or `gh gist create` process has fully stopped; cancelling a blocked gist upload terminates and awaits that process before reporting cancellation and removing the export.
- MCP diagnostics now redact opaque endpoint paths, user information, query values, and fragments without changing outbound requests, and parse-failure logs omit response bodies that could echo request secrets.
- Telegram notification daemon self-heals degraded on-disk state: permanently missing scan roots are pruned (so one deleted worktree no longer disables orphan-topic cleanup), and retained exact-unlink transition/placeholder artifacts are reaped on ownership acquire and each scan. `gjc daemon reload` can recover without manual filesystem surgery (#2956).
- On macOS, resuming a managed session no longer fails with `identity_mismatch` when the first write-append open changes only file `ctime` (e.g. APFS write-provenance / `com.apple.provenance`). `appendSync` allows a single bounded re-capture + retry when `dev`/`ino`/`size`/`mtime`/SHA-256 remain unchanged, and still rejects real content races and repeated ctime transitions (#2944).
- Interactive `/resume` / `AgentSession.switchSession()` now awaits verified managed `local://` legacy-root migration for the newly selected session before post-commit lifecycle proceeds, matching cold-start `createAgentSession()` readiness from #2797 so synchronous `local://` resolution no longer fails with "legacy migration must complete before path resolution" after a mid-session switch (#2925).
- Concurrent edits to the same file path are serialized through a path-scoped mutation lock (in-process always; durable cross-process lock on the real filesystem). Disjoint concurrent `applyPatch` / replace mutations no longer silently overwrite each other, and a commit-time content check rejects writers that observe a mid-flight change (#2900).
- Concurrent edits to the same file path are serialized through a path-scoped mutation lock (in-process always; durable cross-process lock on the real filesystem). Disjoint concurrent `applyPatch` / replace mutations no longer silently overwrite each other, and a commit-time content check rejects writers that observe a mid-flight change. The production `executePatchSingle` / `LspFileSystem` path explicitly enables the durable lock rather than inferring it from FileSystem object identity (#2900).
- Lean notification verbosity no longer floods remote clients with intermediate tool-turn `turn_stream` frames. Under `/lean`, the latest assistant answer is deferred until `agent_end` (idle); ask lead-ins still flush immediately before inline buttons, and `/verbose` keeps per-turn streaming (including opt-in live frames) (#2863).
- Ultragoal `complete-goals` no longer reports contradictory next actions when every incomplete story is `blocked` or `review_blocked`. Text and JSON now agree on `next-action=resolve-blockers` with blocked goal IDs/status; failed-only schedules surface `retry-failed`; `execute-goal` always includes a `goal_id` (#2903).
- Bound each Python tool bridge bearer capability to one active session registration, reject non-canonical or empty bearer credentials before lookup, and rotate authority whenever a retained session replaces its kernel.
- Deep Interview now scopes provider-facing `ask` metadata to the persisted workflow stage, including after durable session resume: Round 0 advertises only the locked `intent_contract` branch, later rounds advertise ordinary and `intent_review` branches, foreign workflow gates cannot seed recorder state, and wire-valid empty positive-round reviews reach canonical Zod diagnostics while malformed authority remains fail-closed.
- Bounded docs.rs rustdoc downloads, legacy cache reads, and gzip expansion before parsing or caching; transport-level content encoding is disabled and rejected so Bun cannot decompress outside the explicit output guard.

### Added

- Added SDK v3 prompt reconciliation through `turn.prompt_status` with caller-supplied `clientRef` correlation, bounded live-session lifecycle retention, reconnect-safe lookup, and explicit ordered non-replay semantics for `turn.prompt` (#2930).
- Added `models.profiles.list` discovery of the effective built-in plus `models.yml` profile catalog, exact-ID pre-spawn validation that reloads host configuration for each lifecycle request, and structured `unknown_model_profile` / `model_profile_registry_error` details across lifecycle startup failures (#2931).

## [0.11.7] - 2026-07-22
### Added

- `/btw` now opens an ephemeral multi-turn side chat: plain text continues the side thread until Esc returns to the main chat, while visible text-only context stays outside the main transcript and session observability/debug hooks and is scrubbed synchronously on close or abort.
- Added `statusLine.showActionHints` (default: `true`) to hide contextual action hints while retaining configured status-line segments.
- `skill_discovery` empty results now carry a `notice` when discovery config caused the emptiness — naming the exact disabled setting (`skills.enabled`, `skills.enablePiProject`, or `skills.enablePiUser`) and the `gjc config set` command to enable it. Previously a disabled config was indistinguishable from "no skills exist", silently hiding freshly written user/project skills.
- `generate_image` now supports Alibaba Bailian (Token Plan) `wan2.7-image` as an image provider: set `providers.image` to `alibaba` (or let auto-detect find `ALIBABA_TOKEN_PLAN_API_KEY` / a registered `alibaba-token-plan` key), override the model with `providers.imageModel` (e.g. `wan2.7-image-pro`). Short-lived OSS result URLs are downloaded immediately, and image editing works via input images.

### Fixed
- Telegram `/session_recent` now retries one concurrently appended managed transcript and omits only candidates that remain unstable, preserving independently verified recent-session rows.
- Repeated byte-identical stale SDK broker locks no longer cause startup to loop when a prior tombstone exists.
- ACP session close now rotates idempotency keys for resumed attachment generations while retaining the same key across terminally uncertain close retries.
- ConversationStore now tolerates only unsupported Windows parent-directory durability errors after preserving temporary-file fsync and atomic rename.
- Ralplan no longer re-asks for execution approval when the user already explicitly named `ultragoal` or `team` in the current turn; that naming is the consent.
- Interactive Windows startup now stays keyboard-ready with large session histories and native multiplexers by showing an interactive-only bootstrap before the first TUI start, deferring bounded recent-session discovery until afterward, and reducing psmux frame pressure while preserving the three-second animation and update checks.

- Cron guidance now routes silent recurring polling and event-driven PR/CI watchers to `monitor`, because every cron firing starts a normal assistant turn and prompt wording cannot reliably suppress its response.
- Ordinary `ask` calls now normalize a provider-emitted `deepInterview: null` placeholder instead of misclassifying it as malformed Round-0 intent recovery data and rejecting it before coercion.
- SDK event replay authorization now refreshes the negotiated capability cache synchronously from the native-sanitized replay snapshot before host filtering, preserving initial and repeated-hello capability updates without trusting client frame claims.

- Plugin-bundle HTTP and SSE MCP requests now bind every connection to a validated public address and revalidate bounded redirects before following them.
- Deep Interview now exposes stage-specific provider-facing `ask` metadata: Round 0 advertises only the locked `intent_contract` branch, while later rounds advertise ordinary and `intent_review` branches, preventing strict-schema constraint stripping from making an invalid empty Round 0 review selectable.
- Deep Interview now exposes stage-specific provider-facing `ask` metadata, including after durable session resume: Round 0 advertises only the locked `intent_contract` branch, while later rounds advertise ordinary and `intent_review` branches. Remaining strict-schema constraints that providers cannot express fail closed with bounded corrective guidance instead of an opaque retry loop.
- Deep Interview now exposes stage-specific provider-facing `ask` metadata, including after durable session resume: Round 0 advertises only the locked `intent_contract` branch, while later rounds advertise ordinary and `intent_review` branches. Foreign workflow gates can no longer seed Deep Interview recorder state, and remaining strict-schema constraints that providers cannot express fail closed with bounded corrective guidance instead of an opaque retry loop.
- Documented that custom OpenAI-compatible models omit vision by default: when `input` is unset, GJC treats the model as text-only and strips images with `[image omitted: model does not support vision]`. Vision backends must set `input: [text, image]` in `models.yml`.
- Restored `/models` preset landing navigation after the Image Generation row and made compaction/pruning regression fixtures use an explicit 200K context boundary instead of a mutable provider descriptor default.
- Fixed Windows legacy session artifact migration by using native directory identity size, a traversable detached-path alias, and writable file handles for final durability sync.
- `gjc setup credentials` now auto-imports only OAuth credentials with a finite expiry strictly in the future. Expired or malformed-expiry discoveries remain visible as non-importable records, and existing imported credentials remain recoverable through `/login`.
- Resumed managed sessions now complete the verified legacy `local://` artifact migration before synchronous path resolution, preserving legacy scratch files instead of failing startup with a migration-order error.
- Corrected Telegram's uncertain lifecycle guidance so create, close, and resume commands describe their own possible outcome; close and resume no longer display the create-only duplicate-start warning.
- Telegram ask notifications now preserve the authoritative recommended choice from native asks and workflow gates, marking that option as `(Recommended)` in the message body without changing button indices or submitted answers.
- Telegram `/session_close` now fails closed when tmux disappearance cannot be confirmed, and publishes the managed owner verdict before locked terminal-state preservation so normal close finalization is not delayed behind that state path.
- Managed publication now fails closed on malformed, committed, or mutation-unknown native outcomes: it never retries or cleans a destination, and preserves bounded atomic-unavailable/durability diagnostics through managed startup (#2804).

## [0.11.5] - 2026-07-20
### Fixed

- Internal transcript PageUp/PageDown now keeps moving through tool-output and other non-semantic rows instead of intermittently becoming a no-op after scrolling through anchored conversation content.

## [0.11.5] - 2026-07-20
### Changed
- Telegram live-message streaming now defaults on for configured Telegram notifications through one durable global preference, supports live in-session preference refresh without weakening redaction, and keeps Discord and Slack finalized-only; process environment overrides remain available.
- Telegram tool-activity updates can now be disabled persistently with `/toolactivity off` (and restored with `/toolactivity on`) or from the Notifications preferences UI, without disabling final answers, asks, or other notification delivery.
- Reduced the default session's initial context and corrected tool-schema token accounting: `estimateToolSchemaTokens` now measures the provider-visible wire schema instead of raw zod schema objects, so `/context`, the status line, and compaction report real cost; the `ask` tool is now registered-not-attached (attached only for pending workflow gates, canonical GJC workflow skill activation, and plan-mode enforcement) and its wire schema was slimmed. A fresh default session drops from 12 to 11 resident tools with markedly lower reported non-message context (#2729).
- Session files now use v5 authority records. Do not roll back to a v4 writer after v5 session data has been created: v4 writers cannot preserve independent MCP and discovered-built-in selections.

### Fixed
- SQLite `read` raw queries now accept exactly one explicit `SELECT` statement, reject comments and statement tails before opening the database, recheck the invariant at execution, and enable SQLite query-only mode as defense in depth.
- Direct HTTP(S) marketplace catalogs now use connection-bound public-address validation, bounded redirects, and a 2 MiB response limit before parsing or caching.
- Bounded MCP list pagination by cursor-cycle, page-count, and item-count limits while preserving abort and cache behavior.
- Shell environment snapshots now use one process-private temporary root with exclusive private files, trusted cache validation, and whole-root shutdown cleanup instead of a predictable shared directory.
- Python kernel startup now materializes its bundled runner in one process-private temporary directory with exclusive file creation instead of consulting a predictable shared cache path.
- SSH command construction and discovery now reject malformed destinations with unsafe prefixes or control characters while preserving normal host, address, username, and alias forms.
- Bounded MCP resource URI and template matching now skips oversized templates and uses deterministic literal-segment matching instead of dynamically constructed regular expressions.
- Fixed the `subagent` tool's `resume` action silently swallowing manager failures. Resume outcomes other than `context_unavailable`/`not_found` (`no_runner`, `resume_failed`, `owner_shutdown_in_progress`, …) were dropped and the stale terminal subagent snapshot was returned as if the resume had succeeded, so ralplan's re-review loop believed the persisted Planner had resumed when it had not and never fell back correctly. The resume action now surfaces every non-ok reason (matching the `steer` branch), and the task resume runner marks a resumed subprocess that aborted or exited non-zero as a `failed` job (carrying its rendered failure summary) instead of reporting it `completed`.
- Daemon timeout flags now reject missing, malformed, non-positive, fractional, whitespace-containing, and unsafe integer values before daemon command side effects instead of partially parsing them.
- Hardened standalone HTML session exports so session identifiers, provider/model labels, and embedded raster images remain confined to their intended HTML contexts; malformed image payloads are omitted.
- Restored legacy `gjc coordinator-mcp` and root `gjc --team --team-size <n>` routing to their native MCP and team commands, with strict team-size validation that prevents malformed legacy flags from selecting team lifecycle actions.
- Fixed the `subagent` tool's `resume` action silently swallowing manager failures. Resume outcomes other than `context_unavailable`/`not_found` (`no_runner`, `resume_failed`, `owner_shutdown_in_progress`, …) were dropped and the stale terminal subagent snapshot was returned as if the resume had succeeded, so ralplan's re-review loop believed the persisted Planner had resumed when it had not and never fell back correctly. The resume action now surfaces every non-ok reason (matching the `steer` branch), and the task resume runner marks a resumed subprocess that aborted or exited non-zero as a `failed` job (preserving its error text) instead of reporting it `completed`.
- OpenRouter image generation now retrieves provider-returned HTTP(S) images only through connection-bound public-address validation, revalidates bounded redirects, and enforces image content-type and byte limits before buffering.
- Fixed session resume crashing with `TypeError: undefined is not an object (evaluating 'usage.input')`, and hardened both usage-aggregation paths against silent total corruption, when a persisted transcript contained a parseable-but-malformed assistant or `task` tool-result entry — as produced by torn concurrent multi-writer / NFS appends. `parseSessionEntries` accepts any parseable JSON, so a corrupt `usage` could be absent, `{}` (NaN totals), numeric strings (`"0" + "10"` → `"010"`), negative (silently reducing totals), a present-but-null/incomplete `premiumRequests`/`cost`, a non-record `cost` (e.g. an array), or cumulatively overflow to `Infinity`. Both the resume (`#buildIndex`) and runtime append (`#appendEntry`) paths now route through one shared validator that requires every usage bucket and `cost.total` to be finite non-negative numbers (defaulting only truly-absent `premiumRequests`/`cost`, and rejecting present-but-null/incomplete fields rather than zeroing them) and rejects any record that would overflow cumulative totals, skipping and reporting the malformed record instead of poisoning every `getUsageStatistics()` consumer.
- Fixed the `subagent` tool's `resume` failing immediately for a persisted ralplan Planner. A subagent that finishes by calling `yield` (or is torn down right after a tool executes) left the saved session ending on an assistant `toolCall` with no matching `toolResult`; replaying that history on resume produced an invalid provider request (a `tool_use` not followed by a `tool_result`) that failed the resumed turn at once. Resumed transcripts now reconcile any trailing unpaired tool call with a synthesized placeholder result before the first resumed prompt. Additionally, a failed/no-op resume leg no longer overwrites the prior run's success output artifact with an empty file.
- Fixed persisted subagent resumes being rejected before session reconstruction with `Session is inside managed storage but is not an authorized managed candidate`. Child session files intentionally live inside their parent session's artifact directory and are not top-level resume-picker candidates; the task resume path now explicitly opens the exact internally registered child session directory while retaining strict candidate validation for user-selected managed sessions.
- Managed session resume scans now read only a bounded no-follow header prefix from foreign workspace transcripts, while fully recapturing and revalidating owned candidates before granting migration, receipt, or deletion authority.
- Secret obfuscation now uses authenticated process-local placeholders that remain stable within a running process and opaque after restart.
- Workspace-wide LSP diagnostics now fail closed instead of launching build or typecheck subprocesses outside execution-tool authorization; concrete-file and glob diagnostics remain available.
- Clean, side-effect-free canonical provider stream first-event and next-event watchdog failures now retry on bare single-model legacy sessions; explicit legacy disable, managed fallback, and fail-closed structured, non-watchdog, or unsafe attempts are unchanged.
- Remote MCP HTTP and SSE responses now enforce finite content and message budgets before parsing or dispatch.
- Added fail-closed managed tmux owner SIGABRT recovery: exact-child supervisor receipts and pre-CLI admission now bind replacement ownership, strict durable Ultragoal/transcript evidence reconciles terminal child yields over stale nonterminal runtime state, recovery hydration remains write-free until an ownership fence, and hostile identity, corruption, concurrency, and path boundaries preserve dirty product files (#2681).
- Restored non-root startup on Synology and other Linux container filesystems that definitively report POSIX ACL storage unsupported for managed session paths; explicit `--session-dir` semantics and all owner, mode, type, symlink, identity, and scope-binding checks remain unchanged and fail closed (#2687).
- Preserved access to legal SQLite table names beginning with `sqlite` but not reserved `sqlite_`.
- Decoupled the Telegram daemon's operational generation from its notification protocol version and advanced it through generation 9, so upgrades from v0.10.2 replace generation-3 owners through durable provisional/ready/retired handoff, canonical process-incarnation fencing, stable process-reference signaling, tri-state foreign-owner provenance, owner-lock leases, identity-atomic transition markers, and retained managed-filesystem authority changes instead of silently attaching. Discord and Slack now use generation 6 with stable process-reference signaling, exact owner/reclaim leases, ownership-heartbeat loss shutdown, replacement of physically live but incompatible owners, and the same retained native-authority boundary; focused rolling-upgrade regressions and a per-family lifecycle authority guard enforce the contract (#2278, #2687).
- Activated discoverable built-in tools now persist with independent MCP and discovered-built-in authority, preserving explicit empty selections and restoring only eligible built-ins across resumed lifecycle transitions.

## [0.11.4] - 2026-07-20
### Added
- Bracketed pastes containing complete lists of saved static-image paths can now attach up to 16 images in source order after explicit confirmation. Paste transactions are cancellation-safe, disabled in command modes, enforce source, encoded-output, dimension, and decoded-memory budgets before commit, reject animated, remote, linked, or path-swapped sources, and restore the literal paste on cancellation or failure.
- Rich tool-call rendering in the transcript viewer: both the session-observer and main-session transcript viewers now share one formatter so tool calls render identically (args summary + intent, then a result block with ✓ done / ✗ error / ⏳ pending states). Fixes a latent bug where a tool call with no result rendered as a false "✓ done"; expanded results cap at 100 source lines with raw/copy exposing the full text (#2656).

### Changed
- Updated the Kimi Coding Plan Eco, Medium, and Pro presets to Kimi K3 with its supported `low`, `high`, and `max` reasoning efforts.

### Removed
- Removed the legacy worktree cleanup implementation behind the `@gajae-code/coding-agent/cli/worktree-cli` and `@gajae-code/coding-agent/commands/worktree` package subpaths (base and `.js` forms). The `gjc worktree`/`wt` CLI command has been unregistered since the workflow-surface narrowing; the modules behind it (including the recursive-deletion `clear` path) were only reachable as package imports. The subpaths now resolve to throwing tombstone modules whose error explains the deliberate removal and the supported replacement: inspect leftover managed worktrees under `~/.gjc/wt` manually and use `git worktree remove` / `git worktree prune`.

### Fixed
- MCP OAuth discovery now treats transport error hints as classification-only and uses one public-network-validated, redirect-aware, issuer/resource-bound traversal budget across metadata aliases and cycles.
- Telegram `/btw` rich-delivery E2E coverage now awaits native and daemon teardown ownership, records exact per-iteration lifecycle phases, and uses an internal exact-tuple terminal-delivery receipt to keep fallback stress deterministic under shard load without extending the original test timeout.
- Malformed spurious Round-0 review metadata no longer blocks an otherwise valid locked-intent question/gate, while durable intent safety remains fail-closed (#2643).
- Restricted role-agent `gjc state` command authorization now fails closed on argv-classification disagreement: one shared manifest-aware native state argv grammar (action names, flag arity, positionals, effective modifiers, selector candidates) is consumed by both runtime dispatch and the policy boundary, which rejects ambiguous selectors, malformed flags, destructive actions, and file-backed input (#2665).
- Browser tab workers now bootstrap through their actual isolated entry without accidentally loading native bindings through broad imports, and startup fails closed instead of falling back to unguarded inline execution; compiled/package smoke now exercises the tab worker, with a PR-head darwin-arm64 CI gate (#2598).
- Added evidence-preserving recovery for legacy multi-writer SDK session-index corruption: `gjc gc` now diagnoses corrupt prefixes, `--repair-session-index` quarantines the original snapshot/log under the session-index lock before atomically restoring only the checksum-valid monotonic prefix, and append failures point operators to the explicit repair path (#2654).
- Malformed selectors on internal read URLs now fail explicitly instead of silently falling back to an unbounded resource read.
- Newly registered earlier resource-GC policies advance the pending sweep without postponing an already earlier sweep.
- Provider onboarding wizard completion is now deterministic under CI load: duplicate in-flight confirmation is suppressed, success tests await the real refresh/notification/status boundary instead of fixed sleeps, and the newly configured model is verified through the subsequent model selector.
- OpenAI-compatible web search now turns malformed successful response bodies into bounded provider errors while preserving normal provider fallback (#2593).
- Windows session storage now keeps a symlink-resolved drive-letter path for Bun filesystem I/O instead of a native Volume GUID identity path, preventing `ENOENT` failures during resident-cache writes that could drop the final assistant message at turn completion.
- On platforms with verified retained publication identity support, detached SDK broker processes now stop after durable loss or replacement of their owned publication while preserving warm reuse and protocol/state formats (#2583). Bounded-practical limitation: requests admitted before the first definitive loss observation—or after authoritative same-object recovery and before a later loss observation—may still perform pathname-based index, ledger, lifecycle, cleanup, or child effects. A detached session-host child spawned by an admitted request may outlive broker exit and may continue pathname effects for the session lifetime. Broker self-reap does not cancel or signal that child and does not provide absolute hostile replacement isolation.

## [0.11.3] - 2026-07-19

### Changed
- The `read` tool is now receipt-by-default: bare and unparseable reads return a bounded receipt (≤50 lines / 10 KiB) with a re-read-with-selector footer only when truncated, `:raw` stays pure verbatim up to a max(2 MiB, spill threshold) ceiling, structural summaries cap unit-granularly at 20 KiB while preserving elision and source-recovery footers, and directories are byte/line capped and never spill. Only an explicit full-content selector (`:raw` or an explicit range) with real content is spill-eligible. Subagent previews now enforce a real byte/code-point cap via per-shape render budgets plus a shape-aware artifact-eligibility tag enforced centrally in output-meta.


### Fixed
- Ultragoal objective ownership no longer treats arbitrary strings that merely mention `goals.json`/`ledger.jsonl` as Ultragoal-owned; only the exact default aggregate objective qualifies for the known-objective path.

### Fixed
- Workflow-state handoff no longer self-locks the active-state cache, so a same-turn skill handoff (e.g. ultragoal → ralplan) completes instead of stalling behind a lock the handoff itself still holds (#2638).
- SDK host shutdown now retries a failed broker unregister instead of short-circuiting with a stale broker-index entry, while retained startup-cleanup owner-release failures remain isolated from the red extension-error path (#2625).
- Non-TTY launches now fail fast when stdin is empty and automatically use print mode for positional prompts and `@file` inputs, preventing orphaned interactive TUI processes (#2507).

### Fixed

- The command palette now labels `app.session.fork` as “Branch from message,” matching its user-message selector and `AgentSession.branch()` behavior while preserving the existing action ID for keybinding compatibility.

## [0.11.2] - 2026-07-19

### Changed
- Simplified the release CI to a minimal, industry-standard workflow: a version tag builds the native addons and binaries, then publishes to npm and cuts the GitHub Release in one self-contained job graph. Removed the source-SHA re-verification gate, evidence-provenance handshake, and draft/finalize multi-job dance that made every version-bump commit fail CI. The lint/type-check job is now native-free (biome + tsc); runtime doc and SDK-canonicalization checks moved to the test job so they run with a built addon.

### Fixed
- The Python eval runtime now honors the documented `GJC_*` environment variables instead of silently reading only legacy `PI_*` names. `GJC_PY` (tokens `0`/`bash`, `1`/`py`, `js`, `mix`/`both`) overrides the eval backend allowance with precedence over legacy `PI_PY`/`PI_JS`; `GJC_PYTHON_SKIP_CHECK`, `GJC_PYTHON_IPC_TRACE`, and `GJC_PYTHON_INTEGRATION` are read first with `PI_*` fallback (OR semantics, so either truthy name wins). Operators following `docs/environment-variables.md` and `docs/python-repl.md` who set `GJC_PY=py` previously saw no effect — a silent docs/runtime contract break. Legacy `PI_*` names remain supported for backward compatibility.

### Fixed
- Team worker launches now receive the validated owning `GJC_SESSION_ID` for sanctioned session-scoped writes while preserving absent identity, fail-closed resolution, and separate spawn provenance (#2597).
- Managed and explicit session directories now canonicalize benign ancestor symlinks (e.g. macOS `/var -> /private/var`, a symlinked `$HOME` or project directory) to a symlink-free trusted root before the strict owner-only and reparse guards run, so session creation, moves, resume, and writes no longer fail with `reparse_point` / `Unsafe reparse storage path` under a symlinked temp root or home. The native primitive stays strict and continues to reject symlinked components at or below the trusted root.
- Skill invocation failures now list available skill names so agents can recover from typos without a blind retry loop.
- Workflow state receipts now use canonical session-layout paths, require resolved session identity, and report a `state_path` that matches native write/clear output (#2393).
- Coordinator MCP operational calls now canonically bootstrap or reuse the agent-global SDK broker when discovery is absent or stale, while coordinator/hermes JSON checks report catalog and broker-discovery readiness separately without mutating broker state (#2552).
- Coordinator MCP question polling now requires a session, reconciles pending workflow gates into bounded public questions, diagnostics, and reconciliation state, and submits bound idempotent answers through `workflow.gate_answer` without exposing private gate payloads (#2550).
- Runtime skill discovery now follows native user config-root precedence: nearest project, canonical `GJC_CONFIG_DIR`/`PI_CONFIG_DIR`/`.gjc` `agent/skills`, configured legacy `<config>/skills`, then historical legacy `~/.gjc/skills`, preserving exact fallback precedence (#2572).
- Opt-in stalled team-worker continuation now remains default-off (`GJC_TEAM_AUTO_CONTINUE_STALLED_WORKERS=1`) and sends at most two fenced, journaled fixed prompts only to a verified stale worker pane with a matching live claim and sufficient lease; unknown restart state fails closed, with no provider replay, pane lifecycle action, or claim mutation (#2580).

### Fixed
- SDK host response delivery to a disconnected client no longer escalates a second structured-error send failure into a process-level unhandled rejection; failures stay local to that connection.

### Fixed
- Repository LSP configuration can no longer define process-affecting server behavior: project files may control declarative matching, activation, and capabilities, but cannot set launch fields, initialization options, or opaque server settings. Trusted canonical user configuration outside the project retains those overrides; project-controlled plugin roots and the quarantined `--plugin-dir` surface cannot inject them. Automatic discovery uses trusted external executables and rejects repository-owned lexical paths as well as symlink-resolved project binaries; status uses the session cwd as its lspmux trust root. `GJC_DISABLE_LSPMUX=1` is the canonical opt-out and `PI_DISABLE_LSPMUX=1` is a supported compatibility alias; either truthy value disables lspmux probing and wrapping.
- Palette slash commands now run only from an empty composer; drafts are never touched.
- Individual default and named-role model assignments now keep the model selector open for consecutive choices, while batch assignments retain their existing close-on-success behavior.
- Aborting a session without an enabled active goal no longer suppresses the first reminder when a goal is activated later; active-goal abort suppression is one-shot, goal-owned, and clears across inactive or replacement-goal transitions (#2436).
- Palette slash submissions no longer clear or rewrite composer text, cursor state, history, or pending images created while an asynchronous input hook is awaiting; canonical keyboard submission cleanup remains unchanged (#2441).
- Dead browser-tab recovery now expires descriptors without releasing replacement, revived, or differently owned tabs, while exactly-once teardown closes stale targets and releases browser holds without refcount underflow (#2437).
- Local-memory Phase 1 no longer processes history from another working directory.

### Added
- Double-Esc now clears an idle draft after a confirmation hint, saving it to prompt history; from an empty editor it follows the configured tree, branch, or disabled action.
- Added a searchable command palette with direct action dispatch; slash commands run only from an empty composer, and drafts are never touched.
- Added deep-interview intent manifests that preserve user-locked artifacts, surfaces, and integrations through Round 0.
- Added Telegram `/btw <question>` support through the `ephemeral_turn_v1` SDK capability in authorized known private-session topics. It uses current-session context in an isolated side turn without injecting or persisting user or assistant messages in main history, remains available while the main turn is busy, permits two concurrent questions per logical session, and cancels provider work at the 120-second host deadline; `notifications.telegram.btw.enabled` defaults to `true` as the local kill switch.
- Telegram `/btw` replies now use eligible complete Bot API 10.1 structured Markdown once as `{rich_message:{markdown,skip_entity_detection:true}}`, correlated in the source topic. Tables and math use Telegram Markdown support rather than outgoing native blocks or media; ineligible content and definite rich rejection use correlated HTML, while ambiguous outcomes never retry or fall back and `/rich off` remains HTML-only.

### Fixed

- Sessions running a managed model fallback chain no longer wedge with repeated `Retry failed after N attempts: The object can not be cloned.` after a provider HTTP error whose response carried headers. The live `Headers` instance attached to the provider error was not structured-cloneable, so the managed attempt snapshot replaced the real provider failure with a local `DataCloneError` on every model in the chain — misreporting `Model fallback chain exhausted` and permanently failing every subsequent prompt while the provider kept erroring. Transport facts now retain only plain-record retry signals, and the attempt snapshot degrades gracefully instead of failing the attempt.

### Fixed
- Active deep-interview sessions now resume automatically after a normal assistant stop while ordinary active interviewing remains eligible, using bounded workflow-state continuation; recovery, leak, stale-state, handoff, and crystallization blocks remain Stop-gate handled.

### Changed
- Removed deprecated `DiscoverableMCPTool`, `DiscoverableMCPSearchIndex`, and related MCP-only discovery helper exports. Use the unified `DiscoverableTool` discovery APIs; the `mcp.discoveryMode` settings alias remains supported.

### Fixed
- Connected MCP server instructions now remain untrusted user-role data instead of entering the cached system prompt; hostile file paths, working directories, and workspace-tree metadata are structurally encoded, and volatile project context is removed from durable session history between requests.
- Restored the strict G002 public-surface quarantine by removing the default README advertisement for the private coordinator MCP runtime.
### Added

- Added opt-in prompt suggestions (Claude Code-style ghost-text autocomplete): with the `promptSuggestions` setting enabled, a smol-model prediction of your likely next prompt renders as dim ghost text in the empty composer after each agent turn; Tab accepts it, typing dismisses it, and a new turn clears it. Predictions are heuristically gated (silence on evaluative/meta/agent-voice/overlong output) and never generated while the composer has text or a turn is streaming.

## [0.11.1] - 2026-07-16

### Fixed
- Published the Windows Bun workflow-gate durability fix that tolerates unsupported `EPERM` directory `fsync` failures after an already-committed atomic rename; the 0.11.0 package changelog described the fix, but the released artifact did not contain it (#2316).

## [0.11.0] - 2026-07-15

### Fixed
- Discord inbound lease recovery now exposes a deterministic scheduler seam, preserves exponential retry wakeups after transient endpoint lookup failures, and cancels pending recovery exactly on daemon stop instead of relying on wall-clock sleeps in regression coverage.
- Input-free interactive TTY startup now keeps the TUI reachable when configured model profiles are missing required provider credentials, skips only the blocked profiles, and preserves later `--mpreset` and explicit model/thinking precedence; redirected terminals, input-bearing, resume-continuation, image-only, print/text, and unrelated activation failures remain fail-closed (#2277).
- Windows Bun runtimes no longer crash while committing the durable workflow-gate store when directory `fsync` reports the unsupported-operation code `EPERM`; unexpected directory-sync failures remain fail-closed.
- Browser geo settings now propagate coherently across request `Accept-Language`, navigator languages, and `Intl` locale/timezone surfaces; configured managed browsers are isolated by geo/profile posture, concurrent acquisition is serialized, and unset geo preserves Chromium's native locale/timezone instead of injecting a fixed New York profile.
- Windows startup no longer fails when the platform rejects the workflow-gate store's parent-directory durability sync with `EPERM`; file fsync and atomic replacement remain enforced.

- Cooperative mid-run context maintenance now waits at a cancellation-aware FIFO consumer-drain checkpoint before flushing or rewriting session history. Materialized tool results and steering messages are synchronously canonicalized first; aborted barriers and hook/signal-cancelled compactions settle without rewriting or scheduling a continuation. Promotion, pruning, and compaction each start a clean provider/prompt-cache epoch. Script-aware #2067 unsent-delta accounting remains cache-free and distinct from the lifecycle checkpoint.
- Classified the cooperative mid-run maintenance driver and token estimator test seams as locked non-public SDK exclusions, restoring deterministic operation-inventory generation and post-merge dev CI coverage.
- Accepted SDK prompts now deliver correlated `agent_start` and exactly one terminal lifecycle frame directly to the requesting authenticated WebSocket connection while retaining replayable host events. Harness owner observation also waits for every previously accepted frame to finish serial persistence, so message-update storms and polling gaps cannot hide sticky completion evidence (#2169).
- `/new` now fails closed while owned subagent shutdown is unproven: it preserves the current session identity and shows an actionable cleanup notice. Successful replacement waits for cooperative child cancellation, cancels owner jobs before switching identity, and `/drop` creates the replacement before attempting old-session deletion (#2261).

### Added

- Added the additive SDK Q10 model-catalog DTO: `Q10`, `models.list/current`, `models.list`, and `models.current` now return the same paged registry rows with reasoning/thinking capability metadata and current-model readback. `thinking.validLevels` is an `off`-first canonical menu; sparse raw reasoning descriptors remain available for inspection. The public DTO types are exported from `@gajae-code/coding-agent/sdk`, while undocumented `/sdk/models` deep imports remain unavailable. `inherit` is readback-only and malformed descriptors fail with a safe internal SDK error (#2163).
- Gajae Pet selection is now terminal-capability aware: unsupported terminals show an actionable warning (with multiplexer-specific guidance for tmux/screen/zellij, including the `PI_FORCE_IMAGE_PROTOCOL=sixel` expert opt-in), `/pet` and Settings disable the unavailable `RedGajae`/`BlueGajae` choices while `off` stays selectable, a saved-but-unavailable choice is identified as `(saved)`, and the public command names are consistent across execution, completion, and inline hints (`/pet RedGajae`, `/pet BlueGajae`, `/pet off`, case-insensitive).
- Added the standalone `@gajae-code/bridge-client` transport-only v3 SDK package. It exports `SdkClient` and its associated types; `@gajae-code/coding-agent/sdk` remains a compatibility re-export with the exact same class identity. Historical BridgeClient backend protocol, handshake, commands, SSE, and host-control bypass surfaces remain unavailable.
- Added explicit `--mcp-config <absolute-path>` support for one trusted, tools-only MCP config in top-level standalone sessions without enabling automatic user or project MCP discovery; exact reads reject links and identity changes, and MCP tool-name collisions fail closed.
- Added additive v3 workflow-gate correlation compatibility surfaces (#2171): explicit Rust workflow-frame readers/registration preserve `workflowGateId` without changing legacy `ActionNeeded`, `ServerMessage`, or `register_ask`; N-API retains `registerAsk` and adds correlated/arbitrated registration and exact unclaimed-retirement APIs. Private presentation leases, routes, claims, receipts, epochs, and endpoint generations remain non-public.
- Added the versioned, readonly managed session-directory SDK: `SESSION_DIRECTORY_API_VERSION`, `resolveManagedSessionScope`, and `listManagedSessionCandidates` are exported from `@gajae-code/coding-agent/sdk`. The package boundary continues to reject private `session/internal/*` imports. Managed writes use v2 workspace scopes with validated opt-in legacy copy-retain migration (#2177).

### Changed
- Explicit fold choices from the user shortcut or extension `setToolsExpanded` now pin a block for its component lifetime, so automatic stamping no longer overwrites them; sessions that never toggle are unchanged.

- Renamed the notifications SDK to the Gajae-Code SDK: `docs/notifications-sdk.md` is now `docs/sdk.md`, `src/notifications/` is now `src/sdk/bus/`, and `src/sdk.ts` is now the `src/sdk/` module directory. Old deep-import specifiers no longer resolve.
- Moved SDK discovery from `.gjc/state/notifications/` to `.gjc/state/sdk/`. Restart sessions and daemons together when upgrading; the runtime does not dual-scan the old and new directories.
- Removed the `--mode rpc`, `--mode rpc-ui`, and `--mode bridge` external ingress modes. Machine clients must use the SDK WebSocket interfaces documented in `docs/sdk.md`; no RPC or Bridge compatibility path remains.
- Documented the current GPT-5.6 Codex and combo profile mappings as product judgments, including the durable `opus-codex` `anthropic/claude-sonnet-5` planner override and `fable-opus-codex` `anthropic/claude-opus-4-8:medium` planner.
- Resolved the SDK v3 workflow-gate shipping classification (#2171): `workflowGateId` and Q12 diagnostics are additive SDK v3 surfaces, while `action_needed.id` remains the transient, generic `reply.id` authority. `expectedSessionId` omission remains accepted and audited for the entire SDK v3 line; new clients must send it, and mandatory enforcement or removal can occur no earlier than SDK v4 only after at least one full published deprecation release/window with deployed-client notice. Explicit session mismatches fail closed before resolution; mismatched sessions, stale/reissued actions, and unsafe ambiguity never regain authority.
- Documented release pairing: the `@gajae-code/coding-agent` runtime and `@gajae-code/natives` native addon ship from the same source release at exact matching package versions, with the native loader version sentinel enforcing the pair. Mixed native/runtime versions are unsupported and cannot claim SDK compatibility.
### Fixed
- Startup continuation now participates in the existing managed fallback and in-flight recovery envelope, preventing a retryable resumed turn from publishing `agent_end`/idle before retry success, exhaustion, cancellation, or startup failure has settled (#2092).

- Fenced SDK WebSocket lifecycle callbacks and request settlement to the owning retry cycle/socket incarnation, so stale open, close, error, message, and timeout delivery cannot reject or corrupt work on a replacement connection; sent mutations remain non-replayed and deterministic race regressions cover the reconnect boundary (#2164).
- Owned LSP stdin `EPIPE` and `ERR_STREAM_DESTROYED` failures now terminalize and evict only the affected client, reject pending and stale requests with a stable transport-closed error, and permit clean client recreation without suppressing serialization or unrelated sink failures (#2138).
- Serialized fresh prompt preflight and durable default-model selection through deterministic per-session admission, preventing a later `model.set` from overtaking an earlier prompt while preserving provider-stream and continuation behavior (#2199).
- Direct SDK broker lifecycle hosts now wait for their session-owned startup capability before publishing lifecycle readiness. Only a `started` capability permits a ready marker; failed startup requires proven process, endpoint, and host cleanup before the broker reports `spawn_failed` with no endpoint available, otherwise it preserves terminal uncertainty (#2168).
- Isolated default source-mode SDK broker and session-host respawns from caller Bun startup policy. Internal children now use fixed `--no-env-file` plus product-owned config/entrypoint paths, scrub `BUN_OPTIONS` and mutable compiled markers, preserve compiled/custom launch compatibility, and clean up owned broker children on startup failure without leaking launch secrets (#2178).
## [0.10.2] - 2026-07-14

### Added

- Gajae Pet selection is now terminal-capability aware: unsupported terminals show an actionable warning (with multiplexer-specific guidance for tmux/screen/zellij, including the `PI_FORCE_IMAGE_PROTOCOL=sixel` expert opt-in), `/pet` and Settings disable the unavailable `RedGajae`/`BlueGajae` choices while `off` stays selectable, a saved-but-unavailable choice is identified as `(saved)`, and the public command names are consistent across execution, completion, and inline hints (`/pet RedGajae`, `/pet BlueGajae`, `/pet off`, case-insensitive).

### Changed

- Documented the current GPT-5.6 Codex and combo profile mappings as product judgments, including the durable `opus-codex` `anthropic/claude-sonnet-5` planner override and `fable-opus-codex` `anthropic/claude-opus-4-8:medium` planner.
- RPC clients can now durably select the machine-global default model and effective thinking level for subsequent messages, while project policy and resumed session history retain precedence; a late live-apply failure now restores the prior runtime model and thinking level without masking the original error.

### Fixed

- Gajae Pet overlays no longer leak images or stale pixels across lifecycle changes: each widget owns a randomized Kitty image ID (deleted on disable, replace, switch, and dispose), the previous Sixel footprint is tracked and erased on movement, resize, and narrow-terminal fallback, replaced pet widgets are disposed before their successors install, and a saved pet preference survives editor replacement while graphics are still unavailable (so a delayed Sixel capability probe can still activate it). Teardown is exception-safe and idempotent: a failed or unavailable terminal write never aborts logical disposal or steals a successor widget's overlay slot, and Sixel/Kitty cleanup authority is retained until the erase is actually delivered so a later mode switch or dispose retries it.
- Gajae Pet cleanup that fails during final widget disposal is now retained by the TUI for retry, and Kitty image IDs remain reserved until their exact-ID delete is delivered.
- Fixed `gjc --tmux` startup from GNOME and other VTE terminals by recognizing `vte-spawn-*.scope` only when cgroup metadata proves matching user-manager ancestry (#2159).
- Fixed native Windows `GJC_TMUX_COMMAND=tmux` resolution when WinGet's `tmux.exe` is a psmux alias with a generic `tmux` banner: GJC now compares executable identity with the installed `psmux.exe`/`pmux.exe` companions and fails closed when identity cannot be established instead of authorizing native-tmux semantics (#2086).

- Accepted or declined initial external credential-import decisions now persist across normal restarts and upgrades, suppressing automatic startup and bare `/login` discovery; same-version legacy markers remain compatible and explicit `/provider` import remains available ([#2117](https://github.com/Yeachan-Heo/gajae-code/issues/2117)).


## [0.10.1] - 2026-07-13

### Added

- Added an owner-proof idle session reaper and `gjc_coordinator_stop_session` for ephemeral (delegate-created) coordinator sessions. Termination goes exclusively through the canonical SDK broker `session.close` lifecycle (durable process identity verified before close) — never a raw `process.kill` or tmux control. The reaper re-validates ephemeral and no-active-turn state at close time under the same per-session mutation lock as delegate reuse, and purges coordinator metadata only after SDK closure is verified, retaining it when closure cannot be confirmed (#2080).

- Added an owner-proof idle session reaper and `gjc_coordinator_stop_session` for ephemeral (delegate-created) coordinator sessions. Termination goes exclusively through the owner-proof `forceCloseGjcTmuxSession` path (pid, native session id, owner generation, server key, and start time all verified before SIGTERM) — never a raw `process.kill`. The reaper binds each close to the persisted runtime-state file, re-validates ephemeral and no-active-turn at kill time under the same per-session mutation lock as delegate reuse, and purges state only on verified termination (#2080).
- SDK clients can now pass an explicit thinking level to `model.set`, atomically applying the effective model and thinking level to the active session and the machine-global default for future sessions, while project policy and resumed session history retain precedence.
- Context-usage tokens/% now use provider-reported usage as the single source of truth on every surface. `AgentSession.getContextUsage()` returns a source-tagged snapshot (`source: "provider_anchor" | "heuristic" | "unknown"`), and the status-line `context_pct` segment, inline model percentage, and `/context` totals consume that snapshot instead of recomputing an independent heuristic sum — so footer, status line, `/context`, ACP, and RPC can no longer disagree about the same session state. Heuristic estimation now applies only when no provider anchor exists (session start, aborted/error-only turns), and that fallback now includes the fixed system-prompt/tool/skill context it previously omitted. The pre-prompt compaction estimate honors the latest-compaction boundary (never anchors on stale pre-compaction usage totals), unknown post-compaction usage stays unknown (status line renders `?`; ACP omits the `usage_update` instead of reporting `used: 0`), and `/context` labels its total by provenance with a reconciliation line when the estimated category composition diverges from the provider-reported total.
- Post-durable default-model-selection failures now expose a stable SDK error with bounded `restored`, `partial`, or `unknown` rollback state; preflight and validation errors remain unchanged.
### Fixed
- Made SDK host startup publish its runtime and initial identity frame before exposing direct-v3 transport endpoints, preventing early replay/control frames from being dropped or dereferencing uninitialized session state under concurrent test and process load.

- IRC deliveries now accept their exchange batch in the recipient's volatile current-session queue before recipient/main UI observations or sender success. Awaited deliveries generate the reply first, then accept the ordered incoming + auto-reply pair and commit the IRC roster claim before observation; provider failures and sender aborts before acceptance leave no ghost exchange, while observer failures after acceptance are isolated. This is not a durability guarantee: durable history injection remains a later flush and no fsync, recovery, persistent IDs, or deduplication was added.
- `/model` role-agent assignments now replace active model-profile overrides immediately, so changing architect, critic, planner, or executor models and reasoning levels takes effect in the current session and remains persisted afterward.
- Print mode now records terminal text-mode errors as exit status 1 (or 78 for context overflow) without bypassing output quiescence or session disposal. It retains JSON event delivery through disposal and suppresses `EPIPE` from its owned stdout; `ERR_STREAM_DESTROYED` is suppressed only after that `EPIPE` has latched, while other output failures remain errors.
- Preserved clipboard image attachments when the interactive editor clears the composer before dispatching the submit callback, so Alt+V image placeholders still send their image blocks instead of placeholder-only text (#2126).
- Extension contexts now receive a defensive copy from `getSystemPrompt()` instead of the live mutable system-prompt array, so an in-place mutation by an in-process extension can no longer bypass context-revision tracking and serve stale display-only context-usage estimates.
- Completed bracketed-paste input now returns a manually paged transcript to live output before the paste is dispatched, including asynchronous consumed and unconsumed paste paths.
- Prevented orphaned background processes by reaping failed detached harness owners and their exact SDK session children with verified TERM/KILL cleanup, giving only the invocation-scoped transport-close capability permission to break a direct owner-stop cycle while every public stop caller awaits truthful teardown, keeping runtime-owner lease/heartbeat authority live while failed teardown retries, binding broker discovery to OS process incarnations before accepting retained ownership, making isolated ACP and broker subprocess tests stop their exact broker before deleting temporary state, and adding a cooperative Telegram daemon watchdog that stops superseded or non-progressing owners.
- Preserved clipboard image attachments when the interactive editor clears the composer before dispatching the submit callback, so Alt+V image placeholders still send their image blocks instead of placeholder-only text (#2126).
- Completed bracketed-paste input now returns a manually paged transcript to live output before the paste is dispatched, including asynchronous consumed and unconsumed paste paths.
- Telegram `/usage` now includes secret-safe 5-hour and weekly limit summaries when normalized provider data is available, `/reasoning` reports effort/scope/display with compatible controls and accurate help, and `/model` offers owner-authorized one-shot inline buttons with stale/invalid callback safeguards (#2095).

## [0.10.0] - 2026-07-12

### Added

- Added an opt-in `/pet on|off` composer companion with idle gaze, working claw motion, and occasional automatic flex animation on Sixel- and Kitty-graphics terminals.
- Added Grok 4.5 to the bundled Grok Build catalog with its published 500K context window, multimodal input and token pricing, normalized its official `grok-4.5-latest` and `grok-build-latest` aliases, and limited reasoning effort to the documented `low`, `medium`, and `high` levels.

- Added `notifications.sessionScope` (`all` default | `primary`). Under `primary`, the separate-process child sessions GJC spawns (team workers, harness RPC owners) no longer register their own Telegram forum topic / notification endpoint unless they explicitly opt in (`GJC_NOTIFICATIONS=1`, the `/session_create` path). The default `all` fully preserves current behavior, and user-opened CLI/tmux/headless sessions are never affected. The provenance marker is per-spawn and non-dynastic (consumed once at session startup, never inherited by grandchildren) (#1908).
- Coordinator MCP `gjc_coordinator_start_session` and the `gjc_delegate_plan`/`gjc_delegate_execute`/`gjc_delegate_team` tools now accept an optional `mpreset` argument that authoritatively activates a GJC model profile for a fresh session, with the same semantics as `gjc --mpreset <profile>` (#2003). The name is resolved through the merged built-in/custom profile registry before launch (so custom profiles keep working), legacy profile aliases are canonicalized exactly like the CLI (e.g. `codex-standard` → `codex-medium`), and the canonical profile is injected into the child startup command so the profile's default and per-role models apply from the first turn; unknown names are rejected with the available-profile listing and never reach a spawned command, and an unreadable/invalid `models.yml` fails closed with a distinct `model_profile_registry_error` rather than silently degrading to built-ins only. An explicit empty/whitespace `mpreset` is rejected rather than treated as omission. The effective profile is recorded on the session and surfaced in coordinator status/readback, reusing a session with a conflicting `mpreset` fails with a stable `mpreset_conflict` reason, and calls that omit `mpreset` keep their current behavior. The existing advisory `model` prompt hint is unchanged, and no machine-wide durable default is introduced (#2066 remains out of scope).

- `notifications.telegram.topics.nameTemplate` configures the Telegram forum-topic title, with `{repo}`, `{branch}`, and `{title}` placeholders, so operators can put the session title first (e.g. `"{title} · {repo}/{branch}"`) and keep concurrent sessions on the same checkout distinguishable in the topic sidebar. The template applies only when every placeholder it references resolves for the session; otherwise the daemon falls back to the built-in `{repo}/{branch} - {title}` composition (and its title/repo/branch fallbacks). Unset preserves the current naming exactly (#1909).
- Added the IRC chat-room surface: IRC messages persist in the main chat scrollback by default (no 10s TTL) with stable observation ids and a rebuild-aware ledger, and the agent is IRC-aware. Enabling `irc.sidebar.enabled` moves the persistent record into the opt-in `alt+i` sidebar split while inline display stays ephemeral. Message persistence and agent awareness are default-on; the sidebar panel itself is opt-in (#2018).
- Added a transport-agnostic, secret-safe shared notification service (status, health, test delivery, ownership-protected recovery) consumed by both the `gjc notify` CLI and the cross-mode `/notify` slash command (TUI + ACP), so onboarding and daemon recovery no longer duplicate daemon/config logic per surface. `/notify` now exposes `status|health|test|recovery|setup` and `gjc notify` gains `health`/`test`/`recovery` with `--probe`/`--message` (#2050).
- Added beginner-safe `gjc daemon` operational shortcuts sharing one operator contract so the guided human surface and machine-readable `--json` never drift: a `restart` alias that resolves to reload-if-running-else-spawn, concise per-daemon output by default with `--verbose`/`-v` for runtime detail and the full roots list, and an actionable structured recovery path when token/chat ownership mismatches instead of a large payload ending in `blocked`. Exit codes stay 0 on success / 1 on failure (#2057).
- Added fail-closed ACP session deletion: the delete path refuses rather than proceeding when the target session cannot be safely resolved, and retains the inode in the replacement case (#2074).
- Added the interactive **Notifications** settings tab with masked Telegram setup, global and session controls, health/test/recovery/reconnect actions, atomic preference saves, and safe blocked-owner recovery guidance (#2050).

### Changed

- Migrated the repository type-check and release declaration pipeline to stable TypeScript 7.0.2 with a non-mutating publish-type gate.
- Rebalanced GPT-5.6 Codex and combo presets around published family tiers and reasoning-effort curves. The executor assignments are informed by descriptive repeated local exact-edit evidence from selected TypeScript tasks; default, planner, architect, and critic assignments remain product judgments rather than benchmark claims.
- Cache-miss diagnostics now separate actionable, diagnostic-only, and provider-side-suspected causes instead of asserting a user-side fix for every miss (#2020). A large, costly miss with no cache reads or writes is reported as a neutral `Cache notice` marked "provider-side suspected / not user-actionable" (with what GJC cannot determine) rather than telling the user to keep a stable prefix; a miss with reads but no writes is reported as diagnostic-only without asserting a single cause; and the "cache write without enough matching reads" warning now only fires when reads actually fail to cover the writes. The existing miss cost summary and the #1929/#1936 pricing/provenance safeguards are unchanged.

### Fixed
- `/btw` side questions now start independently while the main answer is still streaming, read only committed conversation state, avoid main-session callbacks/history/IRC-roster mutation, disable silent provider retries, and fail the side request visibly if no provider event arrives within 15 seconds.

- Fixed native-Windows coordinator/runtime compatibility by treating psmux's successful empty `list-sessions` response as an absent server while keeping malformed rows fail-closed, reading process incarnations through a validated PowerShell start-time query, sharing the existing BOM-free encoded PowerShell pane command, preserving multiline SDK prompts behind semantic readiness, and retaining runtime command/turn acknowledgement identity across Windows-equivalent workspace paths (#2145).
- The coordinator MCP owner-server probe now recognizes tmux ≥3.7's missing-server diagnostic (`error connecting to <socket> (No such file or directory)`) as an absent server. tmux 3.7 changed the wording from the older `no server running on <socket>`, which the coordinator probe did not match — so a brand-new coordinator socket (which never has a server yet) was misclassified `unverifiable` instead of `absent`, and **every** `gjc_delegate_*` / session create failed closed with `coordinator_tmux_owner_server_unverifiable` on tmux ≥3.7. The coordinator and `gjc` harness probes now match the same no-server wordings the other owner-isolation probes already did.
- Preserved explicit Telegram forum-topic renames as durable user-owned names, immediately re-asserting delayed edits while retaining restart and rename-race recovery (#1910).
- Prevented typed provider safety stops from entering automatic retry loops and aligned ACP refusal reporting with the provider-native classification.
- `gjc resume` now aliases value-less `--resume`, requests confirmation before opening and continues a resumable tail once only; terminal tails open idle, and headless bare resume exits with explicit `--resume <id>` guidance (#1973).
- Telegram answers to interactive and unattended `ask` prompts now receive a semantic, origin-bound `Selected!` acknowledgement before workflow continuation, with typed multi-select controls, no acknowledgement for toggles/clarifications/skips, at-most-once delivery attempts, and truthful failure/unknown outcomes (#1974).
- Isolated unsafe Linux/systemd tmux owners into independently proven user scopes before server creation, added generation-bound exact-SIGTERM shutdown verdicts and deduplicated incident/recovery provenance, and removed pane payloads from raw session lifecycle evidence (#1938).
- Coordinator MCP stdio server now dispatches JSON-RPC requests with bounded concurrency and answers the standard `ping` utility, so a long-running tool call (e.g. `gjc_coordinator_await_turn`, which polls for minutes) no longer starves keepalive on the same channel — without the state/lifecycle races unbounded concurrency would introduce. Same-session mutations (notably `send_prompt`) serialize through a per-session lock so concurrent calls can no longer persist two "active" turns; `ping` is a reserved control frame that bypasses the data-concurrency cap; data-handler fanout is bounded (excess rejected as `server_busy`); `writeLine` failures are terminal instead of poisoning the write chain; and EOF drains in-flight handlers under a bounded timeout before returning.
- Prevented best-effort coordinator runtime-state persistence from surfacing unhandled rejections when a session root disappears during teardown, preserved public-safe coordinator errors including bounded-concurrent handler failures, bound tmux GC pruning to the collected native session identity and owner generation so same-name replacements are never removed, and preserved subsecond ordering between canonical verdict artifacts and their evidence receipts (#1938).
- The `browser` `close`/`close all` tool now enforces one end-to-end deadline (the existing `timeout` option, default 30s) across the whole teardown chain — `releaseAllTabs`, `waitForClosed`, `worker.terminate()`, and `releaseBrowser()`/`disposeBrowserHandle()` — so an externally CDP-connected target dying mid-close can no longer hang or terminate the calling agent session. Steps that exceed the shared budget are detached best-effort with their rejections swallowed (no unhandled rejections, no worker/browser/tab registry leaks, timers cleaned up); the tool always settles with a close count or a structured error, and normal live-target close semantics are unchanged (#2027).
- Pre-prompt context estimates now anchor on the last successful assistant's total usage (input + cache + output) instead of prompt-only tokens, and skip error/aborted turns when picking the anchor, so a large-reasoning turn (e.g. GPT-5.6 Sol at high efforts) no longer vanishes from the estimate right before the next request. The compaction token-correction ratio likewise no longer counts the anchor assistant's own output in its heuristic denominator, since that output was the anchored request's response rather than part of its prompt.
- The coordinator MCP tmux owner-server probe (`probeServer`: `tmux list-sessions` plus a portable `ps` incarnation read) now tolerates transient spawn failures. Under load a momentary `Bun.spawn` failure (e.g. `EAGAIN`, or a brief tmux/`ps` hiccup) threw straight out of the probe, and because `proveCoordinatorOwnerServer` only retries on non-safe *state* — not on a thrown exception — a single blip aborted the whole delegate immediately with `coordinator_tmux_owner_server_unverifiable` (a ~0.03s hard failure). The probe now surfaces a transient failure as an `unverifiable` state so the existing bounded retry loop can re-probe once it clears; owner isolation is unchanged (`unverifiable` still fails closed, creating no session).
- Coordinator-created tmux sessions now require an immutable, launch-bound runtime readiness marker before any prompt keys are injected, preventing early input races and preserving recoverable readiness-timeout evidence (#2009).
- Unsent-context token estimates are now script-aware (CJK characters charged near 1 token/char instead of chars/4), and the per-message delta estimate is no longer cached: the compaction-threshold decision always recomputes from current content, so an in-place mutation (e.g. a same-length ASCII→CJK edit) can never gate the threshold with a stale 4x-undercounted estimate.
- Capability-gated controlled ask delivery per connection: clients default-deny until they negotiate `ask_controls_v1`, renegotiate after reconnect, and receive the additive non-actionable `action_unavailable` frame instead of stripped option buttons when non-capable (#2029).
- `NotificationServer#pushFrame` now rejects `ActionNeeded` frames; emit asks and idle notifications through `registerAsk` / `noteIdle` so controlled asks remain capability-gated per connection (#2029).
- A rolling/in-place upgrade that left a still-live pre-upgrade Telegram daemon owning the lock is now reloaded instead of silently attached. The old daemon speaks the pre-#1999 wire protocol without ask-ack/controls, so its `Selected!` acknowledgements were dropped; an operational `DAEMON_GENERATION` (tied to `NOTIFICATION_PROTOCOL_VERSION`) now flags a fresh live owner running an older generation as reload-required, and the new host registers its session root then hands off through the cooperative SIGTERM/control path (#2028).
- A numeric gate reply is an option index: an out-of-range index is no longer accepted as free-text `Other`. `mapAnswerToGate` returns a discriminated result and the unattended handler closes the exact claim/receipt and reissues instead of durably accepting or emitting a `Selected!` ack; the JSON-string free-text path is preserved (#2030).

## [0.9.6] - 2026-07-10
### Changed

- Moved the `codex-eco`/`codex-medium`/`codex-pro` presets and the `opus-codex`/`codex-opencodego`/`fable-opus-codex` combo presets from `gpt-5.5` onto the GPT-5.6 tier family: Sol drives `default` and `architect` on every codex preset (eco `sol:medium`, medium `sol:high`, pro `sol:xhigh`/`sol:max`), with Luna/Terra covering the lighter executor/planner/critic roles by tier.
### Fixed

- Corrected launch-update guidance: only recognized Bun global installs, recognized Windows npm installs, and supported bundled-installer binaries may use `gjc update`; source checkouts and dev links must use their checkout workflow, while unrecognized package-manager or PATH installs must use their original update method. Successful updates require authoritative post-update version and smoke verification.

### Fixed

- Fixed v0.9.3–v0.9.6 compiled release binaries crashing at first real launch with `Cannot find module '/$bunfs/root/node_modules/handlebars/lib/index.js'` while `--version`/`--help` still worked (#1939). `--minify` silently dropped the handlebars bunfs extra entrypoint; handlebars is now bundled through a statically-traceable `require("handlebars")` in `@gajae-code/utils` prompt rendering (still lazy at runtime), and the fragile extra entrypoint is gone from both release and dev compile args. `--minify` and its startup-RSS win are retained.

## [0.9.5] - 2026-07-09
### Fixed

- ACP permission prompts now honor `clientCapabilities._meta.gjc.permissionHandling` and the `GJC_ACP_PERMISSION_MODE` fallback, so `auto` and `always-allow` no longer emit `session/request_permission` calls while invalid values fail safely to `prompt`.
- Model selector batch assignments ("Set for all role agents" / "Set for all targets") now open the reasoning-effort menu whenever any batch target requires an explicit choice (e.g. Anthropic reasoning models like `claude-fable-5`), and the chosen effort plus the full batch survive the menu. Previously the menu never appeared for Anthropic models (silently persisting `:off` selectors for every role agent), and for OpenAI/Codex models picking an effort collapsed the batch to a DEFAULT-only assignment.
### Added

- ACP clients now receive GJC automatic-compaction start/end state through additive `session_info_update` metadata, including the compaction action, trigger, retry/abort/error outcome, and busy-to-idle phase transitions.

## [0.9.4] - 2026-07-09
### Fixed

- `RpcClient.onSessionEvent()` now exposes the full renderer-facing agent-wire event stream instead of dropping non-core session events such as notices, todo reminders, retry events, subagent steering, thinking-level changes, and goal updates, while `onEvent()` remains the filtered legacy `AgentEvent` subscription path.
- Clarified `/session delete` help, confirmation, and completion wording to specify current vs. selected session transcript/artifact deletion and that other sessions plus topic/history metadata are not removed (#1913).
- Home screen build labels now come from install/build metadata, so release binaries and package installs no longer show a misleading dev build label (#1911).

## [0.9.3] - 2026-07-09

### Fixed

- Stabilized hotfix release checks by making generated docs lazy-load verification independent of Bun's module cache, preserving the docs index sync gate, and polling coordinator MCP watch reconciliation for runtime prompt acknowledgements.
- Updated macOS-specific queue shortcut and clipboard-temp image paste tests to match the shipped runtime behavior.

## [0.9.2] - 2026-07-09
### Added

- Added `gjc --credential <selector>` for pinning a stored provider credential by `email:`, `id:`, `account:`, `project:`, or `provider/email:` during a session.
- Added `--mpreset <profile>` support to Telegram `/session_create`, forwarding both `--mpreset <name>` and `--mpreset=<name>` as split argv to the spawned GJC child.
- Added the built-in `skill_discovery` tool for runtime discovery of custom project/user skills without injecting the full skill catalog into the core prompt.
- Pasting or drag-dropping a path to an existing image file now attaches the image and inserts an `[image N]` placeholder, including quoted paths, `file://` URIs, `~/` expansion, spaces, and macOS screenshot narrow no-break spaces.
- Pasted clipboard-temp image paths now attach as `[image N] source="/path"`, so the model receives both the image payload and the retrievable raw temp file path; ordinary saved image paths remain literal prompt text instead of being consumed into opaque placeholders.

### Changed

- The status line (information bar) token-percentage now renders inline within the model segment, right after the reasoning-effort indicator, instead of as a trailing segment at the far end of the line, so the context usage percentage stays grouped with the model it describes. The standalone `context_pct` segment was removed from the `default`, `default-usage`, `compact`, `full`, `nerd`, `ascii`, and `custom` presets (it remains available for `minimal` and custom configs); the inline percentage is color-coded by context-usage level, can be disabled per-preset with `segmentOptions.model.showContextPercent: false`, and is auto-suppressed when a standalone `context_pct` segment is also active so the value is never shown twice.

### Fixed

- Finalized notification turn mirrors now default to the bounded full-turn cap so Telegram's existing chunked delivery can send long assistant answers instead of receiving an already-truncated 3500-character summary; `GJC_NOTIFICATIONS_TURN_MAX` remains available to lower the cap for summary-style mirrors, and live previews stay capped as one editable message.
- `gjc --tmux` now wraps the inner GJC command with a durable `tmux-exit.json` marker next to `runtime-state.json`, so a tmux-resident session that exits before normal runtime-state finalization leaves a public-safe exit timestamp/code for silent-vanish diagnosis (#1746).
- `gjc --tmux` terminal titles now track live tmux session renames while preserving the friendly project/branch title for untouched generated session ids.
- Telegram session forum-topic renames now remain retryable after a transient `editForumTopic` failure, so topics do not get stuck at the provisional `GJC <session>` name while the daemon incorrectly records the final title locally.
- `/effort` selector choices now show the current reasoning effort and mirror `/model` by asking whether to apply the selected effort for the current session or save it as the default, including support for persisting `off`. Default model presets also sync their encoded effort into the persisted effort default so later `/effort` defaults are not overwritten on restart.
- Composer queue submissions (`Alt+Q` / `app.message.queue`) force one-at-a-time follow-up delivery, including replay after compaction, without disabling broader batch mode for other follow-up callers.
- `--credential` now rejects a missing selector immediately instead of falling through into session launch with no output.
- `gjc-session` prompt/monitor postmortem helpers now work on macOS's system Bash/Python, so missing tmux sessions write the public-safe `vanished.json` marker and prompt injection exits through the guarded refusal path.

## [0.9.1] - 2026-07-08

### Added

- Added `/effort` to show or set the current model reasoning effort, including a selector UI when run without arguments and validation for invalid effort names.
- Added `--mpreset <profile>` option to the Telegram `/session_create` command, allowing users to specify a model profile preset when creating a session remotely (e.g. `/session_create path /repo --mpreset codex-eco`). Both `--mpreset <name>` and `--mpreset=<name>` forms are supported.
- Pasting or drag-dropping a path to any existing image file into the interactive editor now attaches the image and inserts an `[image N]` placeholder instead of leaving the raw path in the prompt. Quoted paths, `file://` URIs, `~/` expansion, spaces, and macOS screenshot narrow no-break spaces are handled when the whole paste is a single supported image file.
- Added `GJC_NOTIFY=off` as a per-run completion-notification opt-out.
- Telegram mirror messages now render as native Bot API 10.1 rich messages on by default with a global `/rich on|off` toggle, while failing closed to the previous HTML path.

### Changed

- Upgraded the Extragoal review template with a stronger reviewer lane and optional maximalist N-of-N review recipe.
- Added `--mpreset <profile>` option to the Telegram `/session_create` command, allowing users to specify a model profile preset when creating a session remotely (e.g. `/session_create path /repo --mpreset codex-eco`). Both `--mpreset <name>` and `--mpreset=<name>` forms are supported. The preset is passed as a regular `--mpreset` CLI flag to the spawned `gjc` child, where the existing `applyStartupModelProfiles` flow activates it.
- Added the built-in `skill_discovery` tool for runtime discovery of custom project `.gjc/skills` and user `~/.gjc/skills` without injecting the full skill catalog into the core prompt; selected discovered skills are loaded narrowly through the existing `skill` invocation path (#1815).
- Pasting or drag-dropping a path to any existing image file into the interactive editor now attaches the image and inserts an `[image N]` placeholder instead of leaving the raw path in the prompt. Previously this only worked for clipboard temp files (`/tmp/clipboard-*` or `/var/folders/xx/yy/T/clipboard-*`); terminal drag-drop paths — including shell-escaped spaces and the U+202F narrow no-break space in macOS screenshot names — pasted as long raw path text. Quoted paths, `file://` URIs (decoded via Node's `fileURLToPath` semantics, including Windows drive-letter, `file://localhost`, and UNC forms), and `~/` expansion are handled; the whole paste must be a single path to an existing image file whose content carries a supported image signature (PNG/JPEG/GIF/WEBP), so prose containing paths and non-image files with image-looking extensions are inserted unchanged. When attachment still fails (unsupported content, oversized image, load error), the original pasted text is replayed into the editor instead of being consumed.

### Fixed
- Composer queue submissions (`Alt+Q` / `app.message.queue`) now force one-at-a-time follow-up delivery for those queued prompts, including replay after compaction, so they do not collapse into one batched model call even when the broader follow-up mode is set to `all`.

- `gjc team` on Windows/psmux now targets the GJC-managed leader session by name instead of trusting the inherited `TMUX_PANE`.
- Kitty inline images no longer duplicate/stack or paint over transcript text when the diff renderer repaints the image line.
- Session creation now forwards `--mpreset` as split argv instead of one combined argument.
- The RPC server restores the duplicate-listen boundary error instead of masking it.
- Mac Option+Enter no longer collides with the queue-message binding.
- Telegram completion notifications suppress dot-only messages, and Telegram-originated input is shown immediately and recorded in prompt history.
- The computer red-team CI gate avoids false positives from non-computer-control changes.

## [0.9.0] - 2026-07-07
### Added

- Added `/quit` as an alias of the `/exit` slash command, so the near-universal REPL/CLI quit verb shuts the session down instead of silently falling through to the model as a chat message. Like `/exit` it is a TUI-only shutdown: it is not advertised to ACP clients and is not listed as its own autocomplete/help entry.
- Added a `/clear` slash command that clears the active conversation context while preserving the current session id and durable session history (#1677).
- Added an Extragoal local skill template (`docs/extragoal-skill-template.md`) documenting an external final review gate on top of `ultragoal` — a fresh-context, cross-family, tool-restricted read-only reviewer with a machine-parsable verdict contract, mandatory bundle secret scan, prompt-injection stance, explicit findings triage, and a bounded re-sign loop — plus a `reviewer` stance profile and cross-session review-gate recipe in `docs/multi-vendor-profiles.md`, pinned by `test/extragoal-template.test.ts`.
- Added opt-in live turn streaming to the notifications surface. With `GJC_NOTIFICATIONS_STREAM=1` the session WebSocket now emits throttled non-finalized `turn_stream` frames (each carrying a per-turn `messageRef`) as the assistant message streams, and the Telegram threaded daemon edits ONE message in place — via `editMessageText` keyed by `(session, coalesceKey)` — so the finalized text lands on the same message instead of posting a new one. Off by default; without a `messageRef` finalized turns keep their legacy one-message-per-turn behaviour. Throttle interval is `GJC_NOTIFICATIONS_STREAM_INTERVAL_MS` (default 500ms); streamed frames remain suppressed under redaction.
- Added `GJC_NOTIFICATIONS_TURN_MAX` to raise the finalized `turn_stream` text cap (default 3500 chars, unchanged) so full long turns reach split-capable clients — the Telegram daemon already fans a long finalized turn across multiple messages via `splitTelegramHtml` — instead of being truncated with an ellipsis at the notification layer. The value is clamped to a finite `[280, 40000]` range: a non-finite or non-positive value (unset, `NaN`, `Infinity`, `<= 0`) falls back to the default, so the cap can never be unbounded. Opt-in and off by default (mirror stays a glanceable per-turn summary); live in-progress frames are intentionally NOT raised so a streaming turn stays one editable preview message rather than fanning across sends.

### Fixed
- Composer-pasted images now follow the visible `[image N]` placeholders at submit time, so deleting a pasted image placeholder with Backspace removes that attachment instead of still sending it to the model or Telegram session mirrors.

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
