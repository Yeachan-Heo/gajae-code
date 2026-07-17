# render_mermaid

> Convert Mermaid source into terminal-friendly ASCII/Unicode text.

## Source
- Entry: `packages/coding-agent/src/tools/render-mermaid.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/render-mermaid.md`
- Key collaborators:
  - `packages/utils/src/mermaid-ascii.ts` — thin wrapper over renderer package.
  - `packages/coding-agent/src/tools/index.ts` — tool registration and enablement gate.
  - `packages/coding-agent/src/sdk/session.ts` — session-facing artifact allocation hook.
  - `packages/coding-agent/src/session/session-manager.ts` — persistent-session artifact path allocation.
  - `packages/coding-agent/src/session/artifacts.ts` — artifact filename generation and writes.
- Related user/runtime doc: `docs/render-mermaid.md`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mermaid` | `string` | Yes | Mermaid source text. Schema example: `graph TD; A-->B`. |
| `config` | `object` | No | Optional renderer options. Sanitized before rendering; numeric fields are floored and clamped to `>= 0`. |

`config` fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `useAscii` | `boolean` | No | `true` for plain ASCII, `false`/omitted for Unicode box-drawing output. Passed through unchanged. |
| `paddingX` | `number` | No | Horizontal spacing. `Math.floor`, then `Math.max(0, value)`. |
| `paddingY` | `number` | No | Vertical spacing. `Math.floor`, then `Math.max(0, value)`. |
| `boxBorderPadding` | `number` | No | Inner box padding. `Math.floor`, then `Math.max(0, value)`. |

## Outputs
The tool returns a single text content block:

- inline body: rendered diagram text
- optional trailer: `Saved artifact: artifact://<id>` when artifact storage is available

`details` may include:

- `artifactId?: string`

No image path, SVG, PNG, or binary payload is returned. Stored artifacts are plain text `.log` files; artifact filenames are allocated as `<id>.render_mermaid.log` by `packages/coding-agent/src/session/artifacts.ts`.

## Flow
1. `RenderMermaidTool.execute()` in `packages/coding-agent/src/tools/render-mermaid.ts` receives `mermaid` and optional `config`.
2. `sanitizeRenderConfig()` normalizes `paddingX`, `paddingY`, and `boxBorderPadding` to non-negative integers; `useAscii` is passed through.
3. The tool calls `renderMermaidAscii()` from `@gajae-code/utils`.
4. `packages/utils/src/mermaid-ascii.ts` forwards directly to `renderMermaidASCII()` from the `beautiful-mermaid` package.
5. The tool optionally asks the session for an artifact slot with `allocateOutputArtifact("render_mermaid")`.
6. If a path is returned, `Bun.write()` persists the full rendered text to that file.
7. The tool returns the rendered text, plus an `artifact://` line and `details.artifactId` when persistence succeeded.

## Modes / Variants
- Default render: Unicode box-drawing output when `config.useAscii` is omitted or false.
- ASCII render: plain ASCII output when `config.useAscii` is true.
- Persistent-session path: artifact text is written when `allocateOutputArtifact()` returns a path.
- Ephemeral-session path: no artifact is written; the inline text result is still returned.

## Side Effects
- Filesystem
  - May write one session artifact via `Bun.write()`.
  - Artifact filename format is `<id>.render_mermaid.log`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Consumes the session artifact allocator hook.
  - Returns `details.artifactId` for the tool result.

## Limits & Caps
- No tool-local timeout, retry, truncation, or streaming path.
- Numeric config fields are quantized to integers with `Math.floor()` and clamped to `0` minimum in `sanitizeRenderConfig()`.
- Renderer engine is `beautiful-mermaid@1.1.3` per root `package.json` / `bun.lock`.
- The tool is registered as discoverable and gated by `renderMermaid.enabled` in `packages/coding-agent/src/tools/index.ts`.

## Errors
- `renderMermaidAscii()` is not wrapped in a local `try/catch`; renderer exceptions propagate out of `execute()`.
- Invalid Mermaid syntax therefore fails the tool call rather than returning partial output.
- Artifact allocation failures inside the SDK hook are swallowed there and converted to `{}` in `packages/coding-agent/src/sdk/session.ts`; rendering still succeeds, just without a saved artifact.
- Artifact write failures from `Bun.write()` are not caught in the tool and will fail the call.

## Notes
- The tool summary string says `Render a Mermaid diagram to an image`, but the implementation and prompt both produce text, not images.
- Despite the name, this tool does not use Puppeteer, browser rendering, Mermaid CLI, or native bindings; rendering stays in-process through the JS package wrapper.
- `docs/render-mermaid.md` covers operator-facing behavior and enablement; keep this file focused on the tool contract and runtime path.
