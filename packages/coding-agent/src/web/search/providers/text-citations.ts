/**
 * Inline citation extraction shared by native web-search providers.
 *
 * Web-search-capable models sometimes return a genuinely grounded answer whose
 * sources are written inline (markdown links or bare URLs) instead of as
 * structured citation annotations. When a provider has independent proof that a
 * web search actually ran, these helpers recover sources from the answer text so
 * the result is not discarded.
 */
import type { SearchSource } from "../types";

/** Append a source, de-duplicating by URL. */
export function addSource(sources: SearchSource[], source: SearchSource): void {
	if (!sources.some(existing => existing.url === source.url)) {
		sources.push(source);
	}
}

function countCharacter(text: string, target: string): number {
	let count = 0;
	for (const char of text) {
		if (char === target) count += 1;
	}
	return count;
}

/**
 * Strips prose punctuation and unmatched closing delimiters from extracted URLs.
 * Models often return links embedded in markdown or sentence text.
 */
export function normalizeExtractedUrl(candidate: string): string | null {
	let url = candidate.trim();

	while (url.length > 0) {
		const lastCharacter = url.at(-1);
		if (!lastCharacter) break;
		if (/[.,!?;:'"]/u.test(lastCharacter)) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === ")" && countCharacter(url, ")") > countCharacter(url, "(")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "]" && countCharacter(url, "]") > countCharacter(url, "[")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "}" && countCharacter(url, "}") > countCharacter(url, "{")) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}

	if (!/^https?:\/\//.test(url)) return null;

	try {
		return new URL(url).toString();
	} catch {
		return null;
	}
}

function findMarkdownLinkUrlEnd(text: string, openParenIndex: number): number | null {
	let depth = 0;

	for (let index = openParenIndex; index < text.length; index += 1) {
		const character = text[index];
		if (!character || character === "\n") return null;
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") continue;
		depth -= 1;
		if (depth === 0) return index;
		if (depth < 0) return null;
	}

	return null;
}

/**
 * Extracts citation sources from markdown links and bare URLs in answer text.
 * Used only as a fallback when a provider confirms a search ran but omits
 * structured citation annotations.
 */
export function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];

	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "[") continue;
		const titleEnd = text.indexOf("]", index + 1);
		if (titleEnd === -1 || text[titleEnd + 1] !== "(") continue;
		const urlEnd = findMarkdownLinkUrlEnd(text, titleEnd + 1);
		if (urlEnd === null) continue;
		const title = text.slice(index + 1, titleEnd).trim();
		const url = normalizeExtractedUrl(text.slice(titleEnd + 2, urlEnd));
		if (url) addSource(sources, { title: title || url, url });
		index = urlEnd;
	}

	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		const url = normalizeExtractedUrl(match[0] ?? "");
		if (!url) continue;
		addSource(sources, { title: url, url });
	}

	return sources;
}
