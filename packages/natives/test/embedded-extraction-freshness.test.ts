import { describe, expect, it } from "bun:test";

import { cachedEmbeddedExtractionIsFresh } from "../native/loader-state.js";

const sizes = (map: Record<string, number | null>) => (p: string) => (p in map ? map[p] : null);
const hashes = (map: Record<string, string | null>) => (p: string) => (p in map ? map[p] : null);
const embeddedDigest = "a".repeat(64);

describe("cachedEmbeddedExtractionIsFresh", () => {
	it("reuses a cached extraction whose digest matches the embedded build record", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/pi_natives.node",
				embeddedPath: "/embedded/pi_natives.node",
				expectedDigest: embeddedDigest,
				sizeOf: sizes({ "/cache/pi_natives.node": 44_380_960, "/embedded/pi_natives.node": 44_380_960 }),
				digestOf: hashes({ "/cache/pi_natives.node": embeddedDigest }),
			}),
		).toBe(true);
	});

	it("re-extracts when a same-version cached extraction has drifted in size", () => {
		// An earlier 0.11.1 build cached 66 exports; the embedded payload now has 74.
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/pi_natives.node",
				embeddedPath: "/embedded/pi_natives.node",
				expectedDigest: embeddedDigest,
				sizeOf: sizes({ "/cache/pi_natives.node": 42_000_000, "/embedded/pi_natives.node": 44_380_960 }),
				digestOf: hashes({ "/cache/pi_natives.node": "b".repeat(64) }),
			}),
		).toBe(false);
	});

	it("re-extracts when a same-sized cache contains bytes from a different build", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/pi_natives.node",
				embeddedPath: "/embedded/pi_natives.node",
				expectedDigest: embeddedDigest,
				sizeOf: sizes({ "/cache/pi_natives.node": 44_380_960, "/embedded/pi_natives.node": 44_380_960 }),
				digestOf: hashes({ "/cache/pi_natives.node": "b".repeat(64) }),
			}),
		).toBe(false);
	});

	it("re-extracts when the cached file cannot be inspected", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/missing.node",
				embeddedPath: "/embedded/pi_natives.node",
				expectedDigest: embeddedDigest,
				sizeOf: sizes({ "/embedded/pi_natives.node": 44_380_960 }),
				digestOf: hashes({}),
			}),
		).toBe(false);
	});

	it("re-extracts when the embedded payload cannot be inspected", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/pi_natives.node",
				embeddedPath: "/embedded/missing.node",
				expectedDigest: embeddedDigest,
				sizeOf: sizes({ "/cache/pi_natives.node": 44_380_960 }),
				digestOf: hashes({}),
			}),
		).toBe(false);
	});

	it("re-extracts when the embedded digest is missing or malformed", () => {
		for (const expectedDigest of [null, "not-a-digest"]) {
			expect(
				cachedEmbeddedExtractionIsFresh({
					targetPath: "/cache/pi_natives.node",
					embeddedPath: "/embedded/pi_natives.node",
					expectedDigest,
					sizeOf: sizes({ "/cache/pi_natives.node": 44_380_960, "/embedded/pi_natives.node": 44_380_960 }),
					digestOf: hashes({ "/cache/pi_natives.node": embeddedDigest }),
				}),
			).toBe(false);
		}
	});
});
