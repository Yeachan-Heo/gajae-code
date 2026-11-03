import * as crypto from "node:crypto";
import type { RunSettlementProof } from "@gajae-code/agent-core";
import type { ImageContent } from "@gajae-code/ai/core";
import { logger, parseImageMetadata } from "@gajae-code/utils";
import {
	MAX_IMAGE_INPUT_BYTES,
	MAX_PASTED_IMAGE_DIMENSION,
	MAX_PASTED_IMAGE_PIXELS,
	MAX_PASTED_IMAGE_SOURCE_BYTES,
	MAX_STAGED_PROMPT_IMAGES,
} from "../../utils/image-limits";
import { resizeImageBuffer } from "../../utils/image-resize";
import { isAnimatedImage } from "../../utils/pasted-image-loading";
import { TypedControlError } from "./control/dispatch";

const MAX_CHUNK_BYTES = 96 * 1024;
const MIN_RETAINED_BUFFER_BYTES = 4 * 1024;
const MAX_ACCEPTED_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_BYTES = 256 * 1024 * 1024;
// Each session gets one decoder slot; byte reservations remain process-wide.
const MAX_CONCURRENT_FINISHES = 1;
const LEASE_MS = 120_000;

/** One definitive event-driven wait; teardown and elapsed time are not settlement proof. */
export function retirePromptImageReservation(
	handle: string,
	waitForRunSettlement: (handle: string) => Promise<RunSettlementProof>,
	isCurrent: () => boolean,
	release: () => void,
): void {
	if (!isCurrent()) return;
	void (async (): Promise<void> => {
		try {
			const proof = await waitForRunSettlement(handle);
			if (!isCurrent()) return;
			if (proof.status === "settled") {
				release();
				return;
			}
			logger.warn("SDK image settlement observer returned unfenced proof; capacity retained", {
				handle,
				reason: proof.reason,
				contractViolation: proof.reason === "run_not_sealed" || proof.reason === "resources_pending",
			});
		} catch (error) {
			if (isCurrent())
				logger.warn("SDK image settlement observation failed; capacity retained without settlement proof", {
					handle,
					reason: "observation_failed",
					error,
				});
		}
	})();
}
const MAX_BATCH_ID_LENGTH = 128;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
let processBytes = 0;
let transientBytes = 0;
let concurrentFinishes = 0;

type SessionBudget = { uploadBytes: number; uploadCount: number; acceptedBytes: number; concurrentFinishes: number };
const sessionBudgets = new WeakMap<object, SessionBudget>();

function sessionBudget(session?: object): SessionBudget {
	if (!session) return { uploadBytes: 0, uploadCount: 0, acceptedBytes: 0, concurrentFinishes: 0 };
	let budget = sessionBudgets.get(session);
	if (!budget) {
		budget = { uploadBytes: 0, uploadCount: 0, acceptedBytes: 0, concurrentFinishes: 0 };
		sessionBudgets.set(session, budget);
	}
	return budget;
}

export interface PromptImageProcessBudgetSnapshot {
	/** Retained upload and accepted source bytes, including accepted base64 copies. */
	readonly sourceBytes: number;
	readonly transientBytes: number;
	readonly concurrentFinishes: number;
}

/** Internal process diagnostics only; not an SDK operation or a release capability. */
export function getPromptImageProcessBudgetSnapshot(): PromptImageProcessBudgetSnapshot {
	return Object.freeze({ sourceBytes: processBytes, transientBytes, concurrentFinishes });
}

type Upload = {
	owner: string;
	batchId?: string;
	mimeType: string;
	byteLength: number;
	/** Original selected bytes remain charged to accepted-session capacity after resizing. */
	sourceByteLength: number;
	sha256: string;
	chunks: Buffer[];
	reservedBytes: number;
	length: number;
	sequence: number;
	finishing: boolean;
	finished: boolean;
	expiresAt: number;
	timer: NodeJS.Timeout;
};

function invalid(message: string): never {
	throw new TypedControlError("invalid_input", message);
}
function busy(message: string): never {
	throw new TypedControlError("busy", message);
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Image input must be an object.");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some(key => !fields.includes(key))) invalid("Unknown image input field.");
	return input;
}
function ownerId(connectionId: string | undefined): string {
	if (!connectionId)
		throw new TypedControlError("operation_prohibited", "An authenticated SDK connection is required.");
	return connectionId;
}

/** Session-scoped, connection-owned image leases; no client-supplied path or identity is trusted. */
export class PromptImageUploadStore {
	readonly #uploads = new Map<string, Upload>();
	readonly #isConnectionOpen: (connectionId: string) => boolean;
	#closed = false;
	readonly #budget: SessionBudget;

	/** Pass the real AgentSession to share admission and decoder capacity across host surfaces. */
	constructor(isConnectionOpen: (connectionId: string) => boolean, session?: object) {
		this.#isConnectionOpen = isConnectionOpen;
		this.#budget = sessionBudget(session);
	}

	begin(connectionId: string | undefined, value: unknown): { id: string; nextSequence: 0 } {
		this.#assertOpen();
		const owner = ownerId(connectionId);
		this.#assertConnected(owner);
		const input = object(value, ["mimeType", "byteLength", "sha256", "batchId"]);
		if (
			typeof input.mimeType !== "string" ||
			!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(input.mimeType)
		)
			invalid("Unsupported image MIME type.");
		if (
			!Number.isSafeInteger(input.byteLength) ||
			(input.byteLength as number) <= 0 ||
			(input.byteLength as number) > MAX_IMAGE_INPUT_BYTES
		)
			invalid("Image byteLength exceeds the 20 MiB limit.");
		if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256))
			invalid("Invalid image SHA-256 digest.");
		if (
			Object.hasOwn(input, "batchId") &&
			(typeof input.batchId !== "string" || input.batchId.length === 0 || input.batchId.length > MAX_BATCH_ID_LENGTH)
		)
			invalid("Image batchId must be a nonempty string of at most 128 characters.");
		const now = Date.now();
		for (const [uploadId, upload] of this.#uploads) this.#expire(uploadId, upload, now);
		if (this.#budget.uploadCount >= MAX_STAGED_PROMPT_IMAGES) busy("Too many concurrent image uploads.");
		const id = crypto.randomUUID();
		const timer = setTimeout(() => this.#remove(id), LEASE_MS);
		timer.unref?.();
		const upload: Upload = {
			owner,
			...(typeof input.batchId === "string" ? { batchId: input.batchId } : {}),
			mimeType: input.mimeType,
			byteLength: input.byteLength as number,
			sourceByteLength: input.byteLength as number,
			sha256: input.sha256,
			chunks: [],
			reservedBytes: 0,
			length: 0,
			sequence: 0,
			finishing: false,
			finished: false,
			expiresAt: now + LEASE_MS,
			timer,
		};
		this.#uploads.set(id, upload);
		this.#budget.uploadCount++;
		this.#renewBatch(owner, id, upload);
		return { id, nextSequence: 0 };
	}

	append(
		connectionId: string | undefined,
		value: unknown,
	): { id: string; nextSequence: number; receivedBytes: number } {
		const input = object(value, ["id", "sequence", "data"]);
		this.#owned(connectionId, input.id);
		if (typeof input.data !== "string" || input.data.length > (MAX_CHUNK_BYTES * 4) / 3)
			invalid("Image chunk must be canonical base64 within the frame limit.");
		const reservation = input.data.length + Math.ceil(input.data.length / 4) * 3;
		if (processBytes + transientBytes + reservation > MAX_PROCESS_BYTES)
			busy("Image chunk decoding capacity exceeded.");
		transientBytes += reservation;
		try {
			return this.#append(connectionId, value);
		} finally {
			transientBytes -= reservation;
		}
	}

	#append(
		connectionId: string | undefined,
		value: unknown,
	): { id: string; nextSequence: number; receivedBytes: number } {
		const input = object(value, ["id", "sequence", "data"]);
		const upload = this.#owned(connectionId, input.id);
		if (upload.finishing || upload.finished) invalid("Image upload is already finishing or finished.");
		if (!Number.isSafeInteger(input.sequence) || input.sequence !== upload.sequence)
			invalid("Image chunk sequence is out of order.");
		if (
			typeof input.data !== "string" ||
			input.data.length === 0 ||
			input.data.length > (MAX_CHUNK_BYTES * 4) / 3 ||
			!CANONICAL_BASE64.test(input.data)
		)
			invalid("Image chunk must be canonical base64 within the frame limit.");
		const bytes = Buffer.from(input.data, "base64");
		if (bytes.length === 0 || bytes.length > MAX_CHUNK_BYTES || bytes.toString("base64") !== input.data)
			invalid("Image chunk must be canonical base64 within the frame limit.");
		if (upload.length + bytes.length > upload.byteLength) invalid("Image upload exceeds its declared size.");
		const nextLength = upload.length + bytes.length;
		const allocationLimit = Math.max(upload.byteLength, MIN_RETAINED_BUFFER_BYTES);
		const requiredBytes = Math.min(Math.ceil(nextLength / MAX_CHUNK_BYTES) * MAX_CHUNK_BYTES, allocationLimit);
		const addedBytes = requiredBytes - upload.reservedBytes;
		if (
			this.#budget.uploadBytes + addedBytes > MAX_PASTED_IMAGE_SOURCE_BYTES ||
			processBytes + transientBytes + addedBytes > MAX_PROCESS_BYTES
		)
			busy("Image staging capacity exceeded.");

		// Reserve coalesced fixed-size slabs before allocating or retaining them. Tiny declared
		// uploads reserve at least 4 KiB, avoiding one retained Buffer per admitted byte.
		this.#budget.uploadBytes += addedBytes;
		processBytes += addedBytes;
		const originalChunkCount = upload.chunks.length;
		try {
			const newChunks: Buffer[] = [];
			for (let allocated = upload.reservedBytes; allocated < requiredBytes; ) {
				const chunkBytes = Math.min(MAX_CHUNK_BYTES, requiredBytes - allocated);
				newChunks.push(Buffer.allocUnsafeSlow(chunkBytes));
				allocated += chunkBytes;
			}

			let sourceOffset = 0;
			let targetOffset = upload.length;
			while (sourceOffset < bytes.length) {
				const chunkIndex = Math.floor(targetOffset / MAX_CHUNK_BYTES);
				const chunk =
					chunkIndex < upload.chunks.length
						? upload.chunks[chunkIndex]!
						: newChunks[chunkIndex - upload.chunks.length]!;
				const chunkOffset = targetOffset % MAX_CHUNK_BYTES;
				const copied = Math.min(bytes.length - sourceOffset, chunk.length - chunkOffset);
				bytes.copy(chunk, chunkOffset, sourceOffset, sourceOffset + copied);
				sourceOffset += copied;
				targetOffset += copied;
			}

			if (newChunks.length > 0) upload.chunks.push(...newChunks);
			upload.reservedBytes = requiredBytes;
			upload.length = nextLength;
			upload.sequence++;
		} catch (error) {
			upload.chunks.length = originalChunkCount;
			this.#budget.uploadBytes -= addedBytes;
			processBytes -= addedBytes;
			throw error;
		}
		this.#renewBatch(upload.owner, input.id as string, upload);
		return { id: input.id as string, nextSequence: upload.sequence, receivedBytes: upload.length };
	}

	async finish(
		connectionId: string | undefined,
		value: unknown,
		options?: { autoResize: boolean },
	): Promise<{ id: string; byteLength: number; sha256: string; mimeType: string }> {
		const input = object(value, ["id"]);
		const upload = this.#owned(connectionId, input.id);
		if (upload.finishing || upload.finished) invalid("Image upload is already finishing or finished.");
		if (upload.length !== upload.byteLength) invalid("Image upload is incomplete.");
		// Claim the lease, decoder slot and copy capacity before the first allocation or await.
		if (
			this.#budget.concurrentFinishes >= MAX_CONCURRENT_FINISHES ||
			processBytes + transientBytes + upload.length > MAX_PROCESS_BYTES
		)
			busy("Image finalization capacity exceeded.");
		upload.finishing = true;
		this.#budget.concurrentFinishes++;
		concurrentFinishes++;
		transientBytes += upload.length;
		let transientReservation = upload.length;
		try {
			let bytes = Buffer.concat(upload.chunks, upload.length);
			if (crypto.createHash("sha256").update(bytes).digest("hex") !== upload.sha256)
				invalid("Image SHA-256 digest mismatch.");
			const metadata = parseImageMetadata(bytes);
			if (
				!metadata ||
				metadata.mimeType !== upload.mimeType ||
				!metadata.width ||
				!metadata.height ||
				metadata.width > MAX_PASTED_IMAGE_DIMENSION ||
				metadata.height > MAX_PASTED_IMAGE_DIMENSION ||
				metadata.width * metadata.height > MAX_PASTED_IMAGE_PIXELS
			)
				invalid("Image MIME type, structure or dimensions are invalid.");
			if (isAnimatedImage(bytes, metadata.mimeType) !== false)
				invalid("Animated or malformed images are not supported.");
			const decodedBytes = metadata.width * metadata.height * 4;
			if (processBytes + transientBytes + decodedBytes > MAX_PROCESS_BYTES)
				busy("Image decoding capacity exceeded.");
			transientBytes += decodedBytes;
			transientReservation += decodedBytes;
			try {
				const decoded = await new Bun.Image(bytes).metadata();
				if (decoded.width !== metadata.width || decoded.height !== metadata.height)
					invalid("Image dimensions do not match decoded data.");
				await new Bun.Image(bytes).resize(1, 1).png().bytes();
			} catch (error) {
				if (error instanceof TypedControlError) throw error;
				invalid("Image cannot be decoded.");
			}
			if (options?.autoResize) {
				// The canonical helper runs up to three native encoders concurrently and retains
				// candidates across its fallback ladder. Reserve their decoded rasters, bounded
				// encoded candidates and the retained output copy BEFORE invoking the helper.
				const targetPixels = Math.min(metadata.width * metadata.height, 1568 * 1568);
				const normalizationBytes = decodedBytes * 3 + 6 * (targetPixels * 5 + 64 * 1024) + MAX_IMAGE_INPUT_BYTES;
				if (processBytes + transientBytes + normalizationBytes > MAX_PROCESS_BYTES)
					busy("Image normalization capacity exceeded.");
				transientBytes += normalizationBytes;
				transientReservation += normalizationBytes;
				const resized = await resizeImageBuffer(bytes, upload.mimeType);
				if (resized.buffer.byteLength === 0 || resized.buffer.byteLength > MAX_IMAGE_INPUT_BYTES)
					invalid("Normalized image exceeds the 20 MiB limit.");
				const normalizedBytes = Buffer.from(resized.buffer);
				const normalizedMetadata = parseImageMetadata(normalizedBytes);
				if (
					!normalizedMetadata ||
					normalizedMetadata.mimeType !== resized.mimeType ||
					!normalizedMetadata.width ||
					!normalizedMetadata.height ||
					normalizedMetadata.width > MAX_PASTED_IMAGE_DIMENSION ||
					normalizedMetadata.height > MAX_PASTED_IMAGE_DIMENSION ||
					normalizedMetadata.width * normalizedMetadata.height > MAX_PASTED_IMAGE_PIXELS ||
					isAnimatedImage(normalizedBytes, resized.mimeType) !== false
				)
					invalid("Normalized image MIME type, structure or dimensions are invalid.");
				// The output is a native encoder result (or the already decoded source).
				bytes = normalizedBytes;
				upload.mimeType = resized.mimeType;
			}
			// A custom transport may attest liveness without delivering a close
			// callback. Decode completion must re-authorize, not renew a dead lease.
			if (!this.#isConnectionOpen(upload.owner)) {
				this.#remove(input.id as string);
				throw new TypedControlError("resource_gone", "Image upload connection is closed.");
			}
			// The transport can disconnect while decoding. A removed lease cannot be resurrected.
			if (this.#uploads.get(input.id as string) !== upload || this.#expire(input.id as string, upload))
				throw new TypedControlError("resource_gone", "Image upload expired.");
			const addedBytes = bytes.length - upload.reservedBytes;
			if (
				this.#budget.uploadBytes + addedBytes > MAX_PASTED_IMAGE_SOURCE_BYTES ||
				processBytes + transientBytes + Math.max(0, addedBytes) > MAX_PROCESS_BYTES
			)
				busy("Normalized image staging capacity exceeded.");
			this.#budget.uploadBytes += addedBytes;
			processBytes += addedBytes;
			upload.length = bytes.length;
			upload.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
			upload.chunks = [bytes];
			upload.reservedBytes = bytes.length;
			upload.finished = true;
			this.#renewBatch(upload.owner, input.id as string, upload);
			return { id: input.id as string, byteLength: upload.length, sha256: upload.sha256, mimeType: upload.mimeType };
		} finally {
			// A discarded lease still owns its source chunks until this async decode settles.
			if (this.#uploads.get(input.id as string) !== upload) {
				this.#budget.uploadBytes -= upload.reservedBytes;
				processBytes -= upload.reservedBytes;
			}
			transientBytes -= transientReservation;
			concurrentFinishes--;
			this.#budget.concurrentFinishes--;
			upload.finishing = false;
		}
	}

	/** Trusted in-process adapter: no paths, renderer identities, or unreserved full-source decode. */
	async prepareCanonicalImages(
		connectionId: string,
		images: readonly ImageContent[],
		options: { autoResize: boolean; signal?: AbortSignal },
	): Promise<{ images: ImageContent[]; release: () => void }> {
		this.#assertOpen();
		this.#assertConnected(ownerId(connectionId));
		options.signal?.throwIfAborted();
		if (!Array.isArray(images) || images.length === 0 || images.length > MAX_STAGED_PROMPT_IMAGES)
			invalid(`images must contain 1–${MAX_STAGED_PROMPT_IMAGES} images.`);
		// Copy only string references. The caller's original encoded payload remains
		// charged until every asynchronous decoder/normalizer has finished using it.
		let encodedBytes = 0;
		let sourceBytes = 0;
		const sources = images.map(image => {
			const input = object(image, ["type", "data", "mimeType"]);
			if (
				input.type !== "image" ||
				typeof input.data !== "string" ||
				!input.data.length ||
				input.data.length % 4 !== 0 ||
				input.data.length > Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4 ||
				typeof input.mimeType !== "string" ||
				!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(input.mimeType)
			)
				invalid("Expected canonical base64 image content with a supported MIME type.");
			const padding = input.data.endsWith("==") ? 2 : input.data.endsWith("=") ? 1 : 0;
			const byteLength = (input.data.length / 4) * 3 - padding;
			if (byteLength <= 0 || byteLength > MAX_IMAGE_INPUT_BYTES)
				invalid("Image byteLength exceeds the 20 MiB limit.");
			encodedBytes += input.data.length;
			sourceBytes += byteLength;
			return { data: input.data, mimeType: input.mimeType, byteLength };
		});
		if (
			sourceBytes > MAX_PASTED_IMAGE_SOURCE_BYTES ||
			this.#budget.acceptedBytes + sourceBytes > MAX_ACCEPTED_BYTES ||
			processBytes + transientBytes + encodedBytes + MAX_CHUNK_BYTES * 4 > MAX_PROCESS_BYTES
		)
			busy("Image input capacity exceeded.");
		const reservation = encodedBytes + MAX_CHUNK_BYTES * 4;
		transientBytes += reservation;
		const staged: Array<{ id: string }> = [];
		try {
			// Stage the complete batch synchronously before the first await. Chunks
			// align to base64 quanta; canonical padding bits are checked per chunk.
			for (const source of sources) {
				const hash = crypto.createHash("sha256");
				for (let offset = 0; offset < source.data.length; offset += (MAX_CHUNK_BYTES / 3) * 4) {
					const chunk = source.data.slice(offset, offset + (MAX_CHUNK_BYTES / 3) * 4);
					if (!CANONICAL_BASE64.test(chunk) || (offset + chunk.length < source.data.length && chunk.includes("=")))
						invalid("Image data must be canonical base64.");
					const decoded = Buffer.from(chunk, "base64");
					if (decoded.toString("base64") !== chunk) invalid("Image data must be canonical base64.");
					hash.update(decoded);
				}
				const descriptor = this.begin(connectionId, {
					mimeType: source.mimeType,
					byteLength: source.byteLength,
					sha256: hash.digest("hex"),
				});
				staged.push({ id: descriptor.id });
				let sequence = 0;
				for (let offset = 0; offset < source.data.length; offset += (MAX_CHUNK_BYTES / 3) * 4)
					this.append(connectionId, {
						id: descriptor.id,
						sequence: sequence++,
						data: source.data.slice(offset, offset + (MAX_CHUNK_BYTES / 3) * 4),
					});
			}
			for (const descriptor of staged) {
				options.signal?.throwIfAborted();
				await this.finish(connectionId, descriptor, { autoResize: options.autoResize });
			}
			options.signal?.throwIfAborted();
			return this.redeem(connectionId, staged);
		} finally {
			for (const { id } of staged) this.#remove(id);
			transientBytes -= reservation;
		}
	}

	discard(connectionId: string | undefined, value: unknown): { discarded: true } {
		const input = object(value, ["id"]);
		this.#owned(connectionId, input.id);
		this.#remove(input.id as string);
		return { discarded: true };
	}

	/** Synchronous reserve–validate–copy–consume transaction, called before prompt admission. */
	redeem(connectionId: string | undefined, value: unknown): { images: ImageContent[]; release: () => void } {
		this.#assertOpen();
		const owner = ownerId(connectionId);
		this.#assertConnected(owner);
		if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STAGED_PROMPT_IMAGES)
			invalid(`stagedImages must contain 1–${MAX_STAGED_PROMPT_IMAGES} image IDs.`);
		const seen = new Set<string>();
		const entries: Array<[string, Upload]> = [];
		let bytes = 0;
		let sourceBytes = 0;
		for (const descriptor of value) {
			const input = object(descriptor, ["id"]);
			const id = input.id;
			if (typeof id !== "string" || !id || seen.has(id))
				invalid("stagedImages contains an invalid or duplicate ID.");
			seen.add(id);
			const entry = this.#uploads.get(id);
			if (!entry || entry.owner !== owner || this.#expire(id, entry))
				throw new TypedControlError("image_upload_unavailable", "Image upload is unavailable or already consumed.");
			if (!entry.finished) invalid("Image upload is not finished.");
			bytes += entry.length;
			sourceBytes += entry.sourceByteLength;
			entries.push([id, entry]);
		}
		const encodedBytes = entries.reduce((total, [, entry]) => total + Math.ceil(entry.length / 3) * 4, 0);
		if (
			bytes > MAX_PASTED_IMAGE_SOURCE_BYTES ||
			this.#budget.acceptedBytes + sourceBytes > MAX_ACCEPTED_BYTES ||
			processBytes + transientBytes + bytes + encodedBytes > MAX_PROCESS_BYTES
		)
			busy("Accepted image capacity exceeded.");
		this.#budget.acceptedBytes += sourceBytes;
		processBytes += bytes + encodedBytes;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			this.#budget.acceptedBytes -= sourceBytes;
			processBytes -= bytes + encodedBytes;
		};
		try {
			const images: ImageContent[] = entries.map(([, entry]) => ({
				type: "image",
				data: entry.chunks[0]!.toString("base64"),
				mimeType: entry.mimeType,
			}));
			for (const [id] of entries) this.#remove(id);
			return { images, release };
		} catch (error) {
			release();
			throw error;
		}
	}

	disconnect(connectionId: string): void {
		for (const [id, upload] of this.#uploads) if (upload.owner === connectionId) this.#remove(id);
	}
	close(): void {
		this.#closed = true;
		for (const id of this.#uploads.keys()) this.#remove(id);
	}
	#owned(connectionId: string | undefined, value: unknown): Upload {
		this.#assertOpen();
		const owner = ownerId(connectionId);
		this.#assertConnected(owner);
		if (typeof value !== "string" || !value) invalid("Image upload ID is required.");
		const upload = this.#uploads.get(value);
		if (!upload || upload.owner !== owner || this.#expire(value, upload))
			throw new TypedControlError("resource_gone", "Image upload is unavailable.");
		return upload;
	}
	#assertOpen(): void {
		if (this.#closed) throw new TypedControlError("resource_gone", "Image upload session is closed.");
	}
	#assertConnected(owner: string): void {
		if (!this.#isConnectionOpen(owner))
			throw new TypedControlError("resource_gone", "Image upload connection is closed.");
	}
	#expire(id: string, upload: Upload, now = Date.now()): boolean {
		if (now < upload.expiresAt) return false;
		this.#remove(id);
		return true;
	}
	#renewBatch(owner: string, id: string, current: Upload): void {
		const now = Date.now();
		if (this.#uploads.get(id) !== current || this.#expire(id, current, now))
			throw new TypedControlError("resource_gone", "Image upload expired.");
		if (current.batchId === undefined) {
			this.#resetLease(id, current, now);
			return;
		}
		for (const [uploadId, upload] of this.#uploads)
			if (upload.owner === owner && upload.batchId === current.batchId && !this.#expire(uploadId, upload, now))
				this.#resetLease(uploadId, upload, now);
	}
	#resetLease(id: string, upload: Upload, now: number): void {
		clearTimeout(upload.timer);
		upload.expiresAt = now + LEASE_MS;
		upload.timer = setTimeout(() => this.#remove(id), LEASE_MS);
		upload.timer.unref?.();
	}
	#remove(id: string): void {
		const upload = this.#uploads.get(id);
		if (!upload) return;
		this.#uploads.delete(id);
		this.#budget.uploadCount--;
		clearTimeout(upload.timer);
		if (!upload.finishing) {
			this.#budget.uploadBytes -= upload.reservedBytes;
			processBytes -= upload.reservedBytes;
		}
	}
}
