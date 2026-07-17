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
- arguments: `dispatch`, then the full submitted input text
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

The canonical install location is the agent extensions directory discovered by the native GJC provider:

- user-level: `${GJC_CODING_AGENT_DIR:-$HOME/.gjc/agent}/extensions`
- project-level: `<cwd>/${GJC_CONFIG_DIR:-.gjc}/extensions`

For native discovery, install one of:

- `extensions/<name>.ts` or `extensions/<name>.js`
- `extensions/<name>/index.ts` or `extensions/<name>/index.js`
- `extensions/<name>/package.json` declaring extension entries

The loader scans one level under each `extensions` directory. Complex packages should use a package manifest instead of relying on recursive discovery.

`GJC_CONFIG_DIR` selects the project config directory name. `GJC_CODING_AGENT_DIR` selects the user agent directory name under `$HOME`. The native provider resolves those locations before loading extension modules, skills, rules, hooks, and related capabilities.

Hooks are not the input bridge surface: `packages/coding-agent/src/capability/hook.ts` defines pre/post tool hooks only.
