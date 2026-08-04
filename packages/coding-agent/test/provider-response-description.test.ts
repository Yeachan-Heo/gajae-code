import { describe, expect, it } from "bun:test";
import { describeProviderResponse } from "../src/sdk/bus";

describe("describeProviderResponse", () => {
	it("passes strings through unchanged", () => {
		expect(describeProviderResponse("denied by policy")).toBe("denied by policy");
	});

	it("caps long strings at 500 chars plus an ellipsis", () => {
		const out = describeProviderResponse("x".repeat(1200));
		expect(out.length).toBe(501);
		expect(out.endsWith("…")).toBe(true);
	});

	it("JSON-serializes plain objects", () => {
		expect(describeProviderResponse({ outcome: "approved" })).toBe('{"outcome":"approved"}');
	});

	it("serializes null and primitives", () => {
		expect(describeProviderResponse(null)).toBe("null");
		expect(describeProviderResponse(42)).toBe("42");
	});

	it("returns a safe tag for undefined (JSON.stringify returns undefined)", () => {
		const out = describeProviderResponse(undefined);
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
	});

	it("never throws on a circular object", () => {
		const o: Record<string, unknown> = {};
		o.self = o;
		const out = describeProviderResponse(o);
		expect(typeof out).toBe("string");
		expect(out.length).toBeLessThanOrEqual(501);
	});

	it("never throws on a self-referential array", () => {
		const a: unknown[] = [];
		a.push(a);
		const out = describeProviderResponse(a);
		expect(typeof out).toBe("string");
		expect(out.length).toBeLessThanOrEqual(501);
	});

	it("never throws on an object with a throwing getter", () => {
		const o = Object.defineProperty({ ok: 1 }, "x", {
			get() {
				throw new Error("boom");
			},
			enumerable: true,
		});
		const out = describeProviderResponse(o);
		expect(typeof out).toBe("string");
		expect(out.length).toBeLessThanOrEqual(501);
	});
});
