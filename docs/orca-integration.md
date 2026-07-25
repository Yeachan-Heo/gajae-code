# Orca terminal integration (agent-status bridge)

This guide documents GJC's opt-in status integration with the
[Orca](https://github.com/stablyai/orca) terminal. When enabled, GJC sessions
running inside an Orca pane report live agent status over Orca's loopback
agent-hook endpoint, so Orca's pane badges, sidebar rows, and dashboard show
the session's real state instead of a generic terminal.

## What the bridge does

Orca exports a loopback HTTP agent-hook endpoint into every pane it spawns
(`ORCA_PANE_KEY`, `ORCA_AGENT_HOOK_ENDPOINT`, and related variables). GJC
speaks Orca's pi hook protocol natively from a bundled bridge — no extension
installation, no Orca-side configuration:

- **working / done / blocked state** per pane, including `ask`-style question
  tools surfacing as an action-needed state with the question preview;
- **active tool name and a bounded input preview** while tools run;
- **prompt and last assistant reply previews** for Orca's dashboard rows;
- **session resume identity** (`session id` + transcript path), which lets
  Orca relaunch a sleeping pane with `gjc --resume <session-file>`;
- **startup prefill**: a draft prompt handed over by Orca's launch flow is
  placed into the editor once at session start.

On Orca versions with first-class GJC support the bridge posts to the
dedicated `/hook/gjc` route (GJC identity in the UI); on older versions it
falls back to the `/hook/pi` route after a single 404 and Orca renders the
pane with its Pi identity. Status behavior is identical either way.

## What is exported, and when

Nothing is exported by default. When the setting below is enabled **and** the
session runs inside an Orca pane, the bridge posts to `127.0.0.1` only:

- prompt text, assistant reply text, and serialized tool inputs — all
  **bounded previews** (2000 chars for text, 4KB for tool input), never full
  transcripts;
- session id and session file path (for resume);
- the pane/tab/worktree identifiers Orca itself injected into the pane.

Delivery is strictly best-effort and loopback-only: coordinates are validated
fail-closed, the transport is a raw loopback socket that ignores inherited
`HTTP(S)_PROXY` routing, and a missing or restarting Orca never surfaces
errors inside the session. Helper and subagent sessions never report; only
the root session owning the pane does.

## Enabling the bridge

The bridge is **off by default**. Enable it in your GJC config:

```bash
gjc config set orca.statusBridge true
```

or in `~/.gjc/agent/config.yml`:

```yaml
orca:
  statusBridge: true
```

Then launch `gjc` inside an Orca pane. No Orca-side setup is required.

## Disabling and kill-switch

- Persistent: `gjc config set orca.statusBridge false` (or remove the key —
  the default is off).
- Per-invocation kill-switch, overriding the setting:
  `GJC_ORCA_STATUS_BRIDGE=0 gjc`.

## Appearing in Orca's launch menu

Status reporting works for any pane you start `gjc` in manually. To also
launch GJC from Orca's agent picker on Orca versions without first-class GJC
support, override the Pi catalog entry's command to `gjc` in Orca's Settings →
Agents (agent command overrides).

## Troubleshooting

- **No status shown**: confirm the session is a root GJC session inside an
  Orca pane (`echo $ORCA_PANE_KEY` in that pane), the setting is enabled, and
  `GJC_ORCA_STATUS_BRIDGE` is not `0`.
- **Pane shows Pi identity**: your Orca version predates the `/hook/gjc`
  route; the bridge fell back to the pi route. Status still works.
- **Endpoint file warnings in logs**: the bridge refuses hook endpoint files
  that are symlinks, group/world-writable, owned by another user, or reachable
  through an untrusted directory ancestry, and falls back to the pane's
  environment coordinates. This is fail-closed behavior, not an error in GJC.
