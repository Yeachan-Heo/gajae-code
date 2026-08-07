import type { MemoryDocumentMetadata } from "../documents/frontmatter";
import { invalidInput, type MemoryResult } from "../errors";
import type { MemoryDocumentType, MemoryIntent } from "../index";
import { type AliasDefinition, expandAliases, normalizeAlias } from "./alias-expansion";
import { tokenizeLexical } from "./lexical-search";

export interface MetadataSearchDocument {
	readonly uri: string;
	readonly metadata?: Pick<MemoryDocumentMetadata, "aliases" | "type">;
	readonly aliases?: readonly string[];
	readonly type?: MemoryDocumentType | string;
	readonly intents?: readonly MemoryIntent[] | readonly string[];
}

export interface MetadataSearchHit {
	readonly uri: string;
	readonly score: number;
	readonly matchedFields: readonly ("alias" | "type" | "intent")[];
	readonly matchedAliases: readonly string[];
}

export interface MetadataSearchResult {
	readonly hits: readonly MetadataSearchHit[];
	readonly candidateCount: number;
}

const SCORE_SCALE = 1_000_000;
const MAX_ALIAS_EXPANSIONS = 64;

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`metadata search: ${detail}`);
}

function normalizedText(value: string): string {
	return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function normalizedSet(values: readonly string[] | undefined): readonly string[] {
	if (values === undefined) return [];
	const normalized = values
		.filter(value => typeof value === "string")
		.map(value => normalizedText(value))
		.filter(value => value.length > 0);
	return [...new Set(normalized)].sort(compareUtf8);
}

function tokenOverlap(queryTokens: readonly string[], value: string): number {
	if (queryTokens.length === 0 || value.length === 0) return 0;
	const valueTokens = new Set(tokenizeLexical(value));
	if (valueTokens.size === 0) return 0;
	let matches = 0;
	for (const token of new Set(queryTokens)) if (valueTokens.has(token)) matches += 1;
	return matches / Math.max(queryTokens.length, valueTokens.size);
}

function typeScore(query: string, queryTokens: readonly string[], type: string): number {
	const normalizedType = normalizedText(type);
	if (normalizedType.length === 0) return 0;
	if (query === normalizedType) return SCORE_SCALE;
	const overlap = tokenOverlap(queryTokens, normalizedType);
	return overlap > 0 ? Math.round(overlap * 850_000) : 0;
}

function intentScore(
	query: string,
	queryTokens: readonly string[],
	intents: readonly string[],
): { readonly score: number; readonly matches: readonly string[] } {
	let score = 0;
	const matches: string[] = [];
	for (const intent of intents) {
		const normalizedIntent = normalizedText(intent);
		if (normalizedIntent.length === 0) continue;
		const current =
			query === normalizedIntent ? SCORE_SCALE : Math.round(tokenOverlap(queryTokens, normalizedIntent) * 900_000);
		if (current <= 0) continue;
		if (current > score) score = current;
		matches.push(normalizedIntent);
	}
	return { score, matches: Object.freeze([...new Set(matches)].sort(compareUtf8)) };
}

export interface MetadataSearchOptions {
	readonly intent?: MemoryIntent;
	readonly aliases?: readonly AliasDefinition[];
	readonly fuzzyAliases?: boolean;
}

function isAliasDefinitions(
	value: MetadataSearchOptions | readonly AliasDefinition[],
): value is readonly AliasDefinition[] {
	return Array.isArray(value);
}

/** Deterministic metadata matching over aliases, document type, and intent markers. */
export function metadataSearch(
	query: string,
	documents: readonly MetadataSearchDocument[],
	options: MetadataSearchOptions | readonly AliasDefinition[] = {},
): MemoryResult<MetadataSearchResult> {
	if (typeof query !== "string") return invalid("query must be a string");
	if (!Array.isArray(documents)) return invalid("documents must be an array");
	const canonicalQuery = normalizedText(query);
	const queryTokens = tokenizeLexical(canonicalQuery);
	const configured: MetadataSearchOptions = isAliasDefinitions(options)
		? { aliases: options, fuzzyAliases: true }
		: options;
	if (queryTokens.length === 0) return invalid("query must contain at least one letter or number");
	if (configured.intent !== undefined && typeof configured.intent !== "string")
		return invalid("intent must be a string");
	if (configured.aliases !== undefined && !Array.isArray(configured.aliases))
		return invalid("aliases must be an array");
	if (configured.fuzzyAliases !== undefined && typeof configured.fuzzyAliases !== "boolean")
		return invalid("fuzzyAliases must be boolean");

	const output: MetadataSearchHit[] = [];
	const seenUris = new Set<string>();
	for (const document of documents) {
		if (document === null || typeof document !== "object" || Array.isArray(document))
			return invalid("document must be an object");
		if (typeof document.uri !== "string") return invalid("document URI must be a string");
		const uri = document.uri.normalize("NFC");
		if (uri.length === 0) return invalid("document URI must not be empty");
		if (seenUris.has(uri)) return invalid(`duplicate document URI ${uri}`);
		seenUris.add(uri);
		const aliases = normalizedSet(document.aliases ?? document.metadata?.aliases);
		const type = typeof document.type === "string" ? document.type : document.metadata?.type;
		const intents = normalizedSet(document.intents);
		let score = 0;
		const fields: Array<"alias" | "type" | "intent"> = [];
		const matchedAliases: string[] = [];
		for (const alias of aliases) {
			const aliasScore =
				canonicalQuery === alias ? SCORE_SCALE : Math.round(tokenOverlap(queryTokens, alias) * 950_000);
			if (aliasScore <= 0) continue;
			if (aliasScore > score) score = aliasScore;
			matchedAliases.push(alias);
			if (!fields.includes("alias")) fields.push("alias");
		}
		if (configured.fuzzyAliases === true && aliases.length > 0) {
			const definitions = configured.aliases ?? aliases.map(alias => ({ term: alias, aliases: [alias] }));
			const expansions = expandAliases(
				canonicalQuery,
				definitions,
				Math.min(MAX_ALIAS_EXPANSIONS, definitions.length),
			);
			for (const expansion of expansions) {
				if (!aliases.includes(expansion.term) && !aliases.includes(expansion.alias)) continue;
				if (expansion.score > score) score = Math.round(expansion.score * 0.9);
				if (!fields.includes("alias")) fields.push("alias");
				if (!matchedAliases.includes(expansion.alias)) matchedAliases.push(expansion.alias);
			}
		}
		if (type !== undefined) {
			const current = typeScore(canonicalQuery, queryTokens, type);
			if (current > 0) {
				if (current > score) score = current;
				fields.push("type");
			}
		}
		const intentMatches = intentScore(canonicalQuery, queryTokens, intents);
		if (configured.intent !== undefined) {
			const requested = normalizedText(configured.intent);
			if (intents.includes(requested)) {
				if (SCORE_SCALE > score) score = SCORE_SCALE;
				fields.push("intent");
			}
		}
		if (intentMatches.score > 0) {
			if (intentMatches.score > score) score = intentMatches.score;
			fields.push("intent");
		}
		if (score <= 0) continue;
		output.push(
			Object.freeze({
				uri,
				score: Math.max(0, Math.min(SCORE_SCALE, Math.round(score))),
				matchedFields: Object.freeze([...new Set(fields)]),
				matchedAliases: Object.freeze([...new Set(matchedAliases)].sort(compareUtf8)),
			}),
		);
	}
	output.sort((left, right) => right.score - left.score || compareUtf8(left.uri, right.uri));
	return {
		ok: true,
		value: Object.freeze({
			hits: Object.freeze(output),
			candidateCount: documents.length,
		}),
	};
}

/** Normalize one metadata alias for callers constructing fixture documents. */
export { normalizeAlias };
