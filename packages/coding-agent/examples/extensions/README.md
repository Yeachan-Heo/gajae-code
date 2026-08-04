# Extension Examples

Example extensions for gajae-code.

## Usage

```bash
# Copy an existing extension into the user extension directory for auto-discovery
mkdir -p ~/.gjc/agent/extensions
cp packages/coding-agent/examples/extensions/hello.ts ~/.gjc/agent/extensions/

# Project-local extensions can live in .gjc/extensions/
mkdir -p .gjc/extensions
cp packages/coding-agent/examples/extensions/pirate.ts .gjc/extensions/
```

### Enable the Ouroboros `ooo` bridge

Install the version-pinned Ouroboros `v0.50.7` MCP profile, then configure its GJC runtime:

```bash
uv tool install 'ouroboros-ai[mcp]==0.50.7'
ouroboros setup --runtime gjc
```

`pipx install 'ouroboros-ai[mcp]==0.50.7'` is the equivalent pipx installation. Do not pipe a mutable branch installer into a shell. Pin source audits to commit `cb658aa819bfabafecbbe91bc36327f10691171b`. The [v0.50.7 release](https://github.com/Q00/ouroboros/releases/tag/v0.50.7) publishes `ouroboros_ai-0.50.7-py3-none-any.whl` with SHA-256 `df42f4ef10e032f2edc3249534bf91e8612dee789dfc3517895a9eb2df7f82c4`; verify downloaded release assets before installing them.

Ouroboros setup installs its own managed bridge. Replace that file with this standalone GJC bridge, which preserves the interview session across serialized follow-up answers, disposes it on GJC session switches, and drops queued predecessor-session starts. Download the example from immutable GJC commit `4311fefd49e9c6781c4d1111b8dd3f758e7d8974` and verify it before installation:

```bash
curl -fL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/4311fefd49e9c6781c4d1111b8dd3f758e7d8974/packages/coding-agent/examples/extensions/ooo-bridge.ts -o /tmp/gjc-ooo-bridge.ts
shasum -a 256 /tmp/gjc-ooo-bridge.ts
mkdir -p "${HOME}/${GJC_CONFIG_DIR:-.gjc}/agent/extensions/ouroboros-ooo-bridge" && cp /tmp/gjc-ooo-bridge.ts "${HOME}/${GJC_CONFIG_DIR:-.gjc}/agent/extensions/ouroboros-ooo-bridge/index.ts"
```

The `shasum` output must match `2b0e1e25ac145331f112da629076875542db6f6e63c3c17adcd6770a4dcaf7bd` before the copy. The file has no runtime package imports and uses the host API injected by GJC, so compiled binaries do not require a peer `node_modules` directory beside the installation.

For a project-only installation, copy the same verified file to `.gjc/extensions/ouroboros-ooo-bridge/index.ts`. Start a new GJC session after installation, then enter:

```text
ooo interview "I want to build a task management CLI"
```

The first question is rendered in GJC. While that interview remains active, ordinary interactive input is sent as the answer with the same Ouroboros session ID; completion clears the correlation and returns subsequent ordinary prompts to GJC. Other `ooo ...` commands continue through `ouroboros dispatch --runtime gjc`, including exit-code `78` pass-through.

Set `OUROBOROS_CLI=/absolute/path/to/ouroboros` when the executable is outside `PATH`. Missing executable, MCP startup, and dispatch failures produce an error notification for the claimed input without preventing GJC startup or ordinary prompts.

This external path is separate from GJC's native `/skill:deep-interview`: the native skill runs GJC's bundled interview workflow, while `ooo interview` delegates to the installed Ouroboros MCP interview tool.

## Examples

### Custom Tools & API

| Extension     | Description                                                |
| ------------- | ---------------------------------------------------------- |
| `hello.ts`    | Minimal custom tool example                                |
| `api-demo.ts` | Demonstrates logger access, injected `pi.zod`, and modules |

### Commands & UI

| Extension           | Description                                                                   |
| ------------------- | ----------------------------------------------------------------------------- |
| `plan-mode.ts`      | Anthropic Code-style plan mode for read-only exploration with `/plan` command |
| `tools.ts`          | Interactive `/tools` command to enable/disable tools with session persistence |
| `reload-runtime.ts` | Adds a command and tool for reloading extensions, skills, prompts, and themes |

### System Prompt & Compaction

| Extension   | Description                                                          |
| ----------- | -------------------------------------------------------------------- |
| `pirate.ts` | Demonstrates `systemPromptAppend` to dynamically modify system prompt |

### External Dependencies

| Extension         | Description                                                                  |
| ----------------- | ---------------------------------------------------------------------------- |
| `chalk-logger.ts` | Uses chalk from parent node_modules (demonstrates jiti module resolution)    |
| `ooo-bridge.ts`   | Opt-in `ooo ...` input bridge to the installed Ouroboros CLI and MCP runtime |
| `with-deps/`      | Extension with its own package.json and dependencies                         |

## Writing Extensions

The examples below show the core extension patterns used by this directory.

```typescript
import type { ExtensionAPI } from "@gajae-code/coding-agent";

export default function (pi: ExtensionAPI) {
	const z = pi.zod;

	// Subscribe to lifecycle events
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
			const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
	});

	// Register custom tools
	pi.registerTool({
		name: "greet",
		label: "Greeting",
		description: "Generate a greeting",
		parameters: z.object({
			name: z.string().describe("Name to greet"),
		}),
		async execute(toolCallId, params, onUpdate, ctx, signal) {
			return {
				content: [{ type: "text", text: `Hello, ${params.name}!` }],
				details: {},
			};
		},
	});

	// Register commands
	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (args, ctx) => {
			ctx.ui.notify("Hello!", "info");
		},
	});
}
```
## Key Patterns

**Use `z.enum` for discriminated string tool args:**

```typescript
const { z } = pi.zod;

parameters: z.object({
	action: z.enum(["list", "add"]),
});
```

**State persistence via details:**

```typescript
// Store state in tool result details for proper branching support
return {
	content: [{ type: "text", text: "Done" }],
	details: { todos: [...todos], nextId }, // Persisted in session
};

// Reconstruct on session events
pi.on("session_start", async (_event, ctx) => {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.toolName === "my_tool") {
			const details = entry.message.details;
			// Reconstruct state from details
		}
	}
});
```
