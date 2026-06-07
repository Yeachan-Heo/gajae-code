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

| Extension         | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `chalk-logger.ts` | Uses chalk from parent node_modules (demonstrates jiti module resolution) |
| `with-deps/`      | Extension with its own package.json and dependencies                      |

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
