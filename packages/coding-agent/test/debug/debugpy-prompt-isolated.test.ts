import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { DebugTool } from "../../src/tools/debug";
import { TOOL_CATALOG } from "../../src/tools/tool-catalog.generated";

const ISOLATED_ADAPTER = "`python -I -m debugpy.adapter`";

function session(): ToolSession {
	return {
		cwd: ".",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "debug.enabled": true }),
	};
}

function advertised(): string {
	return TOOL_CATALOG.debug?.description ?? "";
}

describe("debugpy adapter prompt", () => {
	it("shows the isolated debugpy adapter command on the debug tool", () => {
		const tool = new DebugTool(session());
		expect(tool.description).toBe(advertised());
		expect(tool.description).toContain(ISOLATED_ADAPTER);
	});

	it("still allows gdb, lldb-dap, and dlv dap in the debug tool prompt", () => {
		const tool = new DebugTool(session());
		for (const name of ["`gdb`", "`lldb-dap`", "`dlv dap`"]) {
			expect(tool.description).toContain(name);
			expect(advertised()).toContain(name);
		}
	});
});
