import { describe, expect, it } from "bun:test";
import { isEnoent } from "../../src/harness-control-plane/receipt-spool";

const CODES = ["ENOENT", "EACCES", "ELOOP", "EPERM", "EISDIR", "ENOTDIR", "EBUSY", "EINVAL", "EEXIST", "ENOTEMPTY"];

/** Fixed-seed generator. seed 514, 64 inputs. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

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
