import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getDefault } from "../src/config/settings-schema";
import { ReadToolGroupComponent, readArgsTargetInternalUrl } from "../src/modes/components/read-tool-group";
import { InputController } from "../src/modes/controllers/input-controller";
import * as themeModule from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

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
	it("preserves manual fold choices through automatic and entry updates", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		component.updateArgs({ path: "/tmp/one.ts" }, "read-1");
		component.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive" }] }, false, "read-1");
		component.setManuallyExpanded(true);
		component.setExpanded(false);
		component.updateArgs({ path: "/tmp/two.ts" }, "read-2");
		component.updateResult(
			{ content: [{ type: "text", text: "warning" }], details: { suffixResolution: { from: "a", to: "b" } } },
			false,
			"read-2",
		);
		component.updateArgs({ path: "/tmp/three.ts" }, "read-3");
		component.updateResult({ content: [{ type: "text", text: "error" }], isError: true }, false, "read-3");

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("four");

		component.setManuallyExpanded(false);
		component.setExpanded(true);
		expect(Bun.stripANSI(component.render(120).join("\n"))).not.toContain("four");
	});

	it("lets unpinned read groups follow automatic expansion", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		component.updateArgs({ path: "/tmp/example.ts" }, "read-1");
		component.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree\nfour" }] }, false, "read-1");
		component.setExpanded(true);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("four");
	});
	it("accepts a controller override as a fresh explicit pin", () => {
		const manuallyExpandable = { setExpanded: vi.fn(), setManuallyExpanded: vi.fn() };
		const automaticallyExpandable = { setExpanded: vi.fn() };
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [manuallyExpandable, automaticallyExpandable] },
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).setToolsExpanded(true);

		expect(manuallyExpandable.setManuallyExpanded).toHaveBeenCalledWith(true);
		expect(manuallyExpandable.setExpanded).not.toHaveBeenCalled();
		expect(automaticallyExpandable.setExpanded).toHaveBeenCalledWith(true);
	});

	it("dispatches the pin only to real functions and never throws on hostile children", () => {
		const inherited = Object.create({ setManuallyExpanded: vi.fn() });
		inherited.setExpanded = vi.fn();
		const absent = { setExpanded: vi.fn() };
		const nullish = { setExpanded: vi.fn(), setManuallyExpanded: null };
		const truthyNonFunction = { setExpanded: vi.fn(), setManuallyExpanded: true };
		let hostileReads = 0;
		const hostileGetter = {
			setExpanded: vi.fn(),
			get setManuallyExpanded() {
				hostileReads += 1;
				return hostileReads > 1 ? undefined : (true as unknown);
			},
		};
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [inherited, absent, nullish, truthyNonFunction, hostileGetter] },
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveModeContext;

		expect(() => new InputController(ctx).setToolsExpanded(true)).not.toThrow();

		// Inherited callable receives the pin; every non-callable shape falls
		// back to plain setExpanded instead of being invoked.
		expect(Object.getPrototypeOf(inherited).setManuallyExpanded).toHaveBeenCalledWith(true);
		expect(inherited.setExpanded).not.toHaveBeenCalled();
		expect(absent.setExpanded).toHaveBeenCalledWith(true);
		expect(nullish.setExpanded).toHaveBeenCalledWith(true);
		expect(truthyNonFunction.setExpanded).toHaveBeenCalledWith(true);
		expect(hostileGetter.setExpanded).toHaveBeenCalledWith(true);
	});

	it("keeps ToolExecutionHandle source-compatible for legacy structural implementers", () => {
		// Compile-time compatibility fixture: an implementer written against the
		// pre-pin interface (no setManuallyExpanded) must keep typechecking.
		const legacy: import("../src/modes/components/tool-execution").ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [legacy] },
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).setToolsExpanded(true);
		expect(legacy.setExpanded).toHaveBeenCalledWith(true);
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
