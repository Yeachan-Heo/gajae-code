import { describe, expect, it } from "bun:test";
import { commands, routeRootArgv } from "../src/cli";

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

	it("registers the `stats` command so `gjc stats` resolves instead of routing to launch", () => {
		// Regression: `src/commands/stats.ts` (and the `@gajae-code/stats`
		// dependency it drives via `src/cli/stats-cli.ts`) existed, but the
		// entry was never added to the `commands` registry in cli.ts.
		// `isSubcommand()` therefore returned false for "stats", so `gjc stats`
		// fell through to the default `launch` command and was treated as a chat
		// message — the usage-statistics command was completely unreachable.
		const entry = commands.find(c => c.name === "stats");
		expect(entry).toBeDefined();
	});

	it("lazily resolves the registered `stats` entry to the Stats command class", async () => {
		const entry = commands.find(c => c.name === "stats");
		const cmd = (await entry?.load()) as { description?: string } | undefined;
		expect(cmd).toBeDefined();
		expect(cmd?.description ?? "").toMatch(/usage statistics/i);
	});
	it("registers `auth-broker` so documented verbs resolve instead of routing to launch", () => {
		// Regression (#3975): `src/commands/auth-broker.ts` and its handlers in
		// `src/cli/auth-broker-cli.ts` existed, but the entry was never added to
		// the `commands` registry in cli.ts. `isSubcommand()` therefore returned
		// false for "auth-broker", so `gjc auth-broker serve|token|login|…` was
		// rewritten to `launch` and billed a chat turn instead of executing the
		// credential action. docs/auth-broker-gateway.md documents the verbs.
		const entry = commands.find(c => c.name === "auth-broker");
		expect(entry).toBeDefined();
		expect(routeRootArgv(["auth-broker", "serve"])).toEqual(["auth-broker", "serve"]);
		expect(routeRootArgv(["auth-broker", "token"])).toEqual(["auth-broker", "token"]);
		expect(routeRootArgv(["auth-broker", "login", "anthropic"])).toEqual(["auth-broker", "login", "anthropic"]);
	});

	it("lazily resolves the registered `auth-broker` entry to the AuthBroker command class", async () => {
		const entry = commands.find(c => c.name === "auth-broker");
		const cmd = (await entry?.load()) as { description?: string } | undefined;
		expect(cmd).toBeDefined();
		expect(cmd?.description ?? "").toMatch(/auth-broker/i);
	});

	it("registers `auth-gateway` so documented verbs resolve instead of routing to launch", () => {
		// Regression (#3975): same missing-registry-entry pattern as auth-broker.
		// `gjc auth-gateway serve|token|status|check` fell through to launch.
		const entry = commands.find(c => c.name === "auth-gateway");
		expect(entry).toBeDefined();
		expect(routeRootArgv(["auth-gateway", "serve"])).toEqual(["auth-gateway", "serve"]);
		expect(routeRootArgv(["auth-gateway", "check"])).toEqual(["auth-gateway", "check"]);
		expect(routeRootArgv(["auth-gateway", "token", "--regenerate"])).toEqual([
			"auth-gateway",
			"token",
			"--regenerate",
		]);
	});

	it("lazily resolves the registered `auth-gateway` entry to the AuthGateway command class", async () => {
		const entry = commands.find(c => c.name === "auth-gateway");
		const cmd = (await entry?.load()) as { description?: string } | undefined;
		expect(cmd).toBeDefined();
		expect(cmd?.description ?? "").toMatch(/auth-gateway/i);
	});
});
