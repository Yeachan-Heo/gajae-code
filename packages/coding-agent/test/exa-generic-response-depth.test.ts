import { describe, expect, it } from "bun:test";
import { formatGenericResponse } from "../src/exa/mcp-client";

/**
 * `formatGenericResponse` renders a tool-call payload the remote MCP server
 * returned. Each object level re-indents the entire formatted subtree, so cost
 * grows super-linearly with nesting depth, and `MCP_MAX_CONTENT_BYTES` (16 MiB)
 * does not bound depth — 8000 levels of `{"a":` is under 47 KB.
 */
describe("formatGenericResponse nesting depth", () => {
	function nest(levels: number): unknown {
		let value: unknown = { leaf: "x" };
		for (let i = 0; i < levels; i += 1) value = { a: value };
		return value;
	}

	it("formats a deeply nested payload in bounded time", () => {
		// Before the depth bound: 500/1000/2000/4000/8000 levels cost
		// 60ms/227ms/730ms/5.9s/94s, and 20000 levels threw RangeError.
		for (const levels of [2_000, 8_000, 20_000]) {
			const payload = nest(levels);
			const startedAt = performance.now();
			const output = formatGenericResponse(payload);
			const elapsedMs = performance.now() - startedAt;

			expect(output).toContain("[depth-limit]");
			// Bounded work lands under a millisecond; the budget is loose so it
			// fails only if the scan is unbounded again.
			expect(elapsedMs).toBeLessThan(1_000);
		}
	});

	it("bounds deep values reached through array items and leaf serialization", () => {
		// Array item fields and scalar-position objects are serialized with
		// JSON.stringify; 20000 levels exceed its recursion limit if unbounded.
		const deep = nest(20_000);
		for (const payload of [[{ title: "t", body: deep }], [deep], [[deep]]]) {
			const output = formatGenericResponse(payload);
			expect(output).toContain("[depth-limit]");
		}
		expect(formatGenericResponse([{ title: "t", body: { a: 1 } }])).toBe('\n### t\n- **body:** {"a":1}');
	});

	it("bounds a deeply nested title, name, or id on an array item", () => {
		// Template interpolation of a non-string title coerces arrays recursively and
		// throws RangeError past the engine's limit.
		let deepArray: unknown = ["x"];
		for (let i = 0; i < 20_000; i += 1) deepArray = [deepArray];
		for (const key of ["title", "name", "id"]) {
			const output = formatGenericResponse([{ [key]: deepArray }]);
			expect(output).toContain("[depth-limit]");
		}
		expect(formatGenericResponse([{ title: "T" }, { id: 7 }, {}])).toBe("\n### T\n\n### 7\n\n### Item 3");
	});

	it("keeps own __proto__ keys from a parsed payload when serializing values", () => {
		const payload = JSON.parse('[{"meta":{"__proto__":{"x":1},"y":2}},{"__proto__":5}]');
		expect(formatGenericResponse(payload)).toBe(
			'\n### Item 1\n- **meta:** {"__proto__":{"x":1},"y":2}\n\n### Item 2\n- **__proto__:** 5',
		);
	});

	it("leaves payloads within the limit formatted exactly as before", () => {
		expect(formatGenericResponse({ a: 1, b: "x" })).toBe("- **a:** 1\n- **b:** x");
		expect(formatGenericResponse([1, 2, 3])).toBe("- 1\n- 2\n- 3");
		expect(formatGenericResponse({ content: [{ type: "text", text: "hi" }] })).toBe("hi");
		expect(formatGenericResponse({ nested: { deep: { v: 1 } } })).toBe(
			"- **nested:**\n  - **deep:**\n    - **v:** 1",
		);
		// A payload exactly at the limit still renders its leaf.
		expect(formatGenericResponse(nest(63))).toContain("leaf");
		expect(formatGenericResponse(nest(63))).not.toContain("[depth-limit]");
	});
});
