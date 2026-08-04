# Ouroboros `ooo` bridge extension contract

GJC exposes the `ooo` bridge through the existing extension input-event surface. It is not a default workflow skill, hook, slash command, or built-in agent.

## Interception surface

Extensions register an `input` handler:

```ts
import { createOuroborosOooBridge } from "@gajae-code/coding-agent/extensibility/extensions";

export default function activate(gjc) {
  gjc.on("input", createOuroborosOooBridge());
}
```

The handler matches only the bare exact prefix:

- `ooo`
- `ooo ...`

It does not match embedded or longer-token text such as `please ooo status`, `oooo`, or `/ooo`.

The extension runner already treats `InputEventResult.handled === true` as terminal: the input is not sent through normal model flow. An empty result (`{}`) means continue/pass-through, preserving existing chained input handlers and normal prompt handling.

## Dispatch and result semantics

`createOuroborosOooBridge()` is a small specialization of `createExactPrefixCommandBridge()`:

- command: `ouroboros`
- arguments: `dispatch`, `--runtime`, `gjc`, then the full submitted input text
- recursion guard variable: the Ouroboros bridge recursion-depth environment variable

- continue/pass-through exit code: `78`

Exit-code mapping:

| Dispatch result | GJC input result |
| --- | --- |
| `0` | `{ handled: true }`; do not send input to the model. |
| `78` | `{}`; continue/pass-through so GJC processes the input normally. |
| any other non-zero | Surface an extension error notification using stderr, then stdout, then a generic exit-code message, and return `{ handled: true }`; the failed `ooo` command is terminal and is not sent to the model. |

## Recursion guard

Before dispatch, the helper increments the Ouroboros bridge recursion-depth environment variable and restores its previous value after dispatch finishes. A current numeric depth of `0` or `1` is dispatchable, which preserves concurrent independent interactive inputs while marking child dispatcher processes with depth `1`. A current numeric depth greater than `1`, or any non-empty non-numeric value, returns `{}` without dispatching.

This means the bridge allows exactly one inherited bridge-marked dispatcher level and blocks recursive re-entry from deeper bridge-marked children. The guard also passes through `event.source === "extension"` to avoid extension-originated messages re-entering the bridge.

## Installation and discovery

### Supported Ouroboros baseline and MCP ownership

This path is verified against the current GJC `dev` bridge contract and [Q00/ouroboros `v0.50.7`](https://github.com/Q00/ouroboros/releases/tag/v0.50.7), the latest release when this integration was shipped. Use `v0.50.7` or a newer release and check the [latest release](https://github.com/Q00/ouroboros/releases/latest) for current upstream requirements.

Install and configure Ouroboros using its current upstream GJC setup:

```bash
curl -fsSL https://raw.githubusercontent.com/Q00/ouroboros/main/scripts/install.sh | bash
ouroboros setup --runtime gjc
```

In `v0.50.7`, that setup selects GJC as Ouroboros's runtime and LLM backend, installs an Ouroboros-managed GJC bridge, and installs its GJC capability guide. The managed bridge invokes `ouroboros dispatch --runtime gjc`; the GJC example in this repository binds the same runtime flag. Ouroboros's dispatcher then uses its shared MCP handler composition. GJC does not implement the Ouroboros MCP workflow or protocol lifecycle.

### One-command manual enablement

The preferred `ouroboros setup --runtime gjc` path already installs a managed bridge. As a GJC-owned alternative, install the shipped example for the current user:

```bash
mkdir -p "${HOME}/${GJC_CONFIG_DIR:-.gjc}/agent/extensions" && curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/dev/packages/coding-agent/examples/extensions/ooo-bridge.ts -o "${HOME}/${GJC_CONFIG_DIR:-.gjc}/agent/extensions/ooo-bridge.ts"
```

Or enable the example only in the current project:

```bash
mkdir -p .gjc/extensions && curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/dev/packages/coding-agent/examples/extensions/ooo-bridge.ts -o .gjc/extensions/ooo-bridge.ts
```

Use either the Ouroboros-managed bridge or the manual example, not both. Start a new GJC session after installation. Then run:

```text
ooo interview "I want to build a task management CLI"
```

The example dispatches `ouroboros dispatch --runtime gjc <full-input>`, passing the complete input as one argument. If `ouroboros` is missing, cannot start, times out, or returns a non-zero code other than `78`, GJC shows an error notification and treats only that matching `ooo` input as handled. Extension discovery, GJC startup, and ordinary prompts continue to work. Exit code `78` deliberately passes the original input through to normal GJC processing.

### Native interview versus external Ouroboros interview

- `/skill:deep-interview` is GJC's bundled native interview workflow. It includes Ouroboros-inspired behavior but does not invoke the external CLI.
- `ooo interview` is an external integration. With this example enabled, GJC invokes `ouroboros dispatch --runtime gjc` with the complete input, and the installed Ouroboros runtime owns its MCP-backed skill dispatch and interview flow.

The canonical install location is the agent extensions directory discovered by the native GJC provider:

- user-level: `$HOME/${GJC_CONFIG_DIR:-.gjc}/agent/extensions`
- project-level: `<cwd>/.gjc/extensions`

For native discovery, install one of:

- `extensions/<name>.ts` or `extensions/<name>.js`
- `extensions/<name>/index.ts` or `extensions/<name>/index.js`
- `extensions/<name>/package.json` declaring extension entries

The loader scans one level under each `extensions` directory. Complex packages should use a package manifest instead of relying on recursive discovery.

`GJC_CONFIG_DIR` selects the **home-relative** config directory name: the config root is `<home>/<GJC_CONFIG_DIR>`, defaulting to `~/.gjc`. It does not select a project directory — the project-level path is the constant `.gjc` (`discovery/helpers.ts`, `getProjectAgentDir()`), so `GJC_CONFIG_DIR` never moves it. `GJC_CODING_AGENT_DIR` overrides the agent directory **path** rather than naming one under `$HOME`; it is resolved with `path.resolve`, so an absolute value is used as-is and a relative value is resolved against the current working directory.

Discovery is the exception to that second override. The native provider builds its user-level root from `GJC_CONFIG_DIR` alone (`<home>/<config-dir>/agent`) and never consults `getAgentDir()`, so an operator who sets `GJC_CODING_AGENT_DIR` moves the agent directory for the rest of the product but **not** for extension, skill, rule, or hook discovery.

Hooks are not the input bridge surface: `packages/coding-agent/src/capability/hook.ts` defines pre/post tool hooks only.
