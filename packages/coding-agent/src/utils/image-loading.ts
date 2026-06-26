import * as fs from "node:fs/promises";
import type { ImageContent } from "@gajae-code/ai";
import { formatBytes, readImageMetadata, SUPPORTED_IMAGE_MIME_TYPES } from "@gajae-code/utils";
import { resolveReadPath } from "../tools/path-utils";
import { clampImageToApiDimensionCeiling, formatDimensionNote, resizeImage } from "./image-resize";

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_INPUT_IMAGE_MIME_TYPES = SUPPORTED_IMAGE_MIME_TYPES;

export interface LoadImageInputOptions {
	path: string;
	cwd: string;
	autoResize: boolean;
	maxBytes?: number;
	resolvedPath?: string;
	detectedMimeType?: string;
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
	if (SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(image.mimeType)) {
		return image;
	}
	try {
		const bytes = Buffer.from(image.data, "base64");
		const data = await new Bun.Image(bytes).png().toBase64();
		return { type: "image", data, mimeType: "image/png" };
	} catch {
		return null;
	}
}

export async function loadImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const metadata = options.detectedMimeType
		? { mimeType: options.detectedMimeType }
		: await readImageMetadata(resolvedPath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) return null;

	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const inputBuffer = await fs.readFile(resolvedPath);
	if (inputBuffer.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(inputBuffer.byteLength, maxBytes);
	}

	let outputData = Buffer.from(inputBuffer).toBase64();
	let outputMimeType = mimeType;
	let outputBytes = inputBuffer.byteLength;
	let dimensionNote: string | undefined;

	if (options.autoResize) {
		try {
			const resized = await resizeImage({ type: "image", data: outputData, mimeType });
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} catch {
			// keep original image when resize fails
		}
	} else {
		// Auto-resize is off, but the hard API dimension ceiling MUST still hold: a single
		// image over 2000px on any edge permanently bricks multi-image requests (HTTP 400).
		// Downscale only when the ceiling is exceeded; in-spec images pass through untouched.
		try {
			const clamped = await clampImageToApiDimensionCeiling({ type: "image", data: outputData, mimeType });
			if (clamped.wasResized) {
				outputData = clamped.data;
				outputMimeType = clamped.mimeType;
				outputBytes = clamped.buffer.byteLength;
				dimensionNote = formatDimensionNote(clamped);
			}
		} catch {
			// keep original image when clamp fails
		}
	}

	let textNote = `Read image file [${outputMimeType}]`;
	if (dimensionNote) {
		textNote += `\n${dimensionNote}`;
	}

	return {
		resolvedPath,
		mimeType: outputMimeType,
		data: outputData,
		textNote,
		dimensionNote,
		bytes: outputBytes,
	};
}
