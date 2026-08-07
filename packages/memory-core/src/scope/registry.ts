import * as path from "node:path";

import type { MemoryResult } from "../errors";
import { invalidInput } from "../errors";

export const PROJECT_REGISTRY_VERSION = 1 as const;

export interface ProjectRegistryEntry {
	readonly encodedKey: string;
	readonly forgeIds: readonly string[];
	readonly repoRoot: string | null;
	readonly gitCommonDir: string | null;
}

export interface ProjectRegistry {
	readonly version: typeof PROJECT_REGISTRY_VERSION;
	readonly entries: readonly ProjectRegistryEntry[];
	/** Canonical forge id to project key, retained for simple registry consumers. */
	readonly projects: Readonly<Record<string, string>>;
}

export type ProjectRegistryInput = string | ProjectRegistry | Readonly<Record<string, unknown>>;

type RegistryScalar = string | number | boolean | null;
type RegistryMap = { [key: string]: RegistryNode };
type RegistryNode = RegistryScalar | RegistryMap | readonly RegistryNode[];

interface RegistryLine {
	readonly indent: number;
	readonly text: string;
	readonly line: number;
}

interface ParsedNode {
	readonly node: RegistryNode;
	readonly next: number;
}

const EMPTY_REGISTRY = Object.freeze({
	version: PROJECT_REGISTRY_VERSION,
	entries: Object.freeze([]) as readonly ProjectRegistryEntry[],
	projects: Object.freeze({}) as Readonly<Record<string, string>>,
}) satisfies ProjectRegistry;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRegistryMap(value: RegistryNode): value is RegistryMap {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function fail(): never {
	throw new Error("malformed project registry");
}

function stripComment(value: string): string {
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote === null && (character === '"' || character === "'")) {
			quote = character;
			continue;
		}
		if (quote === character) {
			if (quote === "'" && value[index + 1] === "'") {
				index += 1;
				continue;
			}
			if (index === 0 || value[index - 1] !== "\\") quote = null;
			continue;
		}
		if (quote === null && character === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
			return value.slice(0, index).trimEnd();
		}
	}
	return value.trimEnd();
}

function splitTopLevel(value: string, separator: string): string[] {
	const pieces: string[] = [];
	let start = 0;
	let depth = 0;
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote === null && (character === '"' || character === "'")) {
			quote = character;
			continue;
		}
		if (quote === character) {
			if (quote === "'" && value[index + 1] === "'") {
				index += 1;
				continue;
			}
			if (index === 0 || value[index - 1] !== "\\") quote = null;
			continue;
		}
		if (quote !== null) continue;
		if (character === "{" || character === "[") depth += 1;
		if (character === "}" || character === "]") depth -= 1;
		if (depth === 0 && value.startsWith(separator, index)) {
			pieces.push(value.slice(start, index).trim());
			start = index + separator.length;
			index += separator.length - 1;
		}
	}
	pieces.push(value.slice(start).trim());
	return pieces;
}

function colonIndex(value: string): number {
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote === null && (character === '"' || character === "'")) {
			quote = character;
			continue;
		}
		if (quote === character) {
			if (quote === "'" && value[index + 1] === "'") {
				index += 1;
				continue;
			}
			if (index === 0 || value[index - 1] !== "\\") quote = null;
			continue;
		}
		if (quote === null && character === ":") return index;
	}
	return -1;
}

function parseQuotedString(raw: string): string {
	if (raw.startsWith('"')) {
		if (!raw.endsWith('"')) fail();
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			fail();
		}
		if (typeof parsed !== "string") fail();
		return parsed.normalize("NFC");
	}
	if (!raw.startsWith("'")) fail();
	if (!raw.endsWith("'")) fail();
	return raw.slice(1, -1).replaceAll("''", "'").normalize("NFC");
}

function parseScalar(rawValue: string): RegistryNode {
	const raw = rawValue.trim();
	if (raw.length === 0) fail();
	if (raw.startsWith('"') || raw.startsWith("'")) return parseQuotedString(raw);
	if (raw === "null" || raw === "~") return null;
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^-?(?:0|[1-9][0-9]*)$/.test(raw)) return Number(raw);
	if (/[\u0000-\u001f\u007f]/.test(raw) || raw.includes("\t")) fail();
	return raw.normalize("NFC");
}

function parseInlineNode(rawValue: string): RegistryNode {
	const raw = rawValue.trim();
	if (raw === "{}") return {};
	if (raw === "[]") return [];
	if (raw.startsWith("{") && raw.endsWith("}")) {
		const body = raw.slice(1, -1).trim();
		const result: RegistryMap = {};
		if (body.length === 0) return result;
		for (const piece of splitTopLevel(body, ",")) {
			const separator = colonIndex(piece);
			if (separator <= 0) fail();
			const keyNode = parseScalar(piece.slice(0, separator));
			if (typeof keyNode !== "string" || keyNode.length === 0 || keyNode in result) fail();
			result[keyNode] = parseInlineNode(piece.slice(separator + 1));
		}
		return result;
	}
	if (raw.startsWith("[") && raw.endsWith("]")) {
		const body = raw.slice(1, -1).trim();
		if (body.length === 0) return [];
		return splitTopLevel(body, ",").map(piece => parseInlineNode(piece));
	}
	return parseScalar(raw);
}

function parseKeyValue(text: string): { readonly key: string; readonly rawValue: string } {
	const separator = colonIndex(text);
	if (separator <= 0) fail();
	const keyNode = parseScalar(text.slice(0, separator));
	if (typeof keyNode !== "string" || keyNode.length === 0) fail();
	return { key: keyNode, rawValue: text.slice(separator + 1).trim() };
}

function parseLines(input: string): RegistryLine[] {
	if (typeof input !== "string" || input.includes("\u0000")) fail();
	const normalized = input
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replace(/^\uFEFF/, "");
	const lines: RegistryLine[] = [];
	for (const [lineIndex, source] of normalized.split("\n").entries()) {
		const uncommented = stripComment(source);
		if (uncommented.trim().length === 0) continue;
		if (/^\t/.test(uncommented)) fail();
		const leading = uncommented.match(/^ */)?.[0].length ?? 0;
		const text = uncommented.slice(leading).trimEnd();
		if (text === "---" || text === "...") fail();
		lines.push({ indent: leading, text, line: lineIndex + 1 });
	}
	return lines;
}

function parseMap(lines: readonly RegistryLine[], start: number, indent: number): ParsedNode {
	const result: RegistryMap = {};
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (line === undefined || line.indent < indent) break;
		if (line.indent !== indent || line.text.startsWith("-")) fail();
		const pair = parseKeyValue(line.text);
		if (pair.key in result) fail();
		if (pair.rawValue.length > 0) {
			result[pair.key] = parseInlineNode(pair.rawValue);
			index += 1;
			continue;
		}
		index += 1;
		if (index >= lines.length || (lines[index]?.indent ?? 0) <= indent) fail();
		const childIndent = lines[index]?.indent ?? 0;
		const child = lines[index]?.text.startsWith("-")
			? parseSequence(lines, index, childIndent)
			: parseMap(lines, index, childIndent);
		result[pair.key] = child.node;
		index = child.next;
	}
	return { node: result, next: index };
}

function parseSequence(lines: readonly RegistryLine[], start: number, indent: number): ParsedNode {
	const result: RegistryNode[] = [];
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (line === undefined || line.indent < indent) break;
		if (line.indent !== indent || !line.text.startsWith("-")) fail();
		const remainder = line.text.slice(1).trim();
		index += 1;
		if (remainder.length === 0) {
			if (index >= lines.length || (lines[index]?.indent ?? 0) <= indent) fail();
			const childIndent = lines[index]?.indent ?? 0;
			const child = lines[index]?.text.startsWith("-")
				? parseSequence(lines, index, childIndent)
				: parseMap(lines, index, childIndent);
			result.push(child.node);
			index = child.next;
			continue;
		}
		const separator = colonIndex(remainder);
		if (separator <= 0) {
			result.push(parseInlineNode(remainder));
			continue;
		}
		const firstPair = parseKeyValue(remainder);
		const map: RegistryMap = {};
		if (firstPair.rawValue.length === 0) fail();
		map[firstPair.key] = parseInlineNode(firstPair.rawValue);
		if (index < lines.length && (lines[index]?.indent ?? 0) > indent) {
			const childIndent = lines[index]?.indent ?? 0;
			const child = parseMap(lines, index, childIndent);
			if (typeof child.node !== "object" || child.node === null || Array.isArray(child.node)) fail();
			for (const [key, value] of Object.entries(child.node)) {
				if (key in map) fail();
				map[key] = value;
			}
			index = child.next;
		}
		result.push(map);
	}
	return { node: result, next: index };
}

function parseDocument(input: string): RegistryMap {
	const lines = parseLines(input);
	if (lines.length === 0) fail();
	const root = parseMap(lines, 0, lines[0]?.indent ?? 0);
	if (root.next !== lines.length || !isRegistryMap(root.node)) fail();
	return root.node;
}

function normalizeForgeId(value: string): string | null {
	const normalized = value.normalize("NFC").trim();
	if (normalized !== value || normalized.length === 0 || normalized.includes("\\") || normalized.includes("://"))
		return null;
	const pieces = normalized.split("/");
	if (pieces.length !== 3 || pieces.some(piece => piece.length === 0 || piece === "." || piece === "..")) return null;
	const host = pieces[0]?.toLowerCase() ?? "";
	let repo = pieces[2] ?? "";
	if (/\.git$/i.test(repo)) repo = repo.slice(0, -4);
	if (host.length === 0 || repo.length === 0) return null;
	if (pieces.some(piece => /[\u0000-\u0020\u007f%?#]/.test(piece))) return null;
	if (pieces[1]?.includes(":") || pieces[2]?.includes(":")) return null;
	return `${host}/${pieces[1]}/${repo}`;
}

function isWindowsDeviceName(value: string): boolean {
	return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value);
}

export function isValidProjectKey(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const normalized = value.normalize("NFC");
	if (
		normalized !== value ||
		normalized.length === 0 ||
		normalized.length > 128 ||
		normalized === "." ||
		normalized === ".." ||
		!/^[A-Za-z0-9._-]+$/.test(normalized) ||
		/[. ]$/.test(normalized) ||
		isWindowsDeviceName(normalized)
	) {
		return false;
	}
	return true;
}

function canonicalPath(value: string | null): string | null {
	if (value === null || value.length === 0 || value.includes("\u0000") || !path.isAbsolute(value)) return null;
	return path.normalize(path.resolve(value));
}
function isCanonicalProjectRegistry(value: unknown): value is ProjectRegistry {
	if (
		!isRecord(value) ||
		value.version !== PROJECT_REGISTRY_VERSION ||
		!Array.isArray(value.entries) ||
		!isRecord(value.projects)
	) {
		return false;
	}
	for (const entry of value.entries) {
		if (!isRecord(entry) || !isValidProjectKey(entry.encodedKey)) return false;
		if (
			!Array.isArray(entry.forgeIds) ||
			!entry.forgeIds.every(item => typeof item === "string" && normalizeForgeId(item) !== null)
		) {
			return false;
		}
		if (entry.repoRoot !== null && (typeof entry.repoRoot !== "string" || canonicalPath(entry.repoRoot) === null))
			return false;
		if (
			entry.gitCommonDir !== null &&
			(typeof entry.gitCommonDir !== "string" || canonicalPath(entry.gitCommonDir) === null)
		) {
			return false;
		}
	}
	for (const [forgeId, key] of Object.entries(value.projects)) {
		if (normalizeForgeId(forgeId) === null || !isValidProjectKey(key)) return false;
	}
	return true;
}

function stringField(map: RegistryMap, names: readonly string[]): string | null {
	for (const name of names) {
		const value = map[name];
		if (typeof value === "string") return value;
	}
	return null;
}

function stringsField(map: RegistryMap, names: readonly string[]): string[] {
	for (const name of names) {
		const value = map[name];
		if (typeof value === "string") return [value];
		if (Array.isArray(value) && value.every(item => typeof item === "string"))
			return value.map(item => item as string);
	}
	return [];
}

function parseRecord(name: string, node: RegistryNode): ProjectRegistryEntry {
	if (typeof node === "string") {
		const leftForge = normalizeForgeId(name);
		const rightForge = normalizeForgeId(node);
		if (leftForge !== null && rightForge === null && isValidProjectKey(node)) {
			return Object.freeze({
				encodedKey: node,
				forgeIds: Object.freeze([leftForge]),
				repoRoot: null,
				gitCommonDir: null,
			});
		}
		if (leftForge === null && rightForge !== null && isValidProjectKey(name)) {
			return Object.freeze({
				encodedKey: name,
				forgeIds: Object.freeze([rightForge]),
				repoRoot: null,
				gitCommonDir: null,
			});
		}
		fail();
	}
	if (typeof node !== "object" || node === null || Array.isArray(node)) fail();
	const map = node as RegistryMap;
	const keyField = stringField(map, ["key", "projectKey", "encodedKey"]);
	const encodedKey = keyField ?? (isValidProjectKey(name) ? name : null);
	if (encodedKey === null || !isValidProjectKey(encodedKey)) fail();
	const rawForgeIds = stringsField(map, ["forgeId", "forge", "remote", "url", "id", "aliases", "forgeIds"]);
	const forgeIds: string[] = [];
	for (const rawForgeId of rawForgeIds) {
		const forgeId = normalizeForgeId(rawForgeId);
		if (forgeId === null || forgeIds.includes(forgeId)) fail();
		forgeIds.push(forgeId);
	}
	const repoRootRaw = stringField(map, ["repoRoot", "root", "path"]);
	const commonDirRaw = stringField(map, ["gitCommonDir", "commonDir"]);
	const repoRoot = repoRootRaw === null ? null : canonicalPath(repoRootRaw);
	const gitCommonDir = commonDirRaw === null ? null : canonicalPath(commonDirRaw);
	if (repoRootRaw !== null && repoRoot === null) fail();
	if (commonDirRaw !== null && gitCommonDir === null) fail();
	if (forgeIds.length === 0 && repoRoot === null && gitCommonDir === null) fail();
	return Object.freeze({ encodedKey, forgeIds: Object.freeze(forgeIds), repoRoot, gitCommonDir });
}

function nodeToRegistry(node: RegistryNode): ProjectRegistry {
	if (typeof node !== "object" || node === null || Array.isArray(node)) fail();
	const root = node as RegistryMap;
	for (const key of Object.keys(root)) {
		if (key !== "version" && key !== "projects") fail();
	}
	if (root.version !== 1) fail();
	const projectsNode = root.projects;
	if (projectsNode === undefined) fail();
	if (typeof projectsNode !== "object" || projectsNode === null) fail();
	const entries: ProjectRegistryEntry[] = [];
	if (Array.isArray(projectsNode)) {
		for (const item of projectsNode) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) fail();
			const map = item as RegistryMap;
			const name = stringField(map, ["key", "projectKey", "encodedKey"]);
			if (name === null) fail();
			entries.push(parseRecord(name, map));
		}
	} else {
		for (const [name, value] of Object.entries(projectsNode)) entries.push(parseRecord(name, value));
	}
	entries.sort((left, right) => compareUtf8(left.encodedKey, right.encodedKey));
	const byForgeId: Record<string, string> = {};
	const byKey = new Map<string, ProjectRegistryEntry>();
	for (const entry of entries) {
		const existing = byKey.get(entry.encodedKey);
		if (existing !== undefined) {
			const forgeIds = [...existing.forgeIds];
			for (const forgeId of entry.forgeIds) {
				if (!forgeIds.includes(forgeId)) forgeIds.push(forgeId);
			}
			byKey.set(
				entry.encodedKey,
				Object.freeze({
					encodedKey: entry.encodedKey,
					forgeIds: Object.freeze(forgeIds.sort(compareUtf8)),
					repoRoot: entry.repoRoot ?? existing.repoRoot,
					gitCommonDir: entry.gitCommonDir ?? existing.gitCommonDir,
				}),
			);
			continue;
		}
		byKey.set(entry.encodedKey, entry);
	}
	const mergedEntries = [...byKey.values()].sort((left, right) => compareUtf8(left.encodedKey, right.encodedKey));
	for (const entry of mergedEntries) {
		for (const forgeId of entry.forgeIds) {
			const previous = byForgeId[forgeId];
			if (previous !== undefined && previous !== entry.encodedKey) fail();
			byForgeId[forgeId] = entry.encodedKey;
		}
	}
	return Object.freeze({
		version: PROJECT_REGISTRY_VERSION,
		entries: Object.freeze(mergedEntries),
		projects: Object.freeze(byForgeId),
	});
}

function objectToNode(value: unknown, depth: number): RegistryNode {
	if (depth > 8) fail();
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		return value;
	if (Array.isArray(value)) return Object.freeze(value.map(item => objectToNode(item, depth + 1)));
	if (!isRecord(value)) fail();
	const result: RegistryMap = {};
	for (const [key, item] of Object.entries(value)) {
		if (key.length === 0 || key.includes("\u0000")) fail();
		result[key.normalize("NFC")] = objectToNode(item, depth + 1);
	}
	return result;
}

export function parseProjectRegistry(input: unknown): MemoryResult<ProjectRegistry> {
	try {
		if (input === undefined || input === null) return { ok: true, value: EMPTY_REGISTRY };
		if (isCanonicalProjectRegistry(input)) return { ok: true, value: input };
		const document = typeof input === "string" ? parseDocument(input) : objectToNode(input, 0);
		return { ok: true, value: nodeToRegistry(document) };
	} catch {
		return invalidInput("projects/registry.yaml is malformed or unsupported");
	}
}

export function lookupProjectKey(
	registry: ProjectRegistry,
	forgeIds: readonly string[],
	repoRoot: string | null = null,
	gitCommonDir: string | null = null,
): string | null {
	const canonicalRoot = repoRoot === null ? null : canonicalPath(repoRoot);
	const canonicalCommon = gitCommonDir === null ? null : canonicalPath(gitCommonDir);
	for (const entry of registry.entries) {
		if (canonicalCommon !== null && entry.gitCommonDir === canonicalCommon) return entry.encodedKey;
		if (canonicalRoot !== null && entry.repoRoot === canonicalRoot) return entry.encodedKey;
	}
	for (const forgeId of forgeIds) {
		const normalized = normalizeForgeId(forgeId);
		if (normalized === null) continue;
		const key = registry.projects[normalized];
		if (key !== undefined) return key;
	}
	return null;
}
