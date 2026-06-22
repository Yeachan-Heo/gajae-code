---
name: gjc-delegation
description: Delegate planning, execution, and team workflows to gajae-code via the coordinator MCP server.
---

# GJC delegation

This plugin exposes gajae-code's coordinator MCP server so a host agent can
delegate whole workflows to GJC and receive durable turn status plus artifacts.

## Tools

| Tool | Workflow | GJC skill | Purpose |
| --- | --- | --- | --- |
| `gjc_delegate_plan` | plan | /skill:ralplan | Delegate consensus planning to GJC (runs /skill:ralplan to a pending-approval plan). |
| `gjc_delegate_execute` | execute | /skill:ultragoal | Delegate execution to GJC (runs /skill:ultragoal to completion with verification). |
| `gjc_delegate_team` | team | /skill:team | Delegate parallel team execution to GJC (runs /skill:team with internal tmux workers). |

## Fail-closed safety

The bundled MCP config sets `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` to the host
project directory and does **not** set `GJC_COORDINATOR_MCP_MUTATIONS`.
Delegation is read-only until the user explicitly enables a mutation class and
passes `allow_mutation: true` per call. `GJC_COORDINATOR_MCP_REPO` is a
namespace label only, never a filesystem path.

## Polling

Each delegate returns a `turn_id`. Poll `gjc_coordinator_await_turn` (bounded)
or `gjc_coordinator_watch_events` for the `delegation.started` event and the
terminal turn state. Turn state is the source of truth, not terminal scrollback.
