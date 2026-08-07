import type { ParsedMemoryDocument } from "../documents/document-parser";
import type { MemoryDocumentMetadata, ParsedFrontmatter } from "../documents/frontmatter";
import { normalizeDocumentText, parseFrontmatter, serializeFrontmatter } from "../documents/frontmatter";

import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";

export interface SupersessionCandidate {
	readonly uri: string;
	readonly relPath: string;
	readonly content: string;
	readonly digest: string;
	readonly metadata: MemoryDocumentMetadata;
	readonly identityId?: string;
	readonly supersedes?: readonly string[];
}

export interface SupersededDocumentMutation {
	readonly schemaVersion: "gajae.memory.supersession.v1";
	readonly uri: string;
	readonly relPath: string;
	readonly expectedDigest: string;
	readonly content: string;
	readonly supersededBy: string;
	readonly marker: string;
}

export interface SupersessionPlanInput {
	readonly newUri: string;
	readonly newDocument: ParsedMemoryDocument;
	readonly supersedes: readonly string[];
	readonly candidates: readonly SupersessionCandidate[];
	readonly updatedAt?: string;
}

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`supersession: ${detail}`);
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function normalize(value: string): string {
	return value.normalize("NFC").trim();
}

function candidateIdentities(candidate: SupersessionCandidate): readonly string[] {
	const uriPath = candidate.uri.split("#", 1)[0] ?? candidate.uri;
	const base = uriPath.split("/").at(-1) ?? "";
	const withoutExtension = base.replace(/\.md$/iu, "");
	return Object.freeze(
		[candidate.uri, candidate.relPath, candidate.identityId ?? candidate.metadata.id, withoutExtension]
			.map(normalize)
			.filter(value => value.length > 0)
			.sort(compareUtf8),
	);
}

function referenceMatches(reference: string, candidate: SupersessionCandidate): boolean {
	const normalized = normalize(reference);
	return candidateIdentities(candidate).some(identity => identity === normalized);
}

function candidateByReference(
	reference: string,
	candidates: readonly SupersessionCandidate[],
): SupersessionCandidate | null {
	const matches = candidates.filter(candidate => referenceMatches(reference, candidate));
	if (matches.length === 0) return null;
	matches.sort((left, right) => compareUtf8(left.uri, right.uri));
	return matches[0] ?? null;
}

function metadataFromFrontmatter(
	frontmatter: ParsedFrontmatter,
	status: "active" | "superseded",
	updated: string,
): MemoryDocumentMetadata {
	return Object.freeze({
		...frontmatter.metadata,
		status,
		updated,
		supersedes: Object.freeze([...frontmatter.metadata.supersedes]),
		aliases: Object.freeze([...frontmatter.metadata.aliases]),
	});
}

function mutationContent(
	candidate: SupersessionCandidate,
	_supersededBy: string,
	updatedAt: string,
	marker: string,
): MemoryResult<string> {
	const parsed = parseFrontmatter(candidate.content, candidate.relPath);
	if (!parsed.ok) return parsed;
	const metadata = metadataFromFrontmatter(parsed.value, "superseded", updatedAt);
	const body = normalizeDocumentText(parsed.value.body);
	const nextBody = body.includes(marker) ? body : body.length === 0 ? marker : `${body}\n\n${marker}`;
	return { ok: true, value: `${serializeFrontmatter(metadata)}\n${nextBody}`.normalize("NFC") };
}

function graphKey(candidate: SupersessionCandidate): string {
	return normalize(candidate.uri);
}

function graphReferences(
	candidate: SupersessionCandidate,
	candidates: readonly SupersessionCandidate[],
): readonly string[] {
	return Object.freeze(
		(candidate.supersedes ?? candidate.metadata.supersedes)
			.map(reference => candidateByReference(reference, candidates))
			.filter((value): value is SupersessionCandidate => value !== null)
			.map(graphKey),
	);
}

function hasCycle(
	key: string,
	graph: ReadonlyMap<string, readonly string[]>,
	visiting: Set<string>,
	visited: Set<string>,
): boolean {
	if (visiting.has(key)) return true;
	if (visited.has(key)) return false;
	visiting.add(key);
	for (const next of graph.get(key) ?? []) if (hasCycle(next, graph, visiting, visited)) return true;
	visiting.delete(key);
	visited.add(key);
	return false;
}

function cycleGraph(
	newUri: string,
	supersedes: readonly string[],
	newDocument: ParsedMemoryDocument,
	candidates: readonly SupersessionCandidate[],
): ReadonlyMap<string, readonly string[]> {
	const graph = new Map<string, readonly string[]>();
	for (const candidate of candidates) graph.set(graphKey(candidate), graphReferences(candidate, candidates));
	const newKey = normalize(newUri);
	const newReferences = supersedes
		.map(reference => candidateByReference(reference, candidates))
		.filter((value): value is SupersessionCandidate => value !== null)
		.map(graphKey);
	const ownReferences = newDocument.metadata.supersedes
		.map(reference => candidateByReference(reference, candidates))
		.filter((value): value is SupersessionCandidate => value !== null)
		.map(graphKey);
	graph.set(newKey, Object.freeze([...new Set([...newReferences, ...ownReferences])]));
	return graph;
}

/** Detect an existing or newly introduced supersession cycle without mutating storage. */
export function detectSupersessionCycle(input: SupersessionPlanInput): MemoryResult<true> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid("input is malformed");
	if (
		input.newDocument === null ||
		typeof input.newDocument !== "object" ||
		input.newDocument.metadata === null ||
		typeof input.newDocument.metadata !== "object"
	) {
		return invalid("new document is malformed");
	}
	if (typeof input.newUri !== "string" || input.newUri.trim().length === 0) return invalid("new URI is required");
	if (!Array.isArray(input.supersedes) || !Array.isArray(input.candidates)) return invalid("references are malformed");
	const graph = cycleGraph(input.newUri, input.supersedes, input.newDocument, input.candidates);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	for (const key of [...graph.keys()].sort(compareUtf8)) {
		if (hasCycle(key, graph, visiting, visited)) {
			return {
				ok: false,
				error: {
					code: "malformed-document",
					exitCode: MEMORY_EXIT_CODES.malformedDocument,
					relPath: input.newUri,
					detail: "supersession cycle detected",
				},
			};
		}
	}
	return { ok: true, value: true };
}

/** Build the status-transition mutations for every explicitly superseded document. */
export function buildSupersessionMutations(
	input: SupersessionPlanInput,
): MemoryResult<readonly SupersededDocumentMutation[]> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid("input is malformed");
	if (typeof input.newUri !== "string" || input.newUri.trim().length === 0) return invalid("new URI is required");
	if (!Array.isArray(input.supersedes) || !Array.isArray(input.candidates)) return invalid("references are malformed");
	const cycle = detectSupersessionCycle(input);
	if (!cycle.ok) return cycle;
	const updatedAt = input.updatedAt ?? input.newDocument.metadata.updated;
	const selected: SupersessionCandidate[] = [];
	for (const reference of input.supersedes) {
		if (typeof reference !== "string" || normalize(reference).length === 0)
			return invalid("supersession reference is empty");
		const candidate = candidateByReference(reference, input.candidates);
		if (candidate === null) return invalid(`superseded document was not found: ${reference}`);
		if (candidate.uri === input.newUri) return invalid("a document cannot supersede itself");
		if (!selected.some(item => item.uri === candidate.uri)) selected.push(candidate);
	}
	selected.sort((left, right) => compareUtf8(left.uri, right.uri));
	const mutations: SupersededDocumentMutation[] = [];
	for (const candidate of selected) {
		const marker = `<!-- gajae: superseded-by ${normalize(input.newUri)} -->`;
		const content = mutationContent(candidate, input.newUri, updatedAt, marker);
		if (!content.ok) return content;
		mutations.push(
			Object.freeze({
				schemaVersion: "gajae.memory.supersession.v1",
				uri: normalize(candidate.uri),
				relPath: normalize(candidate.relPath),
				expectedDigest: candidate.digest,
				content: content.value,
				supersededBy: normalize(input.newUri),
				marker,
			}),
		);
	}
	return { ok: true, value: Object.freeze(mutations) };
}

/** Build a tombstone mutation while retaining the original document bytes as history. */
export function buildTombstoneMutation(
	candidate: SupersessionCandidate,
	updatedAt: string,
	reason?: string,
): MemoryResult<SupersededDocumentMutation> {
	if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
		return invalid("candidate is malformed");
	const normalizedReason = reason === undefined ? "forgotten" : normalize(reason);
	if (normalizedReason.length === 0 || /[\r\n]/u.test(normalizedReason)) return invalid("tombstone reason is invalid");
	const marker = `<!-- gajae: tombstone ${normalizedReason} -->`;
	const parsed = parseFrontmatter(candidate.content, candidate.relPath);
	if (!parsed.ok) return parsed;
	const metadata = metadataFromFrontmatter(parsed.value, "superseded", updatedAt);
	const body = normalizeDocumentText(parsed.value.body);
	const content =
		`${serializeFrontmatter(metadata)}\n${body.includes(marker) ? body : body.length === 0 ? marker : `${body}\n\n${marker}`}`.normalize(
			"NFC",
		);
	return {
		ok: true,
		value: Object.freeze({
			schemaVersion: "gajae.memory.supersession.v1",
			uri: normalize(candidate.uri),
			relPath: normalize(candidate.relPath),
			expectedDigest: candidate.digest,
			content,
			supersededBy: "",
			marker,
		}),
	};
}

export function supersessionCandidateFromDocument(
	document: ParsedMemoryDocument,
	content: string,
	identityId = document.metadata.id,
	supersedes: readonly string[] = document.metadata.supersedes,
): SupersessionCandidate {
	return Object.freeze({
		uri: document.uri.href,
		relPath: document.citation.relPath,
		content: normalizeDocumentText(content),
		digest: document.digest,
		metadata: document.metadata,
		identityId,
		supersedes: Object.freeze([...supersedes]),
	});
}
