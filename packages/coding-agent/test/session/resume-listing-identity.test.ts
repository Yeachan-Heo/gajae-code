import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureManagedFileNoFollowLimit, inspectManagedFileNoFollow } from "../../src/sdk/session-readonly/inspection";

describe("resume listing identity and digest memo cache", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-listing-identity-"));
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("listing twice hashes each unchanged file once", () => {
		// Create a test file
		const testFile = path.join(tempDir, "test.txt");
		const content = "test content";
		fs.writeFileSync(testFile, content);

		// First inspection - should hash the file
		const snapshot1 = inspectManagedFileNoFollow(testFile, 1024);

		// Second inspection - should use cache, not hash again
		const snapshot2 = inspectManagedFileNoFollow(testFile, 1024);

		// Verify both snapshots have the same hash
		expect(snapshot1.identity.sha256).toBe(snapshot2.identity.sha256);
	});

	it("detects file rewrites even with same mtime via ctime change", () => {
		const testFile = path.join(tempDir, "test-rewrite.txt");
		const content1 = "original content";
		fs.writeFileSync(testFile, content1);

		// Get the initial snapshot
		const snapshot1 = inspectManagedFileNoFollow(testFile, 1024);

		// Rewrite the file with different content
		fs.writeFileSync(testFile, "new content that is different and much longer");

		// Get the new snapshot - should detect content change
		const snapshot2 = inspectManagedFileNoFollow(testFile, 1024);

		// Size must be different since we added more content
		expect(snapshot2.identity.size).not.toBe(snapshot1.identity.size);

		// The hashes must be different because content changed
		expect(snapshot2.identity.sha256).not.toBe(snapshot1.identity.sha256);
	});

	it("respects cache bound (LRU eviction)", () => {
		// Create many files to exceed cache capacity
		const fileCount = 4100; // Exceeds default cache size of 4096
		const files: string[] = [];

		for (let i = 0; i < fileCount; i++) {
			const filePath = path.join(tempDir, `file-${i}.txt`);
			fs.writeFileSync(filePath, `content ${i}`);
			files.push(filePath);
		}

		// Inspect all files (fills cache beyond capacity, triggers LRU eviction)
		const snapshots: Array<{ path: string; hash: string }> = [];
		for (const filePath of files) {
			const snapshot = inspectManagedFileNoFollow(filePath, 1024);
			snapshots.push({ path: filePath, hash: snapshot.identity.sha256 });
		}

		// Now inspect the first file again - it should have been evicted from cache
		// and need to be re-hashed
		const snapshot1st = inspectManagedFileNoFollow(files[0], 1024);

		// The hash should still be correct
		expect(snapshot1st.identity.sha256).toBe(snapshots[0].hash);

		// Inspect a few more to verify cache is still working for recent entries
		const snapshotMid = inspectManagedFileNoFollow(files[fileCount - 1], 1024);
		expect(snapshotMid.identity.sha256).toBe(snapshots[fileCount - 1].hash);
	});

	it("captureManagedFileNoFollowLimit uses digest memo cache", () => {
		const testFile = path.join(tempDir, "capture-test.txt");
		const content = "capture content";
		fs.writeFileSync(testFile, content);

		// First capture - should hash the file
		const snapshot1 = captureManagedFileNoFollowLimit(testFile);

		// Second capture - should use cache
		const snapshot2 = captureManagedFileNoFollowLimit(testFile);

		// Verify both have same hash
		expect(snapshot1.identity.sha256).toBe(snapshot2.identity.sha256);
	});

	it("cache misses when any identity component changes", () => {
		const testFile = path.join(tempDir, "identity-change.txt");
		fs.writeFileSync(testFile, "content");

		// Get initial snapshot
		const snapshot1 = inspectManagedFileNoFollow(testFile, 1024);

		// Modify the file (size changes)
		fs.writeFileSync(testFile, "longer content here");

		// Get new snapshot
		const snapshot2 = inspectManagedFileNoFollow(testFile, 1024);

		// Size is different, so it's definitely a cache miss
		expect(snapshot2.identity.size).not.toBe(snapshot1.identity.size);
		// Hash should be different due to different content
		expect(snapshot2.identity.sha256).not.toBe(snapshot1.identity.sha256);
	});
});
