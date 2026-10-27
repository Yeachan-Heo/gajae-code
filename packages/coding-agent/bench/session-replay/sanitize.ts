import * as path from "node:path";
import { sha256Hex } from "./corpus.js";

export const SANITIZER_VERSION = "1";

interface SanitizerOptions {
	seed: string;
	fixtureRoot: string;
}

interface SanitizerState {
	random: DeterministicRandom;
	fixtureRoot: string;
	pathMappings: Map<string, string>;
	textValues: number;
	rewrittenPaths: number;
	droppedBlocks: number;
	droppedBytes: number;
}

interface TraversalContext {
	insideArguments: boolean;
	toolName?: string;
}

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SECRET_KEY = /(?:api.?key|access.?token|refresh.?token|auth(?:orization)?|credential|password|secret|private.?key)/i;
const SECRET_VALUE = /(?:\bsk-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9_]{12,}\b|\bgithub_pat_[A-Za-z0-9_]{12,}\b|\bBearer\s+\S+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b)/;
const COMBINING_MARK = /\p{M}/u;
const LETTER = /\p{L}/u;
const NUMBER = /\p{N}/u;
const UPPERCASE = /\p{Lu}/u;
const LOWERCASE = /\p{Ll}/u;

const SCRIPT_POOLS: Array<{ script: RegExp; start: number; end: number }> = [
	{ script: /\p{Script=Latin}/u, start: 0x00c0, end: 0x024f },
	{ script: /\p{Script=Greek}/u, start: 0x0370, end: 0x03ff },
	{ script: /\p{Script=Cyrillic}/u, start: 0x0400, end: 0x052f },
	{ script: /\p{Script=Armenian}/u, start: 0x0530, end: 0x058f },
	{ script: /\p{Script=Hebrew}/u, start: 0x0590, end: 0x05ff },
	{ script: /\p{Script=Arabic}/u, start: 0x0600, end: 0x06ff },
	{ script: /\p{Script=Devanagari}/u, start: 0x0900, end: 0x097f },
	{ script: /\p{Script=Bengali}/u, start: 0x0980, end: 0x09ff },
	{ script: /\p{Script=Gurmukhi}/u, start: 0x0a00, end: 0x0a7f },
	{ script: /\p{Script=Gujarati}/u, start: 0x0a80, end: 0x0aff },
	{ script: /\p{Script=Tamil}/u, start: 0x0b80, end: 0x0bff },
	{ script: /\p{Script=Telugu}/u, start: 0x0c00, end: 0x0c7f },
	{ script: /\p{Script=Kannada}/u, start: 0x0c80, end: 0x0cff },
	{ script: /\p{Script=Malayalam}/u, start: 0x0d00, end: 0x0d7f },
	{ script: /\p{Script=Sinhala}/u, start: 0x0d80, end: 0x0dff },
	{ script: /\p{Script=Thai}/u, start: 0x0e00, end: 0x0e7f },
	{ script: /\p{Script=Lao}/u, start: 0x0e80, end: 0x0eff },
	{ script: /\p{Script=Tibetan}/u, start: 0x0f00, end: 0x0fff },
	{ script: /\p{Script=Myanmar}/u, start: 0x1000, end: 0x109f },
	{ script: /\p{Script=Georgian}/u, start: 0x10a0, end: 0x10ff },
	{ script: /\p{Script=Ethiopic}/u, start: 0x1200, end: 0x137f },
	{ script: /\p{Script=Khmer}/u, start: 0x1780, end: 0x17ff },
	{ script: /\p{Script=Hiragana}/u, start: 0x3040, end: 0x309f },
	{ script: /\p{Script=Katakana}/u, start: 0x30a0, end: 0x30ff },
	{ script: /\p{Script=Bopomofo}/u, start: 0x3100, end: 0x312f },
];

type LetterCase = "uppercase" | "lowercase" | "uncased";

function letterCase(character: string): LetterCase {
	if (UPPERCASE.test(character)) return "uppercase";
	if (LOWERCASE.test(character)) return "lowercase";
	return "uncased";
}

class DeterministicRandom {
	#seed: string;
	#counter = 0;
	#bytes: number[] = [];
	#offset = 0;

	constructor(seed: string) {
		this.#seed = seed;
	}

	nextInt(maxExclusive: number): number {
		if (maxExclusive <= 0) throw new Error("Random range must be positive");
		if (this.#offset >= this.#bytes.length) this.#refill();
		const value = this.#bytes[this.#offset];
		this.#offset++;
		if (value === undefined) throw new Error("Deterministic random stream exhausted unexpectedly");
		return value % maxExclusive;
	}

	#refill(): void {
		const digest = sha256Hex(`${this.#seed}\0${this.#counter}`);
		this.#counter++;
		this.#bytes = [];
		for (let offset = 0; offset < digest.length; offset += 2) {
			this.#bytes.push(Number.parseInt(digest.slice(offset, offset + 2), 16));
		}
		this.#offset = 0;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomCodePoint(state: SanitizerState, start: number, end: number): string {
	return String.fromCodePoint(start + state.random.nextInt(end - start + 1));
}

function candidatePool(range: { script: RegExp; start: number; end: number }, characterCase: LetterCase): string[] {
	const candidates: string[] = [];
	for (let codePoint = range.start; codePoint <= range.end; codePoint++) {
		const character = String.fromCodePoint(codePoint);
		if (!LETTER.test(character) || !range.script.test(character)) continue;
		if (letterCase(character) === characterCase) candidates.push(character);
	}
	return candidates;
}

const scriptCandidatePools = new Map<string, Record<LetterCase, string[]>>();

function randomFallbackLetter(character: string, codePoint: number, state: SanitizerState): string {
	const blockStart = Math.floor(codePoint / 0x80) * 0x80;
	const blockEnd = Math.min(0xffff, blockStart + 0x7f);
	const targetCase = letterCase(character);
	const candidates: string[] = [];
	for (let candidatePoint = blockStart; candidatePoint <= blockEnd; candidatePoint++) {
		if (candidatePoint === codePoint) continue;
		const candidate = String.fromCodePoint(candidatePoint);
		if (LETTER.test(candidate) && letterCase(candidate) === targetCase) candidates.push(candidate);
	}
	if (candidates.length === 0) return randomCodePoint(state, blockStart, blockEnd);
	return candidates[state.random.nextInt(candidates.length)] ?? character;
}

function randomScriptLetter(character: string, codePoint: number, state: SanitizerState): string {
	const range = SCRIPT_POOLS.find(candidate => candidate.script.test(character));
	if (!range) return randomFallbackLetter(character, codePoint, state);
	const key = `${range.start}:${range.end}`;
	let pools = scriptCandidatePools.get(key);
	if (!pools) {
		pools = {
			uppercase: candidatePool(range, "uppercase"),
			lowercase: candidatePool(range, "lowercase"),
			uncased: candidatePool(range, "uncased"),
		};
		scriptCandidatePools.set(key, pools);
	}
	const candidates = pools[letterCase(character)];
	if (candidates.length === 0) return randomFallbackLetter(character, codePoint, state);
	return candidates[state.random.nextInt(candidates.length)] ?? String.fromCodePoint(codePoint);
}

function pseudotextSegment(value: string, state: SanitizerState): string {
	let output = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) continue;
		if (character === "\n" || character === "\r") {
			output += character;
		} else if (codePoint >= 0x41 && codePoint <= 0x5a) {
			output += randomCodePoint(state, 0x41, 0x5a);
		} else if (codePoint >= 0x61 && codePoint <= 0x7a) {
			output += randomCodePoint(state, 0x61, 0x7a);
		} else if (codePoint >= 0x30 && codePoint <= 0x39) {
			output += randomCodePoint(state, 0x30, 0x39);
		} else if (COMBINING_MARK.test(character)) {
			output += character.length === 2 ? "\u{1d165}" : "\u0301";
		} else if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
			output += randomCodePoint(state, 0x4e00, 0x9fff);
		} else if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
			output += randomCodePoint(state, 0xac00, 0xd7af);
		} else if (codePoint > 0xffff) {
			output += "\u{1f9ea}";
		} else if (LETTER.test(character)) {
			output += randomScriptLetter(character, codePoint, state);
		} else if (NUMBER.test(character)) {
			output += randomCodePoint(state, 0x30, 0x39);
		} else {
			output += character;
		}
	}
	return output;
}

function pseudotext(value: string, state: SanitizerState): string {
	let output = "";
	let previousIndex = 0;
	ANSI_CSI.lastIndex = 0;
	for (let match = ANSI_CSI.exec(value); match !== null; match = ANSI_CSI.exec(value)) {
		output += pseudotextSegment(value.slice(previousIndex, match.index), state);
		output += match[0];
		previousIndex = match.index + match[0].length;
	}
	output += pseudotextSegment(value.slice(previousIndex), state);
	return output;
}

function isPathKey(key: string, context: TraversalContext): boolean {
	return (
		key === "path" ||
		key === "paths" ||
		key === "file" ||
		key === "cwd" ||
		key === "parentSession" ||
		key === "resolvedPath" ||
		(key === "pattern" && (context.toolName === "glob" || context.toolName === "find"))
	);
}

function rewritePath(value: string, state: SanitizerState): string {
	const existing = state.pathMappings.get(value);
	if (existing) return existing;
	const extension = path.extname(value);
	const pseudoPath = path.join(state.fixtureRoot, `${sha256Hex(value).slice(0, 16)}${extension}`);
	state.pathMappings.set(value, pseudoPath);
	return pseudoPath;
}

const STRUCTURAL_STRING_KEYS = new Set([
	"type",
	"id",
	"parentId",
	"timestamp",
	"role",
	"toolCallId",
	"toolName",
	"provider",
	"model",
	"modelId",
	"previousModel",
	"api",
	"stopReason",
	"encoding",
	"thinkingLevel",
	"serviceTier",
	"mode",
	"titleSource",
	"customType",
	"firstKeptEntryId",
	"fromId",
	"targetId",
	"version",
]);

export function isStructuralStringKey(
	key: string,
	parentType: unknown,
	value: string,
	insideArguments = false,
): boolean {
	if (insideArguments) return false;
	if (key === "name") return parentType === "toolCall";
	if (STRUCTURAL_STRING_KEYS.has(key)) return true;
	return /sha256/i.test(key) && /^[0-9a-f]{64}$/i.test(value);
}

function binaryByteLength(value: string): number {
	const compact = value.replace(/\s/g, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return new TextEncoder().encode(value).byteLength;
	const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function replaceBinaryBlock(value: Record<string, unknown>, state: SanitizerState): Record<string, unknown> | undefined {
	const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
	if (!type.includes("image") && !(typeof value.mimeType === "string" && typeof value.data === "string")) return undefined;
	const bytes = typeof value.data === "string" ? binaryByteLength(value.data) : 0;
	state.droppedBlocks++;
	state.droppedBytes += bytes;
	return { type: "text", text: `[binary content removed: ${bytes} bytes]` };
}

function sanitizeValue(
	value: unknown,
	key: string,
	parentType: unknown,
	context: TraversalContext,
	state: SanitizerState,
	sensitive = false,
): unknown {
	const sensitiveValue = sensitive || SECRET_KEY.test(key);
	if (typeof value === "string") {
		if (isPathKey(key, context) && !sensitiveValue) {
			state.rewrittenPaths++;
			return rewritePath(value, state);
		}
		if (!sensitiveValue && isStructuralStringKey(key, parentType, value, context.insideArguments) && !SECRET_VALUE.test(value)) return value;
		state.textValues++;
		return pseudotext(value, state);
	}
	if (typeof value === "number") return sensitiveValue ? 0 : value;
	if (typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		return value.map(item => sanitizeValue(item, key, parentType, context, state, sensitiveValue));
	}
	if (!isRecord(value)) return value;
	const binaryBlock = replaceBinaryBlock(value, state);
	if (binaryBlock) return binaryBlock;

	const objectType = value.type;
	const toolName = objectType === "toolCall" && typeof value.name === "string" ? value.name : context.toolName;
	const nextContext: TraversalContext = {
		insideArguments: context.insideArguments || key === "arguments",
		toolName,
	};
	const result: Record<string, unknown> = {};
	for (const [childKey, childValue] of Object.entries(value)) {
		if (childKey === "cwd") {
			result[childKey] = state.fixtureRoot;
			state.rewrittenPaths++;
			continue;
		}
		if (childKey === "arguments" && typeof childValue === "string") {
			try {
				const parsed: unknown = JSON.parse(childValue);
				const sanitized = sanitizeValue(parsed, childKey, objectType, nextContext, state);
				result[childKey] = JSON.stringify(sanitized);
			} catch {
				state.textValues++;
				result[childKey] = pseudotext(childValue, state);
			}
			continue;
		}
		result[childKey] = sanitizeValue(childValue, childKey, objectType, nextContext, state, sensitiveValue);
	}
	return result;
}

export function sanitizeSession(raw: string, opts: SanitizerOptions): { jsonl: string; redactionNotes: string } {
	if (opts.seed.length === 0) throw new Error("Session replay sanitizer seed must not be empty");
	if (opts.fixtureRoot.length === 0) throw new Error("Session replay fixture root must not be empty");
	const state: SanitizerState = {
		random: new DeterministicRandom(opts.seed),
		fixtureRoot: opts.fixtureRoot,
		pathMappings: new Map(),
		textValues: 0,
		rewrittenPaths: 0,
		droppedBlocks: 0,
		droppedBytes: 0,
	};
	const lines = raw.split(/\r?\n/);
	const sanitizedLines = lines.map(line => {
		if (line.trim().length === 0) return line;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(`Invalid session JSONL line: ${error instanceof Error ? error.message : String(error)}`);
		}
		return JSON.stringify(sanitizeValue(parsed, "", undefined, { insideArguments: false }, state));
	});
	const jsonl = sanitizedLines.join("\n");
	const redactionNotes = `redacted ${state.textValues} text values; rewrote ${state.rewrittenPaths} path values; replaced ${state.droppedBlocks} binary blocks (${state.droppedBytes} bytes)`;
	return { jsonl, redactionNotes };
}
