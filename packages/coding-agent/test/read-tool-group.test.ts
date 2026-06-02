import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
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
		const component = new ReadToolGroupComponent({ showContentPreview: true });
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
