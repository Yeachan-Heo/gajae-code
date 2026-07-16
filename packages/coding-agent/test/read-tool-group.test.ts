import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Input, setKeybindings, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { KeybindingsManager } from "../src/config/keybindings";
import { getDefault } from "../src/config/settings-schema";
import { ReadToolGroupComponent, readArgsTargetInternalUrl } from "../src/modes/components/read-tool-group";
import * as themeModule from "../src/modes/theme/theme";

describe("ReadToolGroupComponent", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});
	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});
	function expandHintCapability(): () => boolean {
		const ui = new TUI(new VirtualTerminal());
		const editor = new Input();
		ui.addChild(editor);
		ui.setFocus(editor);
		return () => !ui.hasOverlay() && (ui.focusedComponent === null || ui.focusedComponent === editor);
	}

	it("keeps inline read previews disabled by default", () => {
		expect(getDefault("read.toolResultPreview")).toBe(false);

		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "/tmp/example.ts" }, "read-0");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
			},
			false,
			"read-0",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain("Read /tmp/example.ts");
		expect(rendered).not.toContain("line 1");
		expect(rendered.toLowerCase()).not.toContain("ctrl+o");
	});

	it("renders warning previews with warning styling instead of success styling", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		component.updateArgs({ path: "/tmp/example.ts" }, "read-1");
		component.updateResult(
			{
				content: [{ type: "text", text: "const a = 1;\nconst b = 2;\nconst c = 3;" }],
				details: { suffixResolution: { from: "/tmp/exampl.ts", to: "/tmp/example.ts" } },
			},
			false,
			"read-1",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain(themeModule.theme.status.warning);
		expect(rendered).not.toContain(themeModule.theme.status.success);
		expect(rendered).toContain("corrected from");
	});

	it("highlights only the collapsed preview lines", () => {
		const highlightSpy = vi.spyOn(themeModule, "highlightCode");
		const component = new ReadToolGroupComponent({
			showContentPreview: true,
			expandHintCapability: expandHintCapability(),
		});
		component.updateArgs({ path: "/tmp/example.ts" }, "read-2");
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "line 1\nline 2\nline 3\nline 4\nline 5",
					},
				],
			},
			false,
			"read-2",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		const highlightedInput = highlightSpy.mock.calls[0]?.[0];

		expect(highlightedInput).toBe("line 1\nline 2\nline 3");
		expect(rendered).toContain("line 1");
		expect(rendered).not.toContain("line 4");
		expect(rendered.toLowerCase()).toContain("ctrl+o");
	});

	it("does not render a duplicate summary row when inline previews are enabled", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		component.updateArgs({ path: "/tmp/example.ts:L10-L20" }, "read-3");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
			},
			false,
			"read-3",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		const matches = rendered.match(/Read \/tmp\/example\.ts:L10-L20/g) ?? [];

		expect(matches).toHaveLength(1);
	});
	it("retains a manual collapse through automatic updates across mixed read entries", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		component.updateArgs({ path: "/tmp/success.ts" }, "success");
		component.updateArgs({ path: "/tmp/error.ts" }, "error");
		component.updateArgs({ path: "/tmp/warning.ts" }, "warning");
		component.setManuallyExpanded(false);
		component.updateArgs({ path: "/tmp/success-renamed.ts" }, "success");
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "a\nb\nc\nd" }] }, false, "success");
		component.updateResult({ content: [{ type: "text", text: "e\nf\ng\nh" }], isError: true }, false, "error");
		component.updateResult(
			{
				content: [{ type: "text", text: "i\nj\nk\nl" }],
				details: { suffixResolution: { from: "/tmp/warn.ts", to: "/tmp/warning.ts" } },
			},
			false,
			"warning",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).not.toContain("\nd");
		expect(rendered).not.toContain("\nh");
		expect(rendered).not.toContain("\nl");
	});

	it("retains a manual expansion through automatic updates", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		component.updateArgs({ path: "/tmp/example.ts" }, "read");
		component.setManuallyExpanded(true);
		component.updateArgs({ path: "/tmp/example-renamed.ts" }, "read");
		component.setExpanded(false);
		component.updateResult({ content: [{ type: "text", text: "a\nb\nc\nd" }] }, false, "read");

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("d");
	});

	it("follows automatic expansion until explicitly pinned, then applies the new pin", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		component.updateArgs({ path: "/tmp/example.ts" }, "read");
		component.updateResult({ content: [{ type: "text", text: "a\nb\nc\nd" }] }, false, "read");
		component.setExpanded(true);
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("d");

		component.setManuallyExpanded(false);
		expect(Bun.stripANSI(component.render(120).join("\n"))).not.toContain("\nd");

		component.setManuallyExpanded(true);
		component.setExpanded(false);
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("d");
	});

	it("uses the configured expansion key hint and omits it when unbound", () => {
		const component = new ReadToolGroupComponent({
			showContentPreview: true,
			expandHintCapability: expandHintCapability(),
		});
		component.updateArgs({ path: "/tmp/example.ts" }, "read");
		component.updateResult({ content: [{ type: "text", text: "a\nb\nc\nd" }] }, false, "read");

		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+x" }));
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Alt+X for more");

		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": [] }));
		component.invalidate();
		expect(Bun.stripANSI(component.render(120).join("\n"))).not.toContain("for more");
	});

	it("resets manual fold provenance when a transcript rebuild creates a new component", () => {
		const original = new ReadToolGroupComponent({ showContentPreview: true });
		original.updateArgs({ path: "/tmp/example.ts" }, "read");
		original.updateResult({ content: [{ type: "text", text: "a\nb\nc\nd" }] }, false, "read");
		original.setManuallyExpanded(true);

		const rebuilt = new ReadToolGroupComponent({ showContentPreview: true });
		rebuilt.setExpanded(false);
		rebuilt.updateArgs({ path: "/tmp/example.ts" }, "read");
		rebuilt.updateResult({ content: [{ type: "text", text: "a\nb\nc\nd" }] }, false, "read");

		expect(Bun.stripANSI(original.render(120).join("\n"))).toContain("d");
		expect(Bun.stripANSI(rebuilt.render(120).join("\n"))).not.toContain("\nd");
	});
});

describe("readArgsTargetInternalUrl", () => {
	it.each([
		["gjc://docs/tools/read.md"],
		["issue://123"],
		["pr://can1357/gajae-code/456"],
		["agent://abc"],
		["artifact://abc"],
		["memory://root"],
		["rule://name"],
		["local://PLAN.md"],
	])("treats %s as an internal URL read", target => {
		expect(readArgsTargetInternalUrl({ path: target })).toBe(true);
		expect(readArgsTargetInternalUrl({ file_path: target })).toBe(true);
	});

	it.each([
		["/tmp/example.ts"],
		["./relative/path.md"],
		["https://example.com/file"],
		[""],
	])("treats %s as a filesystem/external target", target => {
		expect(readArgsTargetInternalUrl({ path: target })).toBe(false);
	});

	it("returns false for non-record / missing arguments", () => {
		expect(readArgsTargetInternalUrl(undefined)).toBe(false);
		expect(readArgsTargetInternalUrl(null)).toBe(false);
		expect(readArgsTargetInternalUrl("skill://x")).toBe(false);
		expect(readArgsTargetInternalUrl(["skill://x"])).toBe(false);
		expect(readArgsTargetInternalUrl({})).toBe(false);
		expect(readArgsTargetInternalUrl({ path: 42 })).toBe(false);
	});
});
