import type { FunctionCallPart, PartialArg } from "./google-types";

type Primitive = string | number | boolean | null;
type PathKey = string | number;
type ArgumentNode =
	| { kind: "object" | "array"; children: Map<PathKey, ArgumentNode> }
	| { kind: "value"; value: Primitive; continuing: boolean };

export interface CompletedGoogleFunctionCall {
	name: string;
	id?: string;
	args: Record<string, unknown>;
	thoughtSignature?: string;
}

const MAX_PATH_DEPTH = 128;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

function invalid(detail: string): never {
	throw new Error(`Invalid Google function call: ${detail}`);
}

function safeKey(key: string): string {
	if (unsafeKeys.has(key)) invalid("unsafe argument key");
	return key;
}

/** Only concrete member/index paths are accepted, never JSONPath queries or expressions. */
function parsePath(path: string): PathKey[] {
	if (typeof path !== "string" || !path.startsWith("$")) invalid("invalid JSONPath");
	const keys: PathKey[] = [];
	let offset = 1;
	while (offset < path.length) {
		if (keys.length >= MAX_PATH_DEPTH) invalid("argument path is too deep");
		if (path[offset] === ".") {
			const match = /^[A-Za-z_$\u0080-\u{10FFFF}][A-Za-z0-9_$\u0080-\u{10FFFF}]*/u.exec(path.slice(++offset));
			if (!match) invalid("invalid JSONPath member");
			keys.push(safeKey(match[0]));
			offset += match[0].length;
		} else if (path[offset++] === "[") {
			const quote = path[offset];
			if (quote === '"' || quote === "'") {
				offset++;
				let key = "";
				let closed = false;
				while (offset < path.length) {
					const character = path[offset++]!;
					if (character === quote) {
						closed = true;
						break;
					}
					if (character === "\\") {
						const escaped = path[offset++];
						if (escaped === quote || escaped === "\\" || escaped === "/") key += escaped;
						else if (escaped === "b") key += "\b";
						else if (escaped === "f") key += "\f";
						else if (escaped === "n") key += "\n";
						else if (escaped === "r") key += "\r";
						else if (escaped === "t") key += "\t";
						else if (escaped === "u") {
							const hex = path.slice(offset, offset + 4);
							if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid("invalid JSONPath escape");
							key += String.fromCharCode(Number.parseInt(hex, 16));
							offset += 4;
						} else invalid("invalid JSONPath escape");
					} else {
						if (character.charCodeAt(0) < 32) invalid("invalid JSONPath quoted key");
						key += character;
					}
				}
				if (!closed || path[offset++] !== "]") invalid("unterminated JSONPath member");
				keys.push(safeKey(key));
			} else {
				const match = /^(0|[1-9]\d*)\]/.exec(path.slice(offset));
				if (!match) invalid("invalid JSONPath index");
				const index = Number(match[1]);
				if (!Number.isSafeInteger(index) || index > 0xfffffffe) invalid("unsafe JSONPath index");
				keys.push(index);
				offset += match[0].length;
			}
		} else invalid("invalid JSONPath syntax");
	}
	if (keys.length === 0 || typeof keys[0] !== "string") invalid("arguments must be an object");
	return keys;
}

function checkContinuation(value: unknown): void {
	if (value !== undefined && typeof value !== "boolean") invalid("invalid continuation flag");
}

function fragmentValue(fragment: PartialArg): Primitive | undefined {
	const fields = ["numberValue", "stringValue", "boolValue", "nullValue"] as const;
	const present = fields.filter(field => Object.hasOwn(fragment, field));
	if (present.length === 0) return undefined;
	if (present.length !== 1) invalid("ambiguous fragment value");
	switch (present[0]) {
		case "numberValue":
			if (typeof fragment.numberValue !== "number" || !Number.isFinite(fragment.numberValue)) {
				invalid("nonfinite or invalid number");
			}
			return fragment.numberValue;
		case "stringValue":
			if (typeof fragment.stringValue !== "string") invalid("invalid string");
			return fragment.stringValue;
		case "boolValue":
			if (typeof fragment.boolValue !== "boolean") invalid("invalid boolean");
			return fragment.boolValue;
		case "nullValue":
			if (fragment.nullValue !== null && fragment.nullValue !== "NULL_VALUE" && fragment.nullValue !== 0) {
				invalid("invalid null");
			}
			return null;
	}
}

function appendFragment(root: ArgumentNode, fragment: PartialArg): void {
	if (!fragment || typeof fragment !== "object") invalid("invalid argument fragment");
	checkContinuation(fragment.willContinue);
	if (typeof fragment.jsonPath !== "string") invalid("invalid JSONPath");
	// Terminal container markers are not concrete path members. Quoted keys still end in a quote and ].
	const containerKind = fragment.jsonPath.endsWith("[]")
		? "array"
		: fragment.jsonPath.endsWith("{}")
			? "object"
			: undefined;
	const concretePath = containerKind ? fragment.jsonPath.slice(0, -2) : fragment.jsonPath;
	const value = fragmentValue(fragment);
	if (containerKind && (value !== undefined || fragment.willContinue === true)) {
		invalid("container markers must be valueless and cannot continue strings");
	}
	if (containerKind && concretePath === "$") {
		if (containerKind !== root.kind) invalid("arguments must be an object");
		return;
	}
	const path = parsePath(concretePath);
	if (fragment.willContinue && typeof value !== "string") invalid("only strings can continue");
	let node = root;
	for (let index = 0; index < path.length; index++) {
		const key = path[index]!;
		if (node.kind === "value" || (node.kind === "array") !== (typeof key === "number")) {
			invalid("inconsistent argument path types");
		}
		const existing: ArgumentNode | undefined = node.children.get(key);
		if (index === path.length - 1) {
			if (containerKind) {
				if (existing && existing.kind !== containerKind) invalid("inconsistent argument path types");
				if (!existing) node.children.set(key, { kind: containerKind, children: new Map() });
			} else if (existing) {
				if (existing.kind !== "value" || !existing.continuing || typeof existing.value !== "string") {
					invalid("argument overwrites a completed value");
				}
				// The protocol also permits a valueless fragment to close an open string.
				if (value !== undefined && typeof value !== "string") invalid("inconsistent string continuation");
				existing.value += value ?? "";
				existing.continuing = fragment.willContinue === true;
			} else {
				if (value === undefined) invalid("missing fragment value");
				node.children.set(key, { kind: "value", value, continuing: fragment.willContinue === true });
			}
		} else {
			const child: ArgumentNode = existing ?? {
				kind: typeof path[index + 1] === "number" ? "array" : "object",
				children: new Map(),
			};
			node.children.set(key, child);
			node = child;
		}
	}
}

function materialize(node: ArgumentNode): unknown {
	if (node.kind === "value") {
		if (node.continuing) invalid("incomplete argument string");
		return node.value;
	}
	if (node.kind === "array") {
		// Validate density before allocating: even a huge wire index only occupies a Map entry.
		for (const key of node.children.keys()) {
			if (typeof key !== "number" || key >= node.children.size) invalid("sparse argument array");
		}
		const array: unknown[] = [];
		for (let index = 0; index < node.children.size; index++) {
			array.push(materialize(node.children.get(index)!));
		}
		return array;
	}
	const object: Record<string, unknown> = {};
	for (const [key, child] of node.children) object[key] = materialize(child);
	return object;
}

/**
 * One sequential call at a time, as in Google's streaming protocol. Partial state never
 * escapes this assembler. In particular, EOF is not a function-call completion signal.
 */
export class GoogleFunctionCallStream {
	#pending:
		| {
				name?: string;
				id?: string;
				thoughtSignature?: string;
				fullArgs?: Record<string, unknown>;
				root: ArgumentNode;
				hasFragments: boolean;
		  }
		| undefined;

	get pending(): boolean {
		return this.#pending !== undefined;
	}

	retainSignature(signature: string | undefined): void {
		if (this.#pending && signature) this.#pending.thoughtSignature = signature;
	}

	append(call: FunctionCallPart, signature?: string): CompletedGoogleFunctionCall | undefined {
		if (!call || typeof call !== "object" || Array.isArray(call)) invalid("invalid functionCall");
		checkContinuation(call.willContinue);
		if (call.partialArgs !== undefined && !Array.isArray(call.partialArgs)) invalid("invalid partial arguments");
		// Empty repeated fields carry no fragments, including on terminal markers.
		const partialArgs = call.partialArgs?.length ? call.partialArgs : undefined;
		// A redundant empty terminal marker must not create another zero-argument call.
		if (
			!this.#pending &&
			call.name === undefined &&
			call.id === undefined &&
			call.args === undefined &&
			partialArgs === undefined &&
			!call.willContinue
		)
			return undefined;
		this.#pending ??= {
			root: { kind: "object", children: new Map() },
			hasFragments: false,
		};
		const pending = this.#pending;
		for (const field of ["name", "id"] as const) {
			const incoming = call[field];
			if (incoming === undefined) continue;
			if (typeof incoming !== "string" || incoming.length === 0) invalid(`invalid ${field}`);
			if (pending[field] !== undefined && pending[field] !== incoming) invalid(`conflicting ${field}`);
			pending[field] = incoming;
		}
		this.retainSignature(signature);
		if (call.args !== undefined) {
			if (pending.fullArgs !== undefined || pending.hasFragments || partialArgs !== undefined) {
				invalid("conflicting full and partial arguments");
			}
			if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) {
				invalid("arguments must be an object");
			}
			// Complete arguments are parsed JSON data, not paths used for property writes.
			pending.fullArgs = call.args;
		}
		if (partialArgs !== undefined) {
			if (pending.fullArgs !== undefined) {
				invalid("conflicting or invalid partial arguments");
			}
			pending.hasFragments = true;
			for (const fragment of partialArgs) appendFragment(pending.root, fragment);
		}
		if (call.willContinue) return undefined;
		if (!pending.name) invalid("completed call has no name");
		const completed: CompletedGoogleFunctionCall = {
			name: pending.name,
			id: pending.id,
			args: pending.fullArgs ?? (materialize(pending.root) as Record<string, unknown>),
			thoughtSignature: pending.thoughtSignature,
		};
		this.#pending = undefined;
		return completed;
	}

	finish(): void {
		if (this.#pending) invalid("incomplete function call at end of stream");
	}
}
