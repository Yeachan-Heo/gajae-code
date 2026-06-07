# Hermes MCP bridge

GJC exposes a native outward MCP bridge for Hermes-style coordinators:

```bash
gjc mcp-serve hermes
```

The bridge is intentionally separate from GJC's client-side MCP runtime. It lets an external coordinator list sessions, start worktree/tmux-oriented sessions, queue bounded follow-up prompts, read status/tail/artifacts, handle structured questions, and write coordination reports without scraping terminal scrollback.

## Safety model

The bridge is read-only and fail-closed by default.

Required root allowlist:

```bash
export GJC_HERMES_MCP_WORKDIR_ROOTS="/path/to/repo:/path/to/worktrees"
```

Mutating tools require both startup opt-in and per-call consent:

```bash
export GJC_HERMES_MCP_MUTATIONS="sessions,questions,reports"
```

Every mutating MCP call must also include `allow_mutation: true`. Missing startup opt-in or missing per-call consent returns an error instead of falling back to shell or terminal relay.

Artifact reads are canonicalized, symlink escapes are rejected, and returned content is byte-capped by `GJC_HERMES_MCP_ARTIFACT_BYTE_CAP`.

## Optional namespace

Use namespace variables to prevent cross-profile or cross-repo enumeration:

```bash
export GJC_HERMES_MCP_PROFILE="meeseeks2"
export GJC_HERMES_MCP_REPO="gajae-code"
```

Missing namespace never widens into global session enumeration.

## Tool surface

Read tools:

- `gjc_hermes_list_sessions`
- `gjc_hermes_read_status`
- `gjc_hermes_read_tail`
- `gjc_hermes_list_questions`
- `gjc_hermes_list_artifacts`
- `gjc_hermes_read_artifact`
- `gjc_hermes_read_coordination_status`

Mutating tools:

- `gjc_hermes_start_session`
- `gjc_hermes_send_prompt`
- `gjc_hermes_submit_question_answer`
- `gjc_hermes_report_status`

## Hermes config snippet

```json
{
  "mcp_servers": {
    "gjc_hermes": {
      "command": "gjc",
      "args": ["mcp-serve", "hermes"],
      "env": {
        "GJC_HERMES_MCP_WORKDIR_ROOTS": "/home/doyun/src/gajae-code",
        "GJC_HERMES_MCP_PROFILE": "meeseeks2",
        "GJC_HERMES_MCP_REPO": "gajae-code"
      },
      "enabled": true
    }
  }
}
```

## Smoke check

```bash
gjc mcp-serve hermes --check --json
```

Expected result includes `ok: true`, server name `gjc-hermes-mcp`, and the GJC-named tool list.
