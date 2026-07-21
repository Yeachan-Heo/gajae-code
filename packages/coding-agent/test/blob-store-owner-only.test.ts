import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore, EphemeralBlobStore } from "../src/session/blob-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

// A permissive umask (group/other writable) is the default in many container and
// shared-workstation setups. Blob stores can live inside a managed session scope,
// whose owner-only tree snapshot fails closed on any group/other-readable
// descendant. The writes must therefore force owner-only permissions regardless
// of the inherited umask.
describe.skipIf(process.platform === "win32")("blob store owner-only permissions", () => {
	it("creates the resident-cache directory tree and blobs owner-only under a permissive umask", () => {
		const previousUmask = process.umask(0o002);
		try {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-blob-mode-resident-"));
			temporaryDirectories.push(root);
			const cacheDir = path.join(root, "stem", "resident-cache", "inst-1");
			const store = new EphemeralBlobStore(cacheDir);
			const { path: blobPath } = store.putSync(Buffer.from("resident blob"));

			expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700);
			expect(fs.statSync(path.join(root, "stem", "resident-cache")).mode & 0o777).toBe(0o700);
			expect(fs.statSync(blobPath).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});

	it("creates base BlobStore putSync blobs owner-only under a permissive umask", () => {
		const previousUmask = process.umask(0o002);
		try {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-blob-mode-base-"));
			temporaryDirectories.push(root);
			const store = new BlobStore(path.join(root, "blobs"));
			const { path: blobPath } = store.putSync(Buffer.from("base blob"));

			expect(fs.statSync(path.join(root, "blobs")).mode & 0o777).toBe(0o700);
			expect(fs.statSync(blobPath).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});

	it("installs immutable blobs owner-only under a permissive umask", () => {
		const previousUmask = process.umask(0o002);
		try {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-blob-mode-immutable-"));
			temporaryDirectories.push(root);
			const store = new BlobStore(path.join(root, "blobs"));
			const { path: blobPath } = store.putImmutableSync(Buffer.from("immutable blob"));

			expect(fs.statSync(path.join(root, "blobs")).mode & 0o777).toBe(0o700);
			expect(fs.statSync(blobPath).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});
});
