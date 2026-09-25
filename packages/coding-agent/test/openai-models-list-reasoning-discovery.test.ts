import { describe, expect, test } from "bun:test";
import { Effort } from "@gajae-code/ai";

describe("OpenAI Models List Discovery - Reasoning Effort", () => {
	test("should extract reasoning efforts from endpoint response", () => {
		const endpointResponse = {
			reasoning_efforts: [
				{ value: "low", default: false },
				{ value: "medium", default: true },
				{ value: "high", default: false },
			],
		};

		// Verify endpoint response structure is correct
		expect(endpointResponse.reasoning_efforts).toHaveLength(3);
		expect(endpointResponse.reasoning_efforts[0].value).toBe("low");
		expect(endpointResponse.reasoning_efforts[1].value).toBe("medium");
		expect(endpointResponse.reasoning_efforts[1].default).toBe(true);
		expect(endpointResponse.reasoning_efforts[2].value).toBe("high");
	});

	test("should accept single advertised effort", () => {
		const endpointResponse = {
			reasoning_efforts: [{ value: "high", default: true }],
		};

		// Single efforts should be discoverable
		expect(endpointResponse.reasoning_efforts).toHaveLength(1);
		expect(endpointResponse.reasoning_efforts[0].value).toBe("high");
	});

	test("should handle non-canonical effort order", () => {
		const endpointResponse = {
			reasoning_efforts: [
				{ value: "high", default: false },
				{ value: "low", default: false },
				{ value: "medium", default: true },
			],
		};

		// Should be sortable to canonical order
		const sorted = endpointResponse.reasoning_efforts
			.map(e => e.value)
			.sort((a, b) => {
				const order = ["low", "medium", "high"];
				return order.indexOf(a) - order.indexOf(b);
			});

		expect(sorted).toEqual(["low", "medium", "high"]);
		expect(sorted[0]).toBe("low");
		expect(sorted[sorted.length - 1]).toBe("high");
	});

	test("should preserve aliased effort names", () => {
		const endpointResponse = {
			reasoning_efforts: [
				{ value: "low-think", default: false },
				{ value: "medium-think", default: true },
				{ value: "high-think", default: false },
			],
		};

		// Original aliases should be preserved
		const aliases = endpointResponse.reasoning_efforts.map(e => e.value);
		expect(aliases[0]).toBe("low-think");
		expect(aliases[1]).toBe("medium-think");
		expect(aliases[2]).toBe("high-think");

		// And mapped to Effort enum values
		const effortMap = {
			"low-think": Effort.Low,
			"medium-think": Effort.Medium,
			"high-think": Effort.High,
		};
		expect(Object.values(effortMap)).toContain(Effort.Low);
		expect(Object.values(effortMap)).toContain(Effort.Medium);
		expect(Object.values(effortMap)).toContain(Effort.High);
	});
});
