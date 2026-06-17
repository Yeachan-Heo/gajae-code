# Changelog

## [Unreleased]

### Added

- Managed-service examples for Telegram Remote deployments: Linux systemd user units for coordinator
  and RPC modes, macOS launchd parity examples with safe env-loading wrappers, service env templates,
  and docs for same-UID RPC sockets, token handling, linger, socket readiness, restart behavior,
  verification, and uninstall.

- Rich messaging (optional, default on via `GJC_TELEGRAM_REMOTE_ENABLE_RICH`): HTML formatting and
  inline keyboards as a presentation + alternate-entry layer over the same Coordinator MCP surface.
  - Inline **Observe** / **Stop** / **Refresh** / **Confirm stop** / **Cancel** buttons on
    `/sessions` and `/observe`; `setMyCommands` Bot menu (`sessions`/`observe`/`stop`/`help`/`start`,
    excluding hyphenated `/start-session`); `/start` onboarding.
  - Callback queries pass the same default-deny allowlist; `callback_data` is an opaque
    `gtr:v1:<token>` (≤64 bytes, never the session id) backed by TTL-bound, chat/user-bound,
    single-use server-side token metadata holding the exact raw session id.
  - Explicit `answerCallbackQuery` for every callback; unauthorized/expired/malformed/missing-chat/
    replayed/cancel callbacks are answer-only (no chat message, no backend call). HTML escaping at
    the render boundary; the transmitted-data allowlist is unchanged.
  - New transport reply contract (`OutgoingReply` over `IncomingUpdate`), optional
    `editMessageText` refresh (default off, safe fallback), and config knobs
    (`GJC_TELEGRAM_REMOTE_ENABLE_RICH`, `_RICH_CALLBACK_TTL_MS`, `_RICH_CALLBACK_MAX_TOKENS`,
    `_ENABLE_EDIT_MESSAGE_TEXT`, `_REGISTER_COMMANDS`).
  - Push notifications are deferred: rich UI does not proactively notify; future push must reuse the
    existing `gjc_coordinator_watch_events` event surface, not a Telegram-side poller.

- Initial v0 Telegram Remote gateway (`@gajae-code/telegram-remote`) for issue #681: a tiny,
  safe command + bounded-read operator surface over the Coordinator MCP.
  - Five-command vocabulary: `/sessions`, `/observe`, `/start-session`, `/stop`, `/help`.
  - Default-deny authorization with an identical, boring refusal for unlisted senders.
  - Preset-only session creation (fixed workdir + session command + single length-capped,
    control-char-stripped `{{task}}` slot); no workdir/command/shell/RPC from chat.
  - Fail-closed mutation gating with the smallest set (`sessions`, plus `reports` for
    `/stop`); `questions` is never enabled.
  - Transmitted-data allowlist: typed, redacted projection only — never raw tail,
    transcripts, tool IO, diffs, file contents, env, secrets, or absolute paths.
  - `/stop` confirmation gating that records the coordinator terminal `cancelled` status
    (not a process kill).
  - MCP stdio coordinator client, Bot API long-poll transport, env config loader, and a
    runnable service entry point (`gjc-telegram-remote`).
