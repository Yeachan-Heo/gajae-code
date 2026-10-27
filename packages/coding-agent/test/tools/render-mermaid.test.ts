import { describe, expect, it } from "bun:test";
import type { ToolSession } from "../../src/tools";
import { RenderMermaidTool } from "../../src/tools/render-mermaid";

describe("RenderMermaidTool", () => {
	it("returns a native-rendered Mermaid diagram", async () => {
		const tool = new RenderMermaidTool({} as ToolSession);
		const result = await tool.execute("render-mermaid-test", {
			mermaid: "flowchart TD\nA[Start] --> B[Stop]",
		});

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("expected text output");
		expect(result.content[0].text).toContain("Start");
		expect(result.content[0].text).toContain("Stop");
	});
});
