import { describe, expect, it } from "bun:test";
import { validateToolArguments } from "@gajae-code/ai/utils/validation";
import type { ToolSession } from "../../src/tools";
import { SubagentTool } from "../../src/tools/subagent";

const reportedArguments = {
	action: "await",
	ids: ["0-AppImprovementReview"],
	id: "",
	message: "",
	pause: false,
	condition: "all_terminal",
	heartbeat_ms: 10_000,
	timeout_ms: 120_000,
	limit: 1,
	verbosity: "preview",
};

function createTool(): SubagentTool {
	// Schema validation does not read session state or execute the tool.
	return new SubagentTool({} as ToolSession);
}

describe("subagent await heartbeat schema", () => {
	it("accepts the reported 10 second heartbeat through tool argument validation", () => {
		const tool = createTool();
		const parsed = validateToolArguments(tool, {
			type: "toolCall",
			id: "subagent-await-heartbeat-schema",
			name: "subagent",
			arguments: reportedArguments,
		});
		expect(parsed).toEqual(reportedArguments);
	});

	it.each([0, 100, 500, 5_000, 10_000, 60_000])("accepts heartbeat_ms=%s unchanged", heartbeatMs => {
		const parsed = createTool().parameters.parse({ ...reportedArguments, heartbeat_ms: heartbeatMs });
		expect(parsed.heartbeat_ms).toBe(heartbeatMs);
	});

	it.each([
		-1,
		1,
		99,
		100.5,
		60_001,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects out-of-range or non-integer heartbeat_ms=%s", heartbeatMs => {
		const parsed = createTool().parameters.safeParse({ ...reportedArguments, heartbeat_ms: heartbeatMs });
		expect(parsed.success).toBe(false);
		if (parsed.success) throw new Error("expected heartbeat validation failure");
		expect(parsed.error.issues[0]?.path).toEqual(["heartbeat_ms"]);
	});

	it("keeps heartbeat omission optional", () => {
		const parsed = createTool().parameters.parse({ action: "await", timeout_ms: 120_000 });
		expect(parsed.heartbeat_ms).toBeUndefined();
	});
});
