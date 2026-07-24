# GitHub Review Bot

`gjc github-review` is a built-in GitHub code-review bot: a GitHub App webhook
server that reviews pull requests in embedded agent sessions. Reviews land as
the App with inline comments, a marked walkthrough summary (file table,
optional mermaid diagram, closing poem), incremental re-reviews on push, and a
live check-run + status line for progress.

## Commands

```
gjc github-review serve                       # webhook server + in-process sweeper
gjc github-review sweep [--dry-run]           # one-shot reconcile
gjc github-review complete <repo> <pr> <sha> <success|failure|neutral>
gjc github-review token                       # print an App installation token
gjc github-review gh <gh args...>             # run `gh` authenticated as the App
gjc github-review status [--json]             # dump per-PR review state
```

`complete` is invoked by the review session itself as its final step; it is
idempotent and owned by code, not the model: it closes the check-run, flips
the status line, releases the state gate, and drains superseded/queued PRs.

## Configuration

Config lives at `~/.gjc/github-review.json` (override with `--config` or
`GJC_GHR_CONFIG`). Required fields:

```json
{
	"appId": "4261751",
	"installationId": "145584306",
	"privateKeyPath": "~/.gjc/github-app.pem",
	"webhookSecret": "<X-Hub-Signature-256 secret>",
	"botLogin": "gajae-code"
}
```

Common optional fields (defaults in parentheses): `botAliases` (`[botLogin]`),
`botDisplayName`, `markerPrefix`, `checkName`, `host` (`127.0.0.1`), `port`
(`8644`), `webhookPath` (`/webhooks/github-review`), `maxInflight` (`4`),
`turnTimeoutMinutes` (`45`), `modelPattern`, `cwd`, `dataDir`
(`~/.gjc/github-review`), `ignoreRepos`, `repoConfigFile`
(`.gjc-review.yml`), `sweepIntervalSeconds` (`90`), `sweepStaleMinutes`
(`10`), `inflightStaleSeconds` (`1200`), `postCommand`, `completeCommand`,
`localWebhookUrl`, `apiBase`.

Env overrides use the `GJC_GHR_*` namespace: `GJC_GHR_CONFIG`,
`GJC_GHR_APP_ID`, `GJC_GHR_INSTALLATION_ID`, `GJC_GHR_PRIVATE_KEY`,
`GJC_GHR_WEBHOOK_SECRET`, `GJC_GHR_BOT_LOGIN`, `GJC_GHR_HOST`, `GJC_GHR_PORT`,
`GJC_GHR_MAX_INFLIGHT`, `GJC_GHR_TURN_TIMEOUT_MIN`, `GJC_GHR_MODEL`,
`GJC_GHR_CWD`, `GJC_GHR_DATA_DIR`, `GJC_GHR_INFLIGHT_STALE_SEC`,
`GJC_GHR_SWEEP_MIN`.

### Per-repo config

A YAML file at the PR head (default `.gjc-review.yml`) tunes the bot per
repository: `enabled`, `diagrams`, `poem`, `pr_summary`, `tone`,
`max_comments`, `ignore_paths`, and `path_instructions`
(`- path: "glob"` / `instructions: ...` pairs). A broken or missing file
never blocks reviews.

## Authorization model

- **Auto reviews** run for any human, non-draft PR (that is the bot's job),
  but the incremental *outdated-thread cleanup* — the only lane that mutates
  through the operator's user-scoped `gh` — is included only when the PR
  author's `author_association` is trusted.
- **Commands, chat, and inline replies** spawn terminal-capable sessions, so
  they are gated on `allowedAssociations` (default
  `OWNER`/`MEMBER`/`COLLABORATOR`). Untrusted authors get no ack and no
  session; the drop is logged as an `unauthorized` event.
- **`learn`** appends persistent instructions to every future review prompt
  and is therefore gated separately by `learnAssociations` (default
  `OWNER` only).

Webhook deliveries are HMAC-verified (constant-time), bounded in size, and
deduplicated by delivery id inside a persisted time window
(`dataDir/deliveries.json`), so neither redeliveries nor replayed captures of
old signed payloads double-run commands after a restart.

## Lifecycle

```
webhook → HMAC + dedup → router
  gate      per-PR CAS: dedup same-sha / supersede newer sha / queue over cap
  ack       in_progress check-run + live ⏳ status line (best-effort)
  run       embedded agent session (slot-limited, hard deadline)
  complete  idempotent helper: close check, flip status line, drain waiters
  sweeper   interval reconcile: stuck check-runs, stale in-flight state,
            queued/pending drains, PRs whose `opened` webhook was lost
```

The runner force-fails a review whose session ends abnormally
(timeout/error/abort) so the check-run never dangles until the sweeper.

## Deployment notes

- `serve` installs a **process-exit guard**: library code calling
  `process.exit` mid-review is blocked and logged with a stack trace; only
  the SIGTERM/SIGINT drain path may exit. Consequently a fatal internal error
  can leave the process alive-but-idle instead of exiting — **run `serve`
  under a supervisor** (launchd/systemd `KeepAlive`) and monitor `/health`
  (`{ok, running, queued}`).
- SIGTERM drains gracefully: intake closes first, then running reviews get up
  to 150 s to finish. Check `/health` for `running: 0` before restarting if
  you cannot tolerate interrupting a review.
- Reviews are remote-read-only by design (`gh pr diff` / compare API). The
  prompts ban cloning, redirects, and heredocs; the security guard enforces
  the same at tool level.
