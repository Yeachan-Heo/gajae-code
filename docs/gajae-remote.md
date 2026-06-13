# Gajae Remote — v0 Design (thin phone steering wheel)

Status: **design / pending approval** · Tracks issue #565 · Scope: **v0 only**

Gajae Remote is a thin remote *steering wheel* for an already-running PC-side
`gjc` session. It is intentionally **not** a universal phone shell, a remote
filesystem editor, or a remote-desktop replacement. The PC stays the authority
boundary for file edits, shell execution, approval gates, and sensitive output.

This document fixes the two things the issue calls out as blockers/gates before
any code lands: the **authority boundary contract** and the **transmitted-data
contract**. It then maps v0 onto existing surfaces and splits the work into
PR-sized steps.

## TL;DR architecture decision

v0 is a thin **read + one-line-submit** surface layered on subsystems that
already exist. It introduces **no new remote-control protocol** — that would
require ADR-level rationale per [`docs/bridge.md`](bridge.md).

| Concern | Reused existing surface |
| --- | --- |
| Network transport, TLS, bearer auth, fail-closed posture | Bridge mode (`gjc --mode bridge`), [`docs/bridge.md`](bridge.md) |
| Client SDK / framing | `@gajae-code/bridge-client` (`BridgeClient`, `events()`) |
| Session state storage, liveness, bounded status, submit gating | Harness control plane (`gjc harness`), `packages/coding-agent/src/harness-control-plane/` |
| Bounded observation (never a raw transcript dump) | `Observation` / `SessionStateView` in `harness-control-plane/types.ts` |
| Web client precedent (local server + SPA) | `packages/stats` (`server.ts` + `src/client/`) |

The only genuinely new piece is a thin **Gajae Remote gateway**: one PC-side
process that enumerates harness control-plane sessions and proxies a strict,
bounded subset of read/submit operations to each session's owner. The phone
talks to exactly one gateway endpoint.

## Why a gateway (and not one bridge per session)

Bridge mode serves **exactly one live `AgentSession` per process** and is
fail-closed by default (see the endpoint matrix in
`packages/coding-agent/src/modes/bridge/bridge-mode.ts`). The v0 requirement
"list active PC-side sessions" needs cross-session enumeration, which a single
bridge process does not provide.

The harness control plane already centralizes exactly this: per-session
`state.json`, lease + heartbeat liveness, a single-writer severity event log,
and a **bounded** observation vocabulary. So the gateway is a thin read/submit
proxy over the control plane, wearing the bridge security model (TLS + bearer +
fail-closed). This keeps bridge single-session semantics untouched and avoids a
proliferation of per-session ports and pairing surfaces.

```
 phone (mobile web)
        │  HTTPS + bearer (scoped: remote:view + remote:submit)
        ▼
 Gajae Remote gateway  ── enumerates ─▶ harness control-plane session-state dir
   (one PC process)     ── observe ───▶ owner process (RuntimeOwner, lease holder)
                        ── submit ────▶ owner submit path (readyForSubmit gating)
        │
        └─ never: file edits · shell · gate answers · raw transcript · secrets
```

## Authority boundary contract

The PC-side runtime is the sole authority. The gateway and the phone are
**observers + one-line submitters**, nothing more.

The gateway MUST NOT, in v0:

- edit files, run shell, or invoke any mutating tool;
- answer workflow-gate / permission / approval prompts (those stay on the PC);
- expose bridge/RPC command scopes (`message:read`, `session`, `model`, `bash`,
  `host_tools`, `host_uri`, `export`, `admin`, or `control`) to the phone;
- stream raw pane output, transcripts, tool arguments/results, diffs, file
  contents, environment, or secrets;
- bypass the owner's `readyForSubmit` gating or submit while a session is busy.

The phone MAY, in v0:

- list active sessions (bounded metadata);
- open one session and read its **bounded** status/observation;
- submit a single one-line instruction through the owner's normal submit path;
- see idle / working / blocked status and a human-readable reason when blocked.

A one-line submit travels the same path as a local `gjc harness submit`, so it
inherits the owner's submission gating (`Observation.readyForSubmit` /
`submitUnavailableReason`). The phone cannot force a submit the local runtime
would itself refuse.

## Transmitted-data contract (allowlist)

The contract is an **allowlist**: only the fields below leave the PC. Anything
not listed is withheld by default. This is enforced in code as a typed
projection from the control plane's already-bounded `Observation` /
`SessionStateView` — never a passthrough of internal state.

### Session list entry → phone (`RemoteSessionSummary`)

| Field | Source | Notes |
| --- | --- | --- |
| `sessionId` | `SessionState.sessionId` | opaque id |
| `name` | derived from handle metadata (`issueOrPr`, repo, branch, or session id fallback) | sanitized, length-capped |
| `harness` | `SessionState.harness` | `gajae-code` in v1 |
| `status` | derived (see state mapping) | `idle` \| `working` \| `blocked` \| `offline` |
| `lastActivityAt` | `Observation.lastActivityAt` | ISO timestamp |
| `branch` | `Observation.branch` | branch name only |

### Open-session view → phone (`RemoteSessionView`)

| Field | Source | Notes |
| --- | --- | --- |
| `sessionId`, `name`, `harness`, `status` | as above | |
| `lifecycle` | `SessionStateView.lifecycle` | bounded enum |
| `ownerLive` | `SessionStateView.ownerLive` | liveness |
| `blockers` | `SessionStateView.blockers` | reason strings, sanitized |
| `observedSignals` | `Observation.observedSignals` | bounded vocab only (`tool-call`, `test-running`, `streaming`, `idle`, …) |
| `gitDelta` | `Observation.gitDelta` | enum: `clean`/`dirty`/`zero-delta`/`unknown` |
| `risk` | `Observation.risk` | enum |
| `readyForSubmit` | `Observation.readyForSubmit` | submit affordance |
| `submitUnavailableReason` | `Observation.submitUnavailableReason` | when not ready |
| `lastActivityAt`, `branch` | as above | |

### Phone → PC (`RemoteSubmitRequest`)

| Field | Notes |
| --- | --- |
| `sessionId` | target session |
| `text` | single one-line instruction; length-capped, control-chars stripped |
| `idempotencyKey` | optional; dedupes retries (mirrors bridge idempotency) |

### Never transmitted by default

Raw pane/terminal output, full transcript / message bodies, tool call arguments
or results, file contents, diffs, system prompt, environment variables, tokens
or secrets, and absolute paths beyond the session `cwd`/`branch` metadata. When
content is intentionally held back, the phone shows a neutral *"withheld on PC"*
marker rather than a redacted blob.

## Session-state model (idle / working / blocked)

`status` is derived from harness lifecycle + liveness + bounded signals:

- **offline** — `ownerLive == false`, lease dead, or gateway cannot reach the
  owner. (Distinct from blocked; the PC is gone, not waiting.)
- **blocked** — `lifecycle == "blocked"`, OR a workflow-gate / permission prompt
  is pending on the PC, OR `readyForSubmit == false` with a
  `submitUnavailableReason`. Phone shows the reason; it does **not** resolve it.
- **working** — owner live and `lifecycle` in
  `{started, submitted, observing, recovering, validating, finalizing}` with
  recent activity signals (`streaming` / `tool-call` / `test-running`).
- **idle** — owner live, stable lifecycle, last signal `idle`/`completed`, and
  `readyForSubmit == true`.

## Failure states (must be understandable)

| Condition | Detection | Phone UX |
| --- | --- | --- |
| Disconnected PC | `ownerLive`/lease dead or gateway unreachable | `offline`; submit disabled; "PC is offline" |
| Expired pairing | bearer/pairing token expired or revoked | "Pairing expired — re-pair on PC" |
| Session busy | `readyForSubmit == false` (+ reason) | submit disabled with reason; optionally queue |
| Submit rejected | typed object error (e.g. `{ code: "scope_denied" }`, see [`docs/rpc.md`](rpc.md)) | inline rejection reason |
| Sensitive output withheld | bounded observation by design | neutral "withheld on PC" marker |

## Pairing and auth (minimum that is not security soup)

v0 = **local pairing only**. Reuse the bridge security model for transport and authentication posture, but expose a gateway-specific authorization surface:

- **TLS mandatory for every bind, including loopback** (no plaintext fallback;
  matches `docs/bridge.md`).
- **Bearer token mandatory** for every endpoint except health/help.
- Pairing flow: the PC prints/serves a short-lived **pairing code**; the phone
  submits host + code and receives a **scoped bearer** capped to
  gateway-only scopes: `remote:view` + `remote:submit` only. These scopes are
  not aliases for bridge/RPC `message:read` or `prompt`. Phone bearers MUST NOT
  authorize bridge command-catalog calls such as `get_messages`,
  `get_last_assistant_text`, `get_state` with `include: ["systemPrompt",
  "tools"]`, `new_session`, `switch_session`, `branch`, `set_model`,
  `bash`, `host_*`, `control`, or `admin`.
- Tokens expire; re-pairing is the recovery path. The gateway is fail-closed:
  unknown/expired tokens, non-gateway scopes, bridge command-catalog methods,
  and out-of-scope commands are rejected before dispatch.

Hosted relay is **deferred to v1** and gated behind a separate ADR (it changes
the trust model and is where "security soup" risk concentrates).

## Open questions from the issue — v0 decisions

| Question | v0 decision | Deferred |
| --- | --- | --- |
| Hosted relay vs local pairing vs both | Local pairing only | Hosted relay → v1 (ADR) |
| Minimum pairing/auth | Pairing code → gateway-scoped bearer, TLS mandatory | Identity/relay accounts → v1 |
| Which session states are public | Bounded: `idle`/`working`/`blocked`/`offline` + bounded observation vocab | Richer telemetry → v1 |
| Web vs native first | Mobile web first (reuse stats SPA build pattern) | Native app / PWA polish → v1 |
| Notifications / pause / resume | Out of scope for v0 | Staged in v1 |

## Implementation plan (PR-sized steps)

Each step is independently shippable; later steps stay fail-closed until wired.

1. **PR 1 — this doc.** `docs/gajae-remote.md` + README cross-link. Resolves the
   authority + transmitted-data gates. No code.
2. **PR 2 — typed contract + schema.** `RemoteSessionSummary`,
   `RemoteSessionView`, `RemoteSubmitRequest`, `RemoteSubmitResult`,
   `RemoteErrorCode`, plus a projection `Observation`/`SessionStateView →
   RemoteSessionView` and a JSON schema. Tests assert the allowlist (no
   forbidden field can leak). Types only; no runtime wiring.
3. **PR 3 — gateway read path.** Enumerate harness sessions (list) and serve the
   per-session bounded view, behind an explicit opt-in flag, fail-closed
   otherwise, reusing bridge TLS + bearer. Tests for liveness derivation and the
   redaction projection.
4. **PR 4 — gateway submit path.** One-line submit through the owner's submit
   gating; typed rejections for busy/denied; idempotency. Tests for
   busy/rejected paths.
5. **PR 5 — pairing/auth.** Pairing code → gateway-scoped bearer
   (`remote:view` + `remote:submit`) with expiry. Tests prove phone bearers
   cannot call bridge/RPC `message:read`, `prompt`, session/model, shell, host,
   control, or admin surfaces.
6. **PR 6 — mobile web client.** Minimal SPA (list → open → status → submit)
   using `@gajae-code/bridge-client` and the `packages/stats` build pattern.
7. **PR 7 — failure-state UX + hardening.** Failure-state surfaces, redaction
   hardening, CHANGELOG, docs finalize.

## Non-goals (v0)

- No arbitrary phone-side shell.
- No raw secret/log dumping to mobile by default.
- No direct filesystem editor from the phone.
- No bypass around PC-side approval/confirmation gates.
- No remote-desktop replacement.
- No second authenticated remote-control protocol (reuse bridge; relay needs an
  ADR).

## Key source references

- Bridge transport / security: `packages/coding-agent/src/modes/bridge/`, [`docs/bridge.md`](bridge.md)
- RPC command/response contract: `packages/coding-agent/src/modes/rpc/`, [`docs/rpc.md`](rpc.md)
- Client SDK: `packages/bridge-client/src/`
- Control plane (sessions, leases, bounded observation, submit): `packages/coding-agent/src/harness-control-plane/`, `packages/coding-agent/src/commands/harness.ts`
- Web client precedent: `packages/stats/src/server.ts`, `packages/stats/src/client/`

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
