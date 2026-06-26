import { describe, expect, it } from "bun:test";
import { commands } from "../src/cli";

describe("CLI command registry", () => {
	it("registers the `plugin` command so `gjc plugin …` resolves instead of routing to launch", () => {
		// Regression: `src/commands/plugin.ts` existed (and was unit-tested in
		// isolation) but was never added to the `commands` registry in cli.ts.
		// `isSubcommand()` therefore returned false for "plugin", so `gjc plugin
		// install …` fell through to the default `launch` command and was treated
		// as a chat message. The TUI plugin panel meanwhile advertised
		// `gjc plugin install <package>`, an unreachable command.
		const entry = commands.find(c => c.name === "plugin");
		expect(entry).toBeDefined();
	});

	it("lazily resolves the registered `plugin` entry to the Plugin command class", async () => {
		const entry = commands.find(c => c.name === "plugin");
		const cmd = (await entry?.load()) as { description?: string } | undefined;
		expect(cmd).toBeDefined();
		expect(cmd?.description ?? "").toMatch(/plugin/i);
	});

	it("registers the `mcp` command so direct MCP config does not route to launch", () => {
		const entry = commands.find(c => c.name === "mcp");
		expect(entry).toBeDefined();
	});

	it("lazily resolves the registered `mcp` entry to the MCP command class", async () => {
		const entry = commands.find(c => c.name === "mcp");
		const cmd = (await entry?.load()) as { description?: string } | undefined;
		expect(cmd).toBeDefined();
		expect(cmd?.description ?? "").toMatch(/MCP/i);
	});
});
