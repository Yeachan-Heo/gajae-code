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

`createOuroborosOooBridge()` has two bounded paths:

- `ooo interview [topic]` starts `ouroboros_interview` through a lazily connected `ouroboros mcp serve --runtime gjc` stdio server.
- While that interview is active, subsequent ordinary interactive input is claimed as an answer with the same `session_id`. A completed result clears the correlation and closes the MCP connection.
- Other exact-prefix `ooo ...` commands run `ouroboros dispatch --runtime gjc <full-input>` through `createExactPrefixCommandBridge()`.
- `OUROBOROS_CLI` overrides the executable for both paths; otherwise the command is `ouroboros`.

Successful handled text is returned as `{ handled: true, text }`. The interactive input controller renders that text as a visible custom message before clearing the composer, so the first interview question, continuation questions, completion result, and successful non-interview command output reach the user.

Command-dispatch exit mapping remains:

| Dispatch result | GJC input result |
| --- | --- |
| `0` | `{ handled: true, text? }`; render non-empty stdout (or stderr when stdout is empty) and do not send the input to the model. |
| `78` | `{}`; continue/pass-through so GJC processes the input normally. |
| any other non-zero | Surface an extension error notification using stderr, then stdout, then a generic exit-code message, and return `{ handled: true }`; the failed `ooo` command is terminal and is not sent to the model. |

MCP interview errors are notified and handled. A non-terminal response must contain a valid `interview_*` session ID in MCP `_meta` (with the visible `Session ...` text accepted as a compatibility fallback); otherwise the bridge fails closed instead of accepting an uncorrelated answer.

Runner timeout aborts the handler context signal. The bridge passes that signal to MCP connection/tool calls and generation-fences every post-await state mutation, so a late settlement cannot recreate correlation after the runner has fallen through. Any MCP connection or tool failure clears the interview session and cached transport before notifying; a later ordinary prompt therefore passes through, while a new explicit `ooo interview` reconnects cleanly.

Slash-prefixed UI commands bypass interview capture. The bare continue controls `.` and `c` also remain GJC controls; other ordinary text remains a valid interview answer.

The installed example also registers `session_switch` disposal because GJC reuses one `ExtensionRunner` across `/new`, `/drop`, resume, and fork transitions. Session-changing input controls reset immediately, including `/clear`, and the lifecycle hook covers identity changes initiated outside the input path. Interview startup and continuation calls share one FIFO operation chain: a second submission during startup is claimed and waits for the session ID, while overlapping answers issue one MCP call at a time against the latest settled state. Every queue entry is bound to the lifecycle generation at submission, so resets consume predecessor-generation entries—including explicit `ooo interview` starts—without calling MCP in the successor session.

## Recursion guard

Before command dispatch, the exact-prefix helper increments the Ouroboros bridge recursion-depth environment variable and restores its previous value after dispatch finishes. A current numeric depth of `0` or `1` is dispatchable. A current numeric depth greater than `1`, or any non-empty non-numeric value, returns `{}` without dispatching. The guard also passes through `event.source === "extension"` to avoid extension-originated messages re-entering the bridge.

## Installation and discovery

### Pinned Ouroboros baseline

This path is verified against [Q00/ouroboros `v0.50.7`](https://github.com/Q00/ouroboros/releases/tag/v0.50.7). Install its MCP profile at the exact version, then configure GJC:

```bash
uv tool install 'ouroboros-ai[mcp]==0.50.7'
ouroboros setup --runtime gjc
```

`pipx install 'ouroboros-ai[mcp]==0.50.7'` is equivalent. Do not pipe a mutable branch installer into a shell. Pin source audits to commit `cb658aa819bfabafecbbe91bc36327f10691171b`. The release asset `ouroboros_ai-0.50.7-py3-none-any.whl` has SHA-256 `df42f4ef10e032f2edc3249534bf91e8612dee789dfc3517895a9eb2df7f82c4`; compare a downloaded asset with that digest before installation.

### Verified GJC bridge installation

Ouroboros setup installs its own managed GJC bridge. Replace it with the standalone GJC bridge from immutable commit `4311fefd49e9c6781c4d1111b8dd3f758e7d8974`, whose example file has SHA-256 `2b0e1e25ac145331f112da629076875542db6f6e63c3c17adcd6770a4dcaf7bd`:

```bash
curl -fL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/4311fefd49e9c6781c4d1111b8dd3f758e7d8974/packages/coding-agent/examples/extensions/ooo-bridge.ts -o /tmp/gjc-ooo-bridge.ts
shasum -a 256 /tmp/gjc-ooo-bridge.ts
mkdir -p "${HOME}/${GJC_CONFIG_DIR:-.gjc}/agent/extensions/ouroboros-ooo-bridge" && cp /tmp/gjc-ooo-bridge.ts "${HOME}/${GJC_CONFIG_DIR:-.gjc}/agent/extensions/ouroboros-ooo-bridge/index.ts"
```

The `shasum` output must match the published example digest before the copy. The example has no runtime imports: it obtains the bundled bridge helper from the injected extension API, so the copied file works in compiled GJC binaries without extension-local `node_modules`. For project-only installation, copy the same verified file to `.gjc/extensions/ouroboros-ooo-bridge/index.ts`. Start a new GJC session after installation, then run:

```text
ooo interview "I want to build a task management CLI"
```

Set `OUROBOROS_CLI=/absolute/path/to/ouroboros` when the executable is outside `PATH`.

### Native interview versus external Ouroboros interview

- `/skill:deep-interview` is GJC's bundled native interview workflow. It includes Ouroboros-inspired behavior but does not invoke the external CLI.
- `ooo interview` is the external integration. It calls Ouroboros's MCP interview tool, renders each question in GJC, correlates ordinary answers by Ouroboros session ID, and stops claiming input when the interview completes.

The canonical install location is the agent extensions directory discovered by the native GJC provider:

- user-level: `$HOME/${GJC_CONFIG_DIR:-.gjc}/agent/extensions`
- project-level: `<cwd>/.gjc/extensions`

For native discovery, install one of:

- `extensions/<name>.ts` or `extensions/<name>.js`
- `extensions/<name>/index.ts` or `extensions/<name>/index.js`
- `extensions/<name>/package.json` declaring extension entries

The loader scans one level under each `extensions` directory. Complex packages should use a package manifest instead of relying on recursive discovery.

`GJC_CONFIG_DIR` selects the **home-relative** config directory name: the config root is `<home>/<GJC_CONFIG_DIR>`, defaulting to `~/.gjc`. It does not select a project directory — the project-level path is the constant `.gjc` (`discovery/helpers.ts`, `getProjectAgentDir()`), so `GJC_CONFIG_DIR` never moves it. `GJC_CODING_AGENT_DIR` overrides the agent directory **path** rather than naming one under `$HOME`; it is resolved with `path.resolve`, so an absolute value is used as-is and a relative value is resolved against the current working directory.

Native discovery honors the selected agent directory profile. With no override it derives the user-level root from `GJC_CONFIG_DIR` (`<home>/<config-dir>/agent`); when `GJC_CODING_AGENT_DIR` is set, extension, skill, rule, hook, settings, and custom-tool discovery use that explicit agent directory. Explicit-home loads still derive or receive their agent directory from the supplied home and never fall back to the process-global profile.

Hooks are not the input bridge surface: `packages/coding-agent/src/capability/hook.ts` defines pre/post tool hooks only.
