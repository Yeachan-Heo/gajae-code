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

export class EphemeralBlobStore extends BlobStore {
	/**
	 * Bounded LRU byte budget for the in-memory buffer cache. Keeps recent
	 * resident blobs hot for rematerialization after the weak materialized
	 * view is collected, without re-pinning the whole session in RAM.
	 */
	static readonly #BUFFER_CACHE_MAX_BYTES = 8 * 1024 * 1024;

	#bufferCache = new Map<string, Buffer>();
	#bufferCacheBytes = 0;

	constructor(dir: string) {
		super(dir);
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
	}

	#cachePut(hash: string, data: Buffer): void {
		const existing = this.#bufferCache.get(hash);
		if (existing) {
			this.#bufferCache.delete(hash);
			this.#bufferCacheBytes -= existing.byteLength;
		}
		if (data.byteLength > EphemeralBlobStore.#BUFFER_CACHE_MAX_BYTES) return;
		this.#bufferCache.set(hash, data);
		this.#bufferCacheBytes += data.byteLength;
		for (const [oldHash, oldData] of this.#bufferCache) {
			if (this.#bufferCacheBytes <= EphemeralBlobStore.#BUFFER_CACHE_MAX_BYTES) break;
			this.#bufferCache.delete(oldHash);
			this.#bufferCacheBytes -= oldData.byteLength;
		}
	}

	putSync(data: Buffer): BlobPutResult {
		const result = super.putSync(data);
		this.#cachePut(result.hash, Buffer.from(data));
		return result;
	}

	getSync(hash: string): Buffer | null {
		const cached = this.#bufferCache.get(hash);
		if (cached) {
			const blobPath = path.join(this.dir, hash);
			if (fs.existsSync(blobPath)) {
				// Refresh LRU recency on hit.
				this.#bufferCache.delete(hash);
				this.#bufferCache.set(hash, cached);
				return Buffer.from(cached);
			}
			this.#bufferCache.delete(hash);
			this.#bufferCacheBytes -= cached.byteLength;
		}
		const data = super.getSync(hash);
		if (data) this.#cachePut(hash, Buffer.from(data));
		return data;
	}

	clear(): void {
		this.#bufferCache.clear();
		this.#bufferCacheBytes = 0;
		fs.rmSync(this.dir, { recursive: true, force: true });
		fs.mkdirSync(this.dir, { recursive: true });
	}

	dispose(): void {
		this.#bufferCache.clear();
		this.#bufferCacheBytes = 0;
		fs.rmSync(this.dir, { recursive: true, force: true });
	}
}

export class MemoryBlobStore extends BlobStore {
	/**
	 * Generous byte/count LRU bound (F8). Content-addressed resident blobs are fail-closed
	 * on miss (callers raise/handle {@link ResidentBlobMissingError}), so evicting the
	 * least-recently-used entry on an extremely large session is preferable to unbounded
	 * RAM growth. The caps sit well above normal usage and only trip on pathological sizes.
	 */
	static readonly #MAX_BYTES = 64 * 1024 * 1024;
	static readonly #MAX_COUNT = 4096;

	#blobs = new Map<string, Buffer>();
	#bytes = 0;

	constructor() {
		super(":memory:");
	}

	#store(hash: string, data: Buffer): void {
		const existing = this.#blobs.get(hash);
		if (existing) {
			this.#blobs.delete(hash);
			this.#bytes -= existing.byteLength;
		}
		this.#blobs.set(hash, data);
		this.#bytes += data.byteLength;
		while (
			(this.#bytes > MemoryBlobStore.#MAX_BYTES || this.#blobs.size > MemoryBlobStore.#MAX_COUNT) &&
			this.#blobs.size > 1
		) {
			const oldest = this.#blobs.keys().next().value;
			if (oldest === undefined) break;
			const evicted = this.#blobs.get(oldest);
			this.#blobs.delete(oldest);
			if (evicted) this.#bytes -= evicted.byteLength;
		}
	}

	async put(data: Buffer): Promise<BlobPutResult> {
		return this.putSync(data);
	}

	putSync(data: Buffer): BlobPutResult {
		const hash = new Bun.SHA256().update(data).digest("hex");
		this.#store(hash, Buffer.from(data));
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
		if (!data) return null;
		// Refresh LRU recency on hit so hot blobs survive eviction.
		this.#blobs.delete(hash);
		this.#blobs.set(hash, data);
		return Buffer.from(data);
	}

	async has(hash: string): Promise<boolean> {
		return this.#blobs.has(hash);
	}
}

export class ResidentBlobMissingError extends Error {
	constructor(
		readonly hash: string,
		readonly kind: "text" | "imageUrl" | "imageData",
		readonly sessionId?: string,
		readonly sessionFile?: string,
	) {
		super(`Missing resident ${kind} blob: ${hash}`);
		this.name = "ResidentBlobMissingError";
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
 *
 * LEGACY PERSISTED-IMAGE COMPATIBILITY BOUNDARY: when the persisted blob is missing
 * (e.g. resuming an old session whose image blob was pruned), this warns and returns
 * the reference as-is rather than throwing, so legacy resume degrades gracefully.
 * New resident byte-sensitive TEXT uses the fail-closed path instead
 * (`resolveTextBlobSync` -> `ResidentBlobMissingError`). Do NOT route new byte-sensitive
 * resident data through this warn-and-return path.
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
 *
 * LEGACY PERSISTED-IMAGE COMPATIBILITY BOUNDARY: when the blob is missing this warns
 * and returns the reference as-is (downstream sees an invalid base64 ref but does not
 * crash), preserving legacy-session resume. Byte-sensitive resident TEXT is fail-closed
 * via `resolveTextBlobSync`; do NOT route new byte-sensitive resident data here.
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

/**
 * Synchronously resolve a blob reference back to utf8 text.
 *
 * FAIL-CLOSED byte-sensitive path: a missing resident blob throws
 * `ResidentBlobMissingError` rather than degrading, so a missing resident text blob can
 * never silently leak a `blob:sha256:` ref into provider payloads, UI, or exports.
 * (Contrast the legacy persisted-image warn-and-return resolvers above.)
 */
export function resolveTextBlobSync(
	blobStore: BlobStore,
	data: string,
	context?: { kind?: "text"; sessionId?: string; sessionFile?: string },
): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		throw new ResidentBlobMissingError(hash, context?.kind ?? "text", context?.sessionId, context?.sessionFile);
	}
	return buffer.toString("utf8");
}

/**
 * FAIL-CLOSED resident variant of {@link resolveImageDataUrlSync}: a missing resident
 * image-data-url blob throws `ResidentBlobMissingError` ("imageUrl") instead of warn-returning,
 * so resident byte-sensitive provider image data can never leak a `blob:sha256:` ref into
 * materialized entries, context, or provider payloads. The warn-and-return `resolveImageDataUrl*`
 * resolvers remain ONLY for legacy persisted-image resume.
 */
export function resolveResidentImageDataUrlSync(
	blobStore: BlobStore,
	data: string,
	context?: { sessionId?: string; sessionFile?: string },
): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		throw new ResidentBlobMissingError(hash, "imageUrl", context?.sessionId, context?.sessionFile);
	}
	return buffer.toString("utf8");
}

/**
 * FAIL-CLOSED resident variant of {@link resolveImageDataSync}: a missing resident image blob
 * throws `ResidentBlobMissingError` ("imageData") instead of warn-returning a placeholder.
 */
export function resolveResidentImageDataSync(
	blobStore: BlobStore,
	data: string,
	context?: { sessionId?: string; sessionFile?: string },
): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		throw new ResidentBlobMissingError(hash, "imageData", context?.sessionId, context?.sessionFile);
	}
	return buffer.toString("base64");
}
