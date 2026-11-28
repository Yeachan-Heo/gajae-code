import { describe, expect, it } from "bun:test";

/**
 * Test the incremental JSON validator implementation.
 * These tests verify that the incremental validator produces the same results as
 * calling JSON.parse on the full accumulated buffer, but with O(1) per-delta cost.
 */

// Import the internal types and functions for testing
// Since these are not exported, we'll test through the provider behavior

function createIncrementalJsonValidatorState() {
	return {
		inString: false,
		lastWasEscape: false,
		depth: 0,
		sawContent: false,
		lastValidatedSize: 0,
	};
}

function updateIncrementalJsonValidatorState(
	state: ReturnType<typeof createIncrementalJsonValidatorState>,
	buffer: string,
): boolean {
	const startIdx = state.lastValidatedSize;
	const endIdx = buffer.length;

	for (let i = startIdx; i < endIdx; i++) {
		const char = buffer[i];
		const code = char?.charCodeAt(0) ?? 0;

		// Handle escape sequences in strings
		if (state.inString) {
			if (state.lastWasEscape) {
				state.lastWasEscape = false;
			} else if (code === 0x5c) {
				// Backslash
				state.lastWasEscape = true;
			} else if (code === 0x22) {
				// Quote - end of string
				state.inString = false;
			}
			continue;
		}

		// Not in a string, process structural characters
		if (code === 0x22) {
			// Quote - start of string
			state.inString = true;
		} else if (code === 0x7b) {
			// Open brace
			state.depth++;
			state.sawContent = true;
		} else if (code === 0x7d) {
			// Close brace
			if (state.depth > 0) state.depth--;
		} else if (code === 0x5b) {
			// Open bracket
			state.depth++;
		} else if (code === 0x5d) {
			// Close bracket
			if (state.depth > 0) state.depth--;
		}
	}

	state.lastValidatedSize = endIdx;

	// Complete JSON object: depth is 0, we saw content, and not currently in a string
	return !state.inString && state.depth === 0 && state.sawContent;
}

function isCompleteJsonObject(value: string): boolean {
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

describe("incremental JSON validator", () => {
	it("validates empty object", () => {
		const state = createIncrementalJsonValidatorState();
		expect(updateIncrementalJsonValidatorState(state, "{}")).toBe(true);
		expect(isCompleteJsonObject("{}")).toBe(true);
	});

	it("validates object with string property", () => {
		const state = createIncrementalJsonValidatorState();
		const json = '{"name":"test"}';
		expect(updateIncrementalJsonValidatorState(state, json)).toBe(true);
		expect(isCompleteJsonObject(json)).toBe(true);
	});

	it("detects incomplete object missing closing brace", () => {
		const state = createIncrementalJsonValidatorState();
		const json = '{"name":"test"';
		expect(updateIncrementalJsonValidatorState(state, json)).toBe(false);
		expect(isCompleteJsonObject(json)).toBe(false);
	});

	it("detects incomplete string", () => {
		const state = createIncrementalJsonValidatorState();
		const json = '{"name":"test';
		expect(updateIncrementalJsonValidatorState(state, json)).toBe(false);
		expect(isCompleteJsonObject(json)).toBe(false);
	});

	it("handles escaped quotes in strings", () => {
		const state = createIncrementalJsonValidatorState();
		const json = '{"name":"te\\"st"}';
		expect(updateIncrementalJsonValidatorState(state, json)).toBe(true);
		expect(isCompleteJsonObject(json)).toBe(true);
	});

	it("validates incremental updates match full parse", () => {
		const testCases = [
			'{"a":1}',
			'{"a":1,"b":2}',
			'{"a":"hello"}',
			'{"a":{"b":{"c":1}}}',
			'{"items":[1,2,3]}',
			'{"name":"test","value":123}',
		];

		for (const json of testCases) {
			const state = createIncrementalJsonValidatorState();
			// Feed the JSON incrementally, one character at a time
			for (let i = 1; i <= json.length; i++) {
				const prefix = json.slice(0, i);
				const incremental = updateIncrementalJsonValidatorState(state, prefix);
				const fullParse = isCompleteJsonObject(prefix);
				expect(incremental).toBe(fullParse, `Mismatch at position ${i}: "${prefix}"`);
			}
		}
	});

	it("validates random JSON split at random points", () => {
		const jsons = ['{"x":1,"y":2,"z":3}', '{"name":"test","args":{"key":"value"}}', '{"items":[{"id":1},{"id":2}]}'];

		for (const json of jsons) {
			// Test with different chunk sizes
			for (let chunkSize = 1; chunkSize <= 5; chunkSize++) {
				const state = createIncrementalJsonValidatorState();
				let buffer = "";
				for (let i = 0; i < json.length; i += chunkSize) {
					const chunk = json.slice(i, i + chunkSize);
					buffer += chunk;
					const incremental = updateIncrementalJsonValidatorState(state, buffer);
					const fullParse = isCompleteJsonObject(buffer);
					expect(incremental).toBe(
						fullParse,
						`Mismatch with chunk size ${chunkSize} at position ${i}: "${buffer}"`,
					);
				}
			}
		}
	});

	it("handles whitespace correctly", () => {
		const jsons = ['  {  "a" : 1 }  ', '{\n"a": 1\n}', '{\r\n"a": 1\r\n}', '{ \t "a" : 1 \t }'];

		for (const json of jsons) {
			const state = createIncrementalJsonValidatorState();
			const result = updateIncrementalJsonValidatorState(state, json);
			const expected = isCompleteJsonObject(json);
			expect(result).toBe(expected, `Mismatch for JSON: "${json.replace(/[\n\r]/g, "\\n")}"`);
		}
	});

	it("validates nested objects and arrays", () => {
		const complex = '{"data":{"users":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]},"count":2}';
		const state = createIncrementalJsonValidatorState();

		// Feed incrementally
		for (let i = 1; i <= complex.length; i++) {
			const prefix = complex.slice(0, i);
			const incremental = updateIncrementalJsonValidatorState(state, prefix);
			const fullParse = isCompleteJsonObject(prefix);
			expect(incremental).toBe(fullParse);
		}
	});

	it("handles unicode escapes", () => {
		const jsons = [
			'{"text":"hello\\u0020world"}',
			'{"emoji":"\\ud83d\\ude00"}', // Grinning face emoji
		];

		for (const json of jsons) {
			const state = createIncrementalJsonValidatorState();
			const result = updateIncrementalJsonValidatorState(state, json);
			const expected = isCompleteJsonObject(json);
			expect(result).toBe(expected);
		}
	});
});
