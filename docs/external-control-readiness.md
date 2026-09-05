# External control readiness

Process-isolated controllers use broker-bound or managed surfaces. The SDK WebSocket
endpoint is not a public controller interface; endpoint records, transport
credentials, and raw session transports remain inside SDK core; see
[SDK machine interfaces](./sdk.md) for the ownership boundary.

## Supported surfaces

| Surface | Entrypoint | Use it when |
| --- | --- | --- |
| SDK session CLI | `gjc sdk session list|inspect|send|status|tail` or `raw control|query|global` | A local script needs bounded, credential-free session operations. |
| Coordinator MCP | `gjc mcp-serve coordinator` | A controller needs multi-session orchestration, durable reports, or worktree-scoped lifecycle operations. |
| Managed adapter | Configured Telegram, Discord, or Slack integration | A provider renders session presentation through opaque Router attachments. |
| ACP | `gjc --mode acp` or `gjc acp` | An editor or ACP-compatible client supplies the session frontend. |

`--mode rpc`, `--mode rpc-ui`, `--mode bridge`, and `gjc sdk serve` have been removed;
they are not compatibility interfaces.

## SDK session CLI readiness

The session CLI resolves controls through `SessionRouter` and lifecycle globals
through `SessionLifecycleService` and the Broker. It emits credential-free JSON;
review [docs/sdk-session-cli.md](./sdk-session-cli.md) before building a script.
## ACP readiness

ACP remains a stdio editor protocol. Its session control uses the SDK adapter internally; it is not a replacement external bot-control protocol.

For the build/run/verify loop when changing ACP code locally, see [ACP local development](./acp-local-development.md).

#### Turn-end termination of owned work

An ACP `session/cancel` is a C04 terminal abort. By default it stops only the active turn
(`scope:"turn"`, matching the SDK `turn.abort` default and other ACP clients' cancel
behavior); exact owned work that turn spawned (background Bash/task jobs, detached
subagents) keeps running, and its completion can resume the root worker as a fresh turn. A
cancel with `scope:"owned"` additionally stops exact owned work, so an external client
such as Paseo that ends a run terminates everything it started instead of leaving
subagents running in the background. A fresh bounded idempotency key is issued per cancel,
so retries replay deterministically. A cancel with no active turn is a deterministic
no-effect (`no_active_turn`), and an unsettled stop reports `uncertain` instead of
claiming stopped work.

Owned termination is an explicit opt-in: `_meta.gjc.abortScope: "owned"` on the
`session/cancel` notification, or `GJC_ACP_ABORT_SCOPE=owned` in the agent environment as
the process-wide fallback. Paseo keeps owned cancels through its provider config `env`
(see [Paseo custom agent](#paseo-custom-agent)).

#### Evidence promotion policy

Ordinary CI runs publish an **ephemeral** report under `$RUNNER_TEMP` and upload it as a
build artifact with bounded retention; those runs never rewrite tracked evidence.
`artifacts/acp-core-v1-conformance-baseline.json` is a **deliberately promoted** release
baseline: it is refreshed only from a successful pinned run for a release candidate, so a
tracked change to it is an explicit act rather than per-run churn.

The conformance workspace passed via `--cwd` must be a real path, not one reached through
a symlink (on macOS `/tmp` links to `/private/tmp`): the ACP client enforces its session
cwd root against the resolved path, so a symlinked workspace fails the client-authority
cases. The wrapper rejects such a `--cwd` up front.

## JetBrains Air custom agent

Add GJC through Air's **Add Custom Agent** action, then configure the Air-managed `acp.json`. With only `["acp"]`, Air shows GJC's existing model list. Add `--mpreset <id>` only when the Air model selector should show the available GJC preset list and create new sessions with that preset.

The following example starts the `opus-codex` model preset and allows tool calls without permission prompts:

```json
{
  "agent_servers": {
    "Gajae-Local-Opus": {
      "command": "/absolute/path/to/gjc",
      "args": ["acp", "--mpreset", "opus-codex"],
      "env": {
        "GJC_ACP_PERMISSION_MODE": "always-allow"
      }
    }
  }
}
```

`always-allow` gives the agent permission to execute gated tools, including shell commands, without an Air approval prompt. Omit `GJC_ACP_PERMISSION_MODE` or set it to `prompt` when manual approval is required. Start a new Air task after changing `acp.json`; restart Air if it reuses an already-running agent process.

Air supplies MCP servers through ACP session requests. GJC accepts client-supplied stdio, HTTP, and SSE definitions for new sessions and offline resume. Do not add `--mcp-config` to the ACP command: that CLI option is intentionally unsupported for broker-backed ACP. A live session's MCP configuration is immutable; reconnect declarations from Air attach to the existing configuration instead of attempting to replace it. Close or resume the offline session to change its MCP configuration.
Air clients that advertise form elicitation receive `AskUserQuestion` selections and free-text prompts through ACP; declining or cancelling the form leaves the ask unanswered.

For local development, `bun run restart:sdk-broker` asks the published broker to shut down over its authenticated loopback channel, waits for that broker identity to disappear, and starts a replacement. A broker that predates the `broker.shutdown` operation answers `unknown_operation`; the restart then falls back to a `SIGTERM` sent only when the published pid still carries the published process incarnation. Use `--agent-dir <path>` when testing an isolated agent directory.

Restarting the broker alone leaves the session-host processes it spawned running, so ACP clients keep reattaching to sessions that still execute the previous source. Pass `--close-session-hosts` to close those sessions through the live broker first; only sessions served by a `sdk session-host-internal` process are selected, so interactive sessions publishing their own endpoint are never closed.

Air-created Git worktrees are supported because each ACP request's absolute `cwd` becomes the session workspace. Additional ACP workspace roots are not currently supported and are rejected instead of being advertised.

Session title and update metadata are advisory state for the active ACP process. Text, thought, tool-call, and tool-result history is replayed on load, but historical binary image bytes are not replayed.

See [Environment Variables](./environment-variables.md#11-acp-permission-handling) for supported values and precedence.
## Paseo custom agent

[Paseo](https://github.com/getpaseo/paseo) registers GJC as a generic ACP provider through its custom provider configuration. Add this entry to `$PASEO_HOME/config.json` (default `~/.paseo/config.json`); Paseo then lists **Gajae Code** in its provider picker with GJC's model catalog and Default/Plan modes:

```json
{
  "version": 1,
  "agents": {
    "providers": {
      "gjc": {
        "extends": "acp",
        "label": "Gajae Code",
        "command": ["gjc", "acp"],
        "env": {
          "GJC_ACP_ABORT_SCOPE": "owned"
        }
      }
    }
  }
}
```

The `env` entry keeps Paseo's `stop` (an ACP `session/cancel`) terminating owned subagents and background jobs as well as the turn; without it, a cancel stops only the current turn and leaves owned work running (see [Turn-end termination of owned work](#turn-end-termination-of-owned-work)). Restart the Paseo daemon (`paseo daemon restart`) after editing the config.

GJC's ACP session configuration carries the spec-defined `category` on the Mode, Model, and Thinking select options (`mode`, `model`, `thought_level`), which lets ACP clients such as Paseo discover models and thinking levels without provider-specific metadata. The model catalog is filtered to providers with usable stored credentials (`providers.list/active`), falling back to the full catalog on session hosts that do not expose that query.

Model profiles also appear in the ordinary **Model** picker as synthetic entries under the reserved namespace, e.g. `gajae-code/codex-eco` (displayed with the profile label, such as "Codex Eco"). Selecting one through the ACP `Model` select immediately switches the live session to the full profile without persisting `modelProfile.default`; persistence remains an explicit `/model` TUI choice or `gjc --mpreset codex-eco --default`. Only profiles whose providers have usable stored credentials are selectable; synthetic rows are already availability-filtered by the session host, so the Q29 active-provider filter never drops them. An unavailable-but-active profile stays visible as the current readback and, if selected, fails with the existing authentication-required error. The separate ACP startup `--mpreset`/Q27 `Preset` select is likewise session-scoped and non-persistent.

Sessions launched through an ACP client (e.g. `paseo run --provider gjc/...`) are broker-managed and appear in ACP `session/list`, so Paseo's import flow can attach them. Interactive `gjc` sessions register their SDK endpoint with the broker too, so they are listed by ACP clients as well, and `session/load` on an entry the index reports as `live` attaches to the running host instead of resuming a second copy of it — one terminal session, driven from both the TUI and the ACP client. When the off-by-default `paseo.autoImport` setting is enabled, GJC announces those sessions to Paseo by itself; see [Announcing interactive sessions to Paseo](./terminal-app-integrations.md#announcing-interactive-sessions).

## ACP conformance and Air release gates

CI runs every `required_cases` entry in the pinned external `acpx@0.13.0` `acp-core-v1` corpus at upstream
commit `47dc1c56b20da3c248a4a1b5c5106f52e65e6594` against `gjc --mode acp`
through `bun run conformance:run`. The corpus is checked out outside this
repository; it is not vendored.
The `acp_conformance` CI job publishes its JSON report and blocks the aggregate
test status on failure.

JetBrains Air remains a versioned human-only compatibility gate. Before an Air
release claim, complete [`artifacts/acp-jetbrains-air-smoke.md`](../artifacts/acp-jetbrains-air-smoke.md)
for the tested Air and GJC builds, attach only redacted logs, and record the
result with the release evidence. This checklist must not be auto-filled by CI.
## Verification references

- `packages/coding-agent/test/sdk-*.test.ts`
- `packages/coding-agent/test/acp-*.test.ts`
- `packages/coding-agent/test/workflow-gate-broker.test.ts`
- `packages/coding-agent/test/workflow-gate-schema.test.ts`
