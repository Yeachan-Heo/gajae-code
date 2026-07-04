import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { MCPAddWizard } from "../src/modes/components/runtime-mcp-add-wizard";

function visibleText(component: { render(width: number): string[] }): string {
	return Bun.stripANSI(component.render(160).join("\n"));
}

function typeText(component: { handleInput(input: string): void }, text: string): void {
	for (const char of text) component.handleInput(char);
}

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("MCP add wizard", () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		await initTheme(false);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns from no-auth scope selection to the transport connection step", async () => {
		const wizard = new MCPAddWizard(
			() => undefined,
			() => undefined,
			undefined,
			async () => undefined,
			undefined,
			"example-server",
		);

		wizard.handleInput("\x1b[B"); // http transport
		wizard.handleInput("\n");
		expect(visibleText(wizard)).toContain("Step 3: Server URL");

		typeText(wizard, "https://example.test/mcp");
		wizard.handleInput("\n");
		await flushAsync();
		vi.advanceTimersByTime(1_000);
		await flushAsync();
		expect(visibleText(wizard)).toContain("Step: Configuration Scope");

		wizard.handleInput("\x1b");
		const afterBack = visibleText(wizard);
		expect(afterBack).toContain("Step 3: Server URL");
		expect(afterBack).not.toContain("Step: HTTP Header Name");
	});
});
