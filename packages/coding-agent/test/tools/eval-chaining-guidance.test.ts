import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { createTools, type ToolSession } from "../../src/tools";
import { getEvalToolDescription } from "../../src/tools/session-descriptions";

const HEADING = "Batching tool calls through eval";

function batchingSection(description: string): string {
	const start = description.indexOf(HEADING);
	if (start < 0) throw new Error("eval description is missing the batching section");
	const end = description.indexOf("</instruction>", start);
	return description.slice(start, end);
}

function toolSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp/eval-chaining-guidance",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		skipPythonPreflight: true,
		settings,
	};
}

describe("eval tool batching guidance", () => {
	it.each([
		{ py: true, js: true },
		{ py: true, js: false },
		{ py: false, js: true },
	])("renders the batching section for backends %o", backends => {
		expect(getEvalToolDescription(backends)).toContain(HEADING);
	});

	it("recommends batching only read-only, approval-free tools", () => {
		const section = batchingSection(getEvalToolDescription());
		const recommended = section.split("\n").find(line => line.includes("read-only and needs no approval"));
		expect(recommended).toBeDefined();
		for (const tool of ["`read`", "`search`", "`find`", "`ast_grep`", "`lsp`"]) {
			expect(recommended).toContain(tool);
		}
		expect(recommended).not.toContain("`bash`");
		expect(recommended).not.toContain("`grep`");
	});

	it("excludes bash and side-effecting tools from batching", () => {
		const section = batchingSection(getEvalToolDescription());
		expect(section).toContain("Never batch `bash`, `edit`, `write`, or other side-effecting tools through eval");
		expect(section).not.toContain("`bash` with `grep`");
	});

	it("tells the model not to batch when the session asks for approval", () => {
		const section = batchingSection(getEvalToolDescription());
		expect(section).toContain("This session does not ask for approval on tool calls.");
		expect(section).toContain("inside the cell timeout (default 30 s)");
		expect(section).toContain("make direct calls instead");
	});

	it("advertises the guidance only in sessions where eval is enabled", async () => {
		const enabled = await createTools(toolSession(Settings.isolated({ "tools.discoveryMode": "all" })));
		expect(enabled.find(tool => tool.name === "eval")?.description).toContain(HEADING);

		const disabled = await createTools(
			toolSession(Settings.isolated({ "tools.discoveryMode": "all", "eval.py": false, "eval.js": false })),
		);
		// The guidance lives only in eval's description, so no eval tool means no guidance.
		expect(disabled.map(tool => tool.name)).not.toContain("eval");
	});
});
