import { describe, expect, it } from "bun:test";
import fc from "fast-check";
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

describe("calculator exponentiation properties", () => {
	const smallBase = fc.integer({ min: 2, max: 9 });
	const smallExp = fc.integer({ min: 1, max: 6 });

	it("property: a signed exponent equals its parenthesized form and the reciprocal, seed 5112026, 40 inputs", async () => {
		await fc.assert(
			fc.asyncProperty(smallBase, smallExp, async (a, n) => {
				const signed = await evaluate(`${a} ** -${n}`);
				const parenthesized = await evaluate(`${a} ** (-${n})`);
				expect(signed).toBe(parenthesized);
				expect(signed).toBeCloseTo(1 / a ** n, 10);
			}),
			{ seed: 5112026, numRuns: 40 },
		);
	});

	it("property: exponentiation stays right-associative and above left unary, seed 5112026, 40 inputs", async () => {
		await fc.assert(
			fc.asyncProperty(smallBase, smallExp, fc.integer({ min: 1, max: 3 }), async (a, b, c) => {
				expect(await evaluate(`${a} ** ${b} ** ${c}`)).toBeCloseTo(a ** (b ** c), 8);
				expect(await evaluate(`-${a} ** ${b}`)).toBe(-(a ** b));
			}),
			{ seed: 5112026, numRuns: 40 },
		);
	});
});
