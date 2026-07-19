import * as crypto from "node:crypto";
import {
	FILESYSTEM_MEMORY_MAX_READ_BYTES,
	type FilesystemMemoryMarkdownMetadataV1,
	type FilesystemMemoryOutcome,
} from "./contracts";

export interface FilesystemMemoryHeading {
	readonly text: string;
	readonly level: number;
	readonly line: number;
}

export interface FilesystemMemoryDocument {
	readonly metadata: FilesystemMemoryMarkdownMetadataV1;
	readonly body: string;
	readonly headings: readonly FilesystemMemoryHeading[];
	readonly digest: string;
	readonly lineCount: number;
}

export function containsFilesystemMemorySecretLikeContent(text: string): boolean {
	return /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:api[_-]?key|secret|password|token)\s*[:=]\s*[^\s]{8,})/i.test(text);
}

function failure(message: string): FilesystemMemoryOutcome<never> {
	return { code: "invalid_path", message };
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Strict small YAML/JSON mapping parser: aliases, tags, anchors and duplicate keys are rejected before parsing. */
export function parseFilesystemMemoryMapping(text: string): FilesystemMemoryOutcome<Record<string, unknown>> {
	if (text.length > FILESYSTEM_MEMORY_MAX_READ_BYTES)
		return { code: "too_large", message: "Metadata exceeds the document limit." };
	if (/(^|[\s:[{,])[&*!]|<<\s*:/.test(text))
		return failure("YAML aliases, tags, anchors, and merge keys are not supported.");
	const trimmed = text.trim();
	if (!trimmed) return { code: "ok", value: {} };
	if (trimmed.startsWith("{")) {
		const keys = [...trimmed.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/g)].map(match => match[1]);
		if (new Set(keys).size !== keys.length) return failure("Metadata JSON contains duplicate fields.");
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const mapped = record(parsed);
			return mapped ? { code: "ok", value: mapped } : failure("Metadata must be an object.");
		} catch {
			return failure("Metadata JSON is invalid.");
		}
	}
	const result: Record<string, unknown> = {};
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || /^\s*#/.test(line)) continue;
		const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
		if (!match || /^\s/.test(line) || Object.hasOwn(result, match[1]))
			return failure("Metadata YAML must be a flat unique-key mapping.");
		const raw = match[2];
		if (raw.startsWith("[") || raw.startsWith("{")) {
			try {
				result[match[1]] = JSON.parse(raw);
			} catch {
				return failure("Metadata inline JSON is invalid.");
			}
		} else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
			result[match[1]] = raw.slice(1, -1);
		} else result[match[1]] = raw;
	}
	return { code: "ok", value: result };
}

function metadataFrom(value: Record<string, unknown>): FilesystemMemoryOutcome<FilesystemMemoryMarkdownMetadataV1> {
	const keys = Object.keys(value);
	if (keys.some(key => !["version", "title", "tags", "volatility", "status"].includes(key)))
		return failure("Markdown metadata contains an unknown field.");
	if (value.version !== 1 && value.version !== "1")
		return { code: "unknown_version", message: "Markdown metadata version is not 1." };
	if (
		value.title !== undefined &&
		(typeof value.title !== "string" || !value.title.trim() || value.title.length > 512)
	)
		return failure("Metadata title is invalid.");
	if (
		value.tags !== undefined &&
		(!Array.isArray(value.tags) ||
			value.tags.some(tag => typeof tag !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,63}$/i.test(tag)))
	)
		return failure("Metadata tags are invalid.");
	if (value.volatility !== undefined && value.volatility !== "stable" && value.volatility !== "volatile")
		return failure("Metadata volatility is invalid.");
	if (
		value.status !== undefined &&
		value.status !== "active" &&
		value.status !== "archived" &&
		value.status !== "superseded" &&
		value.status !== "unverified"
	)
		return failure("Metadata status is invalid.");
	return {
		code: "ok",
		value: {
			version: 1,
			...(typeof value.title === "string" ? { title: value.title } : {}),
			...(Array.isArray(value.tags) ? { tags: value.tags as string[] } : {}),
			...(value.volatility === "stable" || value.volatility === "volatile" ? { volatility: value.volatility } : {}),
			...(value.status === "active" ||
			value.status === "archived" ||
			value.status === "superseded" ||
			value.status === "unverified"
				? { status: value.status }
				: {}),
		},
	};
}

export function parseFilesystemMemoryDocument(bytes: Uint8Array): FilesystemMemoryOutcome<FilesystemMemoryDocument> {
	if (bytes.byteLength > FILESYSTEM_MEMORY_MAX_READ_BYTES)
		return { code: "too_large", message: "Document exceeds the read limit." };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return failure("Document is not valid UTF-8.");
	}
	const lines = text.split(/\r?\n/);
	let metadata: FilesystemMemoryMarkdownMetadataV1 = { version: 1 };
	let bodyStart = 0;
	if (lines[0] === "---") {
		const end = lines.indexOf("---", 1);
		if (end < 0) return failure("Markdown frontmatter is not terminated.");
		const parsed = parseFilesystemMemoryMapping(lines.slice(1, end).join("\n"));
		if (parsed.code !== "ok") return parsed;
		const decoded = metadataFrom(parsed.value);
		if (decoded.code !== "ok") return decoded;
		metadata = decoded.value;
		bodyStart = end + 1;
	}
	const headings: FilesystemMemoryHeading[] = [];
	for (let index = bodyStart; index < lines.length; index += 1) {
		const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
		if (match) headings.push({ level: match[1].length, text: match[2], line: index + 1 });
	}
	return {
		code: "ok",
		value: {
			metadata,
			body: lines.slice(bodyStart).join("\n"),
			headings,
			digest: crypto.createHash("sha256").update(bytes).digest("hex"),
			lineCount: lines.length,
		},
	};
}

export function filesystemMemoryHeadingRange(
	document: FilesystemMemoryDocument,
	heading: FilesystemMemoryHeading | null,
): readonly [number, number] {
	if (!heading) return [1, document.lineCount];
	const next = document.headings.find(candidate => candidate.line > heading.line && candidate.level <= heading.level);
	return [heading.line, (next?.line ?? document.lineCount + 1) - 1];
}
