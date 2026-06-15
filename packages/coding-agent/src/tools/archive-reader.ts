import { ToolError } from "./tool-errors";

let fflateModulePromise: Promise<typeof import("fflate")> | undefined;
async function loadFflate(): Promise<typeof import("fflate")> {
	if (!fflateModulePromise) fflateModulePromise = import("fflate");
	return fflateModulePromise;
}

export type ArchiveFormat = "zip" | "tar" | "tar.gz";

export interface ArchivePathCandidate {
	archivePath: string;
	subPath: string;
}

export interface ArchiveNode {
	path: string;
	isDirectory: boolean;
	size: number;
	mtimeMs?: number;
}

export interface ArchiveDirectoryEntry extends ArchiveNode {
	name: string;
}

export interface ExtractedArchiveFile extends ArchiveNode {
	bytes: Uint8Array;
}

interface TarStorage {
	type: "tar";
	file: File;
}

interface ZipStorage {
	type: "zip";
	bytes: Uint8Array;
}

type EntryStorage = TarStorage | ZipStorage;

interface ArchiveIndexEntry extends ArchiveNode {
	storage?: EntryStorage;
}

function normalizeArchiveLookupPath(rawPath?: string): string | undefined {
	if (!rawPath) return "";

	const parts = rawPath.replace(/\\/g, "/").split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		normalizedParts.push(part);
	}

	return normalizedParts.join("/");
}

function normalizeArchiveEntryPath(rawPath: string): string | undefined {
	const parts = rawPath.replace(/\\/g, "/").split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) return undefined;
	return normalizedParts.join("/");
}

function isArchiveDirectoryName(rawPath: string): boolean {
	return rawPath.endsWith("/") || rawPath.endsWith("\\");
}

function upsertArchiveEntry(map: Map<string, ArchiveIndexEntry>, entry: ArchiveIndexEntry): void {
	const existing = map.get(entry.path);
	if (!existing) {
		map.set(entry.path, entry);
		return;
	}

	if (existing.isDirectory && !entry.isDirectory) {
		map.set(entry.path, entry);
		return;
	}

	if (!existing.isDirectory && entry.isDirectory) {
		return;
	}

	map.set(entry.path, {
		...existing,
		size: existing.size || entry.size,
		mtimeMs: existing.mtimeMs ?? entry.mtimeMs,
		storage: existing.storage ?? entry.storage,
	});
}

function ensureParentDirectories(map: Map<string, ArchiveIndexEntry>): void {
	for (const entry of [...map.values()]) {
		const parts = entry.path.split("/");
		const stop = parts.length - 1;
		for (let index = 1; index <= stop; index++) {
			const dirPath = parts.slice(0, index).join("/");
			if (!dirPath || map.has(dirPath)) continue;
			map.set(dirPath, {
				path: dirPath,
				isDirectory: true,
				size: 0,
			});
		}
	}
}

function getArchiveFormatFromPath(filePath: string): ArchiveFormat | undefined {
	const normalized = filePath.toLowerCase();
	if (normalized.endsWith(".tar.gz") || normalized.endsWith(".tgz")) return "tar.gz";
	if (normalized.endsWith(".tar")) return "tar";
	if (normalized.endsWith(".zip")) return "zip";
	return undefined;
}

async function readTarEntries(bytes: Uint8Array): Promise<ArchiveIndexEntry[]> {
	let archive: Bun.Archive;
	try {
		archive = new Bun.Archive(bytes);
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}

	let files: Map<string, File>;
	try {
		files = await archive.files();
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}

	const entries: ArchiveIndexEntry[] = [];
	for (const [rawPath, file] of files) {
		const normalizedPath = normalizeArchiveEntryPath(rawPath);
		if (!normalizedPath) continue;
		const mtimeMs = file.lastModified > 0 ? file.lastModified : undefined;
		entries.push({
			path: normalizedPath,
			isDirectory: false,
			size: file.size,
			mtimeMs,
			storage: { type: "tar", file },
		});
	}

	return entries;
}

async function readZipEntries(bytes: Uint8Array): Promise<ArchiveIndexEntry[]> {
	const { unzipSync } = await loadFflate();
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes);
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}

	const entries: ArchiveIndexEntry[] = [];
	for (const [rawPath, fileBytes] of Object.entries(files)) {
		const normalizedPath = normalizeArchiveEntryPath(rawPath);
		if (!normalizedPath) continue;
		const isDirectory = isArchiveDirectoryName(rawPath);
		entries.push({
			path: normalizedPath,
			isDirectory,
			size: isDirectory ? 0 : fileBytes.byteLength,
			storage: isDirectory ? undefined : { type: "zip", bytes: fileBytes },
		});
	}

	return entries;
}

export function parseArchivePathCandidates(filePath: string): ArchivePathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const pattern = /\.(?:tar\.gz|tgz|zip|tar)(?=(?::|$))/gi;
	const seen = new Set<string>();
	const candidates: ArchivePathCandidate[] = [];

	let match: RegExpExecArray | null;
	while (true) {
		match = pattern.exec(normalized);
		if (match === null) {
			break;
		}
		const end = match.index + match[0].length;
		const archivePath = filePath.slice(0, end);
		const subPath = normalized.slice(end).replace(/^:+/, "");
		const key = `${archivePath}\0${subPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ archivePath, subPath });
	}

	return candidates.sort((left, right) => right.archivePath.length - left.archivePath.length);
}

export class ArchiveReader {
	readonly format: ArchiveFormat;
	#entries = new Map<string, ArchiveIndexEntry>();

	constructor(format: ArchiveFormat, entries: ArchiveIndexEntry[]) {
		this.format = format;
		for (const entry of entries) {
			upsertArchiveEntry(this.#entries, entry);
		}
		ensureParentDirectories(this.#entries);
	}

	getNode(subPath?: string): ArchiveNode | undefined {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) return undefined;
		if (normalizedPath === "") {
			return { path: "", isDirectory: true, size: 0 };
		}

		const entry = this.#entries.get(normalizedPath);
		if (!entry) return undefined;
		return {
			path: entry.path,
			isDirectory: entry.isDirectory,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
		};
	}

	listDirectory(subPath?: string): ArchiveDirectoryEntry[] {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) {
			throw new ToolError("Archive path cannot contain '..'");
		}

		if (normalizedPath) {
			const entry = this.#entries.get(normalizedPath);
			if (!entry) {
				throw new ToolError(`Archive path '${normalizedPath}' not found`);
			}
			if (!entry.isDirectory) {
				throw new ToolError(`Archive path '${normalizedPath}' is not a directory`);
			}
		}

		const prefix = normalizedPath ? `${normalizedPath}/` : "";
		const children = new Map<string, ArchiveDirectoryEntry>();

		for (const entry of this.#entries.values()) {
			if (normalizedPath) {
				if (!entry.path.startsWith(prefix) || entry.path === normalizedPath) continue;
			}

			const relativePath = normalizedPath ? entry.path.slice(prefix.length) : entry.path;
			const nextSegment = relativePath.split("/")[0];
			if (!nextSegment) continue;

			const childPath = normalizedPath ? `${normalizedPath}/${nextSegment}` : nextSegment;
			if (children.has(childPath)) continue;

			const childEntry = this.#entries.get(childPath);
			const isDirectory = childEntry?.isDirectory ?? relativePath.includes("/");
			children.set(childPath, {
				name: nextSegment,
				path: childPath,
				isDirectory,
				size: isDirectory ? 0 : (childEntry?.size ?? entry.size),
				mtimeMs: childEntry?.mtimeMs ?? entry.mtimeMs,
			});
		}

		return [...children.values()].sort((left, right) =>
			left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
		);
	}

	async readFile(subPath: string): Promise<ExtractedArchiveFile> {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (!normalizedPath) {
			throw new ToolError("Archive file path is required");
		}

		const entry = this.#entries.get(normalizedPath);
		if (!entry) {
			throw new ToolError(`Archive file '${normalizedPath}' not found`);
		}
		if (entry.isDirectory) {
			throw new ToolError(`Archive path '${normalizedPath}' is a directory`);
		}
		if (!entry.storage) {
			throw new ToolError(`Archive file '${normalizedPath}' has no readable storage`);
		}

		const bytes = entry.storage.type === "tar" ? await entry.storage.file.bytes() : entry.storage.bytes;

		return {
			path: entry.path,
			isDirectory: false,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			bytes,
		};
	}
}

export async function openArchive(filePath: string): Promise<ArchiveReader> {
	const format = getArchiveFormatFromPath(filePath);
	if (!format) {
		throw new ToolError(`Unsupported archive format: ${filePath}`);
	}

	// F20: cap the compressed archive read so opening a multi-GB archive cannot buffer it
	// whole into memory. (Zip-bomb expanded-size bounding would need a streaming inflate.)
	const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
	const file = Bun.file(filePath);
	if (file.size > MAX_ARCHIVE_BYTES) {
		throw new ToolError(
			`Archive too large to open: ${filePath} is ${file.size} bytes (limit ${MAX_ARCHIVE_BYTES}). Extract a subset with a dedicated tool.`,
		);
	}
	const bytes = await file.bytes();
	const entries = format === "zip" ? await readZipEntries(bytes) : await readTarEntries(bytes);
	return new ArchiveReader(format, entries);
}
