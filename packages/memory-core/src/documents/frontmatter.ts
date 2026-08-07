import { MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import type {
	AuthorityTier,
	DocumentStatus,
	MemoryDocumentType,
	MemoryScopeKind,
	Sensitivity,
	Volatility,
} from "../index";

export const MEMORY_DOCUMENT_SCHEMA_VERSION = "gajae.memory.document.v1" as const;

export interface VerificationMetadata {
	readonly provider: string;
	readonly resource: string;
	readonly id: string;
}

export interface MemoryDocumentMetadata {
	readonly schemaVersion: typeof MEMORY_DOCUMENT_SCHEMA_VERSION;
	readonly id: string;
	readonly type: MemoryDocumentType;
	readonly scope: MemoryScopeKind;
	readonly authority: AuthorityTier;
	readonly volatility: Volatility;
	readonly sensitivity: Sensitivity;
	readonly status: DocumentStatus;
	readonly created: string;
	readonly updated: string;
	readonly aliases: readonly string[];
	readonly supersedes: readonly string[];
	readonly verification: VerificationMetadata | null;
}

export interface ParsedFrontmatter {
	readonly metadata: MemoryDocumentMetadata;
	readonly frontmatter: MemoryDocumentMetadata;
	readonly content: string;
	readonly normalizedContent: string;
	readonly body: string;
	readonly frontmatterStartLine: number;
	readonly frontmatterEndLine: number;
	readonly bodyStartLine: number;
}

type YamlObject = { [key: string]: YamlNode };
type YamlNode = string | number | boolean | null | readonly YamlNode[] | YamlObject;

interface SourceLine {
	readonly line: number;
	readonly indent: number;
	readonly text: string;
}

interface NodeSuccess<T> {
	readonly ok: true;
	readonly value: T;
	readonly next: number;
}

interface NodeFailure {
	readonly ok: false;
	readonly detail: string;
}

type NodeResult<T> = NodeSuccess<T> | NodeFailure;

const AUTHORITY_TIERS: readonly AuthorityTier[] = [
	"user-confirmed",
	"repository-reviewed",
	"project-config",
	"tool-verified",
	"session-observed",
	"model-inferred",
	"unverified",
];
const DOCUMENT_TYPES: readonly MemoryDocumentType[] = [
	"preference",
	"constraint",
	"policy",
	"convention",
	"decision",
	"fact",
	"observation",
	"hypothesis",
	"task-state",
	"handoff",
	"checkpoint",
	"note",
];
const SCOPES: readonly MemoryScopeKind[] = ["global", "project", "session"];
const VOLATILITIES: readonly Volatility[] = ["stable", "volatile", "historical"];
const SENSITIVITIES: readonly Sensitivity[] = ["public-safe", "private", "restricted"];
const STATUSES: readonly DocumentStatus[] = ["active", "proposed", "superseded", "archived", "rejected"];
const TOP_LEVEL_FIELDS = new Set([
	"schemaVersion",
	"id",
	"type",
	"scope",
	"authority",
	"volatility",
	"sensitivity",
	"status",
	"created",
	"updated",
	"aliases",
	"supersedes",
	"verification",
]);
const VERIFICATION_FIELDS = new Set(["provider", "resource", "id"]);
const STRICT_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

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

export function normalizeDocumentText(content: string): string {
	return content.replace(/\r\n?/g, "\n").normalize("NFC");
}

function yamlString(value: string): string {
	return JSON.stringify(value.normalize("NFC"));
}

function yamlArray(values: readonly string[]): string {
	if (values.length === 0) return "[]";
	return `[${values.map(yamlString).join(", ")}]`;
}

export function serializeFrontmatter(metadata: MemoryDocumentMetadata): string {
	const lines = [
		"---",
		`schemaVersion: ${yamlString(metadata.schemaVersion)}`,
		`id: ${yamlString(metadata.id)}`,
		`type: ${yamlString(metadata.type)}`,
		`scope: ${yamlString(metadata.scope)}`,
		`authority: ${yamlString(metadata.authority)}`,
		`volatility: ${yamlString(metadata.volatility)}`,
		`sensitivity: ${yamlString(metadata.sensitivity)}`,
		`status: ${yamlString(metadata.status)}`,
		`created: ${yamlString(metadata.created)}`,
		`updated: ${yamlString(metadata.updated)}`,
		`aliases: ${yamlArray(metadata.aliases)}`,
		`supersedes: ${yamlArray(metadata.supersedes)}`,
	];
	if (metadata.verification !== null) {
		lines.push("verification:");
		lines.push(`  provider: ${yamlString(metadata.verification.provider)}`);
		lines.push(`  resource: ${yamlString(metadata.verification.resource)}`);
		lines.push(`  id: ${yamlString(metadata.verification.id)}`);
	}
	lines.push("---");
	return lines.join("\n");
}

function isRecord(value: YamlNode): value is YamlObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isYamlArray(value: YamlNode): value is readonly YamlNode[] {
	return Array.isArray(value);
}

function stripComment(raw: string): NodeResult<string> {
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < raw.length; index += 1) {
		const character = raw[index];
		if (quote === '"') {
			if (character === "\\") {
				index += 1;
				continue;
			}
			if (character === '"') quote = null;
			continue;
		}
		if (quote === "'") {
			if (character === "'" && raw[index + 1] === "'") {
				index += 1;
				continue;
			}
			if (character === "'") quote = null;
			continue;
		}
		if ((character === '"' || character === "'") && (index === 0 || /\s/.test(raw[index - 1] ?? ""))) {
			quote = character;
			continue;
		}
		if (character === "#" && (index === 0 || /\s/.test(raw[index - 1] ?? ""))) {
			return { ok: true, value: raw.slice(0, index).trimEnd(), next: 0 };
		}
	}
	if (quote !== null) return { ok: false, detail: "unterminated quoted scalar" };
	return { ok: true, value: raw.trimEnd(), next: 0 };
}

function parseDoubleQuoted(value: string): NodeResult<string> {
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "string") return { ok: false, detail: "double-quoted scalar must be a string" };
		return { ok: true, value: parsed, next: 0 };
	} catch {
		return { ok: false, detail: "invalid double-quoted scalar" };
	}
}

function parseSingleQuoted(value: string): NodeResult<string> {
	if (value.length < 2 || !value.endsWith("'")) return { ok: false, detail: "invalid single-quoted scalar" };
	return { ok: true, value: value.slice(1, -1).replace(/''/g, "'"), next: 0 };
}

function parseScalar(value: string): NodeResult<YamlNode> {
	const trimmed = value.trim();
	if (trimmed.length === 0) return { ok: false, detail: "empty scalar" };
	if (trimmed.startsWith('"')) {
		if (!trimmed.endsWith('"')) return { ok: false, detail: "invalid double-quoted scalar" };
		return parseDoubleQuoted(trimmed);
	}
	if (trimmed.startsWith("'")) return parseSingleQuoted(trimmed);
	if (trimmed.startsWith("!") || trimmed.startsWith("&") || trimmed.startsWith("*") || trimmed.startsWith("|")) {
		return { ok: false, detail: "YAML tags, anchors, aliases, and block scalars are not supported" };
	}
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		if (!trimmed.endsWith("}")) {
			if (!trimmed.endsWith("]")) return { ok: false, detail: "invalid inline collection" };
			return parseInlineArray(trimmed);
		}
		return { ok: false, detail: "inline objects are not supported" };
	}
	if (trimmed === "null" || trimmed === "~") return { ok: true, value: null, next: 0 };
	if (trimmed === "true") return { ok: true, value: true, next: 0 };
	if (trimmed === "false") return { ok: true, value: false, next: 0 };
	if (/^[+-]?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|(?:0|[1-9][0-9]*)[eE][+-]?[0-9]+)$/.test(trimmed)) {
		const numberValue = Number(trimmed);
		if (!Number.isFinite(numberValue)) return { ok: false, detail: "number is not finite" };
		return { ok: true, value: numberValue, next: 0 };
	}
	if (/^[[\]{}|>&*!]/.test(trimmed)) return { ok: false, detail: "unsupported YAML scalar" };
	if (
		[...trimmed].some(character => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && codePoint < 0x20 && character !== "\t";
		})
	) {
		return { ok: false, detail: "scalar contains a control character" };
	}
	return { ok: true, value: trimmed, next: 0 };
}

function splitInlineArray(value: string): NodeResult<readonly string[]> {
	if (value === "[]") return { ok: true, value: [], next: 0 };
	if (!value.endsWith("]")) return { ok: false, detail: "unterminated inline array" };
	const inside = value.slice(1, -1).trim();
	if (inside.length === 0) return { ok: true, value: [], next: 0 };
	const parts: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < inside.length; index += 1) {
		const character = inside[index];
		if (quote === '"') {
			if (character === "\\") index += 1;
			else if (character === '"') quote = null;
			continue;
		}
		if (quote === "'") {
			if (character === "'" && inside[index + 1] === "'") index += 1;
			else if (character === "'") quote = null;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === ",") {
			parts.push(inside.slice(start, index).trim());
			start = index + 1;
		}
	}
	if (quote !== null) return { ok: false, detail: "unterminated quoted array item" };
	parts.push(inside.slice(start).trim());
	if (parts.some(part => part.length === 0)) return { ok: false, detail: "inline array contains an empty item" };
	return { ok: true, value: parts, next: 0 };
}

function parseInlineArray(value: string): NodeResult<YamlNode> {
	const parts = splitInlineArray(value);
	if (!parts.ok) return parts;
	const nodes: YamlNode[] = [];
	for (const part of parts.value) {
		const scalar = parseScalar(part);
		if (!scalar.ok) return scalar;
		nodes.push(scalar.value);
	}
	return { ok: true, value: nodes, next: 0 };
}

function parseMapping(lines: readonly SourceLine[], start: number, indent: number): NodeResult<YamlObject> {
	const result: YamlObject = Object.create(null) as YamlObject;
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (line.indent < indent) break;
		if (line.indent > indent) return { ok: false, detail: `unexpected indentation on line ${line.line}` };
		if (line.text.startsWith("-")) return { ok: false, detail: `unexpected sequence item on line ${line.line}` };
		const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line.text);
		if (match === null) return { ok: false, detail: `expected a mapping entry on line ${line.line}` };
		const key = match[1];
		if (Object.hasOwn(result, key)) return { ok: false, detail: `duplicate field ${key}` };
		const remainder = match[2];
		if (remainder.includes("\t")) return { ok: false, detail: `tabs are not supported on line ${line.line}` };
		const valueText = remainder.trim();
		if (valueText.length > 0) {
			const parsed = parseScalar(valueText);
			if (!parsed.ok) return parsed;
			result[key] = parsed.value;
			index += 1;
			continue;
		}
		const next = index + 1;
		if (next >= lines.length || lines[next].indent <= indent) {
			return { ok: false, detail: `field ${key} must have a value` };
		}
		const childIndent = lines[next].indent;
		const child = lines[next].text.startsWith("-")
			? parseSequence(lines, next, childIndent)
			: parseMapping(lines, next, childIndent);
		if (!child.ok) return child;
		result[key] = child.value;
		index = child.next;
	}
	return { ok: true, value: result, next: index };
}

function parseSequence(lines: readonly SourceLine[], start: number, indent: number): NodeResult<readonly YamlNode[]> {
	const result: YamlNode[] = [];
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (line.indent < indent) break;
		if (line.indent > indent) return { ok: false, detail: `unexpected indentation on line ${line.line}` };
		if (!line.text.startsWith("-") || (line.text.length > 1 && !/\s/.test(line.text[1] ?? ""))) {
			return { ok: false, detail: `expected a sequence item on line ${line.line}` };
		}
		const itemText = line.text.slice(1).trim();
		if (itemText.length === 0) return { ok: false, detail: `sequence item on line ${line.line} must be scalar` };
		const parsed = parseScalar(itemText);
		if (!parsed.ok) return parsed;
		if (parsed.value !== null && typeof parsed.value === "object") {
			return { ok: false, detail: `sequence item on line ${line.line} must be scalar` };
		}
		result.push(parsed.value);
		index += 1;
	}
	return { ok: true, value: result, next: index };
}

function parseYaml(lines: readonly SourceLine[]): NodeResult<YamlObject> {
	if (lines.length === 0) return { ok: false, detail: "frontmatter is empty" };
	if (lines[0].indent !== 0) return { ok: false, detail: "frontmatter must start at indentation zero" };
	const parsed = parseMapping(lines, 0, 0);
	if (!parsed.ok) return parsed;
	if (parsed.next !== lines.length)
		return { ok: false, detail: `unexpected content on line ${lines[parsed.next].line}` };
	return parsed;
}

function asNonEmptyString(value: YamlNode, field: string): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.normalize("NFC");
	if (normalized.length === 0 || normalized.trim() !== normalized) return null;
	if (
		[...normalized].some(character => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && codePoint < 0x20;
		})
	)
		return null;
	if (field.length === 0) return null;
	return normalized;
}

function asAliasString(value: YamlNode): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.normalize("NFC").trim().toLowerCase();
	if (normalized.length === 0) return null;
	if (
		[...normalized].some(character => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && codePoint < 0x20;
		})
	)
		return null;
	return normalized;
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
	return (values as readonly string[]).includes(value);
}

function strictTimestamp(value: string): boolean {
	const match = STRICT_UTC_PATTERN.exec(value);
	if (match === null) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const millisecond = Number(match[7] ?? "0");
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || millisecond > 999) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	if (day < 1 || day > (daysInMonth ?? 0)) return false;
	return Number.isFinite(Date.parse(value));
}

function stringArray(value: YamlNode | undefined, field: string): readonly string[] | null {
	if (value === undefined) return [];
	if (!isYamlArray(value)) return null;
	const items: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		const normalized = asNonEmptyString(item, field);
		if (normalized === null || seen.has(normalized)) return null;
		seen.add(normalized);
		items.push(normalized);
	}
	return items;
}

function aliasArray(value: YamlNode | undefined): readonly string[] | null {
	if (value === undefined) return [];
	if (!isYamlArray(value)) return null;
	const items: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		const normalized = asAliasString(item);
		if (normalized === null || seen.has(normalized)) return null;
		seen.add(normalized);
		items.push(normalized);
	}
	return items;
}

function verificationObject(value: YamlNode | undefined): VerificationMetadata | null {
	if (value === undefined) return null;
	if (!isRecord(value)) return null;
	const keys = Object.keys(value);
	if (keys.length !== VERIFICATION_FIELDS.size || keys.some(key => !VERIFICATION_FIELDS.has(key))) return null;
	const provider = asNonEmptyString(value.provider, "provider");
	const resource = asNonEmptyString(value.resource, "resource");
	const id = asNonEmptyString(value.id, "id");
	if (provider === null || resource === null || id === null) return null;
	return Object.freeze({ provider, resource, id });
}

function sourceLines(frontmatterLines: readonly string[], offset: number): NodeResult<readonly SourceLine[]> {
	const result: SourceLine[] = [];
	for (let index = 0; index < frontmatterLines.length; index += 1) {
		const raw = frontmatterLines[index];
		const withoutComment = stripComment(raw);
		if (!withoutComment.ok) return withoutComment;
		const cleaned = withoutComment.value;
		if (cleaned.trim().length === 0) continue;
		const indentMatch = /^( *)/.exec(cleaned);
		const indent = indentMatch?.[1].length ?? 0;
		if (cleaned.includes("\t")) return { ok: false, detail: `tabs are not supported on line ${offset + index + 1}` };
		result.push({ line: offset + index + 1, indent, text: cleaned.slice(indent).trimEnd() });
	}
	return { ok: true, value: result, next: 0 };
}

export function parseFrontmatter(content: string, relPath = "<memory-document>"): MemoryResult<ParsedFrontmatter> {
	const pathLabel = typeof relPath === "string" && relPath.length > 0 ? relPath : "<memory-document>";
	if (typeof content !== "string") return malformed(pathLabel, "document content must be a string");
	const normalizedContent = normalizeDocumentText(content);
	const lines = normalizedContent.split("\n");
	if (lines[0] !== "---") return malformed(pathLabel, "document must begin with a YAML frontmatter delimiter");
	let closingIndex = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index] === "---") {
			closingIndex = index;
			break;
		}
	}
	if (closingIndex < 0) return malformed(pathLabel, "frontmatter has no closing delimiter");
	const yamlLines = sourceLines(lines.slice(1, closingIndex), 1);
	if (!yamlLines.ok) return malformed(pathLabel, yamlLines.detail);
	const parsedYaml = parseYaml(yamlLines.value);
	if (!parsedYaml.ok) return malformed(pathLabel, parsedYaml.detail);
	for (const key of Object.keys(parsedYaml.value)) {
		if (!TOP_LEVEL_FIELDS.has(key)) return malformed(pathLabel, `unknown frontmatter field ${key}`);
	}
	const requiredFields = [
		"schemaVersion",
		"id",
		"type",
		"scope",
		"authority",
		"volatility",
		"sensitivity",
		"status",
		"created",
		"updated",
	] as const;
	for (const field of requiredFields) {
		if (!Object.hasOwn(parsedYaml.value, field))
			return malformed(pathLabel, `missing required frontmatter field ${field}`);
	}
	const schemaVersion = asNonEmptyString(parsedYaml.value.schemaVersion, "schemaVersion");
	if (schemaVersion !== MEMORY_DOCUMENT_SCHEMA_VERSION)
		return malformed(pathLabel, "schemaVersion must be gajae.memory.document.v1");
	const id = asNonEmptyString(parsedYaml.value.id, "id");
	const type = asNonEmptyString(parsedYaml.value.type, "type");
	const scope = asNonEmptyString(parsedYaml.value.scope, "scope");
	const authority = asNonEmptyString(parsedYaml.value.authority, "authority");
	const volatility = asNonEmptyString(parsedYaml.value.volatility, "volatility");
	const sensitivity = asNonEmptyString(parsedYaml.value.sensitivity, "sensitivity");
	const status = asNonEmptyString(parsedYaml.value.status, "status");
	const created = asNonEmptyString(parsedYaml.value.created, "created");
	const updated = asNonEmptyString(parsedYaml.value.updated, "updated");
	if (
		id === null ||
		type === null ||
		scope === null ||
		authority === null ||
		volatility === null ||
		sensitivity === null ||
		status === null ||
		created === null ||
		updated === null
	) {
		return malformed(pathLabel, "required frontmatter fields must be non-empty strings");
	}
	if (!isOneOf(type, DOCUMENT_TYPES)) return malformed(pathLabel, `unknown document type ${type}`);
	if (!isOneOf(scope, SCOPES)) return malformed(pathLabel, `unknown document scope ${scope}`);
	if (!isOneOf(authority, AUTHORITY_TIERS)) return malformed(pathLabel, `unknown authority ${authority}`);
	if (!isOneOf(volatility, VOLATILITIES)) return malformed(pathLabel, `unknown volatility ${volatility}`);
	if (!isOneOf(sensitivity, SENSITIVITIES)) return malformed(pathLabel, `unknown sensitivity ${sensitivity}`);
	if (!isOneOf(status, STATUSES)) return malformed(pathLabel, `unknown document status ${status}`);
	if (!strictTimestamp(created) || !strictTimestamp(updated))
		return malformed(pathLabel, "created and updated must be strict UTC timestamps");
	if (Date.parse(created) > Date.parse(updated)) return malformed(pathLabel, "created must not be later than updated");
	const aliases = aliasArray(parsedYaml.value.aliases);
	const supersedes = stringArray(parsedYaml.value.supersedes, "supersedes");
	if (aliases === null || supersedes === null)
		return malformed(pathLabel, "aliases and supersedes must be unique string arrays");
	const verification = verificationObject(parsedYaml.value.verification);
	if (Object.hasOwn(parsedYaml.value, "verification") && verification === null) {
		return malformed(pathLabel, "verification must contain exactly provider, resource, and id strings");
	}
	const metadata = Object.freeze({
		schemaVersion,
		id,
		type,
		scope,
		authority,
		volatility,
		sensitivity,
		status,
		created,
		updated,
		aliases: Object.freeze([...aliases]),
		supersedes: Object.freeze([...supersedes]),
		verification,
	}) as MemoryDocumentMetadata;
	const body = lines.slice(closingIndex + 1).join("\n");
	const result: ParsedFrontmatter = Object.freeze({
		metadata,
		frontmatter: metadata,
		content: normalizedContent,
		normalizedContent,
		body,
		frontmatterStartLine: 1,
		frontmatterEndLine: closingIndex + 1,
		bodyStartLine: closingIndex + 2,
	});
	return { ok: true, value: result };
}
