import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@gajae-code/utils";

const BLOB_PREFIX = "blob:sha256:";

export interface BlobPutResult {
	hash: string;
	path: string;
	get ref(): string;
}

/**
 * Content-addressed blob store for externalizing large binary data (images) from session JSONL files.
 *
 * Files are stored at `<dir>/<sha256-hex>` with no extension. The SHA-256 hash is computed
 * over the raw binary data (not base64). Content-addressing makes writes idempotent and
 * provides automatic deduplication across sessions.
 */
export class BlobStore {
	constructor(readonly dir: string) {}

	/**
	 * Write binary data to the blob store.
	 * @returns SHA-256 hex hash of the data
	 */
	async put(data: Buffer): Promise<BlobPutResult> {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const result = {
			hash,
			path: blobPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};

		await Bun.write(blobPath, data);
		return result;
	}

	/**
	 * Synchronous variant of {@link put}. Use on persistence hot paths where the caller
	 * cannot afford the microtask hops of the async version (e.g. OOM-safe session writes).
	 * Returns once the bytes are in the kernel page cache.
	 */
	putSync(data: Buffer): BlobPutResult {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const result = {
			hash,
			path: blobPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};
		fs.mkdirSync(this.dir, { recursive: true });
		fs.writeFileSync(blobPath, data);
		return result;
	}

	/** Read blob by hash, returns Buffer or null if not found. */
	async get(hash: string): Promise<Buffer | null> {
		const blobPath = path.join(this.dir, hash);
		try {
			const file = Bun.file(blobPath);
			const ab = await file.arrayBuffer();
			return Buffer.from(ab);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Synchronously read blob by hash, returns Buffer or null if not found. */
	getSync(hash: string): Buffer | null {
		const blobPath = path.join(this.dir, hash);
		try {
			return fs.readFileSync(blobPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Check if a blob exists. */
	async has(hash: string): Promise<boolean> {
		try {
			await fsp.access(path.join(this.dir, hash));
			return true;
		} catch {
			return false;
		}
	}
}

export class MemoryBlobStore extends BlobStore {
	#blobs = new Map<string, Buffer>();

	constructor() {
		super(":memory:");
	}

	async put(data: Buffer): Promise<BlobPutResult> {
		return this.putSync(data);
	}

	putSync(data: Buffer): BlobPutResult {
		const hash = new Bun.SHA256().update(data).digest("hex");
		this.#blobs.set(hash, Buffer.from(data));
		return {
			hash,
			path: `memory:${hash}`,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};
	}

	async get(hash: string): Promise<Buffer | null> {
		return this.getSync(hash);
	}

	getSync(hash: string): Buffer | null {
		const data = this.#blobs.get(hash);
		return data ? Buffer.from(data) : null;
	}

	async has(hash: string): Promise<boolean> {
		return this.#blobs.has(hash);
	}
}

/** Check if a data string is a blob reference. */
export function isBlobRef(data: string): boolean {
	return data.startsWith(BLOB_PREFIX);
}

/** Extract the SHA-256 hash from a blob reference string. */
export function parseBlobRef(data: string): string | null {
	if (!data.startsWith(BLOB_PREFIX)) return null;
	return data.slice(BLOB_PREFIX.length);
}

/** Identify provider transport image data URLs so persistence can externalize and restore them losslessly. */
export function isImageDataUrl(data: string): boolean {
	return data.startsWith("data:image/") && data.includes(";base64,");
}

/**
 * Externalize a provider image data URL to the blob store, returning a blob reference.
 * The full data URL string is preserved so transport-native history can be reconstructed on resume.
 */
export async function externalizeImageDataUrl(blobStore: BlobStore, dataUrl: string): Promise<string> {
	if (isBlobRef(dataUrl)) return dataUrl;
	const { ref } = await blobStore.put(Buffer.from(dataUrl, "utf8"));
	return ref;
}

/** Synchronous variant of {@link externalizeImageDataUrl}. */
export function externalizeImageDataUrlSync(blobStore: BlobStore, dataUrl: string): string {
	if (isBlobRef(dataUrl)) return dataUrl;
	return blobStore.putSync(Buffer.from(dataUrl, "utf8")).ref;
}

/**
 * Externalize an image's base64 data to the blob store, returning a blob reference.
 * If the data is already a blob reference, returns it unchanged.
 */
export async function externalizeImageData(blobStore: BlobStore, base64Data: string): Promise<string> {
	if (isBlobRef(base64Data)) return base64Data;
	const buffer = Buffer.from(base64Data, "base64");
	const { ref } = await blobStore.put(buffer);
	return ref;
}

/** Synchronous variant of {@link externalizeImageData}. */
export function externalizeImageDataSync(blobStore: BlobStore, base64Data: string): string {
	if (isBlobRef(base64Data)) return base64Data;
	return blobStore.putSync(Buffer.from(base64Data, "base64")).ref;
}

/**
 * Resolve an externalized provider image data URL back to its original string.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, logs a warning and returns the reference as-is.
 */
export async function resolveImageDataUrl(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

/**
 * Resolve a blob reference back to base64 data.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, logs a warning and returns a placeholder.
 */
export async function resolveImageData(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data; // Return the ref as-is; downstream will see invalid base64 but won't crash
	}
	return buffer.toString("base64");
}

/** Synchronously resolve an externalized provider image data URL back to its original string. */
export function resolveImageDataUrlSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

/** Synchronously resolve a blob reference back to base64 data. */
export function resolveImageDataSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data;
	}
	return buffer.toString("base64");
}

/** Synchronously resolve a blob reference back to utf8 text. */
export function resolveTextBlobSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for text reference", { hash });
		return data;
	}
	return buffer.toString("utf8");
}
