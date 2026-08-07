import { MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import { normalizeDocumentText } from "./frontmatter";

export interface MarkdownSection {
	readonly heading: string;
	readonly slug: string;
	readonly level: number;
	readonly startLine: number;
	readonly endLine: number;
	readonly bodyStartLine: number;
	readonly bodyEndLine: number;
	readonly body: string;
	readonly content: string;
}

interface Heading {
	readonly heading: string;
	readonly level: number;
	readonly line: number;
}

interface Fence {
	readonly character: "`" | "~";
	readonly length: number;
}

function malformed(detail: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "malformed-document",
			exitCode: MEMORY_EXIT_CODES.malformedDocument,
			relPath: "<memory-document>",
			detail,
		},
	};
}

function slugBase(heading: string): string {
	const normalized = heading.normalize("NFC").toLowerCase();
	const slug = normalized.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "section";
}

export function slugifyHeading(heading: string, ordinal = 1): string {
	const base = slugBase(heading);
	return ordinal > 1 ? `${base}-${ordinal}` : base;
}

function openingFence(line: string): Fence | null {
	const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
	if (match === null) return null;
	const run = match[2];
	const character = run[0] as "`" | "~";
	return { character, length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
	const escaped = fence.character === "`" ? "`" : "~";
	const pattern = new RegExp(`^ {0,3}(${escaped}{${fence.length},})[ \\t]*$`);
	const match = pattern.exec(line);
	return match !== null && match[1][0] === fence.character;
}

function headingAt(line: string, localLine: number): Heading | null {
	const match = /^( {0,3})(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
	if (match === null) return null;
	const heading = match[3].normalize("NFC").trim();
	if (heading.length === 0) return null;
	return { heading, level: match[2].length, line: localLine };
}

function sectionBody(lines: readonly string[], start: number, end: number): string {
	if (start > end) return "";
	return lines.slice(start, end + 1).join("\n");
}

export function parseMarkdownSections(content: string, lineOffset = 0): MemoryResult<readonly MarkdownSection[]> {
	if (typeof content !== "string") return malformed("document content must be a string");
	if (!Number.isInteger(lineOffset) || lineOffset < 0) return malformed("lineOffset must be a non-negative integer");
	const normalized = normalizeDocumentText(content);
	const lines = normalized.split("\n");
	const headings: Heading[] = [];
	let fence: Fence | null = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (fence !== null) {
			if (closesFence(line, fence)) fence = null;
			continue;
		}
		const candidateFence = openingFence(line);
		if (candidateFence !== null) {
			fence = candidateFence;
			continue;
		}
		const heading = headingAt(line, index);
		if (heading !== null) headings.push(heading);
	}
	const slugCounts = new Map<string, number>();
	const sections: MarkdownSection[] = [];
	for (let index = 0; index < headings.length; index += 1) {
		const current = headings[index];
		let end = lines.length - 1;
		for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
			if (headings[nextIndex].level <= current.level) {
				end = headings[nextIndex].line - 1;
				break;
			}
		}
		const base = slugBase(current.heading);
		const ordinal = (slugCounts.get(base) ?? 0) + 1;
		slugCounts.set(base, ordinal);
		const start = current.line;
		const bodyStart = start + 1;
		const bodyEnd = end;
		const body = sectionBody(lines, bodyStart, bodyEnd);
		const contentSlice = sectionBody(lines, start, end);
		sections.push(
			Object.freeze({
				heading: current.heading,
				slug: slugifyHeading(current.heading, ordinal),
				level: current.level,
				startLine: start + 1 + lineOffset,
				endLine: end + 1 + lineOffset,
				bodyStartLine: bodyStart + 1 + lineOffset,
				bodyEndLine: bodyEnd + 1 + lineOffset,
				body,
				content: contentSlice,
			}),
		);
	}
	return { ok: true, value: Object.freeze(sections) };
}
