import { describe, expect, it } from "bun:test";
import { describeProviderResponse } from "../src/sdk/bus";

describe("describeProviderResponse", () => {
	it("describes a string by kind and length, never its content", () => {
		expect(describeProviderResponse("denied by policy")).toBe("string (length 16)");
	});

	it("describes null, undefined, and primitives by kind", () => {
		expect(describeProviderResponse(null)).toBe("null");
		expect(describeProviderResponse(undefined)).toBe("undefined");
		expect(describeProviderResponse(42)).toBe("number");
		expect(describeProviderResponse(true)).toBe("boolean");
	});

	it("describes an object by its key names, not its values", () => {
		expect(describeProviderResponse({ outcome: "approved" })).toBe("object (keys: outcome)");
	});

	it("describes an array by its length", () => {
		expect(describeProviderResponse([1, 2, 3])).toBe("array (length 3)");
	});

	it("caps the reported key list at twenty entries", () => {
		const value: Record<string, unknown> = {};
		for (let i = 0; i < 25; i++) value[`k${i}`] = i;
		expect(describeProviderResponse(value)).toBe("object (keys: k0, k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12, k13, k14, k15, k16, k17, k18, k19, +5 more)");
	});

	it("never leaks secret values from an invalid provider response", () => {
		// The descriptor is content-free: only the key name survives, so a payload
		// carrying a credential cannot cross the error boundary into transcripts.
		const secret = "ghp_abcdef0123456789abcdef0123";
		const out = describeProviderResponse({ token: secret });
		expect(out).toContain("token");
		expect(out).not.toContain(secret);
	});

	it("never throws on a circular object", () => {
		const o: Record<string, unknown> = {};
		o.self = o;
		expect(describeProviderResponse(o)).toBe("object (keys: self)");
	});

	it("never throws on a self-referential array", () => {
		const a: unknown[] = [];
		a.push(a);
		expect(describeProviderResponse(a)).toBe("array (length 1)");
	});

	it("never throws on an object with a throwing getter", () => {
		const o = Object.defineProperty({ ok: 1 }, "x", {
			get() {
				throw new Error("boom");
			},
			enumerable: true,
		});
		expect(describeProviderResponse(o)).toBe("object (keys: ok, x)");
	});

	it("never throws when Symbol.toStringTag getter throws", () => {
		// The old implementation called Object.prototype.toString after a
		// serialization failure and escaped here; the descriptor must be total.
		const o = { get [Symbol.toStringTag]() {
			throw new Error("tag boom");
		} };
		const out = describeProviderResponse(o);
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
	});

	it("never throws on a revoked Proxy", () => {
		const { proxy, revoke } = Proxy.revocable<{ a: number }>({ a: 1 }, {});
		revoke();
		const out = describeProviderResponse(proxy);
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
	});

	it("never throws on a Proxy whose ownKeys trap throws", () => {
		const p = new Proxy({}, { ownKeys() {
			throw new Error("ownKeys boom");
		} });
		const out = describeProviderResponse(p);
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
	});
});
