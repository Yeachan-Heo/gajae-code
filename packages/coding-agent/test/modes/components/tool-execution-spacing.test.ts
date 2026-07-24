import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { type IrcSidebarTheme, IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { ToolExecutionComponent } from "@gajae-code/coding-agent/modes/components/tool-execution";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import { ImageProtocol, TERMINAL, type TUI } from "@gajae-code/tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

const uiStub = { requestRender() {} } as unknown as TUI;

const sidebarTheme = {
	fg: (_color: "dim" | "accent", text: string) => text,
	bold: (text: string) => text,
	boxSharp: { vertical: "|" },
} satisfies IrcSidebarTheme;

const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
const originalImageProtocol = TERMINAL.imageProtocol;
const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };

afterEach(() => {
	if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
	if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	terminal.imageProtocol = originalImageProtocol;
});

function renderTool(command: string): string[] {
	const component = new ToolExecutionComponent("bash", { command }, {}, undefined, uiStub);
	component.updateResult({ content: [{ type: "text", text: `output of ${command}` }], isError: false }, false);
	return component.render(80).map(line => Bun.stripANSI(line));
}

function countEdgeBlanks(lines: string[]): { leading: number; trailing: number } {
	let leading = 0;
	for (let i = 0; i < lines.length && lines[i].trim() === ""; i++) leading++;
	let trailing = 0;
	for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ""; i--) trailing++;
	return { leading, trailing };
}

// 083.2: block separation is exactly the leading Spacer (1 blank line above each
// block); the content box itself has no vertical padding. Two consecutive tools
// must be separated by exactly 1 blank line.
describe("ToolExecutionComponent spacing", () => {
	it("renders exactly one blank line above and none below a tool block", () => {
		const lines = renderTool("ls -la");
		const { leading, trailing } = countEdgeBlanks(lines);
		expect(leading).toBe(1);
		expect(trailing).toBe(0);
	});

	it("separates consecutive tool blocks by exactly one blank line", () => {
		const a = renderTool("ls -la");
		const b = renderTool("git status");
		const { trailing } = countEdgeBlanks(a);
		const { leading } = countEdgeBlanks(b);
		expect(trailing + leading).toBe(1);
	});
});
it("preserves manual expansion through automatic updates and drops it on remount", () => {
	const component = new ToolExecutionComponent("custom", { path: "/tmp/example.ts" }, {}, undefined, uiStub);
	component.setManuallyExpanded(true);
	component.setExpanded(false);

	expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Args");

	const remounted = new ToolExecutionComponent("custom", { path: "/tmp/example.ts" }, {}, undefined, uiStub);
	remounted.setExpanded(false);
	expect(Bun.stripANSI(remounted.render(80).join("\n"))).not.toContain("Args");
});

it("lets untouched components follow automatic expansion", () => {
	const component = new ToolExecutionComponent("custom", { path: "/tmp/example.ts" }, {}, undefined, uiStub);
	component.setExpanded(true);

	expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Args");
});

it("replaces generic SIXEL output while the IRC sidebar is visible and restores passthrough when hidden", () => {
	terminal.imageProtocol = ImageProtocol.Sixel;
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
	Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
	const sixel = "\x1bPqcustom-image\x1b\\";
	const component = new ToolExecutionComponent("custom", {}, {}, undefined, uiStub);
	component.updateResult({ content: [{ type: "text", text: `before\n${sixel}\nafter` }], isError: false }, false);
	const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), sidebarTheme);

	expect(split.render(120).join("\n")).toContain(sixel);
	split.setVisible(true);
	const visible = split.render(120).join("\n");
	expect(visible).not.toContain("\x1bP");
	expect(Bun.stripANSI(visible).split("[SIXEL image hidden while IRC sidebar is visible]").length - 1).toBe(1);
	split.setVisible(false);
	expect(split.render(120).join("\n")).toContain(sixel);
});

describe("ToolExecutionComponent durable lifecycle", () => {
	it("keeps the tool identity stable while revisions advance to a final event", () => {
		const component = new ToolExecutionComponent(
			"custom",
			{ path: "/tmp/example.ts" },
			{},
			undefined,
			uiStub,
			"tool-call-1",
		);

		const initial = component.getDurableHistoryEvent(80)!;
		expect(initial.identity).toBe("tool-call-1");
		expect(initial.revision).toBeGreaterThan(0);
		expect(initial.final).toBe(false);

		component.updateArgs({ path: "/tmp/example.ts", content: "updated" }, "different-call-id");
		const streaming = component.getDurableHistoryEvent(80)!;
		expect(streaming.identity).toBe(initial.identity);
		expect(streaming.revision).toBeGreaterThan(initial.revision);
		expect(streaming.final).toBe(false);

		component.setArgsComplete("different-call-id");
		const argsComplete = component.getDurableHistoryEvent(80)!;
		expect(argsComplete.identity).toBe(initial.identity);
		expect(argsComplete.revision).toBeGreaterThan(streaming.revision);
		expect(argsComplete.final).toBe(false);

		component.updateResult({ content: [{ type: "text", text: "done" }] }, false, "different-call-id");
		const completed = component.getDurableHistoryEvent(80)!;
		expect(completed.identity).toBe(initial.identity);
		expect(completed.revision).toBeGreaterThan(argsComplete.revision);
		expect(completed.final).toBe(true);
		expect(completed.snapshot.join("\n")).toContain("done");
	});

	it("does not emit a durable event without a tool call identity", () => {
		const component = new ToolExecutionComponent("custom", {}, {}, undefined, uiStub);

		expect(component.getDurableHistoryEvent(80)).toBeUndefined();
	});

	it("ignores invalid or foreign acknowledgements without changing the durable revision", () => {
		const component = new ToolExecutionComponent("custom", {}, {}, undefined, uiStub, "tool-call-2");
		const event = component.getDurableHistoryEvent(80)!;

		component.acknowledgeDurableHistoryEvent("other-call", event.revision);
		component.acknowledgeDurableHistoryEvent("tool-call-2", 0);
		component.acknowledgeDurableHistoryEvent("tool-call-2", event.revision + 1);

		const afterInvalidAcks = component.getDurableHistoryEvent(80)!;
		expect(afterInvalidAcks.identity).toBe(event.identity);
		expect(afterInvalidAcks.revision).toBe(event.revision);
		expect(afterInvalidAcks.final).toBe(false);

		component.acknowledgeDurableHistoryEvent("tool-call-2", event.revision);
		const afterValidAck = component.getDurableHistoryEvent(80)!;
		expect(afterValidAck).toEqual(event);
	});
});
