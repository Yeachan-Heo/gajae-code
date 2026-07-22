import * as fs from "node:fs/promises";
import type { ImageContent } from "@gajae-code/ai";
import { formatBytes, readImageMetadata, SUPPORTED_IMAGE_MIME_TYPES } from "@gajae-code/utils";
import { resolveReadPath } from "../tools/path-utils";
import { formatDimensionNote, resizeImageBuffer } from "./image-resize";

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_INPUT_IMAGE_MIME_TYPES = SUPPORTED_IMAGE_MIME_TYPES;

export interface LoadImageInputOptions {
	path: string;
	cwd: string;
	autoResize: boolean;
	maxBytes?: number;
	resolvedPath?: string;
	detectedMimeType?: string;
	signal?: AbortSignal;
}

export interface LoadImageInputBytesOptions {
	inputBuffer: Buffer;
	resolvedPath: string;
	mimeType: string;
	autoResize: boolean;
	maxBytes?: number;
	maxOutputBytes?: number;
	signal?: AbortSignal;
}

export interface TransformedImageInput {
	resolvedPath: string;
	mimeType: string;
	buffer: Uint8Array;
	textNote: string;
	dimensionNote?: string;
	bytes: number;
}

export interface LoadedImageInput {
	resolvedPath: string;
	mimeType: string;
	data: string;
	textNote: string;
	dimensionNote?: string;
	bytes: number;
}

export class ImageInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Image file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "ImageInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

export async function ensureSupportedImageInput(image: ImageContent): Promise<ImageContent | null> {
	if (SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(image.mimeType)) return image;
	try {
		const bytes = Buffer.from(image.data, "base64");
		const data = await new Bun.Image(bytes).png().toBase64();
		return { type: "image", data, mimeType: "image/png" };
	} catch {
		return null;
	}
}

/** Transform trusted source bytes without materializing a base64 payload. */
export async function transformImageInputBytes(options: LoadImageInputBytesOptions): Promise<TransformedImageInput> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	options.signal?.throwIfAborted();
	if (options.inputBuffer.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(options.inputBuffer.byteLength, maxBytes);
	}

	let outputBuffer: Uint8Array = options.inputBuffer;
	let outputMimeType = options.mimeType;
	let dimensionNote: string | undefined;

	if (options.autoResize) {
		options.signal?.throwIfAborted();
		try {
			const resized = await resizeImageBuffer(
				options.inputBuffer,
				options.mimeType,
				options.maxOutputBytes === undefined ? undefined : { maxBytes: options.maxOutputBytes },
			);
			options.signal?.throwIfAborted();
			outputBuffer = resized.buffer;
			outputMimeType = resized.mimeType;
			dimensionNote = formatDimensionNote(resized);
		} catch {
			options.signal?.throwIfAborted();
			// Keep the original image when optional resize fails.
		}
	}

	options.signal?.throwIfAborted();
	let textNote = `Read image file [${outputMimeType}]`;
	if (dimensionNote) textNote += `\n${dimensionNote}`;
	return {
		resolvedPath: options.resolvedPath,
		mimeType: outputMimeType,
		buffer: outputBuffer,
		textNote,
		dimensionNote,
		bytes: outputBuffer.byteLength,
	};
}

export function materializeImageInput(transformed: TransformedImageInput): LoadedImageInput {
	return {
		resolvedPath: transformed.resolvedPath,
		mimeType: transformed.mimeType,
		data: Buffer.from(transformed.buffer).toBase64(),
		textNote: transformed.textNote,
		dimensionNote: transformed.dimensionNote,
		bytes: transformed.bytes,
	};
}

/** Build a model image payload from bytes already read through a trusted descriptor. */
export async function loadImageInputBytes(options: LoadImageInputBytesOptions): Promise<LoadedImageInput> {
	return materializeImageInput(await transformImageInputBytes(options));
}

export async function loadImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	options.signal?.throwIfAborted();
	const metadata = options.detectedMimeType
		? { mimeType: options.detectedMimeType }
		: await readImageMetadata(resolvedPath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) return null;

	options.signal?.throwIfAborted();
	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) throw new ImageInputTooLargeError(stat.size, maxBytes);

	const inputBuffer = await fs.readFile(resolvedPath, { signal: options.signal });
	return loadImageInputBytes({
		inputBuffer,
		resolvedPath,
		mimeType,
		autoResize: options.autoResize,
		maxBytes,
		signal: options.signal,
	});
}
