import { describe, expect, it } from "bun:test";
import { MemoryBlobStore } from "@gajae-code/coding-agent/session/blob-store";

describe("MemoryBlobStore byte/count LRU bound (W5 / F8)", () => {
	it("evicts the least-recently-used blob beyond the count cap instead of growing unbounded", () => {
		const store = new MemoryBlobStore();
		const COUNT_CAP = 4096;
		const hashes: string[] = [];
		for (let i = 0; i < COUNT_CAP + 8; i++) {
			hashes.push(store.putSync(Buffer.from(`blob-${i}`)).hash);
		}
		// Oldest insertions are evicted; the most recent survive.
		expect(store.getSync(hashes[0]!)).toBeNull();
		expect(store.getSync(hashes[7]!)).toBeNull();
		expect(store.getSync(hashes[hashes.length - 1]!)).not.toBeNull();
	});

	it("refreshes recency on get so a hot blob survives eviction", () => {
		const store = new MemoryBlobStore();
		const COUNT_CAP = 4096;
		const first = store.putSync(Buffer.from("hot-blob")).hash;
		const second = store.putSync(Buffer.from("cold-blob")).hash;
		for (let i = 0; i < COUNT_CAP - 2; i++) store.putSync(Buffer.from(`filler-${i}`));
		// Touch `first` to move it to the most-recent position.
		expect(store.getSync(first)).not.toBeNull();
		// One more put evicts the now-oldest (`second`), not the refreshed `first`.
		store.putSync(Buffer.from("trigger-eviction"));
		expect(store.getSync(first)).not.toBeNull();
		expect(store.getSync(second)).toBeNull();
	});

	it("round-trips content-addressed blobs under the cap", () => {
		const store = new MemoryBlobStore();
		const data = Buffer.from("hello blob");
		const { hash, ref } = store.putSync(data);
		expect(ref).toBe(`blob:sha256:${hash}`);
		expect(store.getSync(hash)?.toString()).toBe("hello blob");
	});
});
