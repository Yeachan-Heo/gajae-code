# Custom Tools Examples

Example custom tools for gjc-coding-agent.

## Examples

Each example uses the `subdirectory/index.ts` structure required for tool discovery.

### hello/

Minimal example showing the basic structure of a custom tool.

## Usage

GJC discovers custom tools from `tools/<name>/index.ts` in its config directories. Copy the example folder into one of them:

```bash
# All projects
mkdir -p ~/.gjc/agent/tools && cp -r hello ~/.gjc/agent/tools/

# Current project only
mkdir -p .gjc/tools && cp -r hello .gjc/tools/
```

Then in gjc:

```
> greet Alice with the hello tool
```

## Writing Custom Tools

See [docs/codegraph-custom-tool.md](../../../../docs/codegraph-custom-tool.md#2-add-the-custom-tool) for how tools are discovered and loaded.

### Key Points

**Factory pattern:**

```typescript
import { Text } from "@gajae-code/tui";
import type { CustomToolFactory } from "@gajae-code/coding-agent";

const factory: CustomToolFactory = (pi) => ({
	name: "my_tool",
	label: "My Tool",
	description: "Tool description for LLM",
	parameters: pi.zod.object({
		action: pi.zod.enum(["list", "add"]),
	}),

	// Called on session start/switch/branch/clear
	onSession(event) {
		// Reconstruct state from event.entries
	},

	async execute(toolCallId, params) {
		return {
			content: [{ type: "text", text: "Result" }],
			details: {
				/* for rendering and state reconstruction */
			},
		};
	},
});

export default factory;
```
**Custom rendering:**

```typescript
renderCall(args, _options, theme) {
  return new Text(
    theme.fg("toolTitle", theme.bold("my_tool ")) + args.action,
    0, 0  // No padding - Box handles it
  );
},

renderResult(result, { expanded, isPartial }, theme) {
  if (isPartial) {
    return new Text(theme.fg("warning", "Working..."), 0, 0);
  }
  return new Text(theme.fg("success", "✓ Done"), 0, 0);
},
```

**Use `z.enum` for discriminated string tool args:**

```typescript
const { z } = pi.zod;

parameters: z.object({
	action: z.enum(["list", "add"]),
});
```
