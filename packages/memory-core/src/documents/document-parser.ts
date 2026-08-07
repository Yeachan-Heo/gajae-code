import { createHash } from "node:crypto";
import { MEMORY_EXIT_CODES, type MemoryError, type MemoryResult } from "../errors";
import type { MemoryUri as IndexMemoryUri, MemoryCitation } from "../index";
import {
	type MemoryDocumentMetadata,
	normalizeDocumentText,
	type ParsedFrontmatter,
	parseFrontmatter,
} from "./frontmatter";
import { type MarkdownSection, parseMarkdownSections } from "./markdown-sections";
import { formatMemoryUri, type MemoryUri, parseMemoryUri } from "./uri";

export interface ParseMemoryDocumentInput {
	readonly content: string;
	readonly relPath?: string;
	readonly path?: string;
	readonly uri?: string | IndexMemoryUri;
	readonly includeExcluded?: boolean;
	readonly includeInactive?: boolean;
}

export interface ParsedMemoryDocument {
	readonly metadata: MemoryDocumentMetadata;
	readonly frontmatter: MemoryDocumentMetadata;
	readonly content: string;
	readonly normalizedContent: string;
	readonly body: string;
	readonly sections: readonly MarkdownSection[];
	readonly digest: string;
	readonly sha256: string;
	readonly uri: MemoryUri;
	readonly citation: MemoryCitation;
	readonly citations: readonly MemoryCitation[];
	readonly retrievalEligible: boolean;
	readonly eligible: boolean;
	readonly excluded: boolean;
	readonly exclusionReason: "proposed" | "superseded" | "archived" | "rejected" | null;
}

function malformed(relPath: string, detail: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "malformed-document",
			exitCode: MEMORY_EXIT_CODES.malformedDocument,
			relPath,
			detail,
		},
	};
}

function resultDetail(error: MemoryError): string {
	return "detail" in error ? error.detail : error.code;
}

function normalizeRelativePath(value: string): MemoryResult<string> {
	if (value.length === 0) return malformed(value, "relative path is empty");
	const normalized = value.normalize("NFC");
	if (normalized.includes("\\") || normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized)) {
		return malformed(value, "relative path must use POSIX separators and not be absolute");
	}
	const components = normalized.split("/");
	if (components.some(component => component.length === 0 || component === "." || component === "..")) {
		return malformed(value, "relative path contains an empty or traversal component");
	}
	for (const component of components) {
		if (component.includes("\u0000") || component.includes(":") || /[. ]$/.test(component)) {
			return malformed(value, "relative path contains an unsafe component");
		}
		if (
			[...component].some(character => {
				const codePoint = character.codePointAt(0);
				return codePoint !== undefined && codePoint < 0x20;
			})
		)
			return malformed(value, "relative path contains a control character");
	}
	if (!normalized.endsWith(".md")) return malformed(value, "memory documents must use the .md extension");
	return { ok: true, value: components.join("/") };
}

function digestContent(content: string): string {
	return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function uriFromInput(
	metadata: MemoryDocumentMetadata,
	relPath: string,
	explicitUri: string | IndexMemoryUri | undefined,
): MemoryResult<MemoryUri> {
	if (typeof explicitUri === "string") {
		const parsed = parseMemoryUri(explicitUri);
		if (!parsed.ok) return malformed(relPath, resultDetail(parsed.error));
		if (parsed.value.scheme !== metadata.scope)
			return malformed(relPath, "URI scope does not match frontmatter scope");
		return parsed;
	}
	if (explicitUri !== undefined) {
		const formatted = formatMemoryUri(explicitUri);
		if (!formatted.ok) return malformed(relPath, resultDetail(formatted.error));
		const parsed = parseMemoryUri(formatted.value);
		if (!parsed.ok) return malformed(relPath, resultDetail(parsed.error));
		if (parsed.value.scheme !== metadata.scope)
			return malformed(relPath, "URI scope does not match frontmatter scope");
		return parsed;
	}
	const components = relPath.split("/");
	let uriPath = components;
	if (metadata.scope === "global" && components[0] === "global") uriPath = components.slice(1);
	if (metadata.scope === "project" && components[0] === "projects") uriPath = components.slice(1);
	if (metadata.scope === "session" && components[0] === "sessions") uriPath = components.slice(1);
	if (uriPath.length === 0) return malformed(relPath, "document URI path is empty");
	const candidate: IndexMemoryUri = {
		scheme: metadata.scope,
		path: uriPath,
		fragment: null,
		href: "",
	};
	const formatted = formatMemoryUri(candidate);
	if (!formatted.ok) return malformed(relPath, resultDetail(formatted.error));

	const parsed = parseMemoryUri(formatted.value);
	if (!parsed.ok) return malformed(relPath, resultDetail(parsed.error));

	return parsed;
}

function makeCitation(
	metadata: MemoryDocumentMetadata,
	uri: MemoryUri,
	relPath: string,
	digest: string,
	heading: string,
	startLine: number,
	endLine: number,
): MemoryCitation {
	return Object.freeze({
		uri: uri.href,
		scope: metadata.scope,
		relPath,
		heading,
		startLine,
		endLine,
		authority: metadata.authority,
		volatility: metadata.volatility,
		updatedAt: metadata.updated,
		digest,
	});
}

function inputValues(
	inputOrContent: ParseMemoryDocumentInput | string,
	relPathArgument: string | undefined,
	uriArgument: string | undefined,
): ParseMemoryDocumentInput {
	if (typeof inputOrContent === "string") {
		return { content: inputOrContent, relPath: relPathArgument, uri: uriArgument };
	}
	return inputOrContent;
}

export function parseMemoryDocument(input: ParseMemoryDocumentInput): MemoryResult<ParsedMemoryDocument>;
export function parseMemoryDocument(
	content: string,
	relPath?: string,
	uri?: string,
): MemoryResult<ParsedMemoryDocument>;
export function parseMemoryDocument(
	inputOrContent: ParseMemoryDocumentInput | string,
	relPathArgument?: string,
	uriArgument?: string,
): MemoryResult<ParsedMemoryDocument> {
	const input = inputValues(inputOrContent, relPathArgument, uriArgument);
	if (input === null || typeof input !== "object" || typeof input.content !== "string") {
		return malformed(
			typeof relPathArgument === "string" ? relPathArgument : "<memory-document>",
			"document input must contain string content",
		);
	}
	const candidatePath = input.relPath ?? input.path;
	if (typeof candidatePath !== "string") return malformed("<memory-document>", "document input must contain relPath");
	const normalizedPath = normalizeRelativePath(candidatePath);
	if (!normalizedPath.ok) return normalizedPath;
	const relPath = normalizedPath.value;
	const parsedFrontmatter = parseFrontmatter(input.content, relPath);
	if (!parsedFrontmatter.ok) return parsedFrontmatter;
	const frontmatter: ParsedFrontmatter = parsedFrontmatter.value;
	const sectionsResult = parseMarkdownSections(frontmatter.body, frontmatter.bodyStartLine - 1);
	if (!sectionsResult.ok) return malformed(relPath, resultDetail(sectionsResult.error));
	const normalizedContent = normalizeDocumentText(input.content);
	const digest = digestContent(normalizedContent);
	const uri = uriFromInput(frontmatter.metadata, relPath, input.uri);
	if (!uri.ok) return uri;
	const allLines = normalizedContent.split("\n");
	const fullCitation = makeCitation(frontmatter.metadata, uri.value, relPath, digest, "", 1, allLines.length);
	const exclusionReason = frontmatter.metadata.status === "active" ? null : frontmatter.metadata.status;
	const includeExcluded = input.includeExcluded === true || input.includeInactive === true;
	const retrievalEligible = exclusionReason === null || includeExcluded;
	const citations = sectionsResult.value.map(section =>
		makeCitation(
			frontmatter.metadata,
			uri.value,
			relPath,
			digest,
			section.heading,
			section.startLine,
			section.endLine,
		),
	);
	const result: ParsedMemoryDocument = Object.freeze({
		metadata: frontmatter.metadata,
		frontmatter: frontmatter.metadata,
		content: normalizedContent,
		normalizedContent,
		body: frontmatter.body,
		sections: sectionsResult.value,
		digest,
		sha256: digest,
		uri: uri.value,
		citation: fullCitation,
		citations: retrievalEligible ? Object.freeze(citations) : Object.freeze([]),
		retrievalEligible,
		eligible: retrievalEligible,
		excluded: !retrievalEligible,
		exclusionReason,
	});
	return { ok: true, value: result };
}
