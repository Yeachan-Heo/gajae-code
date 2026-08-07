export interface AliasDefinition {
	readonly term: string;
	readonly aliases: readonly string[];
}

export type AliasExpansionReason = "exact" | "fuzzy";

export interface AliasExpansion {
	readonly term: string;
	readonly alias: string;
	readonly score: number;
	readonly reason: AliasExpansionReason;
}

const MAX_EXPANSIONS = 64;
const SCORE_SCALE = 1_000_000;

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function splitCamelCase(value: string): string {
	return value.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2").replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2");
}

/** Normalize aliases without locale- or runtime-dependent collation. */
export function normalizeAlias(value: string): string {
	if (typeof value !== "string") return "";
	return splitCamelCase(value.normalize("NFC"))
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function compact(value: string): string {
	return value.replace(/ /g, "");
}

function singular(value: string): string {
	if (value.endsWith("ies") && value.length > 3) return `${value.slice(0, -3)}y`;
	if (value.endsWith("ses") && value.length > 3) return value.slice(0, -2);
	if (value.endsWith("s") && !value.endsWith("ss") && value.length > 2) return value.slice(0, -1);
	return value;
}

function forms(value: string): readonly string[] {
	const normalized = normalizeAlias(value);
	if (normalized.length === 0) return [];
	const values = [normalized, compact(normalized), singular(normalized), compact(singular(normalized))];
	return Object.freeze([...new Set(values)]);
}

function tokenSet(value: string): ReadonlySet<string> {
	return new Set(value.split(" ").filter(token => token.length > 0));
}

function boundedEditDistance(left: string, right: string, bound: number): number {
	if (Math.abs(left.length - right.length) > bound) return bound + 1;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		const current = [leftIndex];
		let rowMinimum = current[0];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
			const insertion = current[rightIndex - 1] + 1;
			const deletion = previous[rightIndex] + 1;
			const distance = Math.min(substitution, insertion, deletion);
			current.push(distance);
			rowMinimum = Math.min(rowMinimum, distance);
		}
		if (rowMinimum > bound) return bound + 1;
		previous = current;
	}
	return previous[right.length];
}

function tokenSimilarity(left: string, right: string): number {
	const leftTokens = tokenSet(left);
	const rightTokens = tokenSet(right);
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	let intersection = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
	const union = leftTokens.size + rightTokens.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

function similarity(query: string, candidate: string): number {
	if (query === candidate || compact(query) === compact(candidate)) return SCORE_SCALE;
	const maxLength = Math.max(query.length, candidate.length);
	if (maxLength === 0) return 0;
	const bound = Math.min(3, Math.max(1, Math.ceil(maxLength * 0.25)));
	const distance = boundedEditDistance(compact(query), compact(candidate), bound);
	const editScore = distance <= bound ? 1 - distance / Math.max(1, maxLength) : 0;
	const overlapScore = tokenSimilarity(query, candidate) * 0.85;
	const value = Math.max(editScore, overlapScore);
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.max(1, Math.min(SCORE_SCALE - 1, Math.round(value * SCORE_SCALE)));
}

function bestExpansion(query: string, definition: AliasDefinition): AliasExpansion | null {
	if (typeof query !== "string") return null;
	if (typeof definition !== "object" || definition === null || Array.isArray(definition)) return null;
	if (typeof definition.term !== "string" || !Array.isArray(definition.aliases)) return null;
	const term = normalizeAlias(definition.term);
	if (term.length === 0) return null;
	const normalizedQuery = normalizeAlias(query);
	const aliases = [term, ...definition.aliases.map(normalizeAlias)].filter(alias => alias.length > 0);
	const uniqueAliases = [...new Set(aliases)];
	let best: AliasExpansion | null = null;
	for (const alias of uniqueAliases) {
		const aliasForms = forms(alias);
		const queryForms = forms(query);
		let score = 0;
		for (const queryForm of queryForms) {
			for (const aliasForm of aliasForms) score = Math.max(score, similarity(queryForm, aliasForm));
		}
		if (score <= 0) continue;
		const reason: AliasExpansionReason = normalizedQuery === alias ? "exact" : "fuzzy";
		const candidate: AliasExpansion = { term, alias, score, reason };
		if (
			best === null ||
			candidate.score > best.score ||
			(candidate.score === best.score && compareUtf8(candidate.alias, best.alias) < 0)
		) {
			best = candidate;
		}
	}
	return best;
}

/** Return a bounded, deterministic set of normalized exact and fuzzy alias matches. */
export function expandAliases(
	query: string,
	definitions: readonly AliasDefinition[],
	limit: number,
): readonly AliasExpansion[] {
	if (typeof query !== "string" || !Array.isArray(definitions)) return Object.freeze([]);
	if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) return Object.freeze([]);
	const boundedLimit = Math.min(MAX_EXPANSIONS, limit);
	const uniqueExpansions = new Map<string, AliasExpansion>();
	for (const definition of definitions) {
		const expansion = bestExpansion(query, definition);
		if (expansion === null) continue;
		const key = `${expansion.term}\u0000${expansion.alias}`;
		if (!uniqueExpansions.has(key)) uniqueExpansions.set(key, expansion);
	}
	const expansions = [...uniqueExpansions.values()];
	expansions.sort(
		(left, right) =>
			right.score - left.score || compareUtf8(left.term, right.term) || compareUtf8(left.alias, right.alias),
	);
	return Object.freeze(expansions.slice(0, boundedLimit).map(expansion => Object.freeze(expansion)));
}
