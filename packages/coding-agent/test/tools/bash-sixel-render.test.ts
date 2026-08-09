import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { RenderResultOptions } from "@gajae-code/agent-core";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import { type IrcSidebarTheme, IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { bashToolRenderer } from "@gajae-code/coding-agent/tools/bash";
import { getOutputBlockContentWidth } from "@gajae-code/coding-agent/tui/output-block";
import { getKeybindings, ImageProtocol, setKeybindings, TERMINAL, visibleWidth } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;

const sidebarTheme = {
	fg: (_color: "dim" | "accent", text: string) => text,
	bold: (text: string) => text,
	boxSharp: { vertical: "|" },
} satisfies IrcSidebarTheme;

describe("bashToolRenderer", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalKeybindings: ReturnType<typeof getKeybindings>;

	beforeEach(() => {
		originalKeybindings = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		terminal.imageProtocol = originalProtocol;
		setKeybindings(originalKeybindings);
	});

	it("shows rendered env assignments in the command preview", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderCall(
			{ command: "printf '%s' \"$MERMAID\"", env: { MERMAID: 'line "one"\ntwo' } },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain('MERMAID="line \\"one\\"\\ntwo"');
		expect(rendered).toContain("printf '%s' \"$MERMAID\"");
	});

	it("shows partial env assignments while tool args are still streaming", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderCall(
			{
				command: "printf '%s' \"$MERMAID\"",
				__partialJson: '{"command":"printf \'%s\' "$MERMAID"","env":{"MERMAID":"line 1\\nline 2',
			},
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain('MERMAID="line 1\\nline 2"');
		expect(rendered).toContain("printf '%s' \"$MERMAID\"");
	});

	it("sanitizes command tabs and shortens home cwd in previews", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderCall(
			{
				command: "printf\t'%s'",
				cwd: path.join(os.homedir(), "projects", "demo"),
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("~/projects/demo");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("\t");
	});

	it("bounds pending commands to five visual rows and expands inline", async () => {
		const uiTheme = await getThemeByName("red-claw");
		expect(uiTheme).toBeDefined();
		const options = {
			expanded: false,
			isPartial: true,
			renderContext: { expanded: false },
		};
		const command = Array.from({ length: 12 }, (_, index) => `echo line-${index}`).join("\n");
		const component = bashToolRenderer.renderCall({ command }, options, uiTheme!);

		const collapsed = component.render(40).map(line => sanitizeText(line));
		expect(collapsed).toContainEqual(expect.stringContaining("line-0"));
		expect(collapsed).toContainEqual(expect.stringContaining("line-4"));
		expect(collapsed).not.toContainEqual(expect.stringContaining("line-5"));
		expect(collapsed).toContainEqual(expect.stringContaining("7 command rows omitted"));
		expect(collapsed).toContainEqual(expect.stringContaining("ctrl+o to expand"));
		expect(collapsed.length).toBeLessThanOrEqual(1 + 5 + 3);
		for (const line of component.render(40)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}

		options.renderContext.expanded = true;
		const expanded = component.render(40).map(line => sanitizeText(line));
		expect(expanded).toContainEqual(expect.stringContaining("line-11"));
		expect(expanded).not.toContainEqual(expect.stringContaining("command rows omitted"));
	});

	it("bounds completed commands at the output block content width", async () => {
		const uiTheme = await getThemeByName("red-claw");
		expect(uiTheme).toBeDefined();
		const command = Array.from({ length: 12 }, (_, index) => `echo line-${index}`).join("\n");
		const component = bashToolRenderer.renderResult(
			{
				content: [
					{
						type: "text",
						text: Array.from({ length: 12 }, (_, index) => `output-${index}`).join("\n"),
					},
				],
				details: {},
				isError: false,
			},
			{ expanded: false, isPartial: false },
			uiTheme!,
			{ command },
		);

		const rendered = component.render(20);
		const sanitized = rendered.map(line => sanitizeText(line));
		expect(sanitized).toContainEqual(expect.stringContaining("line-0"));
		expect(sanitized).not.toContainEqual(expect.stringContaining("line-5"));
		expect(sanitized).toContainEqual(expect.stringContaining("command rows"));
		expect(sanitized).toContainEqual(expect.stringContaining("omitted"));
		expect(sanitized).toContainEqual(expect.stringContaining("ctrl+o to expand"));
		for (const line of rendered) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}

		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "ctrl+x" }));
		const remapped = component
			.render(80)
			.map(line => sanitizeText(line))
			.join("\n");
		expect(remapped).not.toContain("ctrl+o to expand");
		expect(remapped.match(/ctrl\+x to expand/g)).toHaveLength(2);

		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "ctrl+shift+alt+x" }));
		const fallback = component.render(20).map(line => sanitizeText(line));
		expect(fallback).toContainEqual(expect.stringContaining("expand tools"));
		expect(fallback).not.toContainEqual(expect.stringContaining("ctrl+shift+alt+x"));
	});

	it("updates the collapsed hint when the expand binding changes", async () => {
		const uiTheme = await getThemeByName("red-claw");
		expect(uiTheme).toBeDefined();
		const command = Array.from({ length: 8 }, (_, index) => `echo line-${index}`).join("\n");
		const component = bashToolRenderer.renderCall({ command }, { expanded: false, isPartial: true }, uiTheme!);

		expect(sanitizeText(component.render(40).join("\n"))).toContain("ctrl+o to expand");
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "ctrl+x" }));
		const remapped = sanitizeText(component.render(40).join("\n"));
		expect(remapped).toContain("ctrl+x to expand");
		expect(remapped).not.toContain("ctrl+o to expand");

		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": [] }));
		const unbound = sanitizeText(component.render(40).join("\n"));
		expect(unbound).toContain("expand tools");
		expect(unbound).not.toContain("ctrl+x to expand");
	});

	it("keeps the omission sentinel bounded at narrow widths", async () => {
		const uiTheme = await getThemeByName("red-claw");
		expect(uiTheme).toBeDefined();
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "ctrl+shift+alt+x" }));
		const command = Array.from({ length: 12 }, (_, index) => `echo line-${index}`).join("\n");
		const component = bashToolRenderer.renderCall({ command }, { expanded: false, isPartial: true }, uiTheme!);

		for (const width of [1, 16]) {
			const commandAndSentinel = component.render(width).slice(1);
			expect(commandAndSentinel.length).toBeLessThanOrEqual(5 + 3);
			for (const line of commandAndSentinel) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("exposes the output block's actual section width", async () => {
		const uiTheme = await getThemeByName("red-claw");
		expect(uiTheme).toBeDefined();
		expect(getOutputBlockContentWidth(0, uiTheme!)).toBe(0);
		expect(getOutputBlockContentWidth(20, uiTheme!)).toBe(17);
	});

	it("shows the effective timeout from result details when it differs from call args", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details: { timeoutSeconds: 120 }, isError: false },
			{ expanded: false, isPartial: false, renderContext: { timeout: 1200 } },
			uiTheme,
			{ command: "sleep 1200", timeout: 1200 },
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("Timeout: 120s");
		expect(rendered).not.toContain("Timeout: 1200s");
	});

	it("bypasses truncation/styling for SIXEL lines", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const sixel = "\x1bPqabc\x1b\\";
		const renderOptions: RenderResultOptions & {
			renderContext: {
				output: string;
				expanded: boolean;
				previewLines: number;
			};
		} = {
			expanded: false,
			isPartial: false,
			renderContext: {
				output: `line one\n${sixel}\nline two`,
				expanded: false,
				previewLines: 1,
			},
		};

		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details: {}, isError: false },
			renderOptions,
			uiTheme,
			{ command: "echo sixel" },
		);
		const lines = component.render(80);

		expect(lines.filter(line => line === sixel)).toHaveLength(1);
		expect(lines.some(line => line.includes("ctrl+o to expand"))).toBe(false);
	});
	it("replaces SIXEL output with bordered text while rendered through the visible IRC split", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		const sixel = "\x1bPqabc\x1b\\";
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: sixel }], details: {}, isError: false },
			{ expanded: true, isPartial: false },
			theme!,
			{ command: "echo sixel" },
		);
		const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), sidebarTheme);

		expect(split.render(160).join("\n")).toContain(sixel);
		split.setVisible(true);
		const visible = split.render(160).join("\n");
		expect(visible.match(/\[SIXEL image hidden while IRC sidebar is visible\]/g)).toHaveLength(1);
		expect(visible).not.toContain("\x1bP");
		split.setVisible(false);
		expect(split.render(160).join("\n")).toContain(sixel);
	});

	it("highlights every line of a multi-line bash command in renderResult", async () => {
		const uiTheme = await getThemeByName("red-claw");
		expect(uiTheme).toBeDefined();
		setThemeInstance(uiTheme!);
		const command = 'for f in a b; do\n\techo "$f"\ndone';
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details: {}, isError: false },
			{ expanded: false, isPartial: false },
			uiTheme!,
			{ command },
		);
		const rendered = component.render(120);
		const sanitized = rendered.map(line => sanitizeText(line));
		// Every command line must appear in the output, untruncated.
		const findLine = (needle: string) => sanitized.findIndex(line => line.includes(needle));
		const forLine = findLine("for f in a b; do");
		const echoLine = findLine('echo "$f"');
		const doneLine = findLine("done");
		expect(forLine).toBeGreaterThanOrEqual(0);
		expect(echoLine).toBeGreaterThanOrEqual(0);
		expect(doneLine).toBeGreaterThanOrEqual(0);
		// Each command line carries its own SGR run so terminals don't drop
		// styling after the first newline (the bug this fix addresses).
		for (const idx of [forLine, echoLine, doneLine]) {
			expect(rendered[idx]).toMatch(/\u001b\[38;(?:2|5);/);
		}
	});
});
