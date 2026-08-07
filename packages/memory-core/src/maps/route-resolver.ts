import { invalidInput, type MemoryResult } from "../errors";
import type { MemoryIntent, MemoryScopeKind } from "../index";
import { normalizeMemoryRouteTarget } from "./map-parser";

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

const MEMORY_SCOPES = ["global", "project", "session"] as const satisfies readonly MemoryScopeKind[];
const REJECTED_DIRECTORY_NAMES = new Set(["archive", "archives", "proposal", "proposals", "transcript", "transcripts"]);
const SESSION_CHECKPOINT_ROUTE_ID = "session-checkpoint";

function isContinuityIntent(intent: MemoryIntent): boolean {
	return intent === "current-task-status" || intent === "resume-session";
}

export interface RouteDefinition {
	readonly id: string;
	readonly targets: readonly string[];
	readonly aliases: readonly string[];
	readonly intents: readonly MemoryIntent[];
	readonly scopes: readonly MemoryScopeKind[];
	readonly queryTokens: readonly string[];
	readonly default: boolean;
	readonly sourceIndex: number;
}

export interface RouteConfig {
	readonly version: 1;
	readonly routes: readonly RouteDefinition[];
	readonly defaults: readonly string[];
}

export interface AvailableMapUri {
	readonly uri: string;
	readonly scope?: MemoryScopeKind;
}

export interface RouteResolutionInput {
	readonly query?: string;
	readonly normalizedQuery?: string;
	readonly intent: MemoryIntent;
	readonly enabledScopes?: readonly MemoryScopeKind[];
	readonly scopes?: readonly MemoryScopeKind[];
	readonly availableMapUris?: readonly (string | AvailableMapUri)[];
	readonly availableMaps?: readonly (string | AvailableMapUri)[];
	readonly queryAliases?: readonly string[];
	readonly aliases?: readonly string[];
}

export type RouteMatch = "intent" | "alias" | "query" | "default";

export interface SelectedRoute {
	readonly uri: string;
	readonly routeId: string;
	readonly scope: MemoryScopeKind;
	readonly match: RouteMatch;
	readonly sourceIndex: number;
}

export interface ConsideredRoute {
	readonly uri: string;
	readonly routeId: string;
	readonly scope: MemoryScopeKind | null;
	readonly match: RouteMatch;
	readonly selected: boolean;
	readonly exclusionReason: string | null;
	readonly sourceIndex: number;
}

export interface RouteResolution {
	readonly selectedRoutes: readonly SelectedRoute[];
	readonly consideredRoutes: readonly ConsideredRoute[];
	readonly exclusionReasons: readonly string[];
	readonly truncated: boolean;
}

type YamlScalar = string | number | boolean | null;
type YamlValue = YamlScalar | YamlMap | YamlSequence;

interface YamlMapEntry {
	readonly key: string;
	readonly value: YamlValue;
	readonly line: number;
}

interface YamlMap {
	readonly kind: "map";
	readonly entries: readonly YamlMapEntry[];
}

interface YamlSequence {
	readonly kind: "sequence";
	readonly items: readonly YamlValue[];
}

interface YamlLine {
	readonly indent: number;
	readonly text: string;
	readonly line: number;
}

interface ParseNodeResult {
	readonly value: YamlValue;
	readonly next: number;
}

function invalidRoutes(detail: string): MemoryResult<never> {
	return invalidInput(`routes ${detail}`);
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

function isMemoryScope(value: string): value is MemoryScopeKind {
	return (MEMORY_SCOPES as readonly string[]).includes(value);
}

function safeKey(value: string): boolean {
	return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value);
}

function stripYamlComment(value: string): string {
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote === "'" && character === "'" && value[index + 1] === "'") {
			index += 1;
			continue;
		}
		if (quote === '"' && character === "\\") {
			index += 1;
			continue;
		}
		if (quote === null && (character === "'" || character === '"')) {
			quote = character;
			continue;
		}
		if (quote !== null && character === quote) {
			quote = null;
			continue;
		}
		if (quote === null && character === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
			return value.slice(0, index).trimEnd();
		}
	}
	return value.trimEnd();
}

function prepareYamlLines(content: string): MemoryResult<readonly YamlLine[]> {
	if (typeof content !== "string" || content.length === 0) return invalidRoutes("must be non-empty text");
	const lines: YamlLine[] = [];
	for (const [index, rawLine] of content.replace(/\r\n?/gu, "\n").split("\n").entries()) {
		if (rawLine.includes("\t")) return invalidRoutes(`contains a tab at line ${index + 1}`);
		const withoutComment = stripYamlComment(rawLine);
		if (withoutComment.trim().length === 0) continue;
		const indentation = withoutComment.match(/^ */u)?.[0].length ?? 0;
		const text = withoutComment.slice(indentation);
		if (/^(?:---|\.\.\.)\s*$/u.test(text) || /(?:^|\s)(?:[&*!]|<<\s*:)/u.test(text)) {
			return invalidRoutes(`uses unsupported YAML syntax at line ${index + 1}`);
		}
		lines.push({ indent: indentation, text, line: index + 1 });
	}
	return { ok: true, value: Object.freeze(lines) };
}

function splitFlowItems(value: string): string[] | null {
	const items: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	let depth = 0;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote === "'" && character === "'" && value[index + 1] === "'") {
			index += 1;
			continue;
		}
		if (quote === '"' && character === "\\") {
			index += 1;
			continue;
		}
		if (quote === null && (character === "'" || character === '"')) {
			quote = character;
			continue;
		}
		if (quote !== null && character === quote) {
			quote = null;
			continue;
		}
		if (quote !== null) continue;
		if (character === "[") depth += 1;
		if (character === "]") depth -= 1;
		if (character === "," && depth === 0) {
			items.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}
	if (quote !== null || depth !== 0) return null;
	const last = value.slice(start).trim();
	if (last.length > 0) items.push(last);
	return items;
}

function parseScalar(raw: string, line: number): MemoryResult<YamlValue> {
	const value = raw.trim();
	if (value === "{}") return { ok: true, value: { kind: "map", entries: [] } };
	if (value === "[]") return { ok: true, value: { kind: "sequence", items: [] } };
	if (value.startsWith("[") || value.endsWith("]")) {
		if (!value.startsWith("[") || !value.endsWith("]"))
			return invalidRoutes(`has an invalid inline sequence at line ${line}`);
		const rawItems = splitFlowItems(value.slice(1, -1));
		if (rawItems === null) return invalidRoutes(`has an invalid inline sequence at line ${line}`);
		const items: YamlValue[] = [];
		for (const rawItem of rawItems) {
			const parsed = parseScalar(rawItem, line);
			if (!parsed.ok || (typeof parsed.value === "object" && parsed.value !== null)) {
				return invalidRoutes(`has a nested inline value at line ${line}`);
			}
			items.push(parsed.value);
		}
		return { ok: true, value: { kind: "sequence", items } };
	}
	if ((value.startsWith('"') && !value.endsWith('"')) || (value.startsWith("'") && !value.endsWith("'"))) {
		return invalidRoutes(`has an unterminated quote at line ${line}`);
	}
	if (value.startsWith('"')) {
		try {
			const decoded: unknown = JSON.parse(value);
			if (typeof decoded !== "string") return invalidRoutes(`has a non-string quote at line ${line}`);
			return { ok: true, value: decoded };
		} catch {
			return invalidRoutes(`has an invalid double-quoted scalar at line ${line}`);
		}
	}
	if (value.startsWith("'")) return { ok: true, value: value.slice(1, -1).replace(/''/gu, "'") };
	if (value === "null" || value === "~") return { ok: true, value: null };
	if (value === "true") return { ok: true, value: true };
	if (value === "false") return { ok: true, value: false };
	if (/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
		const number = Number(value);
		if (!Number.isSafeInteger(number)) return invalidRoutes(`has an unsafe integer at line ${line}`);
		return { ok: true, value: number };
	}
	if (/^[&*!]|^<<\s*:/u.test(value)) return invalidRoutes(`uses unsupported YAML syntax at line ${line}`);
	return { ok: true, value };
}

function mappingKey(text: string): { key: string; rawValue: string } | null {
	const match = /^([A-Za-z][A-Za-z0-9_-]*):(?: +(.*))?$/u.exec(text);
	return match === null ? null : { key: match[1], rawValue: match[2] ?? "" };
}

function parseBlock(lines: readonly YamlLine[], start: number, indent: number): MemoryResult<ParseNodeResult> {
	if (start >= lines.length || lines[start].indent !== indent) return invalidRoutes("has inconsistent indentation");
	return lines[start].text.startsWith("-") ? parseSequence(lines, start, indent) : parseMapping(lines, start, indent);
}

function parseMapping(lines: readonly YamlLine[], start: number, indent: number): MemoryResult<ParseNodeResult> {
	const entries: YamlMapEntry[] = [];
	let index = start;
	while (index < lines.length && lines[index].indent === indent) {
		const current = lines[index];
		const keyValue = mappingKey(current.text);
		if (keyValue === null) return invalidRoutes(`has malformed mapping syntax at line ${current.line}`);
		if (entries.some(entry => entry.key === keyValue.key)) return invalidRoutes(`duplicates key ${keyValue.key}`);
		if (keyValue.rawValue.length > 0) {
			const parsed = parseScalar(keyValue.rawValue, current.line);
			if (!parsed.ok) return parsed;
			entries.push({
				key: keyValue.key,
				value: parsed.value,
				line: current.line,
			});
			index += 1;
			if (index < lines.length && lines[index].indent > indent)
				return invalidRoutes(`has unexpected indentation at line ${lines[index].line}`);
			continue;
		}
		if (index + 1 < lines.length && lines[index + 1].indent > indent) {
			const child = parseBlock(lines, index + 1, lines[index + 1].indent);
			if (!child.ok) return child;
			entries.push({
				key: keyValue.key,
				value: child.value.value,
				line: current.line,
			});
			index = child.value.next;
		} else {
			entries.push({
				key: keyValue.key,
				value: { kind: "map", entries: [] },
				line: current.line,
			});
			index += 1;
		}
	}
	return { ok: true, value: { value: { kind: "map", entries }, next: index } };
}

function parseSequence(lines: readonly YamlLine[], start: number, indent: number): MemoryResult<ParseNodeResult> {
	const items: YamlValue[] = [];
	let index = start;
	while (index < lines.length && lines[index].indent === indent) {
		const current = lines[index];
		if (!current.text.startsWith("-")) return invalidRoutes(`mixes mapping and sequence at line ${current.line}`);
		const remainder = current.text.slice(1).trimStart();
		if (remainder.length === 0) {
			if (index + 1 >= lines.length || lines[index + 1].indent <= indent)
				return invalidRoutes(`has an empty sequence item at line ${current.line}`);
			const child = parseBlock(lines, index + 1, lines[index + 1].indent);
			if (!child.ok) return child;
			items.push(child.value.value);
			index = child.value.next;
			continue;
		}
		const inlineKey = mappingKey(remainder);
		if (inlineKey === null) {
			const scalar = parseScalar(remainder, current.line);
			if (!scalar.ok) return scalar;
			items.push(scalar.value);
			index += 1;
			if (index < lines.length && lines[index].indent > indent)
				return invalidRoutes(`indents a scalar item at line ${lines[index].line}`);
			continue;
		}
		const entries: YamlMapEntry[] = [];
		let next = index + 1;
		if (inlineKey.rawValue.length > 0) {
			const first = parseScalar(inlineKey.rawValue, current.line);
			if (!first.ok) return first;
			entries.push({
				key: inlineKey.key,
				value: first.value,
				line: current.line,
			});
		} else if (next < lines.length && lines[next].indent > indent) {
			const first = parseBlock(lines, next, lines[next].indent);
			if (!first.ok) return first;
			entries.push({
				key: inlineKey.key,
				value: first.value.value,
				line: current.line,
			});
			next = first.value.next;
		} else {
			entries.push({
				key: inlineKey.key,
				value: { kind: "map", entries: [] },
				line: current.line,
			});
		}
		if (next < lines.length && lines[next].indent > indent) {
			const child = parseBlock(lines, next, lines[next].indent);
			if (!child.ok) return child;
			const childMap = mapEntries(child.value.value);
			if (childMap === null) return invalidRoutes(`has an invalid mapping sequence item at line ${current.line}`);
			for (const entry of childMap) {
				if (entries.some(existing => existing.key === entry.key))
					return invalidRoutes(`duplicates key ${entry.key}`);
				entries.push(entry);
			}
			next = child.value.next;
		}
		items.push({ kind: "map", entries });
		index = next;
	}
	return {
		ok: true,
		value: { value: { kind: "sequence", items }, next: index },
	};
}

function mapEntries(value: YamlValue): readonly YamlMapEntry[] | null {
	return typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"kind" in value &&
		value.kind === "map"
		? (value as YamlMap).entries
		: null;
}

function sequenceItems(value: YamlValue): readonly YamlValue[] | null {
	return typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"kind" in value &&
		value.kind === "sequence"
		? (value as YamlSequence).items
		: null;
}

function mapValue(entries: readonly YamlMapEntry[], key: string): YamlValue | undefined {
	return entries.find(entry => entry.key === key)?.value;
}

function stringArray(
	value: YamlValue | undefined,
	path: string,
	allowScalar: boolean,
): MemoryResult<readonly string[]> {
	if (value === undefined) return { ok: true, value: [] };
	const items = sequenceItems(value);
	const rawItems = items ?? (allowScalar && typeof value === "string" ? [value] : null);
	if (rawItems === null) return invalidRoutes(`${path} must be a string sequence`);
	const output: string[] = [];
	for (const item of rawItems) {
		if (typeof item !== "string") return invalidRoutes(`${path} contains a non-string value`);
		const normalized = normalizedText(item);
		if (!normalized || !isControlFree(normalized)) return invalidRoutes(`${path} contains an empty or unsafe value`);
		if (!output.includes(normalized)) output.push(normalized);
	}
	return { ok: true, value: Object.freeze(output) };
}

function aliases(value: YamlValue | undefined, path: string): MemoryResult<readonly string[]> {
	const strings = stringArray(value, path, true);
	if (!strings.ok) return strings;
	return {
		ok: true,
		value: Object.freeze(strings.value.map(normalizedAlias).sort(compareUtf8)),
	};
}

function intents(value: YamlValue | undefined, path: string): MemoryResult<readonly MemoryIntent[]> {
	const strings = stringArray(value, path, true);
	if (!strings.ok) return strings;
	const output: MemoryIntent[] = [];
	for (const item of strings.value) {
		const normalized = normalizedText(item).toLowerCase().replace(/[ _]+/gu, "-");
		if (!isMemoryIntent(normalized)) return invalidRoutes(`${path} contains an unknown intent`);
		if (!output.includes(normalized)) output.push(normalized);
	}
	return { ok: true, value: Object.freeze(output.sort(compareUtf8)) };
}

function scopes(value: YamlValue | undefined, path: string): MemoryResult<readonly MemoryScopeKind[]> {
	const strings = stringArray(value, path, true);
	if (!strings.ok) return strings;
	const output: MemoryScopeKind[] = [];
	for (const item of strings.value) {
		const normalized = normalizedText(item).toLowerCase();
		if (!isMemoryScope(normalized)) return invalidRoutes(`${path} contains an unknown scope`);
		if (!output.includes(normalized)) output.push(normalized);
	}
	return { ok: true, value: Object.freeze(output.sort(compareUtf8)) };
}

function routeTarget(value: string, path: string): MemoryResult<string> {
	const normalized = normalizeMemoryRouteTarget(value);
	if (!normalized.ok) return invalidRoutes(`${path} contains an invalid route target`);
	return normalized;
}

function routeReference(value: string, path: string): MemoryResult<string> {
	const normalizedTextValue = normalizedText(value).toLowerCase();
	if (!normalizedTextValue.includes("/") && safeKey(normalizedTextValue)) {
		return { ok: true, value: normalizedTextValue };
	}
	return routeTarget(value, path);
}

function routeDefinition(key: string, value: YamlValue, sourceIndex: number): MemoryResult<RouteDefinition> {
	const id = normalizedText(key).toLowerCase();
	if (!safeKey(id)) return invalidRoutes(`contains an invalid route id: ${key}`);
	let targetValue: YamlValue = value;
	let aliasesValue: YamlValue | undefined;
	let intentsValue: YamlValue | undefined;
	let scopesValue: YamlValue | undefined;
	let queryValue: YamlValue | undefined;
	let defaultValue = false;
	const entries = mapEntries(value);
	if (entries !== null) {
		const allowed = new Set(["targets", "aliases", "intents", "scopes", "scope", "query", "queries", "default"]);
		for (const entry of entries)
			if (!allowed.has(entry.key)) return invalidRoutes(`contains an unknown route key: ${entry.key}`);
		targetValue = mapValue(entries, "targets") ?? {
			kind: "sequence",
			items: [],
		};
		aliasesValue = mapValue(entries, "aliases");
		intentsValue = mapValue(entries, "intents");
		scopesValue = mapValue(entries, "scopes") ?? mapValue(entries, "scope");
		queryValue = mapValue(entries, "queries") ?? mapValue(entries, "query");
		const rawDefault = mapValue(entries, "default");
		if (rawDefault !== undefined) {
			if (typeof rawDefault !== "boolean") return invalidRoutes(`route ${id}.default must be boolean`);
			defaultValue = rawDefault;
		}
	}
	const targetStrings = stringArray(targetValue, `route ${id}.targets`, true);
	if (!targetStrings.ok || targetStrings.value.length === 0) return invalidRoutes(`route ${id} must have targets`);
	const targets: string[] = [];
	for (const target of targetStrings.value) {
		const parsed = routeTarget(target, `route ${id}.targets`);
		if (!parsed.ok) return parsed;
		if (targets.includes(parsed.value)) return invalidRoutes(`route ${id} duplicates a target`);
		targets.push(parsed.value);
	}
	const parsedAliases = aliases(aliasesValue, `route ${id}.aliases`);
	if (!parsedAliases.ok) return parsedAliases;
	const parsedIntents = intents(intentsValue, `route ${id}.intents`);
	if (!parsedIntents.ok) return parsedIntents;
	const parsedScopes = scopes(scopesValue, `route ${id}.scopes`);
	if (!parsedScopes.ok) return parsedScopes;
	const parsedQueries = aliases(queryValue, `route ${id}.queries`);
	if (!parsedQueries.ok) return parsedQueries;
	const allAliases = [...new Set([...parsedAliases.value, id])].sort(compareUtf8);
	return {
		ok: true,
		value: Object.freeze({
			id,
			targets: Object.freeze(targets),
			aliases: Object.freeze(allAliases),
			intents: parsedIntents.value,
			scopes: parsedScopes.value,
			queryTokens: parsedQueries.value,
			default: defaultValue,
			sourceIndex,
		}),
	};
}

function defaultReferences(value: YamlValue | undefined): MemoryResult<readonly string[]> {
	if (value === undefined) return { ok: true, value: [] };
	const entries = mapEntries(value);
	if (entries !== null) {
		const output: string[] = [];
		for (const entry of entries) {
			if (!isMemoryScope(entry.key.toLowerCase()))
				return invalidRoutes(`defaults contains an unknown scope: ${entry.key}`);
			const parsed = stringArray(entry.value, `defaults.${entry.key}`, true);
			if (!parsed.ok) return parsed;
			for (const item of parsed.value) {
				const target = routeReference(item, `defaults.${entry.key}`);

				if (!target.ok) return target;
				if (!output.includes(target.value)) output.push(target.value);
			}
		}
		return { ok: true, value: Object.freeze(output) };
	}
	const parsed = stringArray(value, "defaults", true);
	if (!parsed.ok) return parsed;
	const output: string[] = [];
	for (const item of parsed.value) {
		const target = routeReference(item, "defaults");
		if (!target.ok) return target;
		if (!output.includes(target.value)) output.push(target.value);
	}
	return { ok: true, value: Object.freeze(output) };
}

/** Parse the strict, dependency-free version-1 routes.yaml subset. */
export function parseRoutes(content: string): MemoryResult<RouteConfig> {
	const prepared = prepareYamlLines(content);
	if (!prepared.ok) return prepared;
	if (prepared.value.length === 0) return invalidRoutes("must contain a mapping");
	const parsed = parseBlock(prepared.value, 0, prepared.value[0].indent);
	if (!parsed.ok) return parsed;
	if (parsed.value.next !== prepared.value.length) return invalidRoutes("contains trailing YAML content");
	const root = mapEntries(parsed.value.value);
	if (root === null) return invalidRoutes("root must be a mapping");
	const allowedRoot = new Set(["version", "routes", "defaults"]);
	for (const entry of root)
		if (!allowedRoot.has(entry.key)) return invalidRoutes(`contains an unknown key: ${entry.key}`);
	const version = mapValue(root, "version");
	if (version !== 1) return invalidRoutes("version must be 1");
	const routesValue = mapValue(root, "routes");
	const routeEntries = routesValue === undefined ? [] : mapEntries(routesValue);
	if (routeEntries === null) return invalidRoutes("routes must be a mapping");
	const routes: RouteDefinition[] = [];
	for (const [index, entry] of routeEntries.entries()) {
		const route = routeDefinition(entry.key, entry.value, index);
		if (!route.ok) return route;
		routes.push(route.value);
	}
	const defaults = defaultReferences(mapValue(root, "defaults"));
	if (!defaults.ok) return defaults;
	return {
		ok: true,
		value: Object.freeze({
			version: 1,
			routes: Object.freeze(routes),
			defaults: defaults.value,
		}),
	};
}

function configRoutes(config: RouteConfig): readonly RouteDefinition[] | null {
	if (config === null || typeof config !== "object" || config.version !== 1 || !Array.isArray(config.routes))
		return null;
	return config.routes;
}

function normalizeAvailableUris(input: RouteResolutionInput): MemoryResult<readonly string[]> {
	const entries = input.availableMapUris ?? input.availableMaps ?? [];
	const uris: string[] = [];
	for (const entry of entries) {
		const raw = typeof entry === "string" ? entry : entry?.uri;
		if (typeof raw !== "string") return invalidRoutes("available MAP URI is invalid");
		const normalized = normalizeMemoryRouteTarget(raw);

		if (!normalized.ok) return normalized;
		if (!uris.includes(normalized.value)) uris.push(normalized.value);
	}
	return { ok: true, value: Object.freeze(uris) };
}

function scopeFromUri(uri: string): MemoryScopeKind | null {
	const match = /^memory:\/\/(global|project|session)\//u.exec(uri);
	return match === null ? null : (match[1] as MemoryScopeKind);
}

function rejectedRoute(uri: string): boolean {
	const path = uri.slice("memory://".length).split("#", 1)[0];
	return path.split("/").some(part => REJECTED_DIRECTORY_NAMES.has(part.toLowerCase()));
}
function isSessionCheckpointUri(uri: string): boolean {
	if (scopeFromUri(uri) !== "session") return false;
	const path = uri.slice("memory://session/".length).split("#", 1)[0];
	const parts = path.split("/");
	return parts.length === 2 && parts[0] !== "" && parts[1] === "checkpoint.md";
}

function sessionCheckpointRoute(targets: readonly string[], sourceIndex: number): RouteDefinition {
	return {
		id: SESSION_CHECKPOINT_ROUTE_ID,
		targets: Object.freeze([...targets]),
		aliases: Object.freeze([]),
		intents: Object.freeze(["current-task-status", "resume-session"]),
		scopes: Object.freeze(["session"]),
		queryTokens: Object.freeze([]),
		default: true,
		sourceIndex,
	};
}

function queryWords(value: string): readonly string[] {
	return normalizedText(value)
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.map(token => token.trim())
		.filter(token => token.length > 0)
		.sort(compareUtf8);
}

function routeMatch(route: RouteDefinition, input: RouteResolutionInput, intent: MemoryIntent): RouteMatch | null {
	if (route.intents.includes(intent)) return "intent";
	const aliases = new Set<string>([
		...route.aliases,
		...route.queryTokens,
		...(input.queryAliases ?? input.aliases ?? []).map(normalizedAlias),
	]);
	const query = input.normalizedQuery ?? input.query ?? "";
	const normalizedQuery = normalizedAlias(query);
	if (aliases.has(normalizedQuery)) return "alias";
	const words = new Set(queryWords(query));
	for (const alias of aliases) if (words.has(alias) || queryWords(alias).some(word => words.has(word))) return "query";
	return null;
}

function scopeRank(scope: MemoryScopeKind): number {
	return scope === "session" ? 0 : scope === "project" ? 1 : 2;
}

/** Resolve explicit and default routes without reading ambient state. */
export function resolveRoutes(config: RouteConfig, input: RouteResolutionInput): MemoryResult<RouteResolution> {
	const routes = configRoutes(config);
	if (routes === null || input === null || typeof input !== "object")
		return invalidRoutes("resolution input is invalid");
	if (!isMemoryIntent(input.intent)) return invalidRoutes("resolution intent is unknown");
	const enabledScopes = input.enabledScopes ?? input.scopes;
	if (!Array.isArray(enabledScopes) || enabledScopes.length === 0) return invalidRoutes("enabled scopes are required");
	const scopes = [...new Set(enabledScopes.map(scope => normalizedText(scope).toLowerCase()))];
	if (scopes.some(scope => !isMemoryScope(scope))) return invalidRoutes("enabled scopes contain an unknown scope");
	const available = normalizeAvailableUris(input);
	const hasAvailableMaps = input.availableMapUris !== undefined || input.availableMaps !== undefined;

	if (!available.ok) return available;
	const availableSet = new Set(available.value);
	const selected: SelectedRoute[] = [];
	const considered: ConsideredRoute[] = [];
	const exclusionReasons: string[] = [];
	const defaultIds = new Set<string>(config.defaults.map(normalizedAlias));
	const defaultTargets = new Set<string>();
	for (const value of config.defaults) {
		const normalized = normalizeMemoryRouteTarget(value);
		if (normalized.ok) defaultTargets.add(normalized.value);
	}
	for (const route of routes) {
		if (route.default || route.targets.some(target => defaultTargets.has(target))) {
			defaultIds.add(route.id);
		}
	}
	const matched: Array<{
		readonly route: RouteDefinition;
		readonly match: RouteMatch;
	}> = [];
	for (const route of routes) {
		const match = routeMatch(route, input, input.intent);
		if (match !== null) matched.push({ route, match });
	}
	if (matched.length === 0) {
		for (const route of routes) if (defaultIds.has(route.id)) matched.push({ route, match: "default" });
	}
	if (matched.length === 0 && isContinuityIntent(input.intent) && scopes.includes("session")) {
		const checkpointTargets = available.value.filter(isSessionCheckpointUri).sort(compareUtf8);
		if (checkpointTargets.length > 0) {
			matched.push({
				route: sessionCheckpointRoute(checkpointTargets, routes.length),
				match: "default",
			});
		}
	}
	for (const { route, match } of matched) {
		for (const target of route.targets) {
			const normalizedTarget = normalizeMemoryRouteTarget(target);
			if (!normalizedTarget.ok) {
				considered.push({
					uri: target,
					routeId: route.id,
					scope: null,
					match,
					selected: false,
					exclusionReason: "invalid-uri",
					sourceIndex: route.sourceIndex,
				});
				exclusionReasons.push("invalid-uri");
				continue;
			}
			const uri = normalizedTarget.value;
			const scope = scopeFromUri(uri);
			if (scope === null || rejectedRoute(uri)) {
				considered.push({
					uri,
					routeId: route.id,
					scope,
					match,
					selected: false,
					exclusionReason: "rejected-path",
					sourceIndex: route.sourceIndex,
				});
				exclusionReasons.push("rejected-path");
				continue;
			}
			if (!scopes.includes(scope) || (route.scopes.length > 0 && !route.scopes.includes(scope))) {
				considered.push({
					uri,
					routeId: route.id,
					scope,
					match,
					selected: false,
					exclusionReason: "scope-disabled",
					sourceIndex: route.sourceIndex,
				});
				exclusionReasons.push("scope-disabled");
				continue;
			}
			if (hasAvailableMaps && !availableSet.has(uri)) {
				considered.push({
					uri,
					routeId: route.id,
					scope,
					match,
					selected: false,
					exclusionReason: "map-unavailable",
					sourceIndex: route.sourceIndex,
				});
				exclusionReasons.push("map-unavailable");
				continue;
			}
			if (selected.some(candidate => candidate.uri === uri)) {
				considered.push({
					uri,
					routeId: route.id,
					scope,
					match,
					selected: false,
					exclusionReason: "duplicate-uri",
					sourceIndex: route.sourceIndex,
				});
				exclusionReasons.push("duplicate-uri");
				continue;
			}
			selected.push({
				uri,
				routeId: route.id,
				scope,
				match,
				sourceIndex: route.sourceIndex,
			});
			considered.push({
				uri,
				routeId: route.id,
				scope,
				match,
				selected: true,
				exclusionReason: null,
				sourceIndex: route.sourceIndex,
			});
		}
	}
	selected.sort((left, right) => {
		const byScope = scopeRank(left.scope) - scopeRank(right.scope);
		if (byScope !== 0) return byScope;
		const byUri = compareUtf8(left.uri, right.uri);
		return byUri !== 0 ? byUri : left.sourceIndex - right.sourceIndex;
	});
	const truncated = selected.length > 4;
	if (truncated) {
		for (const route of selected.slice(4)) {
			const index = considered.findIndex(candidate => candidate.uri === route.uri && candidate.selected);
			if (index >= 0)
				considered[index] = {
					...considered[index],
					selected: false,
					exclusionReason: "map-limit",
				};
			exclusionReasons.push("map-limit");
		}
	}
	const selectedRoutes = Object.freeze(selected.slice(0, 4));
	const orderedConsidered = Object.freeze(
		[...considered].sort((left, right) => {
			const leftScope = left.scope === null ? 3 : scopeRank(left.scope);
			const rightScope = right.scope === null ? 3 : scopeRank(right.scope);
			const byScope = leftScope - rightScope;
			if (byScope !== 0) return byScope;
			const byUri = compareUtf8(left.uri, right.uri);
			return byUri !== 0 ? byUri : left.sourceIndex - right.sourceIndex;
		}),
	);
	return {
		ok: true,
		value: Object.freeze({
			selectedRoutes,
			consideredRoutes: orderedConsidered,
			exclusionReasons: Object.freeze([...new Set(exclusionReasons)].sort(compareUtf8)),
			truncated,
		}),
	};
}
