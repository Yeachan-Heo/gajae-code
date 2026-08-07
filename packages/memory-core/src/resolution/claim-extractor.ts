import type { ParsedMemoryDocument } from "../documents/document-parser";
import type { MarkdownSection } from "../documents/markdown-sections";
import { parseMemoryUri } from "../documents/uri";
import { invalidInput, type MemoryResult } from "../errors";
import type {
	AuthorityTier,
	MemoryCitation,
	MemoryClaim,
	MemoryDocumentType,
	MemoryScopeKind,
	Volatility,
} from "../index";

const DOCUMENT_TYPES: readonly MemoryDocumentType[] = Object.freeze([
	"preference",
	"constraint",
	"policy",
	"convention",
	"decision",
	"fact",
	"observation",
	"hypothesis",
	"task-state",
	"handoff",
	"checkpoint",
	"note",
]);
const AUTHORITY_TIERS: readonly AuthorityTier[] = Object.freeze([
	"user-confirmed",
	"repository-reviewed",
	"project-config",
	"tool-verified",
	"session-observed",
	"model-inferred",
	"unverified",
]);
const SCOPES: readonly MemoryScopeKind[] = Object.freeze(["global", "project", "session"]);
const VOLATILITIES: readonly Volatility[] = Object.freeze(["stable", "volatile", "historical"]);
const STRICT_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
/**
 * A claim value is a bounded assertion, not a copy of the document body: it is
 * published through `ConflictResult.resolution.value`, `rejected[].value`, and
 * `VolatileClaim.claim`, so republishing whole sections would defeat the recall
 * privacy invariant. Take the first non-empty normalized line and cap it.
 */
const MAX_CLAIM_VALUE_CHARS = 200;

function boundedClaimValue(body: string, fallback: string): string {
	const normalized = body.replace(/\r\n?/g, "\n").normalize("NFC");
	const firstLine = normalized
		.split("\n")
		.map(line => line.trim())
		.find(line => line.length > 0);
	const value = firstLine ?? fallback.normalize("NFC").trim();
	const characters = [...value];
	return characters.length <= MAX_CLAIM_VALUE_CHARS
		? value
		: `${characters.slice(0, MAX_CLAIM_VALUE_CHARS).join("")}…`;
}

export interface ClaimCitationContext {
	readonly citations?: readonly MemoryCitation[];
	readonly source?: MemoryCitation;
}

export type ClaimCitationInput = readonly MemoryCitation[] | ClaimCitationContext;

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`claim-extractor: ${detail}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function strictTimestamp(value: unknown, label: string): MemoryResult<string> {
	if (typeof value !== "string") return invalid(`${label} must be a string`);
	const match = STRICT_UTC_PATTERN.exec(value);
	if (match === null) return invalid(`${label} must be strict UTC ISO-8601`);
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const millisecond = Number(match[7] ?? "0");
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || millisecond > 999) {
		return invalid(`${label} is outside the UTC calendar range`);
	}
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
	if (day < 1 || day > daysInMonth) return invalid(`${label} is outside the UTC calendar range`);
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) return invalid(`${label} is not a valid timestamp`);
	const parsed = new Date(milliseconds);
	if (
		parsed.getUTCFullYear() !== year ||
		parsed.getUTCMonth() + 1 !== month ||
		parsed.getUTCDate() !== day ||
		parsed.getUTCHours() !== hour ||
		parsed.getUTCMinutes() !== minute ||
		parsed.getUTCSeconds() !== second ||
		parsed.getUTCMilliseconds() !== millisecond
	) {
		return invalid(`${label} is not a valid timestamp`);
	}
	return { ok: true, value };
}

function canonicalSlug(value: string, label: string): MemoryResult<string> {
	const normalized = value.normalize("NFC").trim().toLowerCase();
	const slug = normalized.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
	if (slug.length === 0) return invalid(`${label} must contain at least one letter or number`);
	return { ok: true, value: slug };
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function citationValue(value: unknown, label: string): MemoryResult<MemoryCitation> {
	if (!isRecord(value)) return invalid(`${label} is malformed`);
	if (
		typeof value.uri !== "string" ||
		typeof value.relPath !== "string" ||
		typeof value.heading !== "string" ||
		typeof value.updatedAt !== "string" ||
		typeof value.digest !== "string" ||
		typeof value.startLine !== "number" ||
		typeof value.endLine !== "number" ||
		!Number.isInteger(value.startLine) ||
		!Number.isInteger(value.endLine) ||
		!isOneOf(value.scope, SCOPES) ||
		!isOneOf(value.authority, AUTHORITY_TIERS) ||
		!isOneOf(value.volatility, VOLATILITIES)
	) {
		return invalid(`${label} has malformed fields`);
	}
	if (value.uri.normalize("NFC").trim().length === 0) return invalid(`${label} URI must be non-empty`);
	const parsedUri = parseMemoryUri(value.uri);
	if (!parsedUri.ok) return invalid(`${label} URI is not canonical`);
	if (parsedUri.value.scheme !== value.scope) return invalid(`${label} URI scope does not match citation scope`);
	const updatedAt = strictTimestamp(value.updatedAt, `${label} updatedAt`);
	if (!updatedAt.ok) return updatedAt;
	if (value.startLine < 1 || value.endLine < value.startLine) return invalid(`${label} has an invalid line range`);
	return {
		ok: true,
		value: Object.freeze({
			uri: parsedUri.value.href,
			scope: value.scope,
			relPath: value.relPath.normalize("NFC"),
			heading: value.heading.normalize("NFC"),
			startLine: value.startLine,
			endLine: value.endLine,
			authority: value.authority,
			volatility: value.volatility,
			updatedAt: updatedAt.value,
			digest: value.digest.normalize("NFC"),
		}),
	};
}

function sectionValue(value: unknown, index: number): MemoryResult<MarkdownSection> {
	if (!isRecord(value)) return invalid(`section ${index} is malformed`);
	if (
		typeof value.heading !== "string" ||
		typeof value.slug !== "string" ||
		typeof value.body !== "string" ||
		typeof value.content !== "string" ||
		typeof value.level !== "number" ||
		typeof value.startLine !== "number" ||
		typeof value.endLine !== "number" ||
		typeof value.bodyStartLine !== "number" ||
		typeof value.bodyEndLine !== "number" ||
		!Number.isInteger(value.level) ||
		!Number.isInteger(value.startLine) ||
		!Number.isInteger(value.endLine) ||
		!Number.isInteger(value.bodyStartLine) ||
		!Number.isInteger(value.bodyEndLine)
	) {
		return invalid(`section ${index} has malformed fields`);
	}
	const heading = value.heading.normalize("NFC").trim();
	const slug = value.slug.normalize("NFC").trim();
	if (heading.length === 0 || slug.length === 0) return invalid(`section ${index} heading and slug must be non-empty`);
	if (value.level < 1 || value.level > 6 || value.startLine < 1 || value.endLine < value.startLine) {
		return invalid(`section ${index} has an invalid heading range`);
	}
	return {
		ok: true,
		value: Object.freeze({
			heading,
			slug,
			level: value.level,
			startLine: value.startLine,
			endLine: value.endLine,
			bodyStartLine: value.bodyStartLine,
			bodyEndLine: value.bodyEndLine,
			body: value.body.replace(/\r\n?/g, "\n").normalize("NFC"),
			content: value.content.replace(/\r\n?/g, "\n").normalize("NFC"),
		}),
	};
}

function documentValue(value: unknown): MemoryResult<ParsedMemoryDocument> {
	if (!isRecord(value)) return invalid("document is malformed");
	if (!isRecord(value.metadata)) return invalid("document metadata is malformed");
	const metadata = value.metadata;
	if (
		typeof metadata.id !== "string" ||
		typeof metadata.updated !== "string" ||
		!isOneOf(metadata.type, DOCUMENT_TYPES) ||
		!isOneOf(metadata.scope, SCOPES) ||
		!isOneOf(metadata.authority, AUTHORITY_TIERS) ||
		!isOneOf(metadata.volatility, VOLATILITIES)
	) {
		return invalid("document metadata has malformed fields");
	}
	const id = metadata.id.normalize("NFC").trim();
	if (id.length === 0) return invalid("document metadata id must be non-empty");
	const updated = strictTimestamp(metadata.updated, "document updated");
	if (!updated.ok) return updated;
	if (
		metadata.aliases !== undefined &&
		(!Array.isArray(metadata.aliases) || metadata.aliases.some(alias => typeof alias !== "string"))
	) {
		return invalid("document aliases are malformed");
	}
	if (typeof value.body !== "string") return invalid("document body must be a string");
	if (!Array.isArray(value.sections)) return invalid("document sections must be an array");
	const sections: MarkdownSection[] = [];
	for (const [index, section] of value.sections.entries()) {
		const normalized = sectionValue(section, index);
		if (!normalized.ok) return normalized;
		sections.push(normalized.value);
	}
	const citation = citationValue(value.citation, "document citation");
	if (!citation.ok) return citation;
	if (value.citations !== undefined && !Array.isArray(value.citations))
		return invalid("document citations must be an array");
	const citations: MemoryCitation[] = [];
	if (Array.isArray(value.citations)) {
		for (const [index, candidate] of value.citations.entries()) {
			const normalized = citationValue(candidate, `document citation ${index}`);
			if (!normalized.ok) return normalized;
			citations.push(normalized.value);
		}
	}
	const normalizedMetadata = Object.freeze({ ...metadata, id, updated: updated.value });
	return {
		ok: true,
		value: Object.freeze({
			...value,
			metadata: normalizedMetadata,
			frontmatter: normalizedMetadata,
			body: value.body.replace(/\r\n?/g, "\n").normalize("NFC"),
			sections: Object.freeze(sections),
			citation: citation.value,
			citations: Object.freeze(citations),
		}) as ParsedMemoryDocument,
	};
}

function citationsFromContext(
	document: ParsedMemoryDocument,
	context: ClaimCitationInput | undefined,
): MemoryResult<{ readonly citations: readonly MemoryCitation[]; readonly source: MemoryCitation | null }> {
	if (context === undefined) {
		return {
			ok: true,
			value: { citations: document.citations, source: null },
		};
	}
	if (Array.isArray(context)) {
		const citations: MemoryCitation[] = [];
		for (const [index, candidate] of context.entries()) {
			const normalized = citationValue(candidate, `citation context ${index}`);
			if (!normalized.ok) return normalized;
			citations.push(normalized.value);
		}
		return { ok: true, value: { citations, source: null } };
	}
	if (!isRecord(context)) return invalid("citation context is malformed");
	let citations: readonly MemoryCitation[] = [];
	if (context.citations !== undefined) {
		if (!Array.isArray(context.citations)) return invalid("citation context citations must be an array");
		const normalized: MemoryCitation[] = [];
		for (const [index, candidate] of context.citations.entries()) {
			const citation = citationValue(candidate, `citation context ${index}`);
			if (!citation.ok) return citation;
			normalized.push(citation.value);
		}
		citations = normalized;
	}
	let source: MemoryCitation | null = null;
	if (context.source !== undefined) {
		const normalized = citationValue(context.source, "citation context source");
		if (!normalized.ok) return normalized;
		source = normalized.value;
	}
	return { ok: true, value: { citations, source } };
}

function sectionCitation(base: MemoryCitation, section: MarkdownSection): MemoryCitation {
	return Object.freeze({
		...base,
		heading: section.heading,
		startLine: section.startLine,
		endLine: section.endLine,
	});
}

/** Extract one deterministic claim per parsed section, or one document-level claim when sectionless. */
export function extractClaims(
	document: ParsedMemoryDocument,
	citationContext?: ClaimCitationInput,
): MemoryResult<readonly MemoryClaim[]> {
	const normalizedDocument = documentValue(document);
	if (!normalizedDocument.ok) return normalizedDocument;
	const parsed = normalizedDocument.value;
	const context = citationsFromContext(parsed, citationContext);
	if (!context.ok) return context;
	const metadata = parsed.metadata;
	const claims: MemoryClaim[] = [];
	const seen = new Set<string>();
	const sections = parsed.sections;
	if (sections.length === 0) {
		const keyPart = canonicalSlug(metadata.id, "document id");
		if (!keyPart.ok) return keyPart;
		const text = boundedClaimValue(parsed.body, metadata.id);
		const claimKey = `${metadata.type}.${keyPart.value}`;
		const source = context.value.source ?? context.value.citations[0] ?? parsed.citation;
		const claim: MemoryClaim = Object.freeze({
			claimKey,
			text,
			type: metadata.type,
			authority: metadata.authority,
			freshness: metadata.updated,
			volatility: metadata.volatility,
			source: Object.freeze({ ...source }),
		});
		return { ok: true, value: Object.freeze([claim]) };
	}
	for (const [index, section] of sections.entries()) {
		const keyPart = canonicalSlug(section.slug, `section ${index} slug`);
		if (!keyPart.ok) return keyPart;
		const claimKey = `${metadata.type}.${keyPart.value}`;
		if (seen.has(claimKey)) return invalid(`duplicate claim key ${claimKey}`);
		seen.add(claimKey);
		const base = context.value.citations[index] ?? context.value.source ?? parsed.citations[index] ?? parsed.citation;
		const source = sectionCitation(base, section);
		const text = boundedClaimValue(section.body, section.heading);
		claims.push(
			Object.freeze({
				claimKey,
				text,
				type: metadata.type,
				authority: metadata.authority,
				freshness: metadata.updated,
				volatility: metadata.volatility,
				source,
			}),
		);
	}
	claims.sort(
		(left, right) =>
			compareUtf8(left.claimKey, right.claimKey) ||
			compareUtf8(left.source.uri, right.source.uri) ||
			compareUtf8(left.text, right.text),
	);
	return { ok: true, value: Object.freeze(claims) };
}
