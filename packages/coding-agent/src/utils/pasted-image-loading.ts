import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@gajae-code/ai";
import { formatBytes, parseImageMetadata } from "@gajae-code/utils";
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	MAX_IMAGE_INPUT_BYTES,
	materializeImageInput,
	type TransformedImageInput,
	transformImageInputBytes,
} from "./image-loading";
import { DEFAULT_IMAGE_RESIZE_MAX_BYTES } from "./image-resize";
import { MAX_PASTED_IMAGE_COUNT } from "./pasted-image-path";

export const MAX_PASTED_IMAGE_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_PASTED_IMAGE_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_PASTED_IMAGE_DIMENSION = 20_000;
export const MAX_PASTED_IMAGE_PIXELS = 40_000_000;
export const MAX_PASTED_IMAGE_DECODED_BYTES = 160 * 1024 * 1024;

export type PastedImageBatchErrorCode =
	| "too-many"
	| "unsafe-path"
	| "unsupported-image"
	| "source-aggregate-too-large"
	| "output-aggregate-too-large"
	| "dimensions-too-large";

export class PastedImageBatchError extends Error {
	constructor(
		readonly code: PastedImageBatchErrorCode,
		message: string,
		readonly imagePath?: string,
	) {
		super(message);
		this.name = "PastedImageBatchError";
	}
}

export interface LoadedPastedImageBatch {
	images: ImageContent[];
	loadedInputs: LoadedImageInput[];
	sourcePaths: string[];
}

export interface PastedImageLoadingDependencies {
	/** Synchronization hook used to exercise pathname swaps after descriptor open. */
	afterDescriptorOpen?: (imagePath: string, index: number) => Promise<void> | void;
	beforeDescriptorRead?: (imagePath: string, index: number) => Promise<void> | void;
	transformImageBytes?: typeof transformImageInputBytes;
}

export type PastedImageSourcePolicy = "confirmed" | "automatic-temp";

interface StableFileState {
	dev: bigint;
	ino: bigint;
	mode: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
	nlink: bigint;
}

interface OpenPastedImage {
	sourcePath: string;
	canonicalPath: string;
	handle: fs.FileHandle;
	state: StableFileState;
}

const PASTED_IMAGE_OPEN_FLAGS =
	nodeFs.constants.O_RDONLY | (process.platform === "win32" ? 0 : (nodeFs.constants.O_NOFOLLOW ?? 0));

function stableFileState(stat: nodeFs.BigIntStats): StableFileState | null {
	if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) return null;
	return {
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
		nlink: stat.nlink,
	};
}

function sameStableFileState(expected: StableFileState, actual: StableFileState | null): boolean {
	return (
		actual !== null &&
		expected.dev === actual.dev &&
		expected.ino === actual.ino &&
		expected.mode === actual.mode &&
		expected.size === actual.size &&
		expected.mtimeNs === actual.mtimeNs &&
		expected.ctimeNs === actual.ctimeNs &&
		expected.nlink === actual.nlink
	);
}

function unsafePath(imagePath: string): PastedImageBatchError {
	return new PastedImageBatchError("unsafe-path", `Unsafe pasted image path: ${path.basename(imagePath)}`, imagePath);
}

function isRemoteWindowsPath(imagePath: string): boolean {
	return process.platform === "win32" && (imagePath.startsWith("\\\\") || imagePath.startsWith("//"));
}

async function exactPathState(imagePath: string): Promise<StableFileState | null> {
	return stableFileState(await fs.lstat(imagePath, { bigint: true }));
}

function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function hasLinkedWindowsAncestor(imagePath: string, signal: AbortSignal): Promise<boolean> {
	if (process.platform !== "win32") return false;
	const root = path.parse(imagePath).root;
	const parent = path.dirname(imagePath);
	const relativeParent = path.relative(root, parent);
	let current = root;
	for (const component of relativeParent.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		const state = await fs.lstat(current);
		signal.throwIfAborted();
		if (state.isSymbolicLink()) return true;
	}
	return false;
}

async function hasLinkedPathBelowRoot(root: string, imagePath: string, signal: AbortSignal): Promise<boolean> {
	const relativeParent = path.relative(root, path.dirname(imagePath));
	if (relativeParent === "" || relativeParent === ".") return false;
	if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
		return true;
	}
	let current = root;
	for (const component of relativeParent.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		const state = await fs.lstat(current);
		signal.throwIfAborted();
		if (state.isSymbolicLink()) return true;
	}
	return false;
}

async function openStablePastedImage(
	imagePath: string,
	index: number,
	dependencies: PastedImageLoadingDependencies,
	signal: AbortSignal,
	sourcePolicy: PastedImageSourcePolicy,
	canonicalTempRoot: string | undefined,
	lexicalTempRoot: string | undefined,
): Promise<OpenPastedImage> {
	signal.throwIfAborted();
	if (!path.isAbsolute(imagePath) || isRemoteWindowsPath(imagePath)) throw unsafePath(imagePath);
	if (await hasLinkedWindowsAncestor(imagePath, signal)) throw unsafePath(imagePath);
	if (
		sourcePolicy === "automatic-temp" &&
		(!lexicalTempRoot ||
			!isPathInside(lexicalTempRoot, imagePath) ||
			(await hasLinkedPathBelowRoot(lexicalTempRoot, imagePath, signal)))
	) {
		throw unsafePath(imagePath);
	}

	const initialSourceState = await exactPathState(imagePath);
	signal.throwIfAborted();
	if (!initialSourceState) throw unsafePath(imagePath);
	const canonicalPath = await fs.realpath(imagePath);
	signal.throwIfAborted();
	if (isRemoteWindowsPath(canonicalPath)) throw unsafePath(imagePath);
	if (sourcePolicy === "automatic-temp" && (!canonicalTempRoot || !isPathInside(canonicalTempRoot, canonicalPath))) {
		throw unsafePath(imagePath);
	}
	const initialCanonicalState = await exactPathState(canonicalPath);
	signal.throwIfAborted();
	if (!sameStableFileState(initialSourceState, initialCanonicalState)) throw unsafePath(imagePath);

	const handle = await fs.open(canonicalPath, PASTED_IMAGE_OPEN_FLAGS);
	try {
		signal.throwIfAborted();
		await dependencies.afterDescriptorOpen?.(imagePath, index);
		signal.throwIfAborted();
		const openedState = stableFileState(await handle.stat({ bigint: true }));
		signal.throwIfAborted();
		const currentSourceState = await exactPathState(imagePath);
		signal.throwIfAborted();
		const currentCanonicalPath = await fs.realpath(imagePath);
		signal.throwIfAborted();
		if (
			!sameStableFileState(initialSourceState, openedState) ||
			!sameStableFileState(initialSourceState, currentSourceState) ||
			currentCanonicalPath !== canonicalPath
		) {
			throw unsafePath(imagePath);
		}
		return { sourcePath: imagePath, canonicalPath, handle, state: initialSourceState };
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

async function readExactDescriptor(opened: OpenPastedImage, signal: AbortSignal): Promise<Buffer> {
	if (opened.state.size > BigInt(Number.MAX_SAFE_INTEGER)) throw unsafePath(opened.sourcePath);
	const size = Number(opened.state.size);
	const bytes = Buffer.allocUnsafe(size);
	let offset = 0;
	while (offset < size) {
		signal.throwIfAborted();
		const result = await opened.handle.read(bytes, offset, size - offset, offset);
		signal.throwIfAborted();
		if (result.bytesRead === 0) {
			throw new PastedImageBatchError(
				"unsupported-image",
				`Incomplete pasted image file: ${path.basename(opened.sourcePath)}`,
				opened.sourcePath,
			);
		}
		offset += result.bytesRead;
	}

	signal.throwIfAborted();
	const afterReadState = stableFileState(await opened.handle.stat({ bigint: true }));
	signal.throwIfAborted();
	const currentSourceState = await exactPathState(opened.sourcePath);
	signal.throwIfAborted();
	const currentCanonicalPath = await fs.realpath(opened.sourcePath);
	signal.throwIfAborted();
	if (
		!sameStableFileState(opened.state, afterReadState) ||
		!sameStableFileState(opened.state, currentSourceState) ||
		currentCanonicalPath !== opened.canonicalPath
	) {
		throw unsafePath(opened.sourcePath);
	}
	return bytes;
}

function mimeTypeForFormat(format: string): string | undefined {
	if (format === "png") return "image/png";
	if (format === "jpeg" || format === "jpg") return "image/jpeg";
	if (format === "gif") return "image/gif";
	if (format === "webp") return "image/webp";
	return undefined;
}

function skipGifSubBlocks(bytes: Buffer, startOffset: number): number | undefined {
	let offset = startOffset;
	while (offset < bytes.length) {
		const length = bytes[offset] ?? 0;
		offset += 1;
		if (length === 0) return offset;
		if (offset + length > bytes.length) return undefined;
		offset += length;
	}
	return undefined;
}

function gifFrameCount(bytes: Buffer): number | undefined {
	if (bytes.length < 13) return undefined;
	const header = bytes.toString("latin1", 0, 6);
	if (header !== "GIF87a" && header !== "GIF89a") return undefined;
	let offset = 13;
	const globalPacked = bytes[10] ?? 0;
	if ((globalPacked & 0x80) !== 0) offset += 3 * 2 ** ((globalPacked & 0x07) + 1);
	let frames = 0;
	while (offset < bytes.length) {
		const marker = bytes[offset];
		if (marker === 0x3b) return frames;
		if (marker === 0x21) {
			if (offset + 2 > bytes.length) return undefined;
			const nextOffset = skipGifSubBlocks(bytes, offset + 2);
			if (nextOffset === undefined) return undefined;
			offset = nextOffset;
			continue;
		}
		if (marker !== 0x2c || offset + 10 > bytes.length) return undefined;
		frames += 1;
		const localPacked = bytes[offset + 9] ?? 0;
		offset += 10;
		if ((localPacked & 0x80) !== 0) offset += 3 * 2 ** ((localPacked & 0x07) + 1);
		if (offset >= bytes.length) return undefined;
		offset += 1;
		const nextOffset = skipGifSubBlocks(bytes, offset);
		if (nextOffset === undefined) return undefined;
		offset = nextOffset;
	}
	return undefined;
}

function hasPngAnimation(bytes: Buffer): boolean {
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const end = offset + 12 + length;
		if (end > bytes.length) return false;
		if (bytes.toString("latin1", offset + 4, offset + 8) === "acTL") return true;
		offset = end;
	}
	return false;
}

function hasWebpAnimation(bytes: Buffer): boolean {
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunkType = bytes.toString("latin1", offset, offset + 4);
		const length = bytes.readUInt32LE(offset + 4);
		if (chunkType === "ANIM" || chunkType === "ANMF") return true;
		offset += 8 + length + (length % 2);
	}
	return false;
}

function isAnimatedImage(bytes: Buffer, mimeType: string): boolean | undefined {
	if (mimeType === "image/gif") {
		const frames = gifFrameCount(bytes);
		return frames === undefined ? undefined : frames > 1;
	}
	if (mimeType === "image/png") return hasPngAnimation(bytes);
	if (mimeType === "image/webp") return hasWebpAnimation(bytes);
	return false;
}

interface ValidatedImageStructure {
	mimeType: string;
	decodedBytes: number;
}

async function validateImageStructure(
	bytes: Buffer,
	imagePath: string,
	signal: AbortSignal,
	maxDimension: number,
	maxPixels: number,
	maxDecodedBytes: number,
): Promise<ValidatedImageStructure> {
	signal.throwIfAborted();
	const parsed = parseImageMetadata(bytes);
	const width = parsed?.width;
	const height = parsed?.height;
	if (!parsed || width === undefined || height === undefined || width <= 0 || height <= 0) {
		throw new PastedImageBatchError(
			"unsupported-image",
			`Unsupported or incomplete pasted image: ${path.basename(imagePath)}`,
			imagePath,
		);
	}
	if (width > maxDimension || height > maxDimension || width * height > maxPixels) {
		throw new PastedImageBatchError(
			"dimensions-too-large",
			`Pasted image dimensions are too large: ${path.basename(imagePath)} (${width}×${height})`,
			imagePath,
		);
	}
	const decodedBytes = width * height * 4;
	if (decodedBytes > maxDecodedBytes) {
		throw new PastedImageBatchError(
			"dimensions-too-large",
			`Pasted image decoded size is too large: ${path.basename(imagePath)} (${formatBytes(decodedBytes)})`,
			imagePath,
		);
	}
	const animated = isAnimatedImage(bytes, parsed.mimeType);
	if (animated !== false) {
		throw new PastedImageBatchError(
			"unsupported-image",
			`${animated ? "Animated" : "Malformed"} pasted images are not supported: ${path.basename(imagePath)}`,
			imagePath,
		);
	}

	try {
		const decoded = await new Bun.Image(bytes).metadata();
		signal.throwIfAborted();
		const decodedMimeType = mimeTypeForFormat(decoded.format);
		if (decoded.width !== width || decoded.height !== height || decodedMimeType !== parsed.mimeType) {
			throw new Error("Image metadata mismatch");
		}
		await new Bun.Image(bytes).resize(1, 1).png().bytes();
		signal.throwIfAborted();
	} catch {
		signal.throwIfAborted();
		throw new PastedImageBatchError(
			"unsupported-image",
			`Unsupported or incomplete pasted image: ${path.basename(imagePath)}`,
			imagePath,
		);
	}
	return { mimeType: parsed.mimeType, decodedBytes };
}

export interface LoadPastedImageBatchOptions {
	paths: readonly string[];
	autoResize: boolean;
	signal: AbortSignal;
	sourcePolicy?: PastedImageSourcePolicy;
	maxImageBytes?: number;
	maxSourceBytes?: number;
	maxOutputBytes?: number;
	maxDimension?: number;
	maxPixels?: number;
	maxDecodedBytes?: number;
	dependencies?: PastedImageLoadingDependencies;
}

export async function loadPastedImageBatch(options: LoadPastedImageBatchOptions): Promise<LoadedPastedImageBatch> {
	const dependencies = options.dependencies ?? {};
	const maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_INPUT_BYTES;
	const maxSourceBytes = options.maxSourceBytes ?? MAX_PASTED_IMAGE_SOURCE_BYTES;
	const maxOutputBytes = options.maxOutputBytes ?? MAX_PASTED_IMAGE_OUTPUT_BYTES;
	const maxDimension = options.maxDimension ?? MAX_PASTED_IMAGE_DIMENSION;
	const maxPixels = options.maxPixels ?? MAX_PASTED_IMAGE_PIXELS;
	const maxDecodedBytes = options.maxDecodedBytes ?? MAX_PASTED_IMAGE_DECODED_BYTES;
	const transformImageBytes = dependencies.transformImageBytes ?? transformImageInputBytes;
	const sourcePaths = [...options.paths];
	if (sourcePaths.length > MAX_PASTED_IMAGE_COUNT) {
		throw new PastedImageBatchError("too-many", `Cannot attach more than ${MAX_PASTED_IMAGE_COUNT} pasted images.`);
	}
	const sourcePolicy = options.sourcePolicy ?? "confirmed";
	const lexicalTempRoot = sourcePolicy === "automatic-temp" ? path.resolve(os.tmpdir()) : undefined;
	let canonicalTempRoot: string | undefined;
	if (sourcePolicy === "automatic-temp") {
		canonicalTempRoot = await fs.realpath(os.tmpdir());
		options.signal.throwIfAborted();
		if (isRemoteWindowsPath(canonicalTempRoot)) throw unsafePath(os.tmpdir());
	}
	const openedFiles: OpenPastedImage[] = [];
	try {
		let sourceBytes = 0;
		for (const [index, imagePath] of sourcePaths.entries()) {
			const opened = await openStablePastedImage(
				imagePath,
				index,
				dependencies,
				options.signal,
				sourcePolicy,
				canonicalTempRoot,
				lexicalTempRoot,
			);
			openedFiles.push(opened);
			if (opened.state.size > BigInt(maxImageBytes)) {
				throw new ImageInputTooLargeError(Number(opened.state.size), maxImageBytes);
			}
			sourceBytes += Number(opened.state.size);
			if (sourceBytes > maxSourceBytes) {
				throw new PastedImageBatchError(
					"source-aggregate-too-large",
					`Pasted image sources total ${formatBytes(sourceBytes)}, exceeding the ${formatBytes(maxSourceBytes)} aggregate limit.`,
				);
			}
		}

		const loadedInputs: LoadedImageInput[] = [];
		const images: ImageContent[] = [];
		let outputPayloadBytes = 0;
		let decodedBytes = 0;
		for (const [index, opened] of openedFiles.entries()) {
			options.signal.throwIfAborted();
			await dependencies.beforeDescriptorRead?.(opened.sourcePath, index);
			options.signal.throwIfAborted();
			const bytes = await readExactDescriptor(opened, options.signal);
			const validated = await validateImageStructure(
				bytes,
				opened.sourcePath,
				options.signal,
				maxDimension,
				maxPixels,
				maxDecodedBytes - decodedBytes,
			);
			decodedBytes += validated.decodedBytes;
			const remainingPayloadBytes = maxOutputBytes - outputPayloadBytes;
			const remainingRawBytes = Math.floor(remainingPayloadBytes / 4) * 3;
			if (remainingRawBytes <= 0) {
				throw new PastedImageBatchError(
					"output-aggregate-too-large",
					`Pasted image payloads exceed the ${formatBytes(maxOutputBytes)} aggregate limit.`,
				);
			}
			const transformed: TransformedImageInput = await transformImageBytes({
				inputBuffer: bytes,
				resolvedPath: opened.sourcePath,
				mimeType: validated.mimeType,
				autoResize: options.autoResize,
				maxBytes: maxImageBytes,
				maxOutputBytes: Math.min(DEFAULT_IMAGE_RESIZE_MAX_BYTES, remainingRawBytes),
				signal: options.signal,
			});
			options.signal.throwIfAborted();
			const payloadBytes = Math.ceil(transformed.bytes / 3) * 4;
			if (outputPayloadBytes + payloadBytes > maxOutputBytes) {
				throw new PastedImageBatchError(
					"output-aggregate-too-large",
					`Pasted image payloads total ${formatBytes(outputPayloadBytes + payloadBytes)}, exceeding the ${formatBytes(maxOutputBytes)} aggregate limit.`,
				);
			}
			outputPayloadBytes += payloadBytes;
			const loaded = materializeImageInput(transformed);
			loadedInputs.push(loaded);
			images.push({ type: "image", data: loaded.data, mimeType: loaded.mimeType });
		}
		options.signal.throwIfAborted();
		return { images, loadedInputs, sourcePaths };
	} finally {
		await Promise.all(openedFiles.map(file => file.handle.close().catch(() => {})));
	}
}
