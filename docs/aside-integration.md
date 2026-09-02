# Aside sidecar evaluation

This note records the safe first-step boundary for evaluating [Aside](https://aside.com/) with Gajae-Code (`gjc`). The search/context sidecar path is intentionally docs-only: GJC does not ship an Aside adapter, does not auto-discover Aside, and does not enable browser-control behavior by default.

The one in-tree CLI ergonomics surface is the explicit `/aside` composer slash command. It probes a user-installed Aside CLI and can run `aside exec` / `aside account` when the operator types it. That command does not restore a GJC browser-tool backend and does not turn Aside on for ordinary browser or search tools.

## Current public surface

Official Aside docs currently describe Aside as a browser agent that can run tasks across websites, accounts, browsing history, files, saved credentials, and browser state. The developer surface includes:

- `aside "..."` for starting a browser task from the terminal.
- `aside --session <session-id> "..."` for continuing a task.
- `aside mcp` for exposing Aside to another agent or coding tool as an MCP server.
- `aside repl` for direct browser automation REPL tasks.

Those are useful evaluation hooks, but they are not a narrow GJC-native search API. The documented Aside product surface is broader than search/context retrieval, including browser actions, login-adjacent flows, files, payments, messages, and internal websites. GJC therefore treats Aside as an external, user-owned sidecar until a separate design approves a smaller protocol contract.

## Supported GJC boundary

Use Aside with GJC only when the user explicitly configures it. The safe default scope is:

- search, source-heavy research, summarization, and context retrieval;
- read-only inspection prompts where possible;
- explicit user-provided endpoint, command, and credentials;
- no raw browser/session/private payloads in logs, PRs, issues, or support bundles.

Out of scope by default:

- browser actions and form submissions;
- login flows, credential autofill, MFA, account recovery, and password-manager operations;
- payments, purchases, subscriptions, billing changes, posts, messages, or destructive actions;
- internal-tool workflows, customer/admin dashboards, or privileged production data;
- file writes or local computer control through Aside;
- automatic import of Aside browser history, cookies, task transcripts, screenshots, or local profile data into GJC.

If a task needs any out-of-scope behavior, stop and require a separate explicit design and approval path. Do not smuggle that behavior through a generic “search” tool name.

## Option A: local Aside MCP command

When the Aside CLI is installed and the operator wants to record the Aside MCP command for repo-local inspection, store the definition explicitly:

```sh
gjc mcp add aside aside mcp --project
```

Use `--project` for repo-local evaluation records. Omit it only when the operator intentionally wants the stored definition in the user-level GJC MCP config; both scopes are consumed by ordinary standalone GJC sessions at startup (conventional autoload) unless disabled or opted out with `--no-mcp`.

After registration, inspect the redacted definition:

```sh
gjc mcp list --json
```

`gjc mcp add` makes the stored server definition available to ordinary standalone `gjc`, `gjc --tmux`, and print-mode sessions as runtime tools. Do not paste task transcripts, browser screenshots, cookies, saved credential state, or private Aside profile paths into issues or PRs. If you need to share evidence, summarize the stored definition shape and any benign externally gathered result.


Recommended prompt boundary for evaluation:

```text
Use the Aside sidecar only for read-only search/context retrieval. Do not click, submit, sign in, autofill credentials, use payment or billing flows, post messages, write files, or operate internal tools. Return a short answer with source titles/URLs only.
```

## Option B: `/aside` composer command

Type `/aside` in the GJC composer to probe and use a locally installed Aside CLI. This is operator-initiated and does not enable GJC browser-control by default.

```text
/aside
/aside Summarize the current page
/aside exec --session <id> Continue
/aside mcp
/aside account list
```

Behavior:

- Bare `/aside` prints the resolved CLI path, `aside --version` when available, and usage.
- `/aside <prompt>` and `/aside exec …` spawn `aside exec` with argv (no shell).
- `/aside mcp` prints `gjc mcp add aside <resolved-cli> mcp --project`. It does not start `aside mcp` inside GJC, because that command is a stdio server.
- `/aside repl` is refused inside GJC. Run `aside repl` in a real terminal TTY.
- If the CLI is missing, GJC prints the searched paths and `curl -fsSL https://releases.aside.com/install.sh | bash`. It never runs the installer.
- On native Windows, the printed MCP and REPL commands use PowerShell quoting; the documented installer command is for WSL or Git Bash, not PowerShell itself.

Probe order: `~/.local/bin/aside`, then `~/.aside/cli/Aside CLI.app/Contents/MacOS/aside`, then `PATH`.

Keep the same payload boundary as the MCP path: do not paste cookies, screenshots, task transcripts, or private Aside profile paths into issues or PRs.

## Option C: future HTTP/SSE MCP endpoint

If Aside or a wrapper later exposes a narrow search/context MCP endpoint, keep endpoint and credentials user-owned:

```sh
export ASIDE_MCP_URL="https://aside.example.invalid/mcp"
export ASIDE_API_KEY="..."
gjc mcp add aside-search --type http --url "$ASIDE_MCP_URL" --header Authorization="Bearer $ASIDE_API_KEY" --project
```

`gjc mcp list` and `gjc mcp remove` redact header/auth values, but operators are still responsible for not echoing secrets in shell history, CI logs, screenshots, or copied terminal output. Prefer environment indirection over literals whenever possible.

A future Aside search endpoint should be accepted only if it is narrower than browser automation. Minimum shape:

- one or more read-only search/context tools;
- no browser click/type/navigation tool in the same registered server unless explicitly approved;
- no direct access to cookies, saved credentials, raw screenshots, raw task transcripts, or browser profile paths;
- bounded response sizes with source titles/URLs and short snippets by default;
- clear auth failure vs endpoint/network failure errors without dumping request headers or private response bodies.

## Benign smoke checklist

Use this checklist instead of a live login/payment/internal-site scenario:

1. Register the MCP server definition with `gjc mcp add ... --project`.
2. Run `gjc mcp list --json` and confirm secrets are redacted.
3. Confirm the record is project-scoped or user-scoped as intended.
4. Confirm the registration is consumed by a normal standalone GJC session in that project (tools appear at startup). To verify without a server, use `--no-mcp` or disable the server (`enabled: false` / `disabledServers`) for that session.
5. If evaluating Aside behavior separately, run one public, non-personal query through the Aside-owned surface, for example: `Find the Aside public help page that describes MCP support and summarize the documented command names.`
6. Confirm any shared evidence includes only public page titles/URLs or short snippets.
7. Confirm no API key, Authorization header, cookie, browser profile path, screenshot, raw task transcript, or private session payload appears in terminal output, logs, issue comments, or PR text.
8. Remove the evaluation server if it is no longer needed:

```sh
gjc mcp remove aside --project
# or
gjc mcp remove aside-search --project
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `aside` command not found | Run `/aside` in the GJC composer, or install the Aside CLI from Aside developer settings, then use the concrete CLI path as the MCP `command` if needed. |
| `/aside` says the CLI was not found | Confirm the installer symlink (`~/.local/bin/aside`) or the `Aside CLI.app` bundle exists and is executable. `/aside` never runs the installer. |
| `/aside repl` is refused | Expected. GJC cannot attach a TTY to `aside repl`; run that command in a terminal. |
| MCP server does not appear in `gjc mcp list` | Re-run `gjc mcp list --json`; confirm whether the registration was user-scoped or project-scoped. |
| Aside tools do not appear in a normal GJC session | Check `gjc mcp list --json`: the server must be `autoload` status (not `enabled: false`, not in `disabledServers`, not `autoload: false`), project scope must not be disabled by an explicit `mcp.enableProjectConfig: false` setting, and the session must not have passed `--no-mcp`. |
| Auth failure | Rotate or re-enter the Aside-side token/API key. Do not paste it into GJC prompts or issue comments. |
| Endpoint/network failure | Check the URL, proxy, and TLS path outside GJC with a benign health check; do not dump request headers. |
| Retrieval misses context | Narrow the query to public sources first. Do not add browser history, cookies, screenshots, or account pages unless a separate approved design covers that data flow. |
| Stored definition points at browser-action tools | Treat the server as browser automation, not search-only. Keep it as recordkeeping only for default GJC workflows unless a separate approved design covers that broader sidecar for runtime use. |

## Decision

Docs-only remains the smallest safe outcome for the search/context sidecar in issue #1097: existing GJC MCP registration can store a user-provided Aside MCP server definition for redacted inspection, and Aside already documents `aside mcp`. `/aside` is the separate CLI-ergonomics path: an explicit composer command that probes and optionally execs the user-installed binary, without adapter glue and without restoring the reverted Aside browser-tool backend. The future-safe boundary is to keep Aside external and opt-in, document read/search/context-only use, and require a separate design before GJC claims runtime support for browser actions, login, payment, internal-tool, or private browser-session workflows.

## Option D: `browser.backend: aside` (CLI routing)

`browser.backend` selects the browser surface offered to the model. The default `"native"` keeps the built-in Puppeteer `browser` tool. Setting it to `"aside"` hides the built-in tool (it is neither active nor discoverable) and appends a `<browser-backend>` system-prompt block that requires every browser task to run through the Bash tool as a direct `aside repl` (deterministic Playwright) or `aside exec` (agentic) invocation. It does not register or start an MCP server, does not spawn or supervise any Aside process from GJC, and does not restore the reverted in-process Aside browser driver; the boundary decision above is unchanged because the operator opts in explicitly per setting.

There is no fallback to the native browser. When the Aside CLI is unavailable, the direct CLI command fails in the Bash tool result and the session has no browser tool.

```sh
gjc config set browser.backend aside
```

The routing contract follows Aside's official developer documentation
(`https://docs.aside.com/help/developers.md`, indexed by
`https://docs.aside.com/llms.txt`) and the API references bundled with the
installed Aside version. It covers:

- deterministic Playwright through `aside repl`, including tab attachment,
  snapshots, locators, authenticated fetch/downloads, screenshots, Chrome
  profile APIs, visual CUA fallback, and authorized CAPTCHA helpers;
- agentic `aside exec` work for runtime judgment, source-heavy research,
  browser history, MFA/autofill, approvals, notifications, monitoring,
  multi-site synthesis, routines, and resumable `--session` follow-ups;
- account/model/provider/speed/effort targeting without changing user defaults;
- dedicated Google, document, media, social, password-manager, PDF, and Office
  integrations when the installed Aside build exposes them; and
- explicit permission, privacy, credential, payment, messaging, posting,
  document-edit, profile-mutation, and destructive-action boundaries.

The always-injected prompt stays a routing and safety contract rather than
copying every versioned method signature. The user-level `aside` skill contains
the detailed API inventory and points agents to the installed official builtin
skills when exact signatures matter.
