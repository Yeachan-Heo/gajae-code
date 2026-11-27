import { describe, expect, it } from "bun:test";
import { isEnoent } from "../../src/harness-control-plane/receipt-spool";
import { mulberry32 } from "../helpers/seeded-random";

const CODES = ["ENOENT", "EACCES", "ELOOP", "EPERM", "EISDIR", "ENOTDIR", "EBUSY", "EINVAL", "EEXIST", "ENOTEMPTY"];

describe("receipt spool missing-file classification", () => {
	it("matches ENOENT and only ENOENT across 64 seeded errors", () => {
		const next = mulberry32(514);
		const samples = Array.from({ length: 64 }, () => {
			const code = CODES[Math.floor(next() * CODES.length)] ?? "EINVAL";
			return Object.assign(new Error(code), { code });
		});
		for (const error of samples) {
			const reference = error.code === "ENOENT";
			expect(isEnoent(error)).toBe(reference);
			expect(isEnoent(error)).toBe(isEnoent(error));
		}
		expect(samples.some(error => error.code === "ENOENT")).toBe(true);
		expect(samples.some(error => error.code !== "ENOENT")).toBe(true);
	});
});
