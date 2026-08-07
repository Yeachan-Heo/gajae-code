import { type ParsedMemoryDocument, parseMemoryDocument } from "../documents/document-parser";
import { serializeFrontmatter } from "../documents/frontmatter";
import type { MarkdownSection } from "../documents/markdown-sections";
import { parseMemoryUri } from "../documents/uri";
import type { MemoryEnvironment } from "../env";
import { MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import type { Sensitivity } from "../index";
import { verifyReadAccessGrant } from "../policy/access-policy";
import { scanSecretContent } from "../policy/secret-scan";
import { enforceSensitivity } from "../policy/sensitivity";
import { prepareReadableResource } from "../resources/resolve-readable-resource";
import { openVerifiedFile, VerifiedStorageError } from "../storage/verified-open";

const REDACTED_BODY = "[REDACTED]";

type LifecycleSensitivity = Sensitivity;

export interface InternalLifecycleDocument {
	readonly parsed: ParsedMemoryDocument;
	/**
	 * Canonical bytes are returned only for public-safe documents. Sensitive
	 * documents carry an explicitly redacted, parseable representation instead.
	 */
	readonly content: string;
	readonly sensitivity: LifecycleSensitivity;
	/** Original identity needed for lifecycle matching without serializing it. */
	readonly identity: {
		readonly id: string;
		readonly supersedes: readonly string[];
	};
}

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "global-canonical",
			reason,
		},
	};
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

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function readFailure(error: unknown): MemoryResult<never> {
	if (error instanceof VerifiedStorageError) return policyDenied(error.reason);
	return policyDenied(`internal lifecycle read failed: ${errorCode(error) ?? "verified-read-failed"}`);
}

function decodeUtf8(bytes: Buffer, relPath: string): MemoryResult<string> {
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		return { ok: true, value: decoder.decode(bytes) };
	} catch {
		return malformed(relPath, "document is not valid UTF-8");
	}
}

function sectionRedaction(section: MarkdownSection, ordinal: number): MarkdownSection {
	const heading = `Section ${ordinal}`;
	const content = `${heading}\n${REDACTED_BODY}`;
	return Object.freeze({
		...section,
		heading,
		slug: `section-${ordinal}`,
		body: REDACTED_BODY,
		content,
	});
}

function redactedParsedDocument(parsed: ParsedMemoryDocument): ParsedMemoryDocument {
	const metadata = Object.freeze({
		...parsed.metadata,
		id: "redacted",
		aliases: Object.freeze([]),
		supersedes: Object.freeze([]),
		verification: null,
	});
	const sections = Object.freeze(parsed.sections.map((section, index) => sectionRedaction(section, index + 1)));
	const citations = Object.freeze(
		parsed.citations.map((citation, index) => Object.freeze({ ...citation, heading: `Section ${index + 1}` })),
	);
	const content = `${serializeFrontmatter(metadata)}\n${REDACTED_BODY}`.normalize("NFC");
	return Object.freeze({
		...parsed,
		metadata,
		frontmatter: metadata,
		content,
		normalizedContent: content,
		body: REDACTED_BODY,
		sections,
		citations,
	});
}

function lifecycleDocument(parsed: ParsedMemoryDocument): InternalLifecycleDocument {
	const identity = Object.freeze({
		id: parsed.metadata.id,
		supersedes: Object.freeze([...parsed.metadata.supersedes]),
	});
	if (parsed.metadata.sensitivity === "public-safe") {
		return Object.freeze({ parsed, content: parsed.content, sensitivity: parsed.metadata.sensitivity, identity });
	}
	const redacted = redactedParsedDocument(parsed);
	return Object.freeze({
		parsed: redacted,
		content: redacted.content,
		sensitivity: parsed.metadata.sensitivity,
		identity,
	});
}

/**
 * Read one canonical document for lifecycle bookkeeping. This deliberately
 * reuses the public reader's admission and verified-storage chokepoints, but
 * does not apply its public-safe-only disclosure gate. Sensitive body bytes
 * are scanned and then replaced before they can reach proposal construction.
 */
export async function readInternalLifecycleDocument(
	environment: MemoryEnvironment,
	uri: string,
): Promise<MemoryResult<InternalLifecycleDocument>> {
	const parsedUri = parseMemoryUri(uri);
	if (!parsedUri.ok) return parsedUri;
	const prepared = prepareReadableResource(environment, parsedUri.value.href);
	if (!prepared.ok) return prepared;
	const verified = verifyReadAccessGrant(prepared.value.grant, prepared.value.absolutePath, prepared.value.scope);
	if (!verified.ok) return verified;
	let bytes: Buffer;
	try {
		bytes = openVerifiedFile(verified.value.root, verified.value.relativePath);
	} catch (error) {
		return readFailure(error);
	}
	const decoded = decodeUtf8(bytes, prepared.value.relPath);
	if (!decoded.ok) return decoded;
	const parsed = parseMemoryDocument({
		content: decoded.value,
		relPath: prepared.value.relPath,
		uri: prepared.value.uri.href,
		includeExcluded: true,
	});
	if (!parsed.ok) return parsed;
	if (
		parsed.value.uri.scheme !== prepared.value.scope ||
		parsed.value.uri.path.join("/") !== prepared.value.uri.path.join("/") ||
		parsed.value.uri.fragment !== prepared.value.uri.fragment
	) {
		return malformed(prepared.value.relPath, "document URI does not match the requested resource");
	}
	const scanned = scanSecretContent(parsed.value.content);
	if (!scanned.ok) return scanned;
	const sensitivity = enforceSensitivity(
		"global-canonical",
		parsed.value.metadata.sensitivity,
		scanned.value.findings,
	);
	if (!sensitivity.ok) return sensitivity;
	return { ok: true, value: lifecycleDocument(parsed.value) };
}
