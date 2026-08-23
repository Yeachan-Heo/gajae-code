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
gjc setup paseo             # register GJC as an ACP provider in ~/.paseo/config.json
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
  (`~/.paseo/config.json` holds a credential, which never reaches stdout, stderr, `--json`, or a diff);
- a durable, credential-free intent record makes an interrupted run recoverable;
- the Paseo daemon is never restarted for you.

### Verify and roll back

```sh
gjc setup paseo --check          # diagnose: pass / stale / drift / skipped
gjc setup paseo --check --json   # machine-readable, exit code carries the verdict
gjc setup paseo --remove         # roll back only what GJC itself created
```

`--remove` deletes a key only when GJC's own provenance ledger recorded creating it *and* the value
still matches what GJC wrote, so a hand-edited entry always survives. Paseo's skills directory is
treated as read-only: GJC bridges `~/.agents/skills` when a CLI install materialized it, the Paseo.app
bundle's `Contents/Resources/skills` on a desktop install, or an explicit `PASEO_SKILLS_DIR` — and
derives the bridged skill names from whichever directory actually exists. When a Paseo release swaps
skills, re-running `gjc setup paseo` converges the bridge and a follow-up `gjc setup paseo --check`
verifies it — `--check` itself is read-only and never repairs. A source that disappears
entirely is still reported as `missing-skills-directory` drift (exit 1) until Paseo is reinstalled or
a trusted `PASEO_SKILLS_DIR` is supplied — the bridge is never faked with dangling links.

**`PASEO_SKILLS_DIR` trust rule:** the override is honored only when it is the user's own
explicit intent. If any project dotenv file in the current working directory (`.env`,
`.env.local`, `.env.development*`, `.env.production.local`, or the `NODE_ENV`-specific
variants) defines `PASEO_SKILLS_DIR`, the override is rejected for runs from that checkout —
a cloned repository must not be able to bridge its own shipped skill content into your
global GJC configuration. Run from outside the checkout, or remove the dotenv key, to use a
legitimately relocated skills directory.

### Extra providers for model profiles

```sh
gjc setup paseo --mpreset codex-eco    # registers an additional `gjc-codex-eco` provider
```

Model profiles are also selectable without a second provider: GJC advertises each usable profile to
ACP clients as a synthetic model under the reserved `gajae-code/<profile>` namespace (e.g.
`gajae-code/codex-eco`), so Paseo's ordinary **Model** picker can switch profiles for the live session.

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
| `gjc setup paseo --check` reports `missing-skills-directory` | Paseo's skills moved or were uninstalled; the bridge is skipped, not faked | point `PASEO_SKILLS_DIR` at the real directory, or re-run `gjc setup paseo` after reinstalling Paseo |
| `failed to create agent` in `~/.paseo/daemon.log` | `gjc` not resolvable from the daemon's PATH | re-run `gjc setup paseo` so the absolute path is rewritten |
| Permission-gated tools never prompt | `GJC_ACP_PERMISSION_MODE` overridden | set it back to `prompt` in the provider `env` |

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
   curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.0/scripts/install.sh -o gjc-install.sh
   sh gjc-install.sh
   gjc auth
   ```

   To pick a newer installer, change `v0.15.0` to the release tag you want (see [docs/install.md](install.md)).

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
