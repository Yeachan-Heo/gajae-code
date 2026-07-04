import { describe, expect, it } from "bun:test";
import { subagentIrcActive } from "../../src/task/executor";

describe("subagentIrcActive", () => {
	it("is false when IRC is disabled, regardless of tools", () => {
		expect(subagentIrcActive(false, undefined)).toBe(false);
		expect(subagentIrcActive(false, ["irc"])).toBe(false);
	});

	it("is true when IRC is enabled and the agent takes the default toolset (undefined toolNames)", () => {
		expect(subagentIrcActive(true, undefined)).toBe(true);
	});

	it("is true when IRC is enabled and the agent's tool allowlist includes irc", () => {
		expect(subagentIrcActive(true, ["read", "irc", "search"])).toBe(true);
	});

	it("is false when IRC is enabled but the agent's tool allowlist omits irc", () => {
		// architect/planner/critic declare tools without `irc`; they must not be told to use it.
		expect(subagentIrcActive(true, ["read", "search", "find", "lsp", "ast_grep", "web_search", "bash"])).toBe(false);
	});
});
