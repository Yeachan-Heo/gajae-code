import { invalidInput, type MemoryResult } from "../errors";
import type { MemoryIntent } from "../index";

const APPROVED_MARKERS = [
	["<!-- AUTO:PROJECTS START -->", "<!-- AUTO:PROJECTS END -->"],
	["<!-- AUTO:INDEX-HEALTH START -->", "<!-- AUTO:INDEX-HEALTH END -->"],
] as const;

const MEMORY_INTENTS = [
	"user-preference",
	"project-convention",
	"architecture-rationale",
	"decision-history",
	"current-task-status",
	"resume-session",
	"person-identity",
	"environment",
	"debugging-history",
	"workflow-policy",
	"generic-recall",
] as const satisfies readonly MemoryIntent[];

const REJECTED_DIRECTORY_NAMES = new Set(["archive", "archives", "proposal", "proposals", "transcript", "transcripts"]);

export interface MemoryMapRoute {
	readonly uri: string;
	readonly label: string;
	readonly aliases: readonly string[];
	readonly intents: readonly MemoryIntent[];
	readonly sourceUri: string;
	readonly sourceLine: number;
	readonly sourceIndex: number;
}

export interface ParsedMemoryMap {
	readonly version: 1;
	readonly sourceUri: string;
	readonly routes: readonly MemoryMapRoute[];
}

interface FenceState {
	readonly character: "`" | "~";
	readonly length: number;
}

function invalidMap(detail: string): MemoryResult<never> {
	return invalidInput(`MAP ${detail}`);
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizedText(value: string): string {
	return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function normalizedAlias(value: string): string {
	return normalizedText(value).toLowerCase();
}

function isControlFree(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) return false;
	}
	return true;
}

function isMemoryIntent(value: string): value is MemoryIntent {
	return (MEMORY_INTENTS as readonly string[]).includes(value);
}

function normalizeIntent(value: string): MemoryResult<MemoryIntent> {
	const normalized = normalizedText(value).toLowerCase().replace(/[ _]+/gu, "-");
	if (!isMemoryIntent(normalized)) return invalidMap(`contains an unknown intent tag: ${value}`);
	return { ok: true, value: normalized };
}

function decodeUriPart(value: string): string | null {
	let current = value;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(current);
		} catch {
			return null;
		}
		if (decoded === current) break;
		current = decoded;
	}
	if (current.includes("%")) {
		try {
			if (decodeURIComponent(current) !== current) return null;
		} catch {
			return null;
		}
	}
	return current;
}

function validatePathPart(value: string): boolean {
	if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) return false;
	if (!isControlFree(value) || value.endsWith(".") || value.endsWith(" ")) return false;
	return !REJECTED_DIRECTORY_NAMES.has(value.toLowerCase());
}

/** Normalize and validate a canonical memory document URI. */
export function normalizeMemoryDocumentUri(raw: string): MemoryResult<string> {
	if (typeof raw !== "string" || raw.length === 0 || raw !== raw.trim() || !raw.startsWith("memory://")) {
		return invalidMap("contains a non-canonical document URI");
	}
	if (raw.includes("\\") || raw.includes("\u0000") || /[\u0000-\u001f\u007f]/u.test(raw)) {
		return invalidMap("contains an unsafe document URI");
	}
	const withoutScheme = raw.slice("memory://".length);
	const hashIndex = withoutScheme.indexOf("#");
	const queryIndex = withoutScheme.indexOf("?");
	if (queryIndex >= 0) return invalidMap("contains a query string");
	const pathAndFragment = hashIndex >= 0 ? withoutScheme.slice(0, hashIndex) : withoutScheme;
	const fragmentRaw = hashIndex >= 0 ? withoutScheme.slice(hashIndex + 1) : null;
	const slashIndex = pathAndFragment.indexOf("/");
	if (slashIndex <= 0 || slashIndex === pathAndFragment.length - 1) return invalidMap("has an invalid scope path");
	const scopeRaw = pathAndFragment.slice(0, slashIndex).toLowerCase();
	if (scopeRaw !== "global" && scopeRaw !== "project" && scopeRaw !== "session") {
		return invalidMap("uses an unknown scope");
	}
	const rawParts = pathAndFragment.slice(slashIndex + 1).split("/");
	if (rawParts.some(part => part.length === 0)) return invalidMap("contains an empty path component");
	const parts: string[] = [];
	for (const rawPart of rawParts) {
		const decoded = decodeUriPart(rawPart);
		if (decoded === null || !validatePathPart(decoded.normalize("NFC"))) {
			return invalidMap("contains traversal or a rejected path component");
		}
		parts.push(decoded.normalize("NFC"));
	}
	if ((scopeRaw === "project" || scopeRaw === "session") && parts.length < 2) {
		return invalidMap("does not identify a project or session document");
	}
	const lastPart = parts[parts.length - 1];
	if (!lastPart.toLowerCase().endsWith(".md")) return invalidMap("does not identify a Markdown document");
	let fragment: string | null = null;
	if (fragmentRaw !== null) {
		const decodedFragment = decodeUriPart(fragmentRaw);
		if (decodedFragment === null || !isControlFree(decodedFragment)) return invalidMap("has an invalid fragment");
		fragment = decodedFragment.normalize("NFC").trim();
		if (fragment.length === 0 || fragment.includes("/") || fragment === "." || fragment === "..") {
			return invalidMap("has an invalid fragment");
		}
	}
	return {
		ok: true,
		value: `memory://${scopeRaw}/${parts.join("/")}${fragment === null ? "" : `#${fragment}`}`,
	};
}

/** Normalize either a canonical memory URI or a root-relative memory path. */
export function normalizeMemoryRouteTarget(raw: string): MemoryResult<string> {
	if (typeof raw !== "string" || raw.length === 0 || raw !== raw.trim()) {
		return invalidMap("contains an invalid route target");
	}
	if (raw.startsWith("memory://")) return normalizeMemoryDocumentUri(raw);
	if (
		raw.startsWith("/") ||
		raw.startsWith("./") ||
		raw.startsWith("../") ||
		raw.includes("\\") ||
		raw.includes("://") ||
		raw.includes("\u0000")
	) {
		return invalidMap("contains an out-of-root route target");
	}
	const normalized = raw.normalize("NFC");
	const parts = normalized.split("/");
	if (parts.length < 2) return invalidMap("contains an invalid root-relative route target");
	const prefix = parts[0].toLowerCase();
	if (prefix === "global") return normalizeMemoryDocumentUri(`memory://global/${parts.slice(1).join("/")}`);
	if (prefix === "project" || prefix === "projects") {
		if (parts.length < 3) return invalidMap("contains an incomplete project route target");
		return normalizeMemoryDocumentUri(`memory://project/${parts.slice(1).join("/")}`);
	}
	if (prefix === "session" || prefix === "sessions") {
		if (parts.length < 3) return invalidMap("contains an incomplete session route target");
		return normalizeMemoryDocumentUri(`memory://session/${parts.slice(1).join("/")}`);
	}
	return invalidMap("contains an out-of-root route target");
}

function fenceStart(line: string): FenceState | null {
	const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
	if (!match) return null;
	const marker = match[2];
	return { character: marker[0] as "`" | "~", length: marker.length };
}

function fenceEnd(line: string, state: FenceState): boolean {
	const match = /^( {0,3})(`{3,}|~{3,})\s*$/u.exec(line);
	return match !== null && match[2][0] === state.character && match[2].length >= state.length;
}

function insideInlineCode(line: string, offset: number): boolean {
	let backticks = 0;
	for (let index = 0; index < offset; index += 1) if (line[index] === "`") backticks += 1;
	return backticks % 2 === 1;
}

function splitAnnotationValues(value: string): string[] {
	const trimmed = value.trim().replace(/-->$/u, "").trim();
	if (!trimmed) return [];
	return trimmed
		.split(/[,;]/u)
		.map(item => item.trim().replace(/^['"]|['"]$/gu, ""))
		.filter(item => item.length > 0);
}

type AnnotationName = "aliases" | "intents";

interface AnnotationMatch {
	readonly name: AnnotationName;
	readonly start: number;
	readonly valueStart: number;
}

interface ParsedAnnotationValue {
	readonly value: string;
	readonly next: number;
}

function nextAnnotation(text: string, start: number): AnnotationMatch | null {
	const pattern = /\b(aliases?|intents?)\s*:/giu;
	pattern.lastIndex = start;
	const match = pattern.exec(text);
	if (match === null || match.index === undefined) return null;
	const matchedName = match[1] ?? "";
	return {
		name: matchedName.toLowerCase().startsWith("alias") ? "aliases" : "intents",
		start: match.index,
		valueStart: pattern.lastIndex,
	};
}

function hasAnnotationBrackets(value: string): boolean {
	return value.includes("[") || value.includes("]") || value.includes("{") || value.includes("}");
}

function parseBracketedAnnotationValue(
	text: string,
	start: number,
	name: AnnotationName,
): ParsedAnnotationValue | null {
	const opening = name === "aliases" ? "[" : "{";
	const closing = name === "aliases" ? "]" : "}";
	if (text[start] !== opening) return null;
	for (let index = start + 1; index < text.length; index += 1) {
		const character = text[index];
		if (character === closing) return { value: text.slice(start + 1, index), next: index + 1 };
		if (character === "[" || character === "]" || character === "{" || character === "}") return null;
	}
	return null;
}

function parseAnnotationValue(text: string, start: number, name: AnnotationName): ParsedAnnotationValue | null {
	let valueStart = start;
	while (valueStart < text.length && /\s/u.test(text[valueStart] ?? "")) valueStart += 1;
	const opening = text[valueStart];
	if (opening === "[" || opening === "{") return parseBracketedAnnotationValue(text, valueStart, name);
	const next = nextAnnotation(text, valueStart);
	const end = next?.start ?? text.length;
	const value = text.slice(valueStart, end);
	return hasAnnotationBrackets(value) ? null : { value, next: end };
}

function parseAnnotations(
	line: string,
	endOffset: number,
): MemoryResult<{
	aliases: readonly string[];
	intents: readonly MemoryIntent[];
}> {
	const trailing = line.slice(endOffset);
	const aliases: string[] = [];
	const intents: MemoryIntent[] = [];
	let annotation = nextAnnotation(trailing, 0);
	while (annotation !== null) {
		const parsed = parseAnnotationValue(trailing, annotation.valueStart, annotation.name);
		if (parsed === null) return invalidMap("contains a malformed annotation");
		const next = nextAnnotation(trailing, parsed.next);
		if (hasAnnotationBrackets(trailing.slice(parsed.next, next?.start ?? trailing.length))) {
			return invalidMap("contains a malformed annotation");
		}
		for (const item of splitAnnotationValues(parsed.value)) {
			if (annotation.name === "aliases") {
				const normalized = normalizedAlias(item);
				if (!normalized || !isControlFree(normalized)) return invalidMap("contains an invalid alias");
				if (!aliases.includes(normalized)) aliases.push(normalized);
			} else {
				const intent = normalizeIntent(item);
				if (!intent.ok) return intent;
				if (!intents.includes(intent.value)) intents.push(intent.value);
			}
		}
		annotation = next;
	}
	for (const token of trailing.matchAll(/#([A-Za-z0-9_-]+)/gu)) {
		const normalized = normalizedText(token[1]).toLowerCase().replace(/[ _]+/gu, "-");
		if (isMemoryIntent(normalized) && !intents.includes(normalized)) intents.push(normalized);
	}
	return {
		ok: true,
		value: {
			aliases: Object.freeze(aliases.sort(compareUtf8)),
			intents: Object.freeze(intents.sort(compareUtf8)),
		},
	};
}

function parseMarker(name: string): readonly [string, string] | null {
	for (const marker of APPROVED_MARKERS) {
		if (marker[0] === name || marker[1] === name) return marker;
	}
	return null;
}

function parseLinkLine(
	line: string,
	lineNumber: number,
	sourceUri: string,
	sourceIndex: number,
): MemoryResult<MemoryMapRoute[]> {
	const routes: MemoryMapRoute[] = [];
	const pattern = /\[([^\n]*?)\]\(\s*(memory:\/\/[^)\s]+)\s*\)/gu;
	for (const match of line.matchAll(pattern)) {
		const offset = match.index ?? 0;
		if (insideInlineCode(line, offset)) continue;
		const uri = normalizeMemoryDocumentUri(match[2]);
		if (!uri.ok) return uri;
		const label = normalizedText(match[1]);
		if (!label || !isControlFree(label)) return invalidMap("contains a document link without a label");
		const annotation = parseAnnotations(line, offset + match[0].length);
		if (!annotation.ok) return annotation;
		const aliases = new Set<string>([normalizedAlias(label), ...annotation.value.aliases]);
		routes.push({
			uri: uri.value,
			label,
			aliases: Object.freeze([...aliases].sort(compareUtf8)),
			intents: annotation.value.intents,
			sourceUri,
			sourceLine: lineNumber,
			sourceIndex,
		});
		sourceIndex += 1;
	}
	return { ok: true, value: routes };
}

/** Parse links from the generated AUTO regions of a memory MAP document. */
export function parseMemoryMap(content: string, sourceUri: string): MemoryResult<ParsedMemoryMap> {
	if (typeof content !== "string" || typeof sourceUri !== "string" || sourceUri.length === 0) {
		return invalidMap("content and source URI are required");
	}
	const normalizedSourceUri = sourceUri.normalize("NFC");
	const lines = content.replace(/\r\n?/gu, "\n").split("\n");
	const routes: MemoryMapRoute[] = [];
	const seenUris = new Set<string>();
	let activeMarker: readonly [string, string] | null = null;
	let fence: FenceState | null = null;
	let sourceIndex = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (fence !== null) {
			if (fenceEnd(line, fence)) fence = null;
			continue;
		}
		const startedFence = fenceStart(line);
		if (startedFence !== null) {
			fence = startedFence;
			continue;
		}
		const trimmed = line.trim();
		const marker = parseMarker(trimmed);
		if (marker !== null) {
			if (trimmed === marker[0]) {
				if (activeMarker !== null) return invalidMap("contains nested AUTO marker regions");
				activeMarker = marker;
			} else if (activeMarker === null || activeMarker[1] !== trimmed) {
				return invalidMap("contains an unmatched AUTO marker");
			} else {
				activeMarker = null;
			}
			continue;
		}
		if (activeMarker === null) continue;
		const parsed = parseLinkLine(line, index + 1, normalizedSourceUri, sourceIndex);
		if (!parsed.ok) return parsed;
		for (const route of parsed.value) {
			if (seenUris.has(route.uri)) return invalidMap(`contains a duplicate document URI: ${route.uri}`);
			seenUris.add(route.uri);
			routes.push(route);
			sourceIndex += 1;
		}
	}
	if (activeMarker !== null) return invalidMap("contains an unterminated AUTO marker region");
	if (fence !== null) return invalidMap("contains an unterminated code fence");
	return {
		ok: true,
		value: Object.freeze({
			version: 1,
			sourceUri: normalizedSourceUri,
			routes: Object.freeze(routes),
		}),
	};
}
