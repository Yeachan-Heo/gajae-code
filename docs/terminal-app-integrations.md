# Terminal app integrations (Paseo · Orca · T3 Code)

GJC is a terminal-first coding agent, but it does not have to be the outermost window. Three external
"agent shells" — desktop/mobile orchestrators that run agents for you — can drive GJC today, at three
different levels of support.

| Host | Support | How GJC is driven | Setup |
| --- | --- | --- | --- |
| [Paseo](https://paseo.sh) | ★★★★★ | ACP provider (`gjc acp`), managed by GJC's own installer | [`gjc setup paseo`](#paseo) |
| [Orca](https://onorca.dev) | ★★★★☆ | Custom CLI agent — Orca launches `gjc` in a worktree terminal | [manual, one field](#orca) |
| [T3 Code](https://t3.codes) | ★★★☆☆ (experimental) | No built-in GJC harness upstream yet; drive GJC beside it | [read this first](#t3-code) |

Ratings describe how much of GJC's surface the host actually reaches — model/mode pickers, permission
prompts, cancel semantics, session listing — not how good the host is.

---

## Paseo

[Paseo](https://github.com/getpaseo/paseo) is an ACP client, and GJC's ACP surface is
conformance-tested against the pinned external `acpx@0.13.0` `acp-core-v1` corpus, so this is the
deepest integration GJC has with any external app.

### Install

```sh
gjc setup paseo             # register GJC in $PASEO_HOME/config.json (default ~/.paseo/config.json)
paseo daemon restart        # Paseo caches config in a long-lived daemon
paseo provider ls           # gjc must read `available`, not `error`
```

GJC is also proposed for Paseo's in-app ACP provider catalog ([getpaseo/paseo#3471](https://github.com/getpaseo/paseo/pull/3471)), which
would make even this command unnecessary for new users.

`gjc setup paseo` writes exactly one provider entry — an absolute `gjc acp` command,
`GJC_ACP_PERMISSION_MODE=prompt`, and the `acp` base — under `agents.providers.gjc`, and it bridges
Paseo's orchestration skills into GJC skill discovery. Paseo owns those files, so every write is
conservative:

- a round-trip fidelity self-check refuses to touch a config GJC cannot reproduce byte-for-byte;
- publication is guarded by a compare-and-swap, with a mode-0600 backup beside the original
  (`$PASEO_HOME/config.json`, default `~/.paseo/config.json`, holds a credential that never reaches
  stdout, stderr, `--json`, or a diff);
- a durable, credential-free intent record makes an interrupted run recoverable;
- the Paseo daemon is never restarted for you.

### Verify and roll back

```sh
gjc setup paseo --check          # diagnose: pass / stale / drift / skipped
gjc setup paseo --check --json   # machine-readable, exit code carries the verdict
gjc setup paseo --remove         # roll back only what GJC itself created
```

`--remove` deletes a key only when GJC's own provenance ledger recorded creating it *and* the value
still matches what GJC wrote, so a hand-edited entry always survives. `~/.agents/skills` is treated as
read-only.

### Extra providers for model profiles

```sh
gjc setup paseo --mpreset codex-eco    # registers an additional `gjc-codex-eco` provider
```

Model profiles are also selectable without a second provider: GJC advertises each usable profile to
ACP clients as a synthetic model under the reserved `gajae-code/<profile>` namespace (e.g.
`gajae-code/codex-eco`), so Paseo's ordinary **Model** picker can switch profiles for the live session.

### Announcing interactive sessions

A terminal `gjc` is not only a client of Paseo, it is also visible *inside* it. Every interactive
session registers its SDK endpoint with GJC's broker, and an ACP `session/load` against an entry the
broker reports as `live` attaches to the **running** host rather than resuming a copy — so the same
session can be driven from the terminal and from Paseo (including Paseo mobile) at once.

A prompt sent from Paseo reaches the live session, the terminal renders it, and Paseo streams the
turn back: assistant text, thinking, and tool calls arrive as they happen, and the turn settles to
`idle`. Content is delivered only to the connections that submitted the turn, so an ordinary terminal
prompt with nobody attached streams nothing, and a session with no attached client costs nothing.

GJC can perform the one remaining step for you. This is **opt-in and off by default** — nothing
contacts Paseo until you turn it on:

```sh
gjc config set paseo.autoImport true    # or Settings → Interaction → "Announce Sessions to Paseo"
```

Once enabled, when an interactive session starts, and only when a GJC provider is already registered
in `$PASEO_HOME/config.json` (default `~/.paseo/config.json`) **and** the Paseo daemon is already
listening, GJC runs the equivalent of:

```sh
paseo import --provider <provider-key> --cwd /path/to/repo <session-id>
```

The base `gjc` provider is preferred. When it is absent, the first enabled `gjc-<preset>` provider is
used instead. The order of checks is what keeps this free: an absent Paseo config, no valid GJC ACP provider entry,
no `paseo` on PATH, or a daemon that is not listening each stop the announcement before anything is
spawned. The daemon check is a plain socket probe, because the Paseo CLI blocks indefinitely when its
daemon is down. A session that is not yet registered with the broker is never imported either, since
that would make `session/load` resume a second host for a session that is already running. While the
daemon is simply not up yet, GJC retries the probe every 30 seconds for approximately ten minutes, so
starting Paseo after your terminal still works. Retry states are recorded at debug level; a genuine
import failure is shown as a nonblocking status, while absent/configuration skip outcomes remain quiet.

Re-importing an already-imported session is a no-op: Paseo refuses it and GJC reads that refusal as
success. A daemon that requires a password is skipped in the same quiet way — the socket probe cannot
see that, because the TCP connect succeeds, so it is recognized from the CLI's refusal; export
`PASEO_PASSWORD` if you want announcements to reach a protected daemon. Set `paseo.autoImport` back to
`false` to stop announcing on future launches. Changing it inside the running Settings UI also cancels
that process's pending or active attempt; a separate `gjc config set` process applies on the next launch.

### Lifecycle: GJC creates, you delete

GJC only ever *adds* an entry. It never deletes, archives, or rewrites one, so nothing it does can
remove an agent you still wanted — and the cleanup is yours to run.

What that means in practice:

- **One entry per launch.** Every interactive start gets a fresh session id, including `gjc -c`, so
  resuming your work in the same directory adds another entry rather than reusing the previous one.
- **Ending the session does not remove its entry.** Paseo keeps listing it, and keeps showing it as
  `idle`, because nothing told the daemon otherwise. Sending to it fails with
  `SDK session attachment is stale`, and Paseo then marks it `error`.

So the list grows one row per launch until you prune it:

```sh
paseo ls                  # find the stale ids
paseo delete <agent-id>
```

If that bookkeeping is not worth it to you, leave `paseo.autoImport` off and import the sessions you
actually want to drive by hand — `paseo import --provider <provider-key> --cwd "$PWD" <session-id>` is
exactly what the setting automates. Use `gjc` when the base provider is enabled, or the selected
`gjc-<preset>` key when only a preset provider is available.

Nothing else about the integration depends on this setting: `paseo run --provider gjc` and manual
`paseo import` work exactly the same whether it is on or off.

### Run it

```sh
paseo run --provider gjc --cwd /path/to/repo --wait-timeout 3m "your prompt"
paseo logs <agent-id>     # rendered transcript
paseo ls                  # running / idle / error
paseo stop <agent-id>     # ACP session/cancel
paseo delete <agent-id>
```

Paseo lists **Gajae Code** with GJC's model catalog (filtered to providers with usable stored
credentials), Default/Plan modes, and thinking levels, because GJC emits the spec-defined `category`
on the `mode`, `model`, and `thought_level` select options.

### Cancel semantics

`paseo stop` sends an ACP `session/cancel`, which by default stops **only the current turn** — owned
background work (subagents, background jobs) keeps running. To make a stop terminate exactly the work
GJC owns, add to the provider's `env` entry and restart the Paseo daemon:

```json
"env": { "GJC_ACP_PERMISSION_MODE": "prompt", "GJC_ACP_ABORT_SCOPE": "owned" }
```

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `gjc` reads `error` in `paseo provider ls` | daemon still holds the pre-install config | `paseo daemon restart` |
| `gjc setup paseo --check` reports `stale` | config is correct, daemon has not reloaded | `paseo daemon restart` |
| `gjc setup paseo --check` reports `drift` | the entry was edited by hand or by another tool | reconcile manually, or `--remove` then re-install |
| `failed to create agent` in `$PASEO_HOME/daemon.log` (default `~/.paseo/daemon.log`) | `gjc` not resolvable from the daemon's PATH | re-run `gjc setup paseo` so the absolute path is rewritten |
| Permission-gated tools never prompt | `GJC_ACP_PERMISSION_MODE` overridden | set it back to `prompt` in the provider `env` |
| Nothing appears in Paseo after `gjc` | `paseo.autoImport` is off (the default) | `gjc config set paseo.autoImport true` |
| Still nothing, and the log says `daemon-auth-required` | the daemon requires a password and `PASEO_PASSWORD` is not exported where `gjc` runs | export it, or leave it and import by hand |
| Still nothing, and there is no announcement log line at all | the `gjc` on `PATH` predates the feature | rebuild/reinstall, then confirm with `gjc config get paseo.autoImport` |

The announcement is best-effort and never interrupts a launch. Configuration skips remain quiet,
retries and the terminal outcome are recorded at debug level, and a genuine import failure appears as
a nonblocking status message:

```sh
grep 'Paseo session announcement' ~/.gjc/logs/gjc.$(date +%F).log | tail -1
```

The `reason` names the exact gate that stopped it: `no-paseo-config`, `no-provider`, `cli-missing`,
`daemon-unreachable`, `unsupported-daemon-target`, `daemon-auth-required`, or `session-not-live`.

#### Password-protected daemons

GJC has no credential setting and reads no Paseo credential file. It runs `paseo import` with the
session's own environment, so the CLI authenticates exactly as it would if you ran it by hand: if
`PASEO_PASSWORD` is exported where you start `gjc`, it is used; if it is not, the daemon refuses and
the announcement is a quiet skip. There is nothing to configure on the GJC side either way.

Deeper reading: [ACP local development loop](./acp-local-development.md) ·
[External-control readiness](./external-control-readiness.md#paseo-custom-agent) ·
[Environment variables](./environment-variables.md#11-acp-permission-handling).

---

## Orca

[Orca](https://github.com/stablyai/orca) is a worktree ADE: it runs a fleet of agents side by side,
each in its own git worktree, with diff review, a mobile companion, and SSH/remote worktrees. Its agent
picker "just launches a process in a terminal", so **any** CLI agent works — including `gjc`.

GJC is not (yet) in Orca's preconfigured agent list, so you add it once as a custom agent. The
upstream registry entry is proposed in [stablyai/orca#15025](https://github.com/stablyai/orca/pull/15025); until it lands, use the custom
agent below.

### Setup

1. Install and authenticate GJC on the machine Orca runs agents on:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.sh -o gjc-install.sh
   sh gjc-install.sh
   gjc auth
   ```

   To pick a newer installer, change `v0.15.3` to the release tag you want (see [docs/install.md](install.md)).

2. In Orca, open **Settings → Agents** and add a custom agent:

   | Field | Value |
   | --- | --- |
   | Name | `Gajae Code` |
   | Command | `gjc` |
   | Arguments | *(empty — bare `gjc` starts the TUI in the worktree cwd)* |

3. Create a worktree, pick **Gajae Code** in the agent combobox, and start prompting.

Orca pre-fills a permission-bypass flag for agents that expose one. **GJC has none by design** — leave
the argument list empty. GJC's own approval gates (`bash`, `eval`, destructive file operations, workflow
approvals) stay in force inside the worktree, which is the point: the worktree is disposable, the
approval record is not.

### What you get, and what you do not

- **You get:** true parallelism across worktrees, Orca's diff viewer and AI-diff annotation, terminal
  splits, the mobile companion, and SSH worktrees — all with GJC running as the agent.
- **You do not get (yet):** Orca's deep-integration features that require per-agent adapters — usage /
  rate-limit tracking, account hot-swap, agent hooks, and native status. Those need Gajae Code in Orca's
  built-in registry ([PR](https://github.com/stablyai/orca/pull/15025)).

### Driving several GJC worktrees at once

Orca's own CLI (`orca worktree create`, `snapshot`, …) composes with GJC's `--worktree` launcher and the
`gjc sdk session` CLI. If you want a controller — not a human — fanning work across GJC sessions, prefer
the [Coordinator MCP bridge](./hermes-mcp-bridge.md) over terminal scraping.

---

## T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) is an agent-harness control surface with an excellent
mobile app: a local server on your machine plus iOS/Android/web/desktop clients that drive agent CLIs.

**Status: experimental.** Upstream T3 Code ships harnesses for Codex, Claude Code, Cursor CLI, Grok Build
and OpenCode only. There is no GJC harness in T3 Code today and no released bridge package, so nothing
here is a one-command install yet. Treat this section as the honest state of the art, not a supported path.

### What works today

Run T3 Code's server for the agents it does support, and drive GJC in parallel through its own machine
surfaces on the same box:

```sh
npx t3@latest              # T3 Code server + local web app
gjc sdk session list       # GJC's own session control surface, unrelated to T3
```

For phone access to GJC itself — questions, approvals, and prompts from a mobile device — GJC already
ships first-class remote surfaces that do not depend on T3 Code:

- [Telegram onboarding](./telegram-onboarding.md) — answer the agent from your phone
- [Discord onboarding](./discord-onboarding.md)
- [Bot / external controller integration](./bot-integration.md)
- [SDK & wire protocol](./sdk.md) · [SDK session CLI](./sdk-session-cli.md)

### What native support will look like

GJC exposes a conformance-tested ACP agent (`gjc acp`) with streaming session updates, spec-shaped
permission requests, and cancel semantics — the same surface Paseo consumes. A T3 Code provider only has
to map T3's thread/turn/permission model onto that surface. That work is proposed upstream in
[pingdotgg/t3code#7290](https://github.com/pingdotgg/t3code/discussions/7290) — a bespoke driver is a large change in T3 Code's Effect-TS provider
layer, so the discussion asks whether they want a `gjc` driver or a generic ACP driver first. Until
something lands there, `gjc` in T3 Code is not supported.

If you are building your own bridge, start from
[External-control readiness](./external-control-readiness.md) and
[ACP local development](./acp-local-development.md), and use `GJC_ACP_PERMISSION_MODE` to map permission
modes rather than inventing CLI flags — GJC has no permission-bypass flag.

---

## Choosing between them

- Want the deepest, best-supported integration with model/mode/thinking pickers and real permission
  prompts → **Paseo**.
- Want many GJC sessions racing in isolated worktrees with first-class diff review → **Orca**.
- Want GJC on your phone right now → skip the host apps and use GJC's own
  [Telegram](./telegram-onboarding.md) or [bot](./bot-integration.md) surfaces.
