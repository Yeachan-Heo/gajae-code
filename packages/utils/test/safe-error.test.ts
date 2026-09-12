import { describe, expect, it } from "bun:test";
import { safeErrorDescription } from "@gajae-code/utils";

/** A same-realm `Error` whose `message` getter refuses to answer. */
function errorRefusingMessage(): Error {
	const error = new Error("this message is never readable");
	Object.defineProperty(error, "message", {
		configurable: true,
		get(): never {
			throw new Error("message getter always throws");
		},
	});
	return error;
}

describe("safeErrorDescription", () => {
	it("reads a plain Error message", () => {
		expect(safeErrorDescription(new Error("plain failure"))).toBe("plain failure");
		expect(safeErrorDescription(new TypeError("typed failure"))).toBe("typed failure");
	});

	it("describes non-Error throwables without throwing", () => {
		expect(safeErrorDescription("string throw")).toBe("string throw");
		expect(safeErrorDescription(42)).toBe("42");
		expect(safeErrorDescription(null)).toBe("null");
		expect(safeErrorDescription(undefined)).toBe("undefined");
	});

	it("survives a hostile message getter", () => {
		expect(safeErrorDescription(errorRefusingMessage())).toBe("<unprintable error>");
	});

	it("survives a hostile toString", () => {
		const hostile = {
			toString(): never {
				throw new Error("toString always throws");
			},
		};
		expect(safeErrorDescription(hostile)).toBe("<unprintable error>");
		expect(safeErrorDescription({ toString: () => ({}) })).toBe("<unprintable error>");
	});

	it("survives a hostile instanceof", () => {
		const hostile = new Proxy(() => {}, {
			getPrototypeOf(): never {
				throw new Error("getPrototypeOf always throws");
			},
			get(): never {
				throw new Error("get always throws");
			},
		});
		expect(() => safeErrorDescription(hostile)).not.toThrow();
		expect(safeErrorDescription(hostile)).toBe("<unprintable error>");
	});
});
