import { describe, expect, it } from "bun:test";
import type { ToolSession } from "../src/tools";
import { CalculatorTool } from "../src/tools/calculator";

function makeTool(): CalculatorTool {
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		settings: {},
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "test-session",
		getAgentId: () => "0-Test",
		sendCustomMessage: async () => {},
		purgeQueuedCustomMessages: () => [],
	} as unknown as ToolSession;
	return new CalculatorTool(session);
}

async function evaluate(expression: string): Promise<number> {
	const tool = makeTool();
	const result = await tool.execute("call", { calculations: [{ expression, prefix: "", suffix: "" }] });
	const details = result.details as { results: Array<{ value: number }> } | undefined;
	if (details?.results.length !== 1) {
		throw new Error(`expected one result for ${expression}`);
	}
	return details.results[0]!.value;
}

describe("calculator exponentiation", () => {
	it("evaluates negative exponents", async () => {
		expect(await evaluate("2 ** -3")).toBe(0.125);
		expect(await evaluate("2 ** -3 ** 2")).toBeCloseTo(2 ** -9, 12);
		expect(await evaluate("2 ** +3")).toBe(8);
	});

	it("keeps exponentiation right-associative and above unary on the left", async () => {
		expect(await evaluate("2 ** 3 ** 2")).toBe(512);
		expect(await evaluate("-2 ** 2")).toBe(-4);
		expect(await evaluate("2 ** 3 * 4")).toBe(32);
		expect(await evaluate("2 ** 3 - 1")).toBe(7);
	});
});
