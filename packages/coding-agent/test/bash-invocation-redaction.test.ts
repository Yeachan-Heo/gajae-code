import { beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@gajae-code/coding-agent/modes/components/bash-execution";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { bashToolRenderer, formatBashCommand } from "@gajae-code/coding-agent/tools/bash";
import {
	formatInvocationCommand,
	formatInvocationEnvironment,
} from "@gajae-code/coding-agent/tools/invocation-display";
import type { TUI } from "@gajae-code/tui";
import { visibleWidth } from "@gajae-code/tui";

const ui = { requestRender: () => {} } as unknown as TUI;

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	expect(theme).toBeDefined();
	setThemeInstance(theme!);
});

describe("bash invocation display safety", () => {
	it("summarizes multiline environment values while preserving expanded non-sensitive detail", () => {
		const value = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
		const collapsed = formatInvocationEnvironment({ ISSUE_BODY: value }, false);
		const expanded = formatInvocationEnvironment({ ISSUE_BODY: value }, true);

		expect(collapsed).toContain('ISSUE_BODY="<multiline, 8 lines,');
		expect(collapsed).not.toContain("line 8");
		expect(expanded).toContain("line 1\\nline 2");
		expect(expanded).toContain("line 8");
	});

	it("redacts sensitive keys and token-shaped values in collapsed and expanded views", () => {
		const secret = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
		for (const expanded of [false, true]) {
			const env = formatInvocationEnvironment({ GITHUB_TOKEN: secret, SAFE: `Bearer ${secret}` }, expanded);
			const command = formatInvocationCommand(
				`curl --authorization '${secret}' --password 'my secret phrase' https://user:password@example.test`,
				expanded,
			);

			expect(env).not.toContain(secret);
			expect(env).toContain('GITHUB_TOKEN="<redacted>"');
			expect(env).toContain("Bearer <redacted>");
			expect(command).not.toContain(secret);
			expect(command).not.toContain("password@example.test");
			expect(command).not.toContain("my secret phrase");
			expect(command).toContain("--authorization '<redacted>'");
		}
	});

	it("keeps short safe commands readable and collapses large arguments", () => {
		expect(formatInvocationCommand("git status --short", false)).toBe("git status --short");
		const longArgument = JSON.stringify({ body: "x".repeat(300) });
		const collapsed = formatInvocationCommand(`curl --data '${longArgument}' https://example.test`, false);
		const expanded = formatInvocationCommand(`curl --data '${longArgument}' https://example.test`, true);

		expect(collapsed).toContain("<argument,");
		expect(collapsed).not.toContain("x".repeat(100));
		expect(expanded).toContain(longArgument);

		const unquoted = formatInvocationCommand(`printf %s ${"y".repeat(300)}`, false);
		expect(unquoted).toContain("<argument,");
		expect(unquoted).not.toContain("y".repeat(100));
	});

	it("applies the same redaction and expansion policy to bash tool arguments", () => {
		const value = "first\nsecond\nthird\nfourth";
		const collapsed = formatBashCommand({
			command: "gh issue create",
			env: { ISSUE_BODY: value, API_TOKEN: "sk-abcdefghijklmnop" },
		});
		const expanded = formatBashCommand(
			{ command: "gh issue create", env: { ISSUE_BODY: value, API_TOKEN: "sk-abcdefghijklmnop" } },
			true,
		);

		expect(collapsed).toContain("gh issue create");
		expect(collapsed).toContain('ISSUE_BODY="<multiline, 4 lines,');
		expect(collapsed).toContain('API_TOKEN="<redacted>"');
		expect(expanded).toContain("first\\nsecond\\nthird\\nfourth");
		expect(expanded).not.toContain("sk-abcdefghijklmnop");
	});

	it("redacts the invocation during streaming, success, failure, and expansion", async () => {
		const theme = (await getThemeByName("red-claw"))!;
		const secret = "sk-abcdefghijklmnopqrstuvwxyz";
		const args = { command: `curl --api-key '${secret}' https://example.test`, env: { SESSION_TOKEN: secret } };
		const rendered = [
			bashToolRenderer.renderCall(args, { expanded: false, isPartial: true }, theme).render(120).join("\n"),
			bashToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "ok" }], details: {}, isError: false },
					{ expanded: false, isPartial: false },
					theme,
					args,
				)
				.render(120)
				.join("\n"),
			bashToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "failed" }], details: {}, isError: true },
					{ expanded: true, isPartial: false },
					theme,
					args,
				)
				.render(120)
				.join("\n"),
		];

		for (const output of rendered) {
			expect(output).not.toContain(secret);
			expect(Bun.stripANSI(output)).toContain("<redacted>");
		}
	});

	it("keeps the shell execution header bounded and never reveals secrets when expanded", () => {
		const body = Array.from({ length: 10 }, (_, index) => `설명 ${index + 1}`).join("\n");
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
		const command = `ISSUE_BODY='${body}' GITHUB_TOKEN='${secret}' gh issue create --title fix`;
		const component = new BashExecutionComponent(command, ui, false);
		component.setComplete(0, false);

		const collapsed = Bun.stripANSI(component.render(36).join("\n"));
		expect(collapsed).toMatch(/<multiline,\s+10 lines,/);
		expect(collapsed).not.toContain("설명 10");
		expect(collapsed).not.toContain(secret);
		for (const line of collapsed.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(36);

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(80).join("\n"));
		expect(expanded).toContain("설명 10");
		expect(expanded).not.toContain(secret);
		expect(expanded).toContain("GITHUB_TOKEN='<redacted>'");
	});
});
