import * as crypto from "node:crypto";
import type { ImageContent } from "@gajae-code/ai/core";
import { parseImageMetadata } from "@gajae-code/utils";
import { MAX_IMAGE_INPUT_BYTES } from "../../utils/image-loading";
import {
	MAX_PASTED_IMAGE_DIMENSION,
	MAX_PASTED_IMAGE_PIXELS,
	MAX_PASTED_IMAGE_SOURCE_BYTES,
} from "../../utils/pasted-image-loading";
import { TypedControlError } from "./control/dispatch";

const MAX_CHUNK_BYTES = 96 * 1024;
const MAX_IMAGES = 16;
const MAX_UPLOADS = 16;
const MAX_ACCEPTED_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_BYTES = 256 * 1024 * 1024;
const LEASE_MS = 2 * 60_000;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
let processBytes = 0;

type Upload = {
	owner: string;
	mimeType: string;
	byteLength: number;
	sha256: string;
	chunks: Buffer[];
	length: number;
	sequence: number;
	finishing: boolean;
	finished: boolean;
	timer: ReturnType<typeof setTimeout>;
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
	#closed = false;
	#uploadBytes = 0;
	#acceptedBytes = 0;

	begin(connectionId: string | undefined, value: unknown): { id: string; nextSequence: 0 } {
		this.#assertOpen();
		const owner = ownerId(connectionId);
		const input = object(value, ["mimeType", "byteLength", "sha256"]);
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
		if (this.#uploads.size >= MAX_UPLOADS) busy("Too many concurrent image uploads.");
		const id = crypto.randomUUID();
		const timer = setTimeout(() => this.#remove(id), LEASE_MS);
		timer.unref?.();
		this.#uploads.set(id, {
			owner,
			mimeType: input.mimeType,
			byteLength: input.byteLength as number,
			sha256: input.sha256,
			chunks: [],
			length: 0,
			sequence: 0,
			finishing: false,
			finished: false,
			timer,
		});
		return { id, nextSequence: 0 };
	}

	append(
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
		if (
			this.#uploadBytes + bytes.length > MAX_PASTED_IMAGE_SOURCE_BYTES ||
			processBytes + bytes.length > MAX_PROCESS_BYTES
		)
			busy("Image staging capacity exceeded.");
		upload.chunks.push(bytes);
		upload.length += bytes.length;
		upload.sequence++;
		this.#uploadBytes += bytes.length;
		processBytes += bytes.length;
		return { id: input.id as string, nextSequence: upload.sequence, receivedBytes: upload.length };
	}

	async finish(
		connectionId: string | undefined,
		value: unknown,
	): Promise<{ id: string; byteLength: number; sha256: string; mimeType: string }> {
		const input = object(value, ["id"]);
		const upload = this.#owned(connectionId, input.id);
		if (upload.finishing || upload.finished) invalid("Image upload is already finishing or finished.");
		if (upload.length !== upload.byteLength) invalid("Image upload is incomplete.");
		// Reserve the lease synchronously: host controls are dispatched concurrently.
		upload.finishing = true;
		try {
			const bytes = Buffer.concat(upload.chunks, upload.length);
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
			try {
				const decoded = await new Bun.Image(bytes).metadata();
				if (decoded.width !== metadata.width || decoded.height !== metadata.height)
					invalid("Image dimensions do not match decoded data.");
				await new Bun.Image(bytes).resize(1, 1).png().bytes();
			} catch {
				invalid("Image cannot be decoded.");
			}
			// The transport can disconnect while decoding. A removed lease cannot be resurrected.
			if (this.#uploads.get(input.id as string) !== upload)
				throw new TypedControlError("resource_gone", "Image upload expired.");
			upload.chunks = [bytes];
			upload.finished = true;
			return { id: input.id as string, byteLength: upload.length, sha256: upload.sha256, mimeType: upload.mimeType };
		} finally {
			upload.finishing = false;
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
		if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMAGES)
			invalid("stagedImages must contain 1–16 image IDs.");
		const seen = new Set<string>();
		const entries: Array<[string, Upload]> = [];
		let bytes = 0;
		for (const descriptor of value) {
			const input = object(descriptor, ["id"]);
			const id = input.id;
			if (typeof id !== "string" || !id || seen.has(id))
				invalid("stagedImages contains an invalid or duplicate ID.");
			seen.add(id);
			const entry = this.#uploads.get(id);
			if (!entry || entry.owner !== owner)
				throw new TypedControlError("resource_gone", "Image upload is unavailable.");
			if (!entry.finished) invalid("Image upload is not finished.");
			bytes += entry.length;
			entries.push([id, entry]);
		}
		if (
			bytes > MAX_PASTED_IMAGE_SOURCE_BYTES ||
			this.#acceptedBytes + bytes > MAX_ACCEPTED_BYTES ||
			processBytes + bytes > MAX_PROCESS_BYTES
		)
			busy("Accepted image capacity exceeded.");
		this.#acceptedBytes += bytes;
		processBytes += bytes;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			this.#acceptedBytes -= bytes;
			processBytes -= bytes;
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
		if (typeof value !== "string" || !value) invalid("Image upload ID is required.");
		const upload = this.#uploads.get(value);
		if (!upload || upload.owner !== owner)
			throw new TypedControlError("resource_gone", "Image upload is unavailable.");
		return upload;
	}
	#assertOpen(): void {
		if (this.#closed) throw new TypedControlError("resource_gone", "Image upload session is closed.");
	}
	#remove(id: string): void {
		const upload = this.#uploads.get(id);
		if (!upload) return;
		this.#uploads.delete(id);
		clearTimeout(upload.timer);
		this.#uploadBytes -= upload.length;
		processBytes -= upload.length;
	}
}
