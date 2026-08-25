import { describe, expect, it } from "bun:test";

import { cachedEmbeddedExtractionIsFresh } from "../native/loader-state.js";

const sizes = (map: Record<string, number | null>) => (p: string) => (p in map ? map[p] : null);
const hashes = (map: Record<string, string | null>) => (p: string) => (p in map ? map[p] : null);

describe("cachedEmbeddedExtractionIsFresh", () => {
	it("reuses a cached extraction whose size matches the embedded payload", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/pi_natives.node",
				embeddedPath: "/embedded/pi_natives.node",
				sizeOf: sizes({ "/cache/pi_natives.node": 44_380_960, "/embedded/pi_natives.node": 44_380_960 }),
			}),
		).toBe(true);
	});

	it("re-extracts when a same-version cached extraction has drifted in size", () => {
		// An earlier 0.11.1 build cached 66 exports; the embedded payload now has 74.
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/pi_natives.node",
				embeddedPath: "/embedded/pi_natives.node",
				sizeOf: sizes({ "/cache/pi_natives.node": 42_000_000, "/embedded/pi_natives.node": 44_380_960 }),
			}),
		).toBe(false);
	});

	it("re-extracts when a same-size cached extraction has different content", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/pi_natives.node",
				embeddedPath: "/embedded/pi_natives.node",
				hashOf: hashes({ "/cache/pi_natives.node": "stale", "/embedded/pi_natives.node": "current" }),
				sizeOf: sizes({ "/cache/pi_natives.node": 44_380_960, "/embedded/pi_natives.node": 44_380_960 }),
			}),
		).toBe(false);
	});

	it("re-extracts when the cached file cannot be inspected", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/missing.node",
				embeddedPath: "/embedded/pi_natives.node",
				sizeOf: sizes({ "/embedded/pi_natives.node": 44_380_960 }),
			}),
		).toBe(false);
	});

	it("re-extracts when the embedded payload cannot be inspected", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/pi_natives.node",
				embeddedPath: "/embedded/missing.node",
				sizeOf: sizes({ "/cache/pi_natives.node": 44_380_960 }),
			}),
		).toBe(false);
	});
});
