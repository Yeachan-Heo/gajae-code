import { beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@gajae-code/coding-agent/modes/components/bash-execution";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { bashToolRenderer, formatBashCommand } from "@gajae-code/coding-agent/tools/bash";
import { BashInteractiveOverlayComponent } from "@gajae-code/coding-agent/tools/bash-interactive";
import {
	formatInvocationCommand,
	formatInvocationEnvironment,
} from "@gajae-code/coding-agent/tools/invocation-display";
import type { TUI } from "@gajae-code/tui";
import { visibleWidth } from "@gajae-code/tui";
import xterm from "@xterm/headless";

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

	it("redacts complete shell words across escaped, ANSI-C, assignment, and cookie forms", () => {
		const command = String.raw`PASSWORD=$'top secret' curl --password "top \"secret\" suffix" --cookie=$'session secret' --authorization BearerValue`;
		for (const expanded of [false, true]) {
			const displayed = formatInvocationCommand(command, expanded);
			expect(displayed).not.toContain("top secret");
			expect(displayed).not.toContain("suffix");
			expect(displayed).not.toContain("session secret");
			expect(displayed).not.toContain("BearerValue");
			expect(displayed).toContain("PASSWORD=$'<redacted>'");
			expect(displayed).toContain('--password "<redacted>"');
			expect(displayed).toContain("--cookie=$'<redacted>'");
		}
	});

	it("redacts logically constructed sensitive flags and command-substitution values", () => {
		const command =
			"curl --coo$'kie'=session-secret --coo$'kie'\"=\"joined-secret --password=$(printf supersecret) --authorization $(printf authsecret) \"--password=quoted-secret\"";
		for (const expanded of [false, true]) {
			const displayed = formatInvocationCommand(command, expanded);
			expect(displayed).not.toContain("session-secret");
			expect(displayed).not.toContain("supersecret");
			expect(displayed).not.toContain("authsecret");
			expect(displayed).not.toContain("quoted-secret");
			expect(displayed).not.toContain("joined-secret");
			expect(displayed).toContain("--coo$'kie'=<redacted>");
			expect(displayed).toContain("--password=<redacted>");
			expect(displayed).toContain("--authorization <redacted>");
			if (expanded) expect(displayed).toContain('"--password=<redacted>"');
			expect(displayed).toContain("--cookie=<redacted>");
		}
	});

	it("redacts complete quoted and nested substitution spans in collapsed and expanded views", () => {
		const cases: Array<[command: string, expected: string, secrets: string[]]> = [
			['curl --password="$(printf "secret value")"', 'curl --password="<redacted>"', ["secret", "value"]],
			['curl --password="$(echo $(printf "deep secret"))"', 'curl --password="<redacted>"', ["deep", "secret"]],
			[
				'curl --password="$(printf "%s" "literal ) ( secret")"',
				'curl --password="<redacted>"',
				["literal", "secret"],
			],
			['curl --password="`printf "legacy secret"`"', 'curl --password="<redacted>"', ["legacy", "secret"]],
			[
				'curl --password="`echo $(printf "nested legacy secret")`"',
				'curl --password="<redacted>"',
				["nested", "legacy", "secret"],
			],
			[
				'curl --authorization "$(printf "separated secret")"',
				'curl --authorization "<redacted>"',
				["separated", "secret"],
			],
		];

		for (const expanded of [false, true]) {
			for (const [command, expected, secrets] of cases) {
				const displayed = formatInvocationCommand(command, expanded);
				expect(displayed).toBe(expected);
				for (const secret of secrets) expect(displayed).not.toContain(secret);
			}
		}
	});

	it("redacts ANSI-C escaped sensitive flags and complete backtick substitutions", () => {
		const cases: Array<[command: string, secret: string]> = [
			["curl --coo$'\\x6b'ie=hex-secret", "hex-secret"],
			["curl --coo$'\\153'ie=octal-secret", "octal-secret"],
			["curl --coo$'\\u006b'ie=unicode-secret", "unicode-secret"],
			["curl --coo$'\\U0000006b'ie=long-unicode-secret", "long-unicode-secret"],
			["curl --coo$'\\n'kie=standard-control-secret", "standard-control-secret"],
			["curl --coo$'\\c@'kie=control-secret", "control-secret"],
			["curl --password=`printf backtick-equals-secret`", "backtick-equals-secret"],
			["curl --authorization `printf backtick-separated-secret`", "backtick-separated-secret"],
		];
		for (const expanded of [false, true]) {
			for (const [command, secret] of cases) {
				const displayed = formatInvocationCommand(command, expanded);
				expect(displayed).not.toContain(secret);
				expect(displayed).toContain("<redacted>");
			}
		}
	});

	it("preserves safe quoted equals and command substitutions", () => {
		const commands = ["printf '%s' 'a=b' $(printf visible)", "printf '%s' `printf visible legacy`"];
		for (const command of commands) expect(formatInvocationCommand(command, true)).toBe(command);
	});

	it("redacts password and username-only userinfo for generic credential URLs", () => {
		const command =
			"printf %s postgres://user:db-secret@host/db https://:empty-user-secret@example.test ftp://name:p:a:ss@host/path https://opaque-api-token@example.test/path";
		const displayed = formatInvocationCommand(command, true);

		expect(displayed).not.toContain("db-secret");
		expect(displayed).not.toContain("empty-user-secret");
		expect(displayed).not.toContain("p:a:ss");
		expect(displayed).not.toContain("opaque-api-token");
		expect(displayed).toContain("postgres://user:<redacted>@host/db");
		expect(displayed).toContain("https://:<redacted>@example.test");
		expect(displayed).toContain("ftp://name:<redacted>@host/path");
		expect(displayed).toContain("https://<redacted>@example.test/path");
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

	it("hard-bounds retained lines from oversized multiline quoted payloads", () => {
		const oversized = "界".repeat(10_000);
		const command = `printf '%s' '${oversized}\nsecond\nthird\nfourth'`;
		const collapsed = formatInvocationCommand(command, false);

		expect(collapsed).toContain("<multiline command, 4 lines,");
		expect(collapsed).not.toContain("界".repeat(100));
		for (const line of collapsed.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(110);
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

	it("sanitizes terminal controls before every bash tool-card invocation render", async () => {
		const theme = (await getThemeByName("red-claw"))!;
		const maliciousUrl = "https://evil.test";
		const args = {
			command: `printf '\x1b[31mred\x1b[0m\x07'\x1b]8;;${maliciousUrl}\x07link\x1b]8;;\x07`,
			env: { SAFE: `ok\x1b]2;owned\x07` },
		};
		expect(formatBashCommand(args, true)).toBe("$ SAFE=\"ok\" printf 'red'link");

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
			expect(output).not.toContain(maliciousUrl);
			expect(output).not.toContain("owned");
			expect(output).not.toContain("\x07");
			expect(Bun.stripANSI(output)).toContain("printf 'red'link");
		}
	});

	it("redacts and sanitizes the interactive PTY overlay header", async () => {
		const theme = (await getThemeByName("red-claw"))!;
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
		const maliciousUrl = "https://evil.test";
		const command = `API_TOKEN='${secret}' printf '\x1b[31mred\x1b[0m\x07'\x1b]8;;${maliciousUrl}\x07link\x1b]8;;\x07`;
		const component = new BashInteractiveOverlayComponent(command, theme, () => 24, xterm.Terminal);

		const rendered = component.render(100).join("\n");
		component.dispose();

		expect(rendered).not.toContain(secret);
		expect(rendered).not.toContain(maliciousUrl);
		expect(rendered).not.toContain("\x07");
		expect(Bun.stripANSI(rendered)).toContain("API_TOKEN='<redacted>' printf 'red'link");
	});

	it("keeps quoted nested substitutions out of collapsed and expanded standard Bash cards", async () => {
		const theme = (await getThemeByName("red-claw"))!;
		const command = 'curl --password="$(echo $(printf "deep secret value"))"';

		for (const expanded of [false, true]) {
			const rendered = bashToolRenderer
				.renderCall({ command }, { expanded, isPartial: true }, theme)
				.render(120)
				.join("\n");
			const plain = Bun.stripANSI(rendered);
			expect(plain).toContain('curl --password="<redacted>"');
			expect(plain).not.toContain("deep");
			expect(plain).not.toContain("secret value");
			for (const line of rendered.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	it("keeps ANSI-C and backtick secrets out of every Bash invocation header", async () => {
		const theme = (await getThemeByName("red-claw"))!;
		const command =
			"curl --coo$'\\x6b'ie=card-secret --password=`printf equals-secret` --authorization `printf separated-secret`";
		const toolCard = bashToolRenderer
			.renderCall({ command }, { expanded: true, isPartial: true }, theme)
			.render(180)
			.join("\n");
		const execution = new BashExecutionComponent(command, ui, false);
		execution.setExpanded(true);
		const executionHeader = execution.render(180).join("\n");
		const overlay = new BashInteractiveOverlayComponent(command, theme, () => 24, xterm.Terminal);
		const overlayHeader = overlay.render(180).join("\n");
		overlay.dispose();

		for (const rendered of [toolCard, executionHeader, overlayHeader]) {
			expect(rendered).not.toContain("card-secret");
			expect(rendered).not.toContain("equals-secret");
			expect(rendered).not.toContain("separated-secret");
			expect(Bun.stripANSI(rendered)).toContain("<redacted>");
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
