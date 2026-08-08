import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { upgradeJsonSchemaTo202012 } from "@gajae-code/ai/utils/schema";
import { resolveWithinRoot } from "./paths";
import { GjcPluginLoadError, type JsonSchema202012, PluginImplementationHashMismatchError } from "./types";

export const JSON_SCHEMA_202012_URI = "https://json-schema.org/draft/2020-12/schema";

/** Stable JSON serialization used for schema hashes and registry fingerprints. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isFinite(value)) throw new Error("JSON value must be finite");
		if (value === undefined) throw new Error("JSON value cannot be undefined");
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.keys(value as Record<string, unknown>)
		.sort()
		.map(key => {
			const item = (value as Record<string, unknown>)[key];
			if (item === undefined) throw new Error(`JSON value contains undefined at ${key}`);
			return `${JSON.stringify(key)}:${canonicalJson(item)}`;
		});
	return `{${entries.join(",")}}`;
}

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function verifyImplementationHash(filePath: string, expected: string): Promise<string> {
	const actual = sha256(await fs.readFile(filePath));
	if (actual.toLowerCase() !== expected.toLowerCase())
		throw new PluginImplementationHashMismatchError(filePath, expected, actual);
	return actual;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneCanonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneCanonical);
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const item = value[key];
			if (item !== undefined) out[key] = cloneCanonical(item);
		}
		return out;
	}
	return value;
}

const SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

function validateSchemaNode(value: unknown, at: string, depth: number): void {
	if (depth > 64) throw new GjcPluginLoadError("invalid_schema", `JSON Schema is too deeply nested at ${at}`);
	if (typeof value === "boolean") return;
	if (!isRecord(value)) throw new GjcPluginLoadError("invalid_schema", `JSON Schema node at ${at} must be an object`);
	if (value.type !== undefined) {
		const types = typeof value.type === "string" ? [value.type] : Array.isArray(value.type) ? value.type : [];
		if (types.length === 0 || types.some(type => typeof type !== "string" || !SCHEMA_TYPES.has(type))) {
			throw new GjcPluginLoadError("invalid_schema", `JSON Schema type at ${at} is invalid`);
		}
	}
	if (
		value.required !== undefined &&
		(!Array.isArray(value.required) || value.required.some(item => typeof item !== "string"))
	) {
		throw new GjcPluginLoadError("invalid_schema", `JSON Schema required at ${at} must be a string array`);
	}
	if (value.properties !== undefined) {
		if (!isRecord(value.properties))
			throw new GjcPluginLoadError("invalid_schema", `JSON Schema properties at ${at} must be an object`);
		for (const [key, child] of Object.entries(value.properties))
			validateSchemaNode(child, `${at}.properties.${key}`, depth + 1);
	}
	for (const key of ["items", "additionalProperties", "contains", "not", "if", "then", "else"] as const) {
		if (value[key] !== undefined) validateSchemaNode(value[key], `${at}.${key}`, depth + 1);
	}
	for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"] as const) {
		if (value[key] === undefined) continue;
		if (!Array.isArray(value[key]))
			throw new GjcPluginLoadError("invalid_schema", `JSON Schema ${key} at ${at} must be an array`);
		for (const [index, child] of value[key].entries()) validateSchemaNode(child, `${at}.${key}[${index}]`, depth + 1);
	}
	if (value.enum !== undefined && !Array.isArray(value.enum))
		throw new GjcPluginLoadError("invalid_schema", `JSON Schema enum at ${at} must be an array`);
	for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"] as const) {
		if (
			value[key] !== undefined &&
			(typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0)
		) {
			throw new GjcPluginLoadError("invalid_schema", `JSON Schema ${key} at ${at} must be a non-negative integer`);
		}
	}
	if (value.pattern !== undefined && typeof value.pattern !== "string")
		throw new GjcPluginLoadError("invalid_schema", `JSON Schema pattern at ${at} must be a string`);
	if (value.$ref !== undefined && typeof value.$ref !== "string")
		throw new GjcPluginLoadError("invalid_schema", `JSON Schema $ref at ${at} must be a string`);
}

/** Validate and canonicalize a JSON Schema 2020-12 document without executing user code. */
export function canonicalizeJsonSchema(value: unknown): JsonSchema202012 {
	if (typeof value === "boolean") return value;
	if (!isRecord(value))
		throw new GjcPluginLoadError("invalid_schema", "Tool schema must be a JSON Schema object or boolean");
	let upgraded: unknown;
	try {
		upgraded = upgradeJsonSchemaTo202012(value);
	} catch (error) {
		throw new GjcPluginLoadError(
			"invalid_schema",
			`Unable to upgrade tool schema to JSON Schema 2020-12: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(upgraded)) throw new GjcPluginLoadError("invalid_schema", "Tool schema must be a JSON Schema object");
	const copy = structuredClone(upgraded);
	copy.$schema = JSON_SCHEMA_202012_URI;
	validateSchemaNode(copy, "$", 0);
	return cloneCanonical(copy) as JsonSchema202012;
}

export function schemaHash(schema: JsonSchema202012): string {
	return sha256(canonicalJson(schema));
}

interface ScanResult {
	text: string;
	end: number;
}

function skipSpace(source: string, start: number): number {
	let index = start;
	while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
	return index;
}

function readBalanced(source: string, start: number, open: string, close: string): ScanResult {
	if (source[start] !== open) throw new Error(`expected ${open}`);
	let depth = 0;
	let quote: string | undefined;
	let escaped = false;
	for (let index = start; index < source.length; index += 1) {
		const char = source[index] ?? "";
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === open) depth += 1;
		if (char === close) {
			depth -= 1;
			if (depth === 0) return { text: source.slice(start + 1, index), end: index + 1 };
		}
	}
	throw new Error(`unclosed ${open}`);
}

function splitTopLevel(source: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	let quote: string | undefined;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if ("({[".includes(char)) depth += 1;
		else if (")}]".includes(char)) depth -= 1;
		else if (char === "," && depth === 0) {
			parts.push(source.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(source.slice(start));
	return parts.map(part => part.trim()).filter(Boolean);
}

function stringLiteral(value: string): string | undefined {
	const trimmed = value.trim();
	if (!((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))))
		return undefined;
	try {
		if (trimmed.startsWith('"')) return JSON.parse(trimmed) as string;
		return trimmed.slice(1, -1).replace(/\\(['\\])/g, "$1");
	} catch {
		return undefined;
	}
}

function objectEntries(body: string): Array<{ key: string; value: string }> {
	return splitTopLevel(body).flatMap(part => {
		const match = /^([A-Za-z_$][\w$-]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*:\s*([\s\S]+)$/.exec(part.trim());
		if (!match) return [];
		const key = stringLiteral(match[1]!) ?? match[1]!;
		return /^[A-Za-z_$][\w$-]*$/.test(key) ? [{ key, value: match[2]!.trim() }] : [];
	});
}

function callName(expression: string): { name: string; args: string } | undefined {
	const match = /(?:^|[.])([A-Za-z_$][\w$]*)\s*\(/.exec(expression.trim());
	if (!match || match.index === undefined) return undefined;
	const open = expression.indexOf("(", match.index);
	const balanced = readBalanced(expression, open, "(", ")");
	return { name: match[1]!, args: balanced.text };
}

function staticSchemaExpression(expression: string): JsonSchema202012 | undefined {
	const current = expression
		.trim()
		.replace(/^(?:as\s+[^,]+|satisfies\s+[^,]+)$/, "")
		.trim();
	if (current.startsWith("{") && current.endsWith("}")) {
		const body = current.slice(1, -1);
		const out: Record<string, unknown> = {};
		for (const { key, value } of objectEntries(body)) {
			const literal = stringLiteral(value);
			if (literal !== undefined) out[key] = literal;
			else {
				const nested = staticSchemaExpression(value);
				if (nested === undefined) return undefined;
				out[key] = nested;
			}
		}
		return out;
	}
	const name = callName(current);
	if (!name) return undefined;
	if (name.name === "optional" || name.name === "nullable" || name.name === "Readonly" || name.name === "Optional") {
		const inner = name.args.trim() ? splitTopLevel(name.args)[0] : current.slice(0, current.lastIndexOf(".")).trim();
		const schema = inner ? staticSchemaExpression(inner) : undefined;
		if (schema === undefined) return undefined;
		return name.name === "nullable" ? { anyOf: [schema, { type: "null" }] } : schema;
	}
	if (name.name === "Object" || name.name === "object") {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		const entries = objectEntries(name.args);
		if (entries.length === 0 && name.args.trim()) {
			const fallback = /^([A-Za-z_$][\w$-]*)\s*:\s*([\s\S]+)$/.exec(name.args.trim());
			if (fallback) entries.push({ key: fallback[1]!, value: fallback[2]!.trim() });
		}
		for (const { key, value } of entries) {
			const schema = staticSchemaExpression(value);
			if (schema === undefined) return undefined;
			properties[key] = schema;
			if (
				!/\.(?:optional|nullable)\s*\(\s*\)\s*$/.test(value) &&
				!/\.Optional\s*\(\s*\)\s*$/.test(value) &&
				!/(?:Type\.)?Optional\s*\(/.test(value)
			)
				required.push(key);
		}
		return { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: true };
	}
	const scalarTypes: Record<string, string> = {
		String: "string",
		string: "string",
		Number: "number",
		number: "number",
		Integer: "integer",
		integer: "integer",
		Boolean: "boolean",
		boolean: "boolean",
		Unknown: "",
		Any: "",
		any: "",
		unknown: "",
	};
	if (Object.hasOwn(scalarTypes, name.name)) return scalarTypes[name.name] ? { type: scalarTypes[name.name] } : {};
	if (name.name === "Array" || name.name === "array") {
		const first = splitTopLevel(name.args)[0];
		const items = first ? staticSchemaExpression(first) : {};
		return { type: "array", items };
	}
	if (name.name === "Literal" || name.name === "literal") {
		const raw = splitTopLevel(name.args)[0];
		if (!raw) return undefined;
		const literal = stringLiteral(raw);
		if (literal !== undefined) return { const: literal };
		if (/^(?:true|false)$/.test(raw)) return { const: raw === "true" };
		if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return { const: Number(raw) };
	}
	if (name.name === "Union" || name.name === "union") {
		const variants = splitTopLevel(name.args).map(staticSchemaExpression);
		if (variants.some(item => item === undefined)) return undefined;
		return { anyOf: variants as JsonSchema202012[] };
	}
	return undefined;
}

function findParametersExpression(source: string): string | undefined {
	const pattern = /\bparameters\s*:/g;
	if (pattern.exec(source)) {
		let start = skipSpace(source, pattern.lastIndex);
		if (source.slice(start, start + 2) === "{\n") start = skipSpace(source, start);
		let depth = 0;
		let quote: string | undefined;
		let escaped = false;
		for (let index = start; index < source.length; index += 1) {
			const char = source[index] ?? "";
			if (quote) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === quote) quote = undefined;
				continue;
			}
			if (char === '"' || char === "'" || char === "`") {
				quote = char;
				continue;
			}
			if ("([{".includes(char)) depth += 1;
			else if (")]}".includes(char)) depth -= 1;
			if ((char === "," || char === "\n") && depth === 0) return source.slice(start, index).trim();
			if (depth === 0 && ")]}".includes(char)) {
				const next = skipSpace(source, index + 1);
				if (next >= source.length || ",;".includes(source[next] ?? ""))
					return source.slice(start, index + 1).trim();
			}
		}
		return source
			.slice(start)
			.replace(/[,;]\s*$/, "")
			.trim();
	}
	return undefined;
}

/** Extract a common TypeBox/Zod declaration from source text without loading it. */
export function extractDeclaredToolSchema(source: string): JsonSchema202012 {
	const expression = findParametersExpression(source);
	if (!expression)
		throw new GjcPluginLoadError("missing_surface", "Tool implementation has no declared parameters schema");
	const direct = /(?:Type\.Object|zod\.object|\.Object|\.object)\s*\(\s*\{([\s\S]*)\}\s*\)\s*$/.exec(expression);
	if (direct) {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		for (const part of splitTopLevel(direct[1]!)) {
			const field = /^([A-Za-z_$][\w$-]*)\s*:\s*([\s\S]+)$/.exec(part);
			if (!field)
				throw new GjcPluginLoadError("invalid_schema", "Tool parameters object contains an unreadable property");
			let child: JsonSchema202012 | undefined;
			try {
				child = staticSchemaExpression(field[2]!);
			} catch (error) {
				throw new GjcPluginLoadError(
					"invalid_schema",
					`Tool parameters property ${field[1]} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (child === undefined)
				throw new GjcPluginLoadError("invalid_schema", `Tool parameters property ${field[1]} is unreadable`);
			properties[field[1]!] = child;
			if (
				!/\.(?:optional|nullable)\s*\(\s*\)\s*$/.test(field[2]!) &&
				!/\.Optional\s*\(\s*\)\s*$/.test(field[2]!) &&
				!/(?:Type\.)?Optional\s*\(/.test(field[2]!)
			)
				required.push(field[1]!);
		}
		return canonicalizeJsonSchema({
			type: "object",
			properties,
			...(required.length > 0 ? { required } : {}),
			additionalProperties: true,
		});
	}
	try {
		const schema = staticSchemaExpression(expression);
		if (schema === undefined)
			throw new GjcPluginLoadError("invalid_schema", "Tool parameters schema is not statically readable");
		return canonicalizeJsonSchema(schema);
	} catch (error) {
		if (error instanceof GjcPluginLoadError) throw error;
		throw new GjcPluginLoadError(
			"invalid_schema",
			`Tool parameters schema is not statically readable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function readSchemaDeclaration(
	pluginRoot: string,
	sourcePath: string,
	declaration: unknown,
	schemaPath?: string,
): Promise<JsonSchema202012> {
	if (schemaPath !== undefined) {
		const abs = resolveWithinRoot(pluginRoot, schemaPath);
		const text = await fs.readFile(abs, "utf8");
		try {
			return canonicalizeJsonSchema(JSON.parse(text) as unknown);
		} catch (error) {
			if (error instanceof GjcPluginLoadError) throw error;
			throw new GjcPluginLoadError("invalid_schema", `Invalid JSON Schema declaration at ${schemaPath}`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
	}
	if (declaration !== undefined) return canonicalizeJsonSchema(declaration);
	try {
		return canonicalizeJsonSchema(extractDeclaredToolSchema(await fs.readFile(sourcePath, "utf8")));
	} catch (error) {
		if (error instanceof GjcPluginLoadError) throw error;
		throw new GjcPluginLoadError(
			"invalid_schema",
			`Tool parameters schema is not statically readable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
