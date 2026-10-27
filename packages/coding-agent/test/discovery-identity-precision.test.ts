import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { capturePathIdentity } from "../src/capability/fs";
import { readContainedFile } from "../src/discovery/helpers";

describe("File identity exact bigint precision", () => {
	it("captures exact large file IDs that exceed 2^53", async () => {
		// Use the actual filesystem to verify exact ID capture.
		// Create a temporary directory and stat it with bigint: true.
		const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-id-precision-"));
		try {
			const stat = await fs.promises.stat(tempDir, { bigint: true });
			const captured = await capturePathIdentity(tempDir);
			expect(captured).not.toBeNull();
			expect(captured!.dev).toBe(stat.dev);
			expect(captured!.ino).toBe(stat.ino);
			// Verify that the captured identity is bigint, not Number
			expect(typeof captured!.dev).toBe("bigint");
			expect(typeof captured!.ino).toBe("bigint");
		} finally {
			await fs.promises.rm(tempDir, { force: true, recursive: true });
		}
	});

	it("rejects mismatched identities when comparing contained files", async () => {
		// Create two temp directories and verify that mismatched identities are rejected.
		const tempDir1 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-id-precision-1-"));
		const tempDir2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-id-precision-2-"));
		try {
			// Capture the true identity of tempDir1
			const identity1 = await capturePathIdentity(tempDir1);
			expect(identity1).not.toBeNull();

			// Create a test file in tempDir2
			const testFile = path.join(tempDir2, "test.txt");
			await Bun.write(testFile, "test content");

			// readContainedFile should reject a file when given the wrong directory's identity
			const resultWrongIdentity = await readContainedFile(tempDir2, testFile, identity1);
			expect(resultWrongIdentity).toBeNull();

			// Capture the true identity of tempDir2 and verify it matches
			const identity2 = await capturePathIdentity(tempDir2);
			expect(identity2).not.toBeNull();
			const resultCorrectIdentity = await readContainedFile(tempDir2, testFile, identity2);
			expect(resultCorrectIdentity).toBe("test content");

			// Verify that the identities are different (at least in inode)
			expect(identity1!.ino).not.toBe(identity2!.ino);
		} finally {
			await fs.promises.rm(tempDir1, { force: true, recursive: true });
			await fs.promises.rm(tempDir2, { force: true, recursive: true });
		}
	});

	it("rejects an expected identity that differs from the root by a single inode", async () => {
		// readContainedFile must compare bigint identities exactly: an off-by-one inode is a
		// different directory even where a double would round both to the same value.
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-id-precision-"));
		try {
			const file = path.join(root, "SYSTEM.md");
			await Bun.write(file, "authorized");
			const identity = await capturePathIdentity(root);
			expect(identity).not.toBeNull();

			expect(await readContainedFile(root, file, identity)).toBe("authorized");
			expect(await readContainedFile(root, file, { dev: identity!.dev, ino: identity!.ino + 1n })).toBeNull();
		} finally {
			await fs.promises.rm(root, { force: true, recursive: true });
		}
	});
});
