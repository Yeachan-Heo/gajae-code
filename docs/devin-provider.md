# Devin CLI provider (ACP)

GJC can drive [Devin CLI](https://docs.devin.ai/cli) as a selectable provider.
Devin is integrated through its Agent Client Protocol server
(`devin acp`), because that is the only programmatic interface Devin CLI
exposes: Devin publishes no model-inference endpoint, and its CLI credentials
cannot be reused for arbitrary inference requests.

That makes `devin` an **agent-level provider**, not a model backend. This page
states exactly what that means for tools, permissions, workflows, and billing.

## Setup

```sh
# 1. Install Devin CLI and authenticate (credentials stay with Devin).
#    https://docs.devin.ai/cli
devin auth login

# 2. Confirm the CLI is reachable. GJC spawns `devin acp` over stdio.
devin models list

# 3. Start GJC and pick a Devin model.
gjc
#   /model          -> provider model picker
#   gjc models      -> non-interactive model list
```

If `devin` is not on `PATH`, point GJC at the executable:

```sh
GJC_DEVIN_CLI_PATH=/opt/devin/bin/devin gjc
```

## Models

GJC discovers the models **your account** can use from the ACP session's own
`model` config option and applies the model you select with the session's
`session/set_config_option` request. The catalog therefore follows your Devin
account and enterprise allowlists instead of a hardcoded list. `adaptive` is the
default selector when no model has been chosen yet
([Devin's recommended default](https://docs.devin.ai/cli/adaptive)); enterprise
organizations can disable it.

Selecting a model the account does not offer fails loudly with the account's
actual options rather than silently running a different (possibly more
expensive) model. If you switch models mid-session, GJC applies the change to
the live ACP session.

## What applies to a Devin turn

| Surface | Applies? |
| --- | --- |
| GJC TUI, transcript rendering, session persistence, resume | Yes |
| Provider/model selection (`/model`, `gjc models`, role profiles) | Yes |
| Cancelling a turn (Esc/Ctrl+C) | Yes — GJC sends ACP `session/cancel` |
| Devin's own tool calls shown in the transcript | Yes, read-only (see below) |
| GJC tools (bash, read, edit, grep, task, web search, LSP, …) | **No** — Devin runs its own tools |
| GJC skills, workflows (`deep-interview`, `ralplan`, `ultragoal`, `autoresearch`), role agents, hooks | **No** — they are not sent to Devin |
| GJC permission prompts for GJC tools | **No** — see "Permissions" |
| GJC context compaction, handoff, branch summaries | **No** — refused up front, never sent to Devin |
| GJC token accounting, cost display, context-window pressure | **No** — Devin reports its own usage |

### Why GJC tools do not participate

A GJC model provider returns an assistant message whose tool calls GJC then
executes. ACP works the other way around: the agent executes its tools and
reports them to the client. GJC therefore renders Devin's `tool_call` /
`tool_call_update` notifications as read-only transcript entries and always
finishes the turn with a normal stop, so GJC never re-executes a Devin tool
call. Each entry carries its ACP identity under an `_acp` key
(`toolCallId`, `kind`, `status`) in its arguments.

Devin owns the conversation history. GJC forwards only your newest message, and
Devin applies its own rules (`AGENTS.md`, `.devin/` rules and skills, MCP
servers you configured with `devin mcp`). GJC's own `AGENTS.md`-driven harness
guidance is not injected into Devin turns.

### Maintenance and utility calls are refused

GJC also routes non-turn work through a provider: context compaction, handoff
generation, branch summaries, and utility generations such as session titles,
commit messages, and prompt suggestions. Devin is an agent, not a text model, so
GJC refuses those requests instead of spending your Devin quota on them, with an
error naming what happened (`maintenanceCall` on the provider request).

A Devin turn therefore requires an interactive GJC session turn: a session
identity plus a user message. Utility one-shots that carry no session identity
are rejected the same way.

This rarely matters in practice: because GJC forwards only your newest message,
Devin manages the conversation context itself, so GJC-side compaction is not
needed to keep a Devin session going. GJC's own transcript can still reach its
auto-compaction threshold on a long session, in which case compaction reports the
error above — switch to a non-Devin model (`/model`) for that operation, or keep
a non-Devin model as your main model when you rely on GJC-side compaction.

### Images

Image attachments are forwarded only when the ACP agent advertises image prompt
support (an ACP `promptCapabilities` negotiation). Otherwise the attachment is
replaced with a visible note in the prompt, so nothing is dropped silently.

## Permissions

Devin asks the ACP client — GJC — before running the operations its own
permission policy gates. GJC answers from an explicit policy:

| `GJC_DEVIN_PERMISSION_MODE` | Behavior |
| --- | --- |
| unset / `allow` (default) | Grant the least-privileged option Devin offered — `allow_once` before `allow_always`. One action per prompt: GJC never escalates to a persistent grant on its own. |
| `deny` | Reject with `reject_once` (or `reject_always` when that is the only refusal offered). |
| any other value | Fails closed to `deny`. |

If Devin offers no option matching the policy, GJC answers `cancelled` rather
than approving something it was not offered.

This policy mirrors GJC's own stance for its own tools: GJC is an autonomous
coding agent and does not prompt for every tool call. Set
`GJC_DEVIN_PERMISSION_MODE=deny` for untrusted repositories, or configure
Devin's own permission mode (`devin --permission-mode`, `DEVIN_PERMISSION_MODE`)
so it does not ask in the first place.

## Billing

Devin usage is billed to **your Devin account** (quota/credits or ACUs,
depending on your plan). GJC records zero cost for Devin turns and does not
convert Devin usage into GJC token accounting; use Devin's `/usage` or
`/session-stats` inside a session for that.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Provider shows no models | Devin CLI missing, unauthenticated, or off `PATH`. Run `devin auth login`; set `GJC_DEVIN_CLI_PATH` if needed. |
| `Devin CLI is not authenticated` | GJC reached the CLI but it has no credentials. Run `devin auth login` (or set `WINDSURF_API_KEY` for enterprise builds). |
| `Devin account does not offer model "<id>"` | The model is not in your account's allowlist. Pick a discovered model. |
| `Devin ACP process exited with code …` | The CLI crashed; the stderr tail is included in the message. |
| Turn stalls then errors | The agent stopped sending updates within the stream idle timeout. Check `devin doctor`/`devin --version`. |
| Error naming maintenance calls | GJC refused a compaction/handoff/branch-summary request on a Devin model. Switch to a non-Devin model for that operation. |

## Implementation notes

- Provider id `devin`, API `devin-acp`, implemented in
  `packages/ai/src/providers/devin-acp.ts`.
- One `devin acp` child process per GJC session, reused across turns and killed
  at session teardown (`providerSessionState`).
- Authentication, model catalog, tool execution, and usage stay inside Devin;
  GJC never reads or stores Devin credentials.

See also: [Models and providers](./models.md),
[Environment variables](./environment-variables.md).
