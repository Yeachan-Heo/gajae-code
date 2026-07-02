import { afterEach, describe, expect, it } from "bun:test";
import { shouldShowExtensionCommand } from "../src/modes/slash-command-visibility";

const originalGrokToken = process.env.GROK_CLI_OAUTH_TOKEN;

afterEach(() => {
	if (originalGrokToken === undefined) {
		delete process.env.GROK_CLI_OAUTH_TOKEN;
	} else {
		process.env.GROK_CLI_OAUTH_TOKEN = originalGrokToken;
	}
});

describe("slash command visibility", () => {
	it("hides Grok Build usage from beginner command menus when Grok is inactive", () => {
		delete process.env.GROK_CLI_OAUTH_TOKEN;

		expect(shouldShowExtensionCommand("grok-build-usage", "anthropic")).toBe(false);
		expect(shouldShowExtensionCommand("project-helper", "anthropic")).toBe(true);
	});

	it("shows Grok Build usage when the provider is active or env-authenticated", () => {
		delete process.env.GROK_CLI_OAUTH_TOKEN;
		expect(shouldShowExtensionCommand("grok-build-usage", "grok-build")).toBe(true);

		process.env.GROK_CLI_OAUTH_TOKEN = "token";
		expect(shouldShowExtensionCommand("grok-build-usage", "anthropic")).toBe(true);
	});
});
