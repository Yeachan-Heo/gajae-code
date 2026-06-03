import { describe, expect, it } from "bun:test";
import { renderStateGraph } from "@gajae-code/coding-agent/gjc-runtime/state-graph";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";

describe("GJC state graph rendering", () => {
	it("renders one skill as ascii", () => {
		const output = renderStateGraph("deep-interview", "ascii");

		expect(output).toContain("deep-interview (Deep Interview)");
		expect(output).toContain("states:");
		expect(output).toContain("  - interviewing (initial)");
		expect(output).toContain("transitions:");
		expect(output).toContain("  - interviewing -> handoff [write-spec]");
	});

	it("renders one skill as mermaid", () => {
		const output = renderStateGraph("deep-interview", "mermaid");

		expect(output).toContain("stateDiagram-v2");
		expect(output).toContain('state "Deep Interview" as deep-interview {');
		expect(output).toContain("[*] --> interviewing");
		expect(output).toContain("interviewing --> handoff: write-spec");
	});

	it("renders one skill as dot", () => {
		const output = renderStateGraph("deep-interview", "dot");

		expect(output).toContain("digraph gjc_state {");
		expect(output).toContain('subgraph "cluster_deep-interview"');
		expect(output).toContain('"deep-interview:interviewing" [label="interviewing", shape=circle];');
		expect(output).toContain('"deep-interview:interviewing" -> "deep-interview:handoff" [label="write-spec"];');
	});

	it("returns exit 2 for invalid CLI graph format", async () => {
		const result = await runNativeStateCommand(["graph", "--skill", "deep-interview", "--format", "svg"]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("Invalid graph format: svg");
	});
});
