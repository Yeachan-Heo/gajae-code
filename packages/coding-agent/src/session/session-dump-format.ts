/**
 * Plain-text / markdown session formatting (same shape as /dump clipboard export).
 */
import type { AgentMessage, ThinkingLevel } from "@gajae-code/agent-core";
import { INTENT_FIELD } from "@gajae-code/agent-core";
import type { AssistantMessage, Model } from "@gajae-code/ai/core";
import {
	applyRedactions,
	asOriginalText,
	collectCrashRedactionRanges,
	findPrivateKeySpans,
	isCredentialKey,
	isHeaderCollectionKey,
	PRIVATE_KEY_REDACTION_MARKER,
	type PrivateKeySpan,
	type RedactionRanges,
} from "@gajae-code/utils";
import { buildCacheEconomicsWarning, type CacheWarningBuildState } from "./cache-economics";
import {
	type BashExecutionMessage,
	type BranchSummaryMessage,
	bashExecutionToText,
	type CompactionSummaryMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	type PythonExecutionMessage,
	pythonExecutionToText,
} from "./messages";

/** Minimal tool shape for dump output (matches AgentTool fields used by formatSessionDumpText). */
export interface SessionDumpToolInfo {
	name: string;
	description: string;
	parameters: unknown;
}

export interface FormatSessionDumpTextOptions {
	messages: readonly AgentMessage[];
	systemPrompt?: readonly string[] | null;
	model?: Model | null;
	thinkingLevel?: ThinkingLevel | string | null;
	tools?: readonly SessionDumpToolInfo[];
}

function stripTypeBoxFields(obj: unknown): unknown {
	if (Array.isArray(obj)) {
		return obj.map(stripTypeBoxFields);
	}
	if (obj && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			if (!k.startsWith("TypeBox.")) {
				result[k] = stripTypeBoxFields(v);
			}
		}
		return result;
	}
	return obj;
}

function takeRedactedTextRun(parts: string[]): string | undefined {
	if (parts.length === 0) return undefined;
	let redacted: string;
	if (parts.length === 1) {
		// Message text is literal, not encoded JSON, so its `\u` escapes are evidence and stay.
		redacted = redactDumpText(parts[0]);
	} else {
		// Blocks are rendered with a newline between them, which would split a banner that straddles
		// two blocks, so the pairing is detected while the parts are still adjacent. Detection reads
		// the original parts; the mapped private-key ranges join one application pass over the
		// original text, which also finds the containers, URLs and YAML bodies in it.
		const spansByPart = crossFieldPrivateKeySpans(parts);
		const joined = parts.join("\n");
		const privateKeys: PrivateKeySpan[] = [];
		let offset = 0;
		for (let index = 0; index < parts.length; index++) {
			for (const span of spansByPart[index]) {
				privateKeys.push({ start: offset + span.start, end: offset + span.end });
			}
			offset += parts[index].length + 1;
		}
		redacted = scrubText(joined, privateKeys);
	}
	parts.length = 0;
	return redacted;
}

function escapeXmlAttribute(input: string): string {
	return input.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlText(input: string): string {
	return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Decoded character of one `\uXXXX` escape. Control characters stay spelled out unless the
 * caller asks for them: they are identity evidence for a field name (the credential labels
 * accept a tab separator), but a printed value or name must never carry one.
 */
function decodeCodePoint(hex: string, allowControlCharacters: boolean): string {
	const codePoint = Number.parseInt(hex, 16);
	if (!Number.isFinite(codePoint) || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return `\\u${hex}`;
	if (!allowControlCharacters && (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f))) {
		return `\\u${hex}`;
	}
	return String.fromCharCode(codePoint);
}

function decodeUnicodeEscapeText(input: string, allowControlCharacters = false): string {
	const decode = (_match: string, hex: string) => decodeCodePoint(hex, allowControlCharacters);
	return input.replace(/\\\\u([0-9a-fA-F]{4})/g, decode).replace(/\\u([0-9a-fA-F]{4})/g, decode);
}

function markerWithPath(marker: string, markerPath: string | undefined): string {
	return markerPath === undefined || markerPath.length === 0 ? marker : `${marker}#${markerPath}`;
}

/**
 * Give every emitted marker a suffix for its location in a rendered schema. A covered value that
 * lands in several array slots would otherwise print the same placeholder each time and violate
 * `uniqueItems`; longer markers are always safe, and this never shortens a marker.
 */
function withMarkerPath(ranges: RedactionRanges, markerPath: string | undefined): RedactionRanges {
	if (markerPath === undefined || markerPath.length === 0) return ranges;
	return ranges.map(range => ({
		...range,
		label: range.label.length === 0 ? range.label : markerWithPath(range.label, markerPath),
	}));
}

/**
 * One detection pass over the original text, one application. `privateKeys` are ranges a caller
 * mapped from a wider original source; everything else is detected in `text` itself.
 */
function scrubText(text: string, privateKeys: readonly PrivateKeySpan[], markerPath?: string): string {
	const original = asOriginalText(text);
	return applyRedactions(original, withMarkerPath(collectCrashRedactionRanges(original, privateKeys), markerPath));
}

/** A field name is scrubbed through the same original-text detection as a value. */
function scrubName(name: string): string {
	const original = asOriginalText(name);
	return applyRedactions(original, collectCrashRedactionRanges(original));
}

/** Scrub one block of dump text, detecting its masks in that same text. */
function redactDumpText(text: string): string {
	const original = asOriginalText(text);
	return applyRedactions(original, collectCrashRedactionRanges(original));
}

/**
 * Locate private-key blocks that span sibling argument values.
 * Leaves are joined in serialization order without a separator so a banner split
 * mid-token is still paired, and each block is mapped back to ranges of the
 * original leaves. Detection happens before any field-level credential masking
 * can remove one of the two banners.
 */
function crossFieldPrivateKeySpans(values: readonly string[]): PrivateKeySpan[][] {
	const spansByValue: PrivateKeySpan[][] = values.map(() => []);
	const offsets: number[] = [];
	let joined = "";
	for (const value of values) {
		offsets.push(joined.length);
		joined += value;
	}
	// Spans and leaves are both ordered, so the walk advances one leaf pointer instead of
	// visiting every leaf for every span.
	let leaf = 0;
	for (const span of findPrivateKeySpans(asOriginalText(joined))) {
		while (leaf < values.length && offsets[leaf] + values[leaf].length <= span.start) leaf++;
		for (let index = leaf; index < values.length; index++) {
			const valueStart = offsets[index];
			if (valueStart >= span.end) break;
			const valueEnd = valueStart + values[index].length;
			const start = Math.max(span.start, valueStart) - valueStart;
			const end = Math.min(span.end, valueEnd) - valueStart;
			if (end > start) spansByValue[index].push({ start, end });
		}
	}
	return spansByValue;
}

/**
 * Collect the text the renderer emits for every leaf of a value tree, in serialization order.
 * Private-key body text can pass through a numeric, boolean or null argument, which is printed by
 * `JSON.stringify`, so those characters belong to the paired stream too: leaving them out let a
 * block be recognized across two string siblings while the digits between them stayed printed.
 */
function collectSerializedLeaves(value: unknown, out: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collectSerializedLeaves(item, out);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const nested of Object.values(value)) collectSerializedLeaves(nested, out);
		return;
	}
	out.push(serializeParameterValue(value));
}

/**
 * Content masks for the printed scalars of one value tree, in serialization order.
 * Detection fills `spansByLeaf` from the original leaves; application consumes one entry per
 * printed scalar, so both walks visit exactly the same slots, holes included.
 */
interface ValueRedactionPlan {
	readonly spansByLeaf: readonly (readonly PrivateKeySpan[])[];
	readonly cursor: { index: number };
}

/**
 * Detect the private-key ranges that span sibling values, at any nesting depth, and pair them with
 * the rendered leaves they will be applied to.
 *
 * Detection reads the decoded original tree: values are joined in traversal order, so a banner
 * split across adjacent values is found, and each block is mapped back to ranges of the leaves it
 * covers. Field names never enter the joined stream — a name between two halves would separate
 * them, and a name never contributes characters to a block.
 *
 * This is the detection half of the single boundary: no leaf may be replaced before the structural
 * walk has classified it, and no classification may read a replaced leaf.
 */
function createValueRedactionPlan(value: unknown): ValueRedactionPlan {
	const leaves: string[] = [];
	collectSerializedLeaves(value, leaves);
	return { spansByLeaf: crossFieldPrivateKeySpans(leaves), cursor: { index: 0 } };
}

/** Take the next printed scalar's private-key ranges; every scalar consumes exactly one entry. */
function takeLeafSpans(plan: ValueRedactionPlan): readonly PrivateKeySpan[] {
	return plan.spansByLeaf[plan.cursor.index++] ?? [];
}

/** Read the next printed scalar's ranges without consuming its plan entry. */
function peekLeafSpans(plan: ValueRedactionPlan): readonly PrivateKeySpan[] {
	return plan.spansByLeaf[plan.cursor.index] ?? [];
}

/**
 * Advance the plan over a value a structural mask replaces whole. It collects the same leaves the
 * plan collected, through the same walk, so collapsing a subtree cannot shift a later scalar.
 */
function skipValueLeaves(plan: ValueRedactionPlan, value: unknown): void {
	const leaves: string[] = [];
	collectSerializedLeaves(value, leaves);
	plan.cursor.index += leaves.length;
}

/** Both escape layers an argument or schema field name can carry; control characters stay spelled. */
function decodeEscapedText(input: string): string {
	return decodeUnicodeEscapeText(decodeUnicodeEscapeText(input));
}

/**
 * Both escape layers including control characters: identity evidence for a field name, because
 * the credential labels accept a tab separator that an encoded name can carry. Never printed.
 */
function decodeEscapedIdentity(input: string): string {
	return decodeUnicodeEscapeText(decodeUnicodeEscapeText(input, true), true);
}

/**
 * Decode `\u` escapes in every string leaf and every field name, so banner detection,
 * credential-name recognition and the printed value all see the characters a reader sees.
 * Tool arguments can carry one encoded layer and the value itself can spell another, which
 * the renderer used to decode after this prepass; decoding twice here keeps banner pairing
 * and the printed value on the same characters instead of materialising a banner later.
 * A field name is only credential-shaped once its escapes are resolved, so recognition reads
 * the resolved spelling; the name itself is stored and printed as it arrived.
 * The spelling each entry keeps is the one it arrived with, so the pairing stream stays in its
 * original order and no entry is dropped, renamed or moved. Credential recognition resolves the
 * spelling instead, so an encoded name classifies like the name it stands for.
 */
function decodeValueStrings(value: unknown): unknown {
	if (typeof value === "string") return decodeEscapedText(value);
	// Holes are normalized to the `null` they print as, so the leaf collection and the application
	// walk visit exactly the same slots instead of one counting a hole the other skips.
	if (Array.isArray(value)) return Array.from(value, item => decodeValueStrings(item));
	if (value === null || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	const decoded = Object.create(null) as Record<string, unknown>;
	for (const [key, nested] of Object.entries(source)) {
		// The entry keeps the spelling it arrived with, so decoding never renames or reorders a
		// field. Recognition reads the resolved spelling through `fieldIdentity` instead.
		decoded[key] = decodeValueStrings(nested);
	}
	return decoded;
}

/**
 * The name a stored field stands for, so recognition reads the resolved spelling even when a
 * sibling forced this entry to keep the one it arrived with. Control characters are resolved
 * too: an encoded tab between label parts has to classify like the tab itself.
 */
function fieldIdentity(key: string): string {
	return decodeEscapedIdentity(key);
}

function serializeParameterValue(value: unknown): string {
	return typeof value === "string" ? value : (JSON.stringify(value, null, "\t") ?? "null");
}

/**
 * One data value (a tool argument, or a schema's literal data) rebuilt from the original tree with
 * the mask plan applied. Every recognition below reads `value`, which is always an unmodified
 * original: a replaced leaf never feeds back into the classification of a header collection, a
 * header record, or a credential name.
 */
function nestedMarkerPath(markerPath: string | undefined, segment: string | number): string | undefined {
	if (markerPath === undefined) return undefined;
	if (typeof segment === "number") return `${markerPath}[${segment}]`;
	return markerPath.length === 0 ? segment : `${markerPath}.${segment}`;
}

function sanitizeDataValue(
	value: unknown,
	fieldName: string | undefined,
	plan: ValueRedactionPlan,
	markerPath?: string,
): unknown {
	if (fieldName !== undefined && isCredentialKey(fieldIdentity(fieldName))) {
		skipValueLeaves(plan, value);
		return markerWithPath("«redacted»", markerPath);
	}
	if (typeof value === "string") return scrubText(value, takeLeafSpans(plan), markerPath);
	if (value === null || typeof value !== "object") {
		// A number, boolean or null has no textual form that can keep part of a block, so a covered
		// one is replaced whole instead of keeping a fragment of the key.
		return takeLeafSpans(plan).length > 0 ? markerWithPath(PRIVATE_KEY_REDACTION_MARKER, markerPath) : value;
	}
	if (Array.isArray(value)) {
		// A header collection is a flat name/value list only when the original slots say so: a slot a
		// mask will replace still counts with the type it arrived with, so replacing a numeric slot
		// can never turn a mixed collection into a name/value list and pair its records wrongly.
		const headerCollection = fieldName !== undefined && isHeaderCollectionKey(fieldIdentity(fieldName));
		const flatPairs =
			headerCollection &&
			value.length > 0 &&
			value.length % 2 === 0 &&
			value.every((item, index) => index % 2 === 1 || typeof item === "string");
		const sanitized: unknown[] = [];
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			const itemPath = nestedMarkerPath(markerPath, index);
			if (flatPairs && index % 2 === 1) {
				const headerName = value[index - 1];
				if (typeof headerName === "string" && isCredentialKey(fieldIdentity(headerName))) {
					skipValueLeaves(plan, item);
					sanitized.push(markerWithPath("«redacted»", itemPath));
					continue;
				}
			}
			sanitized.push(sanitizeDataValue(item, flatPairs ? undefined : fieldName, plan, itemPath));
		}
		return sanitized;
	}

	const source = value as Record<string, unknown>;
	const sourceKeys = Object.keys(source);
	let hasCredentialHeaderName = false;
	let hasHeaderValue = false;
	for (const field of sourceKeys) {
		const normalized = fieldIdentity(field).toLowerCase();
		if (normalized === "value" || normalized === "values") hasHeaderValue = true;
		if (normalized !== "name" && normalized !== "key") continue;
		// The header name is read as the string it arrived as, before any mask can replace it.
		const headerName = source[field];
		if (typeof headerName === "string" && isCredentialKey(fieldIdentity(headerName))) hasCredentialHeaderName = true;
	}
	const maskHeaderValue =
		fieldName !== undefined &&
		isHeaderCollectionKey(fieldIdentity(fieldName)) &&
		hasCredentialHeaderName &&
		hasHeaderValue;
	const redacted = Object.create(null) as Record<string, unknown>;
	const scrubbedKeys = new Map<string, number>();
	for (const field of sourceKeys) {
		const redactedKey = uniqueScrubbedKey(redacted, field, scrubbedKeys);
		const normalized = fieldIdentity(field).toLowerCase();
		const member = source[field];
		const memberPath = nestedMarkerPath(markerPath, redactedKey);
		if (maskHeaderValue && (normalized === "value" || normalized === "values")) {
			skipValueLeaves(plan, member);
			redacted[redactedKey] =
				normalized === "values" && Array.isArray(member)
					? member.map((_item, index) => markerWithPath("«redacted»", nestedMarkerPath(memberPath, index)))
					: markerWithPath("«redacted»", memberPath);
			continue;
		}
		redacted[redactedKey] = sanitizeDataValue(member, field, plan, memberPath);
	}
	return redacted;
}

/** Keywords whose value is one concrete literal, so a credential-named property's own data can be masked. */
const SCHEMA_VALUE_KEYWORDS = new Set(["default", "example", "examples", "const"]);

/**
 * Keywords whose value maps arbitrary names to schemas rather than being a schema itself.
 * Their entry names are definition identifiers, so an entry called `default` or `const`
 * must not be read as the literal-data keyword of the same spelling.
 */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

/**
 * Keywords whose value is one schema, or whose boolean form is also a schema boolean.
 * A covered boolean under one of these is replaced by the neutral `{}` schema so the emitted
 * document stays a valid JSON Schema without printing the covered value.
 */
const SCHEMA_SINGLE_KEYWORDS = new Set([
	"items",
	"additionalItems",
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"contains",
	"not",
	"if",
	"then",
	"else",
	"propertyNames",
	"contentSchema",
]);

/** Keywords whose value is an array of schemas. */
const SCHEMA_LIST_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/**
 * A covered scalar that may not print. In schema position it becomes the neutral `{}` schema; as an
 * object keyword value it is dropped, because every keyword a scalar can carry is optional and an
 * absence is valid where the covered value would have changed the keyword's meaning.
 */
const OMIT_SCHEMA_VALUE = Symbol("omit-schema-value");

/**
 * Replace every leaf of a data value with the marker, preserving its shape.
 * The shape is kept so the dump still shows what the caller declared; a number or boolean that a
 * mask covers prints as the string marker. Data keywords (`default`, `example`, `examples`,
 * `const`) accept any JSON value, so the marker keeps the document valid JSON Schema; the literal
 * no longer equals what the caller declared, because keeping the covered value's type would mean
 * printing the covered value.
 */
function maskSchemaData(value: unknown, markerPath = ""): unknown {
	if (Array.isArray(value)) {
		return value.map((item, index) => maskSchemaData(item, nestedMarkerPath(markerPath, index)));
	}
	if (value === null || typeof value !== "object") return markerWithPath("«redacted»", markerPath);
	const masked = Object.create(null) as Record<string, unknown>;
	const scrubbedKeys = new Map<string, number>();
	for (const [key, nested] of Object.entries(value)) {
		// Two token-shaped keys scrub to one marker, so the marker alone would let the second
		// property replace the first; the suffix keeps both definitions in the dump.
		const redactedKey = uniqueScrubbedKey(masked, key, scrubbedKeys);
		masked[redactedKey] = maskSchemaData(nested, nestedMarkerPath(markerPath, redactedKey));
	}
	return masked;
}

/**
 * Scrubbed form of a field name, kept distinct when two names scrub to the same marker
 * so one property definition cannot silently replace another.
 */
function uniqueScrubbedKey(target: Record<string, unknown>, key: string, nextSuffix: Map<string, number>): string {
	const scrubbed = scrubName(key);
	if (!Object.hasOwn(target, scrubbed)) return scrubbed;
	let suffix = nextSuffix.get(scrubbed) ?? 2;
	while (Object.hasOwn(target, `${scrubbed}#${suffix}`)) suffix += 1;
	nextSuffix.set(scrubbed, suffix + 1);
	return `${scrubbed}#${suffix}`;
}

/**
 * Scrub a tool schema without destroying its definitions.
 * Names in a schema map (`properties`, `patternProperties`, `$defs`, `definitions`,
 * `dependentSchemas`) are schema structure, not credential assignments, so they stay
 * readable; only string leaves and data-carrying keywords are redacted. Every keyword and every
 * name is classified on the original schema, and each printed scalar takes its one plan entry in
 * the same walk, so a masked leaf can never change how a later entry is read.
 *
 * A covered non-string scalar cannot print its type without printing evidence of the value it
 * masked. In schema position it becomes `{}` (a valid schema that constrains nothing); as a
 * keyword value it is omitted. Both keep the emitted document valid JSON Schema instead of
 * turning `minLength: 7` or `flag: false` into a marker string.
 */
function sanitizeSchemaValue(
	value: unknown,
	propertyName: string | undefined,
	plan: ValueRedactionPlan,
	schemaPosition: boolean,
	markerPath = "",
): unknown {
	if (typeof value === "string") return scrubText(value, takeLeafSpans(plan), markerPath);
	if (Array.isArray(value)) {
		return value.map((item, index) => {
			const itemPath = nestedMarkerPath(markerPath, index);
			const sanitized = sanitizeSchemaValue(item, propertyName, plan, schemaPosition, itemPath);
			// An array slot cannot be omitted without shifting later slots, so a covered scalar keeps
			// its marker form here; the arrays that reach this branch hold literal data (`enum`,
			// `examples`) or schemas, and a string is valid in both.
			return sanitized === OMIT_SCHEMA_VALUE ? markerWithPath(PRIVATE_KEY_REDACTION_MARKER, itemPath) : sanitized;
		});
	}
	if (value === null || typeof value !== "object") {
		if (takeLeafSpans(plan).length === 0) return value;
		return schemaPosition ? Object.create(null) : OMIT_SCHEMA_VALUE;
	}

	const source = value as Record<string, unknown>;
	const redacted = Object.create(null) as Record<string, unknown>;
	const scrubbedKeys = new Map<string, number>();
	for (const [field, nested] of Object.entries(source)) {
		// Keywords are recognized by the name they stand for, so an escaped keyword a sibling forced
		// to keep its spelling is still a map or a data keyword rather than an ordinary field.
		const keyword = decodeEscapedText(field);
		const redactedKey = uniqueScrubbedKey(redacted, field, scrubbedKeys);
		// The path uses the scrubbed key, never the stored spelling: a token-shaped name is a
		// credential and must not reappear inside a marker suffix.
		const fieldPath = nestedMarkerPath(markerPath, redactedKey);
		if (SCHEMA_MAP_KEYWORDS.has(keyword) && nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
			const schemas = Object.create(null) as Record<string, unknown>;
			const nameSuffixes = new Map<string, number>();
			for (const [name, schema] of Object.entries(nested as Record<string, unknown>)) {
				// The definition keeps the name it was stored under; the credential test reads the name
				// the definition stands for, so a collided spelling still masks its literal data.
				const redactedName = uniqueScrubbedKey(schemas, name, nameSuffixes);
				schemas[redactedName] = sanitizeSchemaValue(
					schema,
					fieldIdentity(name),
					plan,
					true,
					nestedMarkerPath(fieldPath, redactedName),
				);
			}
			redacted[redactedKey] = schemas;
			continue;
		}
		if (SCHEMA_VALUE_KEYWORDS.has(keyword)) {
			if (propertyName !== undefined && isCredentialKey(propertyName)) {
				// The literal is data under a credential-named property, so nothing of it may print;
				// its leaves still take their plan entries even though the masked copy replaces them.
				skipValueLeaves(plan, nested);
				redacted[redactedKey] = maskSchemaData(nested, fieldPath);
			} else {
				redacted[redactedKey] = sanitizeDataValue(nested, propertyName, plan, fieldPath);
			}
			continue;
		}
		const childIsSchema = SCHEMA_SINGLE_KEYWORDS.has(keyword) || SCHEMA_LIST_KEYWORDS.has(keyword);
		if (keyword === "type" && Array.isArray(nested) && nested.every(item => typeof item === "string")) {
			// A `type` list accepts only type names, so a covered member cannot print as the marker.
			// Members the mask touches are dropped; a list that loses every member is omitted.
			const kept: string[] = [];
			for (const item of nested) {
				const covered = peekLeafSpans(plan).length > 0;
				takeLeafSpans(plan);
				if (!covered) kept.push(scrubText(item, []));
			}
			if (kept.length > 0) redacted[redactedKey] = kept;
			continue;
		}
		if (typeof nested === "string" && !childIsSchema) {
			// A keyword value the mask covers in full has to go: a string marker is valid JSON but not
			// a valid value for an enumerated keyword such as `type`. The keyword itself is optional,
			// so dropping it is the one replacement that cannot print the covered value.
			const covered = peekLeafSpans(plan).some(span => span.start === 0 && span.end === nested.length);
			if (covered) {
				takeLeafSpans(plan);
				continue;
			}
		}
		const sanitized = sanitizeSchemaValue(nested, propertyName, plan, childIsSchema, fieldPath);
		// A covered scalar under an ordinary keyword is dropped: the keyword is optional, and the
		// covered value would otherwise have to print as something it is not.
		if (sanitized === OMIT_SCHEMA_VALUE) continue;
		redacted[redactedKey] = sanitized;
	}
	return redacted;
}

/** Text of one already-sanitized schema value: escaped for XML. */
function formatSchemaText(value: unknown): string {
	return escapeXmlText(serializeParameterValue(value));
}

/** One `<parameter>` element, with a multi-line value indented as before. */
function formatParameter(indent: string, escapedKey: string, text: string): string {
	if (!text.includes("\n")) return `${indent}<parameter name="${escapedKey}">${text}</parameter>`;
	const indentedText = text
		.split("\n")
		.map(line => `${indent}\t${line}`)
		.join("\n");
	return `${indent}<parameter name="${escapedKey}">\n${indentedText}\n${indent}</parameter>`;
}

/**
 * Serialize an object as XML parameter elements, one per key.
 * The generated `<parameter>` markup is never passed through the text scrubber:
 * a value ending in `KEY=<placeholder>` must not consume the closing tag, and a
 * private-key block spanning two values is redacted inside those values so each
 * parameter keeps its own identity.
 *
 * Both modes decode the arguments once, detect the plan over that original tree, and then walk
 * it exactly once applying the masks. Detection therefore never reads a partially applied tree.
 */
function formatArgsAsXml(
	args: Record<string, unknown>,
	mode: "arguments" | "schema" = "arguments",
	indent = "\t",
): string {
	const decoded = decodeValueStrings(args) as Record<string, unknown>;
	const plan = createValueRedactionPlan(decoded);
	const parts: string[] = [];
	if (mode === "schema") {
		// A schema root is not an argument, so a definition named `_i` stays part of the schema,
		// and every root entry is walked by the one structural pass.
		const sanitized = sanitizeSchemaValue(decoded, undefined, plan, true) as Record<string, unknown>;
		for (const [key, value] of Object.entries(sanitized)) {
			// The structural walk already scrubbed every key; scrubbing it again would classify a
			// marker this pass produced instead of the name the caller declared.
			const escapedKey = escapeXmlAttribute(key);
			parts.push(formatParameter(indent, escapedKey, formatSchemaText(value)));
		}
		return parts.join("\n");
	}
	for (const [key, value] of Object.entries(decoded)) {
		// The intent field is the literal key the agent loop destructures: a field whose name
		// merely resolves to it is an ordinary argument, so only that exact spelling is dropped.
		// A dropped entry still owns its leaves in the plan, so they are skipped explicitly.
		if (key === INTENT_FIELD) {
			skipValueLeaves(plan, value);
			continue;
		}
		const escapedKey = escapeXmlAttribute(scrubName(key));
		const text = escapeXmlText(serializeParameterValue(sanitizeDataValue(value, key, plan)));
		parts.push(formatParameter(indent, escapedKey, text));
	}
	return parts.join("\n");
}

/**
 * Format messages and session metadata as markdown/plain text (same shape as /dump clipboard export).
 * Text runs, tool-argument sections, and each rendered Bash or Python execution
 * section are scrubbed inside that section so a private-key banner cannot pair
 * across unrelated messages. Each section detects its private-key blocks and credential containers
 * on the original text and replaces both in one pass, so no mask can hide the evidence a later one
 * needs.
 */
export function formatSessionDumpText(options: FormatSessionDumpTextOptions): string {
	const lines: string[] = [];

	const systemPrompt = options.systemPrompt?.filter(prompt => prompt.length > 0) ?? [];
	if (systemPrompt.length > 0) {
		lines.push("## System Prompt\n");
		for (let index = 0; index < systemPrompt.length; index++) {
			if (systemPrompt.length > 1) {
				lines.push(`### System Prompt ${index + 1}\n`);
			}
			lines.push(redactDumpText(systemPrompt[index]));
			lines.push("\n");
		}
	}

	const model = options.model;
	const thinkingLevel = options.thinkingLevel;
	lines.push("## Configuration\n");
	lines.push(`Model: ${model ? `${redactDumpText(model.provider)}/${redactDumpText(model.id)}` : "(not selected)"}`);
	lines.push(`Thinking Level: ${redactDumpText(String(thinkingLevel ?? ""))}`);
	lines.push("\n");

	const tools = options.tools ?? [];
	if (tools.length > 0) {
		lines.push("## Available Tools\n");
		for (const tool of tools) {
			lines.push(`<tool name="${redactDumpText(tool.name)}">`);
			lines.push(redactDumpText(tool.description));
			const parametersClean = stripTypeBoxFields(tool.parameters);
			lines.push(`\nParameters:\n${formatArgsAsXml(parametersClean as Record<string, unknown>, "schema")}`);
			lines.push("<" + "/tool>\n");
		}
		lines.push("\n");
	}

	const cacheWarningState: CacheWarningBuildState = { warningsEmitted: 0 };
	for (const msg of options.messages) {
		if (msg.role === "user" || msg.role === "developer") {
			lines.push(msg.role === "developer" ? "## Developer\n" : "## User\n");
			if (typeof msg.content === "string") {
				lines.push(redactDumpText(msg.content));
			} else {
				const textRun: string[] = [];
				for (const c of msg.content) {
					if (c.type === "text") {
						textRun.push(c.text);
					} else if (c.type === "image") {
						const redactedText = takeRedactedTextRun(textRun);
						if (redactedText !== undefined) lines.push(redactedText);
						lines.push("[Image]");
					}
				}
				const redactedText = takeRedactedTextRun(textRun);
				if (redactedText !== undefined) lines.push(redactedText);
			}
			lines.push("\n");
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			lines.push("## Assistant\n");

			const textRun: string[] = [];
			for (const c of assistantMsg.content) {
				if (c.type === "text") {
					textRun.push(c.text);
				} else if (c.type === "thinking") {
					if (c.thinking.trim().length === 0) continue;
					const redactedText = takeRedactedTextRun(textRun);
					if (redactedText !== undefined) lines.push(redactedText);
					lines.push("<thinking>");
					lines.push(redactDumpText(c.thinking));
					lines.push("</thinking>\n");
				} else if (c.type === "toolCall") {
					const redactedText = takeRedactedTextRun(textRun);
					if (redactedText !== undefined) lines.push(redactedText);
					lines.push(`<invoke name="${redactDumpText(c.name)}">`);
					if (c.arguments && typeof c.arguments === "object") {
						lines.push(formatArgsAsXml(c.arguments as Record<string, unknown>, "arguments"));
					}
					lines.push("<" + "/invoke>\n");
				}
			}
			const redactedText = takeRedactedTextRun(textRun);
			if (redactedText !== undefined) lines.push(redactedText);
			const cacheWarning = buildCacheEconomicsWarning(assistantMsg.usage, model, cacheWarningState);
			if (cacheWarning) {
				lines.push(redactDumpText(cacheWarning));
			}
			lines.push("");
		} else if (msg.role === "toolResult") {
			lines.push(`### Tool Result: ${redactDumpText(msg.toolName)}`);
			if (msg.isError) {
				lines.push("(error)");
			}
			const textRun: string[] = [];
			for (const c of msg.content) {
				if (c.type === "text") {
					textRun.push(c.text);
				} else if (c.type === "image") {
					const redactedText = takeRedactedTextRun(textRun);
					if (redactedText !== undefined) lines.push("```", redactedText, "```");
					lines.push("[Image output]");
				}
			}
			const redactedText = takeRedactedTextRun(textRun);
			if (redactedText !== undefined) lines.push("```", redactedText, "```");
			lines.push("");
		} else if (msg.role === "bashExecution") {
			const bashMsg = msg as BashExecutionMessage;
			if (!bashMsg.excludeFromContext) {
				lines.push("## Bash Execution\n");
				// The renderer emits the sections in reading order, so scrubbing its output pairs a
				// private-key block across command, output and notice without ordering assumptions.
				lines.push(redactDumpText(bashExecutionToText(bashMsg)));
				lines.push("\n");
			}
		} else if (msg.role === "pythonExecution") {
			const pythonMsg = msg as PythonExecutionMessage;
			if (!pythonMsg.excludeFromContext) {
				lines.push("## Python Execution\n");
				lines.push(redactDumpText(pythonExecutionToText(pythonMsg)));
				lines.push("\n");
			}
		} else if (msg.role === "custom" || msg.role === "hookMessage") {
			const customMsg = msg as CustomMessage | HookMessage;
			lines.push(`## ${redactDumpText(customMsg.customType)}\n`);
			if (typeof customMsg.content === "string") {
				lines.push(redactDumpText(customMsg.content));
			} else {
				const textRun: string[] = [];
				for (const c of customMsg.content) {
					if (c.type === "text") {
						textRun.push(c.text);
					} else if (c.type === "image") {
						const redactedText = takeRedactedTextRun(textRun);
						if (redactedText !== undefined) lines.push(redactedText);
						lines.push("[Image]");
					}
				}
				const redactedText = takeRedactedTextRun(textRun);
				if (redactedText !== undefined) lines.push(redactedText);
			}
			lines.push("\n");
		} else if (msg.role === "branchSummary") {
			const branchMsg = msg as BranchSummaryMessage;
			lines.push("## Branch Summary\n");
			lines.push(`(from branch: ${redactDumpText(branchMsg.fromId)})\n`);
			lines.push(redactDumpText(branchMsg.summary));
			lines.push("\n");
		} else if (msg.role === "compactionSummary") {
			const compactMsg = msg as CompactionSummaryMessage;
			lines.push("## Compaction Summary\n");
			lines.push(`(${compactMsg.tokensBefore} tokens before compaction)\n`);
			lines.push(redactDumpText(compactMsg.summary));
			lines.push("\n");
		} else if (msg.role === "fileMention") {
			const fileMsg = msg as FileMentionMessage;
			lines.push("## File Mention\n");
			for (const file of fileMsg.files) {
				lines.push(`<file path="${redactDumpText(file.path)}">`);
				if (file.content) {
					lines.push(redactDumpText(file.content));
				}
				if (file.image) {
					lines.push("[Image attached]");
				}
				lines.push("</file>\n");
			}
			lines.push("\n");
		}
	}

	return lines.join("\n").trim();
}
