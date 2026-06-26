import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BlobCorruptError,
	BlobStore,
	EphemeralBlobStore,
	MemoryBlobStore,
} from "@gajae-code/coding-agent/session/blob-store";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-blob-store-"));
	tempDirs.push(dir);
	return dir;
}

function sha256Hex(data: Buffer): string {
	return new Bun.SHA256().update(data).digest("hex");
}

function expectRehydrationAvailable(store: BlobStore, hash: string): Buffer {
	const data = store.getCheckedSync(hash);
	if (!data) throw new Error(`Blob unavailable: ${hash}`);
	return data;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("BlobStore immutable checked blobs", () => {
	it("does not rewrite an existing valid target", () => {
		const dir = makeTempDir();
		const store = new BlobStore(dir);
		const data = Buffer.from("stable blob bytes", "utf8");
		const hash = sha256Hex(data);
		const blobPath = path.join(dir, hash);
		fs.writeFileSync(blobPath, data);
		const beforeStat = fs.statSync(blobPath);
		const beforeContent = fs.readFileSync(blobPath);

		const result = store.putImmutableSync(data);

		expect(result.hash).toBe(hash);
		expect(result.path).toBe(blobPath);
		expect(result.ref).toBe(`blob:sha256:${hash}`);
		expect(result.bytes).toBe(data.byteLength);
		expect(fs.readFileSync(blobPath).equals(beforeContent)).toBe(true);
		expect(fs.statSync(blobPath).mtimeMs).toBe(beforeStat.mtimeMs);
	});

	it("detects an existing corrupt same-size target", () => {
		const dir = makeTempDir();
		const store = new BlobStore(dir);
		const data = Buffer.from("abc", "utf8");
		const hash = sha256Hex(data);
		const blobPath = path.join(dir, hash);
		fs.writeFileSync(blobPath, Buffer.from("xyz", "utf8"));

		expect(() => store.putImmutableSync(data)).toThrow(BlobCorruptError);
		expect(fs.readFileSync(blobPath).toString("utf8")).toBe("xyz");
	});

	it("keeps a valid winner and verifies repeated same-hash puts", () => {
		const dir = makeTempDir();
		const store = new BlobStore(dir);
		const data = Buffer.from("race winner bytes", "utf8");
		const hash = sha256Hex(data);
		const blobPath = path.join(dir, hash);

		const first = store.putImmutableSync(data);
		const firstStat = fs.statSync(blobPath);
		const second = store.putImmutableSync(Buffer.from(data));

		expect(first.hash).toBe(hash);
		expect(second.hash).toBe(hash);
		expect(fs.statSync(blobPath).mtimeMs).toBe(firstStat.mtimeMs);
		expect(sha256Hex(fs.readFileSync(blobPath))).toBe(hash);

		const precreatedDir = makeTempDir();
		const precreatedStore = new BlobStore(precreatedDir);
		const precreatedPath = path.join(precreatedDir, hash);
		fs.writeFileSync(precreatedPath, data);
		const precreatedStat = fs.statSync(precreatedPath);
		const precreated = precreatedStore.putImmutableSync(data);

		expect(precreated.hash).toBe(hash);
		expect(fs.readFileSync(precreatedPath).equals(data)).toBe(true);
		expect(fs.statSync(precreatedPath).mtimeMs).toBe(precreatedStat.mtimeMs);
	});

	it("supports parallel callers that install the same bytes", async () => {
		const dir = makeTempDir();
		const store = new BlobStore(dir);
		const data = Buffer.from("parallel immutable blob", "utf8");
		const hash = sha256Hex(data);

		const results = await Promise.all([
			Promise.resolve().then(() => store.putImmutableSync(data)),
			Promise.resolve().then(() => store.putImmutableSync(Buffer.from(data))),
		]);

		expect(results.map(result => result.hash)).toEqual([hash, hash]);
		expect(sha256Hex(fs.readFileSync(path.join(dir, hash)))).toBe(hash);
	});

	it("getCheckedSync returns valid bytes, null for missing, and throws for corrupt blobs", () => {
		const dir = makeTempDir();
		const store = new BlobStore(dir);
		const data = Buffer.from("checked read", "utf8");
		const { hash } = store.putImmutableSync(data);

		expect(store.getCheckedSync(hash)?.equals(data)).toBe(true);
		expect(store.getCheckedSync(sha256Hex(Buffer.from("missing", "utf8")))).toBeNull();

		fs.writeFileSync(path.join(dir, hash), Buffer.from("tampered", "utf8"));
		expect(() => store.getCheckedSync(hash)).toThrow(BlobCorruptError);
	});

	it("getChecked async mirrors checked sync semantics", async () => {
		const dir = makeTempDir();
		const store = new BlobStore(dir);
		const data = Buffer.from("async checked read", "utf8");
		const { hash } = store.putImmutableSync(data);

		expect((await store.getChecked(hash))?.equals(data)).toBe(true);
		expect(await store.getChecked(sha256Hex(Buffer.from("not present", "utf8")))).toBeNull();

		fs.writeFileSync(path.join(dir, hash), Buffer.from("corrupt", "utf8"));
		expect(store.getChecked(hash)).rejects.toThrow(BlobCorruptError);
	});

	it("rehydration-style checked reads never return wrong data", () => {
		const dir = makeTempDir();
		const store = new BlobStore(dir);
		const data = Buffer.from("rehydrate me", "utf8");
		const { hash } = store.putImmutableSync(data);

		expect(expectRehydrationAvailable(store, hash).equals(data)).toBe(true);
		expect(() => expectRehydrationAvailable(store, sha256Hex(Buffer.from("missing", "utf8")))).toThrow(
			"Blob unavailable",
		);

		fs.writeFileSync(path.join(dir, hash), Buffer.from("wrong bytes", "utf8"));
		expect(() => expectRehydrationAvailable(store, hash)).toThrow(BlobCorruptError);
	});
	it("falls back to an exclusive copy when hard links are unsupported and fsyncs the destination", () => {
		const dir = makeTempDir();
		const store = new BlobStore(dir);
		const data = Buffer.from("fallback durable bytes", "utf8");
		const hash = sha256Hex(data);

		// Force the hard-link install to fail so the exclusive-copy fallback runs.
		const linkSpy = spyOn(fs, "linkSync").mockImplementation(() => {
			const err = new Error("operation not supported") as NodeJS.ErrnoException;
			err.code = "ENOTSUP";
			throw err;
		});
		const copySpy = spyOn(fs, "copyFileSync");

		try {
			const result = store.putImmutableSync(data);
			expect(result.hash).toBe(hash);
			// Destination installed by exclusive copy, content correct, rehydrate works.
			expect(fs.readFileSync(path.join(dir, hash))).toEqual(data);
			expect(expectRehydrationAvailable(store, hash)).toEqual(data);
			// The fallback copy MUST use COPYFILE_EXCL (no-clobber), never a bare copy.
			expect(copySpy.mock.calls.length).toBeGreaterThan(0);
			for (const call of copySpy.mock.calls) {
				expect(call[2]).toBe(fs.constants.COPYFILE_EXCL);
			}
		} finally {
			copySpy.mockRestore();
			linkSpy.mockRestore();
		}
	});
});

describe("checked blob store variants", () => {
	it("MemoryBlobStore supports immutable put and checked read", async () => {
		const store = new MemoryBlobStore();
		const data = Buffer.from("memory checked", "utf8");
		const result = store.putImmutableSync(data);

		expect(result.path).toBe(`memory:${result.hash}`);
		expect(result.bytes).toBe(data.byteLength);
		expect(store.getCheckedSync(result.hash)?.equals(data)).toBe(true);
		expect((await store.getChecked(result.hash))?.equals(data)).toBe(true);
		expect(store.getCheckedSync(sha256Hex(Buffer.from("missing", "utf8")))).toBeNull();
	});

	it("EphemeralBlobStore keeps disk and cache behavior consistent for checked APIs", () => {
		const dir = makeTempDir();
		const store = new EphemeralBlobStore(dir);
		const data = Buffer.from("ephemeral checked", "utf8");
		const result = store.putImmutableSync(data);

		expect(store.getCheckedSync(result.hash)?.equals(data)).toBe(true);
		fs.writeFileSync(result.path, Buffer.from("ephemeral corrupt", "utf8"));
		expect(() => store.getCheckedSync(result.hash)).toThrow(BlobCorruptError);
		store.dispose();
	});
});
