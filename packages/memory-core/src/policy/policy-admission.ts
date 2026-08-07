import { validateMemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import type { MemoryEnvironment, MemoryScopeKind, Sensitivity, WriteDestination } from "../index";
import { readControlResource } from "../resources/read-control-resource";
import { resolveScopes } from "../scope/scope-resolver";
import {
	DEFAULT_MEMORY_POLICY_CONFIG,
	type MemoryPolicyConfig,
	type MemoryPolicyLayer,
	mergeMemoryPolicyConfigs,
	validateMemoryPolicyConfig,
} from "./config-merge";

const SENSITIVITY_RANK: Readonly<Record<Sensitivity, number>> = Object.freeze({
	"public-safe": 0,
	private: 1,
	restricted: 2,
});

const SENSITIVITIES: readonly Sensitivity[] = Object.freeze(["public-safe", "private", "restricted"]);
const DESTINATIONS: readonly WriteDestination[] = Object.freeze([
	"global-canonical",
	"project-canonical",
	"session",
	"proposal",
	"checkpoint",
	"ledger",
	"redact-output",
	"export-output",
	"explain-output",
	"doctor-report",
]);

function policyDenied(destination: WriteDestination, reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination,
			reason,
		},
	};
}

function sensitivityViolation(destination: WriteDestination, sensitivity: Sensitivity): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "sensitivity-violation",
			exitCode: MEMORY_EXIT_CODES.sensitivityViolation,
			destination,
			findings: [
				Object.freeze({
					kind: "sensitivity-label",
					patternId: null,
					sensitivity,
					line: 0,
					excerptRedacted: "[REDACTED]",
				}),
			],
		},
	};
}

type YamlScalar = string | number | boolean | null;
type YamlNode = YamlScalar | readonly YamlNode[] | { readonly [key: string]: YamlNode };
interface MutableYamlObject {
	[key: string]: YamlNode;
}
interface YamlLine {
	readonly indent: number;
	readonly text: string;
	readonly line: number;
}
interface ParsedYamlNode {
	readonly value: YamlNode;
	readonly next: number;
}

function stripYamlComment(value: string): string {
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote === null && (character === "'" || character === '"')) {
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
		if (quote === null && character === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
			return value.slice(0, index).trimEnd();
		}
	}
	return value.trimEnd();
}

function prepareYamlLines(content: string): MemoryResult<readonly YamlLine[]> {
	if (typeof content !== "string") return invalidInput("memory policy config must be text");
	const lines: YamlLine[] = [];
	for (const [index, rawLine] of content.replace(/\r\n?/gu, "\n").split("\n").entries()) {
		if (rawLine.includes("\t")) return invalidInput(`memory policy config contains a tab at line ${index + 1}`);
		const withoutComment = stripYamlComment(rawLine);
		if (withoutComment.trim().length === 0) continue;
		const indentation = withoutComment.match(/^ */u)?.[0].length ?? 0;
		const text = withoutComment.slice(indentation);
		if (/^(?:---|\.\.\.)\s*$/u.test(text) || /(?:^|\s)(?:[&*!]|<<\s*:)/u.test(text)) {
			return invalidInput(`memory policy config uses unsupported YAML syntax at line ${index + 1}`);
		}
		lines.push({ indent: indentation, text, line: index + 1 });
	}
	return { ok: true, value: Object.freeze(lines) };
}

function splitTopLevel(value: string, separator: string): readonly string[] | null {
	const pieces: string[] = [];
	let start = 0;
	let depth = 0;
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote === null && (character === "'" || character === '"')) {
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
		if (character === "[" || character === "{") depth += 1;
		if (character === "]" || character === "}") depth -= 1;
		if (depth < 0) return null;
		if (depth === 0 && value.startsWith(separator, index)) {
			pieces.push(value.slice(start, index).trim());
			start = index + separator.length;
			index += separator.length - 1;
		}
	}
	if (quote !== null || depth !== 0) return null;
	pieces.push(value.slice(start).trim());
	return pieces;
}

function colonIndex(value: string): number {
	let quote: "'" | '"' | null = null;
	let depth = 0;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote === null && (character === "'" || character === '"')) {
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
		if (character === "[" || character === "{") depth += 1;
		if (character === "]" || character === "}") depth -= 1;
		if (depth === 0 && character === ":") return index;
	}
	return -1;
}

function parseScalar(rawValue: string, line: number): MemoryResult<YamlNode> {
	const raw = rawValue.trim();
	if (raw.length === 0) return invalidInput(`memory policy config has an empty value at line ${line}`);
	if (raw === "null" || raw === "~") return { ok: true, value: null };
	if (raw === "true") return { ok: true, value: true };
	if (raw === "false") return { ok: true, value: false };
	if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(raw)) {
		const number = Number(raw);
		return Number.isFinite(number)
			? { ok: true, value: number }
			: invalidInput(`memory policy number is invalid at line ${line}`);
	}
	if (raw.startsWith('"')) {
		if (!raw.endsWith('"')) return invalidInput(`memory policy string is malformed at line ${line}`);
		try {
			const parsed: unknown = JSON.parse(raw);
			return typeof parsed === "string"
				? { ok: true, value: parsed.normalize("NFC") }
				: invalidInput(`memory policy value is invalid at line ${line}`);
		} catch {
			return invalidInput(`memory policy string is malformed at line ${line}`);
		}
	}
	if (raw.startsWith("'")) {
		if (!raw.endsWith("'")) return invalidInput(`memory policy string is malformed at line ${line}`);
		return { ok: true, value: raw.slice(1, -1).replaceAll("''", "'").normalize("NFC") };
	}
	if (raw.startsWith("[") && raw.endsWith("]")) {
		const body = raw.slice(1, -1).trim();
		if (body.length === 0) return { ok: true, value: Object.freeze([]) };
		const pieces = splitTopLevel(body, ",");
		if (pieces === null) return invalidInput(`memory policy array is malformed at line ${line}`);
		const values: YamlNode[] = [];
		for (const piece of pieces) {
			const parsed = parseScalar(piece, line);
			if (!parsed.ok) return parsed;
			values.push(parsed.value);
		}
		return { ok: true, value: Object.freeze(values) };
	}
	if (raw.startsWith("{") && raw.endsWith("}")) {
		try {
			const parsed: unknown = JSON.parse(raw);
			return { ok: true, value: parsed as YamlNode };
		} catch {
			return invalidInput(`memory policy object is malformed at line ${line}`);
		}
	}
	if (/[\u0000-\u001f\u007f]/u.test(raw)) return invalidInput(`memory policy value is malformed at line ${line}`);
	return { ok: true, value: raw.normalize("NFC") };
}

function parseBlock(
	lines: readonly YamlLine[],
	start: number,
	indent: number,
	depth: number,
): MemoryResult<ParsedYamlNode> {
	if (depth > 64) return invalidInput("memory policy config nesting is too deep");
	const first = lines[start];
	if (first === undefined || first.indent !== indent)
		return invalidInput("memory policy config indentation is invalid");
	return first.text.startsWith("-")
		? parseSequence(lines, start, indent, depth)
		: parseMapping(lines, start, indent, depth);
}

function parseSequence(
	lines: readonly YamlLine[],
	start: number,
	indent: number,
	depth: number,
): MemoryResult<ParsedYamlNode> {
	const values: YamlNode[] = [];
	let index = start;
	while (index < lines.length) {
		const current = lines[index];
		if (current === undefined || current.indent !== indent || !current.text.startsWith("-")) break;
		const raw = current.text.slice(1).trim();
		if (raw.length === 0) {
			const next = lines[index + 1];
			if (next === undefined || next.indent <= indent)
				return invalidInput(`memory policy sequence is missing a value at line ${current.line}`);
			const nested = parseBlock(lines, index + 1, next.indent, depth + 1);
			if (!nested.ok) return nested;
			values.push(nested.value.value);
			index = nested.value.next;
			continue;
		}
		const parsed = parseScalar(raw, current.line);
		if (!parsed.ok) return parsed;
		values.push(parsed.value);
		index += 1;
	}
	return { ok: true, value: { value: Object.freeze(values), next: index } };
}

function parseMapping(
	lines: readonly YamlLine[],
	start: number,
	indent: number,
	depth: number,
): MemoryResult<ParsedYamlNode> {
	const object: MutableYamlObject = {};
	let index = start;
	while (index < lines.length) {
		const current = lines[index];
		if (current === undefined || current.indent !== indent || current.text.startsWith("-")) break;
		const separator = colonIndex(current.text);
		if (separator <= 0) return invalidInput(`memory policy mapping is malformed at line ${current.line}`);
		const key = current.text.slice(0, separator).trim();
		if (key.length === 0 || key === "__proto__" || key === "prototype" || key === "constructor") {
			return invalidInput(`memory policy key is invalid at line ${current.line}`);
		}
		if (Object.hasOwn(object, key)) return invalidInput(`memory policy key is duplicated at line ${current.line}`);
		const raw = current.text.slice(separator + 1).trim();
		let value: YamlNode;
		if (raw.length === 0) {
			const next = lines[index + 1];
			if (next === undefined || next.indent <= indent)
				return invalidInput(`memory policy value is missing at line ${current.line}`);
			const nested = parseBlock(lines, index + 1, next.indent, depth + 1);
			if (!nested.ok) return nested;
			value = nested.value.value;
			index = nested.value.next;
		} else {
			const parsed = parseScalar(raw, current.line);
			if (!parsed.ok) return parsed;
			value = parsed.value;
			index += 1;
		}
		Object.defineProperty(object, key, { configurable: true, enumerable: true, writable: true, value });
	}
	return { ok: true, value: { value: Object.freeze(object), next: index } };
}

function parsePolicyConfigText(content: string): MemoryResult<unknown> {
	const trimmed = content.normalize("NFC").trim();
	if (trimmed.length === 0) return invalidInput("memory policy config must not be empty");
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return { ok: true, value: JSON.parse(trimmed) as unknown };
		} catch {
			return invalidInput("memory policy config is malformed");
		}
	}
	const prepared = prepareYamlLines(trimmed);
	if (!prepared.ok) return prepared;
	if (prepared.value.length === 0) return invalidInput("memory policy config must not be empty");
	const first = prepared.value[0];
	if (first === undefined) return invalidInput("memory policy config must not be empty");
	const parsed = parseBlock(prepared.value, 0, first.indent, 0);
	if (!parsed.ok) return parsed;
	if (parsed.value.next !== prepared.value.length) return invalidInput("memory policy config indentation is invalid");
	return { ok: true, value: parsed.value.value };
}

function readLayer(environment: MemoryEnvironment, relPath: string): MemoryResult<MemoryPolicyLayer | undefined> {
	const resource = readControlResource(environment, relPath);
	if (!resource.ok) {
		if (resource.error.code === "not-found") return { ok: true, value: undefined };
		return resource;
	}
	const parsed = parsePolicyConfigText(resource.value.content);
	if (!parsed.ok) return parsed;
	const validated = validateMemoryPolicyConfig(parsed.value);
	if (!validated.ok) return validated;
	return { ok: true, value: validated.value };
}

/** Load the three in-store policy layers through the verified control reader. */
export function admitMemoryPolicy(environment: MemoryEnvironment): MemoryResult<MemoryPolicyConfig> {
	const validated = validateMemoryEnvironment(environment);
	if (!validated.ok) return validated;
	try {
		const global = readLayer(validated.value, "config.yaml");
		if (!global.ok) return global;
		let project: MemoryResult<MemoryPolicyLayer | undefined> = { ok: true, value: undefined };
		const scopes = resolveScopes(validated.value);
		if (!scopes.ok) return scopes;
		if (scopes.value.project.encodedKey.length > 0) {
			project = readLayer(validated.value, `projects/${scopes.value.project.encodedKey}/config.yaml`);
			if (!project.ok) return project;
		}
		let session: MemoryResult<MemoryPolicyLayer | undefined> = { ok: true, value: undefined };
		if (validated.value.sessionId !== null) {
			session = readLayer(validated.value, `sessions/${validated.value.sessionId}/policy.yaml`);
			if (!session.ok) return session;
		}
		return mergeMemoryPolicyConfigs(global.value, project.value, session.value);
	} catch {
		return invalidInput("memory policy admission failed closed");
	}
}

export function writeDestinationForScope(scope: MemoryScopeKind): WriteDestination {
	return scope === "global" ? "global-canonical" : scope === "project" ? "project-canonical" : "session";
}

export function enforceMemoryWritePolicy(
	policy: MemoryPolicyConfig,
	destination: WriteDestination,
	operation: string,
): MemoryResult<true> {
	if (!DESTINATIONS.includes(destination)) return invalidInput("memory policy destination is invalid");
	if (!policy.write.enabled) return policyDenied(destination, `${operation} is disabled by memory policy`);
	if (!policy.write.allowedDestinations.includes(destination)) {
		return policyDenied(destination, `${operation} destination is not allowed by memory policy`);
	}
	return { ok: true, value: true };
}

export function enforceMemoryApproval(
	policy: MemoryPolicyConfig,
	destination: WriteDestination,
	requiresApproval: boolean,
): MemoryResult<true> {
	if (policy.write.requireApproval && !requiresApproval) {
		return policyDenied(destination, "apply requires an approved proposal under memory policy");
	}
	return { ok: true, value: true };
}

export function enforceMemorySensitivity(
	policy: MemoryPolicyConfig,
	destination: WriteDestination,
	sensitivity: Sensitivity,
): MemoryResult<true> {
	if (!SENSITIVITIES.includes(sensitivity)) return invalidInput("memory policy sensitivity is invalid");
	if (SENSITIVITY_RANK[sensitivity] > SENSITIVITY_RANK[policy.privacy.maxSensitivity]) {
		return sensitivityViolation(destination, sensitivity);
	}
	return { ok: true, value: true };
}

export { DEFAULT_MEMORY_POLICY_CONFIG };
