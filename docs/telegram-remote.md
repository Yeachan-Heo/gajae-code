# Telegram Remote — v0 Roadmap (tiny operator button, not a cockpit)

Status: **spec + reference implementation** · Tracks issue #681 · Target: **0.6.0** · Reference implementation: [`packages/telegram-remote`](../packages/telegram-remote/README.md) (incl. rich messaging; push deferred)

Telegram Remote is a tiny, safe operator surface for Gajae-Code (`gjc`) session
**lifecycle and observation** from a phone. It is deliberately **not** a remote
RPC cockpit, a remote shell, a config editor, or a transcript viewer. The real
session owner stays GJC/tmux/harness-side; Telegram is only the control button.

This document fixes the v0 contract the issue calls out before any code lands:
the **first backend** (Coordinator MCP), the **preset-only session model**, the
**minimal command contract**, the **authorization posture**, and the
**transmitted-data allowlist**. It then splits the work into PR-sized steps.

## TL;DR architecture decision

v0 is a thin **command + bounded-read** surface layered on the **Coordinator
MCP**, which already exists and already enforces the safety properties this
roadmap needs. It introduces **no new remote-control protocol** — a second
authenticated control protocol would require ADR-level rationale per
[`docs/bridge.md`](bridge.md).

| Concern | Reused existing surface |
| --- | --- |
| Cross-session enumeration + bounded status | Coordinator MCP read tools ([`docs/bot-integration.md`](bot-integration.md), [`docs/hermes-mcp-bridge.md`](hermes-mcp-bridge.md)) |
| Preset-bounded session creation (workdir allowlist + session command) | `GJC_COORDINATOR_MCP_WORKDIR_ROOTS`, `GJC_COORDINATOR_MCP_SESSION_COMMAND` |
| Mutation gating (fail-closed: startup opt-in **and** per-call `allow_mutation`) | `GJC_COORDINATOR_MCP_MUTATIONS` |
| Namespacing so one bot cannot enumerate another's state | `GJC_COORDINATOR_MCP_PROFILE`, `GJC_COORDINATOR_MCP_REPO` |
| Bounded artifact reads (byte-capped, symlink-safe) | `GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP` |

The only genuinely new piece is a thin **Telegram gateway**: one PC-side or
systemd-managed process that authenticates an allowlisted Telegram user/chat,
maps a four-command vocabulary onto Coordinator MCP tool calls, and projects the
already-bounded coordinator state into short, redacted chat messages.

```
 Telegram user (allowlisted chat id)
        │  bot commands: /start-session /sessions /observe /stop
        ▼
 Telegram gateway  ── default-deny auth (allowlist) ──▶ reject everyone else
   (one process)   ── preset resolve ────────────────▶ fixed workdir + command + task template
        │          ── Coordinator MCP calls ─────────▶ gjc mcp-serve coordinator
        │
        └─ never: arbitrary shell · raw RPC · gate answers · raw tail/transcript · secrets
```

## Why Coordinator MCP first (and not bridge or harness directly)

The issue asks which backend is the first supported target. v0 picks
**Coordinator MCP** because it is the only existing surface that already gives
the gateway everything it needs without new code:

- **Cross-session enumeration.** `gjc_coordinator_list_sessions` answers
  `/sessions` directly. Bridge mode serves exactly one live session per process,
  so it cannot list.
- **Preset-bounded creation.** `gjc_coordinator_start_session` is constrained to
  `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` and launches `GJC_COORDINATOR_MCP_SESSION_COMMAND`.
  That is exactly the "fixed workdir root + fixed session command" preset model
  below — no arbitrary command string crosses Telegram.
- **Fail-closed mutations.** Mutating calls require both a startup mutation
  opt-in and per-call `allow_mutation: true`. Missing either fails closed, so a
  read-only gateway is the safe default.
- **Bounded observation.** Coordinator read tools return durable, bounded status
  rather than raw scrollback, which matches the "no raw dumps in Telegram" rule.

The web "steering wheel" remote ([`docs/gajae-remote.md`](gajae-remote.md), issue
#565) chose the harness control plane + bridge because it needs live
`Observation`/`readyForSubmit` submit gating for a one-line submit surface.
Telegram Remote v0 has **no submit surface** — only lifecycle and observation —
so it does not need the harness/bridge path. The two roadmaps stay independent;
a future Telegram backend adapter could front the harness control plane behind
the same four commands without changing this contract.

## Authority boundary contract

The Coordinator MCP and the GJC/tmux/harness runtime behind it are the sole
authority. The Telegram gateway and the chat user are **operators of a tiny
button set**, nothing more.

The gateway MUST NOT, in v0:

- run arbitrary shell, send arbitrary prompts/turns, or proxy raw RPC/MCP calls
  from chat text;
- accept a workdir, session command, branch, or repo chosen from chat (only
  preset ids are accepted);
- answer workflow-gate / permission / approval / structured questions (those
  stay owner-side; the gateway never enables the `questions` mutation class);
- stream raw tmux tail, transcripts, tool arguments/results, diffs, file
  contents, environment, system prompt, or secrets to chat;
- expand the preset task template into anything beyond a single length-capped,
  control-char-stripped task string.

The chat user MAY, in v0:

- start one session from an **approved preset** (`/start-session`);
- list live/recent sessions with concise bounded status (`/sessions`);
- read one session's bounded public-safe status slice (`/observe`);
- request a graceful stop/retire for one session (`/stop`), with confirmation.

## Preset-only session model

Session creation is **preset-only**. A preset is a named, server-side bundle —
never assembled from chat input:

| Preset field | Source / binding | Notes |
| --- | --- | --- |
| `workdir` | one entry from `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` | fixed; chat cannot pass a path |
| `sessionCommand` | `GJC_COORDINATOR_MCP_SESSION_COMMAND` | fixed; e.g. `gjc --worktree`; chat cannot pass a command |
| `taskTemplate` | optional fixed template string | optional; the only injection point is one `{{task}}` slot |
| `taskMaxLen` | gateway config | hard length cap on the chat-supplied task string |
| `id` | gateway config | the only preset reference a chat user may name |

`/start-session <presetId> [task]` resolves `presetId` to a configured preset and,
if the preset has a `taskTemplate`, substitutes a **single length-capped,
control-char-stripped** task string into the `{{task}}` slot. With no template,
the task argument is ignored or rejected per preset policy. The resolved
`{ cwd, prompt }` is passed to `gjc_coordinator_start_session` with
`allow_mutation: true`. No part of `workdir` or `sessionCommand` is ever derived
from chat input. This is the "smallest preset format that is useful without
becoming arbitrary remote execution" the issue asks for.

## Command contract (v0)

Four commands plus help. Everything else is rejected as unknown.

| Command | Intent | Coordinator MCP mapping | Mutation |
| --- | --- | --- | --- |
| `/start-session <presetId> [task]` | Create a bounded session from an approved preset | `gjc_coordinator_start_session` (preset `cwd` + templated `prompt`) | `sessions` |
| `/sessions` | List live/recent sessions with concise status | `gjc_coordinator_list_sessions` (+ `gjc_coordinator_read_status` for derived status) | none (read) |
| `/observe <sessionId>` | Show one session's bounded public-safe status slice | `gjc_coordinator_read_status` / `gjc_coordinator_read_coordination_status` | none (read) |
| `/stop <sessionId>` | Request graceful stop/retire for a session | `gjc_coordinator_report_status` with `status: "cancelled"` (records terminal turn state) | `reports` |
| `/help` | Show the command set | none | none |

Notes:

- `/observe` deliberately uses **bounded status**, not `gjc_coordinator_read_tail`.
  Raw tail is advisory debug context that can contain scrollback and is never
  surfaced to chat in v0.
- `/stop` over Coordinator MCP records a **terminal turn status** (`cancelled`);
  per the coordinator contract this is coordination state, **not** a tmux process
  kill. v0 treats `/stop` as "request graceful stop/retire"; the actual process
  teardown remains an owner-side concern. A true remote teardown is deferred and
  gated behind an explicit decision (see open questions).
- The gateway runs the Coordinator MCP with the **smallest** mutation set it
  needs: `sessions` for `/start-session`, plus `reports` only if `/stop` is
  enabled. It NEVER enables `questions`, and it exposes no read tool beyond list
  and bounded status.

## Authorization and safety posture

- **Default deny.** Only an explicit allowlist of Telegram user ids (and/or chat
  ids) may issue any command. Unlisted senders get a boring, identical refusal —
  no capability hints, no enumeration, no preset names.
- **No raw dumps.** Chat output is short and redacted by construction: session
  ids, derived status, branch, timestamps. Never transcripts, tool IO, diffs,
  file contents, env, system prompt, or secrets.
- **Allowlisted presets only.** Session creation cannot name a workdir, command,
  repo, or branch from chat — only a configured preset id.
- **Confirmation for destructive actions.** `/stop` requires an explicit
  confirmation step (e.g. a confirm callback or a second `/stop <id> confirm`)
  before any cancellation is recorded.
- **Stable session identity.** `/observe` and `/stop` operate on the coordinator
  `session_id`; the gateway resolves and echoes a stable id so the operator
  cannot accidentally stop the wrong owner.
- **Telegram is the button, GJC owns the session.** The gateway never bypasses
  coordinator mutation gating, never answers PC-side gates, and degrades to
  read-only or fully closed when mutations are not opted in.

## Transmitted-data contract (allowlist)

Only the fields below leave the PC into chat. Anything not listed is withheld by
default; this is a typed projection from the coordinator's already-bounded
status, never a passthrough of internal state.

### Session list entry → chat

| Field | Source | Notes |
| --- | --- | --- |
| `sessionId` | coordinator session id | opaque, stable id |
| `name` | derived (repo/branch/preset or id fallback) | sanitized, length-capped |
| `status` | derived from coordinator session/turn state | bounded enum: `idle` \| `working` \| `blocked` \| `offline` |
| `branch` | coordinator status | branch name only |
| `lastActivityAt` | coordinator status | timestamp |

### Open-session view → chat

| Field | Source | Notes |
| --- | --- | --- |
| `sessionId`, `name`, `status`, `branch` | as above | |
| `lifecycle` | coordinator session/turn lifecycle | bounded enum |
| `activeTurn` | coordinator turn status | `queued`/`active`/`waiting_for_answer`/terminal, no body |
| `blockerSummary` | coordinator status | short sanitized reason when blocked |

### Never transmitted

Raw tmux tail / scrollback, full transcript or message bodies, tool call
arguments or results, file contents, diffs, system prompt, environment
variables, tokens or secrets, and absolute paths beyond `branch`/preset
metadata. When content is intentionally withheld, chat shows a neutral
*"withheld on PC"* marker rather than a redacted blob.

## Failure states (must be boring and understandable)

| Condition | Detection | Chat UX |
| --- | --- | --- |
| Unauthorized sender | not in allowlist | identical boring refusal; no hints |
| Unknown preset | preset id not configured | "unknown preset"; no preset enumeration |
| Mutations disabled | `coordinator_mutation_class_disabled:*` | "session control is disabled"; stays read-only |
| Mutation not allowed for call | `coordinator_mutation_call_not_allowed:*` | refusal; no auto-escalation |
| Unknown session | `unknown_session` | "no such session"; re-list with `/sessions` |
| Active turn exists | `active_turn_exists` | report current turn; do not force |
| Coordinator unreachable / session offline | liveness/`offline` | "session offline"; control disabled |
| Task too long | exceeds `taskMaxLen` | rejected before any MCP call |

## Open questions from the issue — v0 decisions

| Question | v0 decision | Deferred |
| --- | --- | --- |
| Where does it live (in-repo app / example / companion package)? | Companion **gateway** spec here; first reference implementation as an example integration / small service, not a core `gjc` mode | In-repo first-class mode → later, behind a decision |
| First session backend (tmux GJC / harness / both)? | **Coordinator MCP** (covers managed + registered visible-tmux sessions) | Harness control-plane adapter behind the same four commands → later |
| Smallest useful preset format? | Fixed `workdir` + fixed `sessionCommand` + optional fixed `taskTemplate` with one length-capped `{{task}}` slot | Multi-step / parameterized presets → later |
| Does `/stop` kill the process? | No — v0 records coordinator terminal status (`cancelled`); teardown stays owner-side | True remote teardown → decision-gated |
| Hosted relay vs local bot token? | Standard Telegram bot token + allowlist; PC/systemd-hosted gateway | Hosted multi-tenant relay → ADR-gated |

## Implementation plan (PR-sized steps)

Each step is independently shippable; later steps stay fail-closed until wired.

1. **PR 1 — this doc.** `docs/telegram-remote.md` + README cross-link. Resolves
   the backend, preset, command, authorization, and transmitted-data decisions.
   No code.
2. **PR 2 — preset + command contract types.** Preset shape (`id`, `workdir`,
   `sessionCommand`, `taskTemplate?`, `taskMaxLen`), command parse model, and a
   typed projection `coordinator status → chat summary/view`. Tests assert the
   allowlist (no forbidden field can leak; task length cap enforced). Types only;
   no Telegram wiring.
3. **PR 3 — gateway read path.** `/sessions` + `/observe` over coordinator read
   tools, behind an explicit opt-in, default-deny allowlist, redaction
   projection. Tests for status derivation and redaction.
4. **PR 4 — gateway create path.** `/start-session <presetId> [task]` →
   `gjc_coordinator_start_session` with preset-bound `cwd`/`prompt` and the
   length-capped task slot. Tests for preset resolution and rejection of
   arbitrary workdir/command/task injection.
5. **PR 5 — gateway stop path.** `/stop <sessionId>` with confirmation →
   coordinator `cancelled`. Tests for confirmation gating and unknown/active
   session handling.
6. **PR 6 — auth + hardening.** Allowlist enforcement, boring refusals, mutation
   opt-in matrix, CHANGELOG, docs finalize. Tests prove unauthorized senders and
   non-preset inputs are rejected before any MCP call.

## Non-goals (v0)

- No arbitrary Telegram-side shell or raw RPC/MCP passthrough.
- No raw transcript/tail/secret/log dumping to chat by default.
- No filesystem editor or config editor from chat.
- No answering of PC-side approval/confirmation/structured-question gates.
- No second authenticated remote-control protocol (reuse Coordinator MCP; relay
  needs an ADR).
- No remote-desktop replacement.

## Key source references

- Coordinator MCP contract + setup: [`docs/bot-integration.md`](bot-integration.md), [`docs/hermes-mcp-bridge.md`](hermes-mcp-bridge.md), `packages/coding-agent/src/commands/harness.ts`
- External-control readiness classification: [`docs/external-control-readiness.md`](external-control-readiness.md)
- Web "steering wheel" remote (sibling roadmap, harness/bridge-backed): [`docs/gajae-remote.md`](gajae-remote.md)
- Bridge transport / fail-closed posture (why no second protocol): [`docs/bridge.md`](bridge.md)
- RPC command/response contract and error shapes: [`docs/rpc.md`](rpc.md)
- v0 reference implementation (this contract, as a small companion service): [`packages/telegram-remote`](../packages/telegram-remote/README.md)

## Rich messaging and push notifications (implemented)

The reference implementation adds optional rich messaging (default on) as a presentation +
alternate-entry layer, without widening the action surface or transmitted-data allowlist:

- HTML formatting and inline keyboards (**Observe** / **Stop** / **Refresh** / **Confirm stop** /
  **Cancel**), a `setMyCommands` Bot menu (`sessions`/`observe`/`stop`/`help`/`start`; the hyphenated
  `/start-session` cannot be registered and is documented in `/help`), and `/start` onboarding.
- Callback queries are a new authenticated input channel that reuses the **same** default-deny
  authorization, the **same** `CoordinatorClient` → Coordinator MCP calls, and the **same**
  redaction. `callback_data` is an opaque `gtr:v1:<token>` (≤64 bytes, never the session id) backed
  by TTL-bound, chat/user-bound, single-use server-side token metadata holding the exact raw id.
  Every callback is answered; unauthorized/expired/malformed/missing-chat/replayed/cancel callbacks
  are answer-only (no chat message, no backend call).

**Push notifications reuse the `gjc_coordinator_watch_events` event surface.** Follow/Mute state is gateway-owned and bounded; delivery preserves the transmitted-data allowlist and does not introduce a Telegram-side session journal or shadow notification protocol.

## RPC mode (second backend)

The package also supports a second backend, `GJC_TELEGRAM_REMOTE_BACKEND=rpc`,
for a single persistent session. In this mode the gateway dials an existing
owner-only UNIX socket exposed by `gjc launch --output rpc`; it never spawns,
kills, or tears down the session. Telegram acts as an attach/detach remote
keyboard with `/attach`, `/detach`, `/status`, `/abort`, and `/help`/`/start`.
Coordinator browsing commands (`/sessions`, `/observe`, `/presets`,
`/start-session`, `/stop`) are not part of RPC mode and are rejected as unknown.

RPC delivery is event-driven: agent questions and gates render as inline buttons,
and turn completion sends only the final assistant text, HTML-escaped and
Telegram-chunked. Session exit or liveness timeout produces exactly one
stale-attachment alert. The socket's OS ownership is the real boundary: same-UID
clients are fully trusted in v1, while protection targets different-UID users and
unsafe filesystem placement. Controller ownership is last-connected-wins; a later
UDS client becomes current, the gateway alerts once, reconnects, and resyncs.
See [`packages/telegram-remote/README.md`](../packages/telegram-remote/README.md)
and [`packages/telegram-remote/.env.example`](../packages/telegram-remote/.env.example)
for RPC knobs.

## Managed service examples

`packages/telegram-remote/examples/systemd/` contains Linux systemd **user-unit** examples, which are the canonical always-on deployment path:

- `gjc-telegram-remote-coordinator.service` runs the default Coordinator MCP backend as one bot service.
- `gjc-rpc-session.service` runs the persistent `gjc launch --output rpc --listen <socket>` session.
- `gjc-telegram-remote-rpc.service` runs the RPC Telegram bot, orders after and wants the session unit, and performs a finite socket wait because `After=` is not readiness.
- `telegram-remote.env.example` is a service-oriented env template; copied real env files must be owner-only (`0600`).

`packages/telegram-remote/examples/launchd/` contains macOS LaunchAgent parity examples. They use `com.example...` labels so operators replace the namespace, and shell wrappers source a protected env file then `exec` the real command. launchd parity cannot express systemd `Wants=`/`After=`/`BindsTo=` semantics; the RPC bot wrapper performs a finite socket wait.

Service examples are not a new daemon and do not change the runtime contract. Coordinator mode remains one service. RPC mode remains two services because the Telegram gateway dials an existing owner-only socket and never owns the session. The examples document the same-UID socket boundary, `last-connected-wins`, concrete socket paths, `loginctl enable-linger` for boot-start Linux user services, absolute executable paths or a service-local `PATH`, no token in units/plists/argv/logs, and install/uninstall verification.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
