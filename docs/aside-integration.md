# Aside sidecar evaluation

This note records the safe first-step boundary for evaluating [Aside](https://aside.com/) with Gajae-Code (`gjc`). It is intentionally docs-only: GJC does not ship an Aside adapter, does not auto-discover Aside, and does not enable browser-control behavior by default.

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

Use `--project` for repo-local evaluation records. Omit it only when the operator intentionally wants the stored definition in the user-level GJC MCP config; normal standalone GJC sessions do not consume either scope as runtime tools today.

After registration, inspect the redacted definition:

```sh
gjc mcp list --json
```

This is storage-only recordkeeping today. `gjc mcp add/list/remove` does not make Aside tools visible in normal `gjc`, `gjc --tmux`, or print-mode sessions. Do not paste task transcripts, browser screenshots, cookies, saved credential state, or private Aside profile paths into issues or PRs. If you need to share evidence, summarize the stored definition shape and any benign externally gathered result.


Recommended prompt boundary for evaluation:

```text
Use the Aside sidecar only for read-only search/context retrieval. Do not click, submit, sign in, autofill credentials, use payment or billing flows, post messages, write files, or operate internal tools. Return a short answer with source titles/URLs only.
```

## Option B: future HTTP/SSE MCP endpoint

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
4. Do not expect the registration to appear as model tools in a normal standalone GJC session today.
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
| `aside` command not found | Install the Aside CLI from Aside developer settings, then use the concrete CLI path as the MCP `command` if needed. |
| MCP server does not appear in `gjc mcp list` | Re-run `gjc mcp list --json`; confirm whether the registration was user-scoped or project-scoped. |
| Aside tools do not appear in a normal GJC session | Expected today. `gjc mcp` stores redacted definitions for recordkeeping/inspection; normal standalone `gjc`, `gjc --tmux`, and print-mode sessions do not load those registrations as runtime tools. |
| Auth failure | Rotate or re-enter the Aside-side token/API key. Do not paste it into GJC prompts or issue comments. |
| Endpoint/network failure | Check the URL, proxy, and TLS path outside GJC with a benign health check; do not dump request headers. |
| Retrieval misses context | Narrow the query to public sources first. Do not add browser history, cookies, screenshots, or account pages unless a separate approved design covers that data flow. |
| Stored definition points at browser-action tools | Treat the server as browser automation, not search-only. Keep it as recordkeeping only for default GJC workflows unless a separate approved design covers that broader sidecar for runtime use. |

## Decision

Docs-only is the smallest safe outcome for issue #1097. Existing GJC MCP registration can store a user-provided Aside MCP server definition for redacted inspection, and Aside already documents `aside mcp`; no GJC adapter glue is required. The future-safe boundary is to keep Aside external and opt-in, document read/search/context-only use, and require a separate design before GJC claims runtime support for browser actions, login, payment, internal-tool, or private browser-session workflows.
