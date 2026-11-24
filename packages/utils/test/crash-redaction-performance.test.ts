import { describe, expect, it } from "bun:test";
import { asOriginalText, maskStructured } from "../src/crash-redaction";

describe("crash redaction performance regression", () => {
	it("should find quoted container data spans in linear time", () => {
		// When scanning for quoted container values, the implementation should not rescan
		// the remaining text for each container. If it did, this test would have O(n²) complexity
		// where n is the number of containers. By reusing a single LineEndScan across all containers,
		// we ensure the complexity stays O(n).
		const containerCount = 200;
		const tailSize = 50000; // Large tail that would be rescanned for each container if we created a new scan

		let text = "";
		for (let i = 0; i < containerCount; i++) {
			text += `unclosed_container_${i}: [\n`;
		}
		// Add a large tail that would cause quadratic behavior if rescanned per container
		text += `tail_data: ${"x".repeat(tailSize)}\n`;

		const original = asOriginalText(text);

		// Time the redaction - should be O(n) where n is text size
		const startTime = performance.now();
		maskStructured(original);
		const duration = performance.now() - startTime;

		// Before the fix: could take several seconds due to O(n²) behavior
		// After the fix: should complete in well under 500ms even on slower machines
		expect(duration).toBeLessThan(500);
	});

	it("should handle nested unclosed containers in linear time", () => {
		// Create deeply nested unclosed containers
		const nestingDepth = 50;

		let text = "";
		for (let i = 0; i < nestingDepth; i++) {
			text += "data: [\n";
		}
		text += `content: ${"x".repeat(5000)}\n`;
		for (let i = 0; i < nestingDepth; i++) {
			text += "]\n";
		}

		const original = asOriginalText(text);

		const startTime = performance.now();
		maskStructured(original);
		const duration = performance.now() - startTime;

		// Should complete quickly even with deep nesting
		expect(duration).toBeLessThan(500);
	});

	it("should not rescan text for quoted value detection across containers", () => {
		// This tests the specific case: when finding quoted container values,
		// we should not rescan the remaining text for each container
		const wrappers =
			'wrapper_1: ["secret_1"]\nwrapper_2: ["secret_2"]\nwrapper_3: ["secret_3"]\nwrapper_4: ["secret_4"]\nwrapper_5: ["secret_5"]\n';
		const text = asOriginalText(wrappers + "x".repeat(10000));

		const startTime = performance.now();
		maskStructured(text);
		const duration = performance.now() - startTime;

		// Should be linear in text size, not quadratic in container count
		expect(duration).toBeLessThan(300);
	});
});
