import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@gajae-code/ai/core";
import { redactCrashSecrets } from "@gajae-code/utils";
import type { CustomMessage } from "../../session/messages";
import type { ExtensionEvent, ExtensionSessionMetadata, ExtensionUIContext } from "./types";

/** Function hooks use the existing extension event stream; `*` is observation middleware. */
export type FunctionHookEventType = ExtensionEvent["type"] | "*";
export type FunctionHookPayloadFor<T extends FunctionHookEventType> = T extends "*"
	? ExtensionEvent
	: Extract<ExtensionEvent, { type: T }>;

/** Narrow capability vocabulary. Parent names expand only to their children. */
export type FunctionHookCapability =
	| "tool"
	| "tool.inspect"
	| "tool.transform"
	| "tool.deny"
	| "ui"
	| "ui.status"
	| "ui.widget"
	| "ui.notify"
	| "ui.transform"
	| "session"
	| "session.read"
	| "session.message"
	| "session.deny"
	| "audit"
	| "audit.append"
	| "network"
	| "network.fetch"
	| "filesystem"
	| "filesystem.read";

export const FUNCTION_HOOK_CAPABILITIES: readonly FunctionHookCapability[] = [
	"tool",
	"tool.inspect",
	"tool.transform",
	"tool.deny",
	"ui",
	"ui.status",
	"ui.widget",
	"ui.notify",
	"ui.transform",
	"session",
	"session.read",
	"session.message",
	"session.deny",
	"audit",
	"audit.append",
	"network",
	"network.fetch",
	"filesystem",
	"filesystem.read",
];

export type FunctionHookOperation = Exclude<
	FunctionHookCapability,
	"tool" | "ui" | "session" | "audit" | "network" | "filesystem"
>;

const CAPABILITY_OPERATIONS: Record<FunctionHookCapability, readonly FunctionHookOperation[]> = {
	tool: ["tool.inspect", "tool.transform", "tool.deny"],
	"tool.inspect": ["tool.inspect"],
	"tool.transform": ["tool.transform"],
	"tool.deny": ["tool.deny"],
	ui: ["ui.status", "ui.widget", "ui.notify", "ui.transform"],
	"ui.status": ["ui.status"],
	"ui.widget": ["ui.widget"],
	"ui.notify": ["ui.notify"],
	"ui.transform": ["ui.transform"],
	session: ["session.read", "session.message", "session.deny"],
	"session.read": ["session.read"],
	"session.message": ["session.message"],
	"session.deny": ["session.deny"],
	audit: ["audit.append"],
	"audit.append": ["audit.append"],
	network: ["network.fetch"],
	"network.fetch": ["network.fetch"],
	filesystem: ["filesystem.read"],
	"filesystem.read": ["filesystem.read"],
};

const KNOWN_CAPABILITIES = new Set<string>(FUNCTION_HOOK_CAPABILITIES);
export interface FunctionHookGrantInput {
	capabilities?: readonly FunctionHookCapability[];
	networkDestinations?: readonly string[];
	filesystemRoots?: readonly string[];
	/** An attenuation boundary can only remove downstream operations. */
	attenuateDownstream?: readonly FunctionHookCapability[];
}

export interface FunctionHookGrant {
	readonly capabilities: readonly FunctionHookCapability[];
	readonly networkDestinations: readonly string[];
	readonly filesystemRoots: readonly string[];
	readonly attenuateDownstream?: readonly FunctionHookCapability[];
}

export interface FunctionHookRegistrationOptions extends FunctionHookGrantInput {
	target?: string;
	registrationId?: string;
}

export interface FunctionHookProvenance {
	readonly source: "builtin" | "user" | "project" | "extension" | "plugin-bundle";
	readonly scope?: "user" | "project" | "native";
	readonly plugin?: string;
	readonly extensionId?: string;
	readonly path: string;
	readonly activationGeneration?: number;
}

export interface FunctionHookInvocation<TEvent extends ExtensionEvent = ExtensionEvent> {
	readonly eventId: string;
	readonly correlationId: string;
	readonly eventType: TEvent["type"];
	readonly provenance: FunctionHookProvenance;
	readonly registrationOrder: number;
	readonly payload: Readonly<TEvent>;
	readonly signal: AbortSignal;
}

export interface FunctionHookMessage {
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display?: boolean;
	details?: unknown;
	attribution?: CustomMessage["attribution"];
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp";
}

export interface FunctionHookAuditRecord {
	readonly sequence: number;
	readonly eventId: string;
	readonly correlationId: string;
	readonly eventType: string;
	readonly action: "continue" | "deny" | "return" | "error" | "timeout";
	readonly registrationOrder: number;
	readonly provenance: {
		source: FunctionHookProvenance["source"];
		scope?: FunctionHookProvenance["scope"];
		plugin?: string;
		extensionId?: string;
		path: string;
	};
	readonly reason?: string;
	readonly payloadHash?: string;
	readonly evidence?: unknown;
	readonly requestedCapabilities?: readonly FunctionHookCapability[];
	readonly effectiveCapabilities?: readonly FunctionHookCapability[];
	readonly capabilityHash?: string;
	readonly activationGeneration?: number;
}

export interface FunctionHookCapabilities {
	readonly tool?: {
		readonly canInspect: boolean;
		readonly canTransform: boolean;
		readonly canDeny: boolean;
	};
	readonly ui?: {
		readonly canTransform: boolean;
		readonly setStatus: (key: string, text: string | undefined) => void;
		readonly setWidget: (key: string, content: string[] | undefined) => void;
		readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
	};
	readonly session?: {
		readonly canRead: boolean;
		readonly canDeny: boolean;
		readonly metadata: Readonly<ExtensionSessionMetadata> | undefined;
		readonly emitMessage: (
			message: FunctionHookMessage,
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
		) => void;
	};
	readonly audit?: { readonly append: (evidence: Record<string, unknown>) => void };
	readonly network?: { readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response> };
	readonly filesystem?: { readonly readFile: (filePath: string) => Promise<string> };
}

export type FunctionHookResult<TEvent extends ExtensionEvent = ExtensionEvent> =
	| { action: "continue"; event?: TEvent }
	| { action: "deny"; reason: string }
	| { action: "return"; value: unknown };

export type FunctionHookNext<TEvent extends ExtensionEvent = ExtensionEvent> = (
	event?: TEvent,
) => Promise<FunctionHookResult<TEvent>>;

export type FunctionHook<TEvent extends ExtensionEvent = ExtensionEvent> = (
	invocation: FunctionHookInvocation<TEvent>,
	capabilities: FunctionHookCapabilities,
	next: FunctionHookNext<TEvent>,
) => FunctionHookResult<TEvent> | undefined | Promise<FunctionHookResult<TEvent> | undefined>;

export interface FunctionHookRegistration {
	readonly event: FunctionHookEventType;
	readonly target?: string;
	readonly registrationId?: string;
	readonly handler: FunctionHook;
	readonly grant: FunctionHookGrant;
	readonly provenance: FunctionHookProvenance;
	readonly registrationOrder?: number;
}

export function validateFunctionHookTarget(target: string): string {
	if (
		target.length === 0 ||
		target.trim() !== target ||
		target === "." ||
		target === ".." ||
		target.includes("/") ||
		target.includes("\\") ||
		target.includes("\0")
	) {
		throw new Error("Function hook target must be a non-empty logical tool name without path separators");
	}
	return target;
}

function expandedOperations(capabilities: readonly FunctionHookCapability[]): Set<FunctionHookOperation> {
	const operations = new Set<FunctionHookOperation>();
	for (const capability of capabilities) {
		if (!KNOWN_CAPABILITIES.has(capability))
			throw new Error(`Unknown function hook capability: ${String(capability)}`);
		for (const operation of CAPABILITY_OPERATIONS[capability]) operations.add(operation);
	}
	return operations;
}

function uniqueSortedCapabilities(input: readonly FunctionHookCapability[] | undefined): FunctionHookCapability[] {
	const values = [...new Set(input ?? [])];
	for (const value of values) {
		if (!KNOWN_CAPABILITIES.has(value)) throw new Error(`Unknown function hook capability: ${String(value)}`);
	}
	return values.sort();
}

function validateNetworkDestination(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Function hook network destinations must be valid HTTPS origins");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
		throw new Error("Function hook network destinations must be origin-only HTTPS URLs");
	return url.origin;
}

function validateFilesystemRoot(value: string): string {
	if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.includes("\0"))
		throw new Error("Function hook filesystem roots must be non-empty paths without NUL or surrounding whitespace");
	return value;
}

export function normalizeFunctionHookGrant(input: FunctionHookGrantInput = {}): FunctionHookGrant {
	const capabilities = uniqueSortedCapabilities(input.capabilities);
	const operations = expandedOperations(capabilities);
	const networkDestinations = [...new Set(input.networkDestinations ?? [])].map(validateNetworkDestination).sort();
	const filesystemRoots = [...new Set(input.filesystemRoots ?? [])].map(validateFilesystemRoot).sort();
	if (networkDestinations.length > 0 && !operations.has("network.fetch"))
		throw new Error("Function hook network destinations require network.fetch");
	if (filesystemRoots.length > 0 && !operations.has("filesystem.read"))
		throw new Error("Function hook filesystem roots require filesystem.read");
	const attenuation =
		input.attenuateDownstream === undefined ? undefined : uniqueSortedCapabilities(input.attenuateDownstream);
	if (attenuation) expandedOperations(attenuation);
	return Object.freeze({
		capabilities: Object.freeze(capabilities),
		networkDestinations: Object.freeze(networkDestinations),
		filesystemRoots: Object.freeze(filesystemRoots),
		...(attenuation ? { attenuateDownstream: Object.freeze(attenuation) } : {}),
	});
}

export function compatibilityFunctionHookGrant(event: string): FunctionHookGrant {
	if (event === "tool_call" || event === "tool_result") return normalizeFunctionHookGrant({ capabilities: ["tool"] });
	if (event.startsWith("session")) return normalizeFunctionHookGrant({ capabilities: ["session"] });
	return normalizeFunctionHookGrant();
}

export function functionHookGrantOperations(grant: FunctionHookGrant): ReadonlySet<FunctionHookOperation> {
	return expandedOperations(grant.capabilities);
}

export function intersectFunctionHookGrants(
	grant: FunctionHookGrant,
	allowed: FunctionHookGrant | undefined,
): FunctionHookGrant {
	if (!allowed) return grant;
	const allowedOperations = expandedOperations(allowed.capabilities);
	const capabilities = [...expandedOperations(grant.capabilities)].filter(operation =>
		allowedOperations.has(operation),
	) as FunctionHookCapability[];
	return normalizeFunctionHookGrant({
		capabilities,
		networkDestinations: grant.networkDestinations.filter(destination =>
			allowed.networkDestinations.includes(destination),
		),
		filesystemRoots: grant.filesystemRoots.filter(root => allowed.filesystemRoots.includes(root)),
		attenuateDownstream: grant.attenuateDownstream,
	});
}

/** Host-owned ceiling for caller-registered in-process extension and hook middleware. */
export const DEFAULT_EXTENSION_FUNCTION_HOOK_GRANT = normalizeFunctionHookGrant({
	capabilities: ["tool", "ui", "session", "audit"],
});

export function attenuateFunctionHookGrant(
	grant: FunctionHookGrant,
	removed: readonly FunctionHookCapability[] | undefined,
): FunctionHookGrant {
	if (!removed || removed.length === 0) return grant;
	const removedOperations = expandedOperations(removed);
	const capabilities = [...expandedOperations(grant.capabilities)].filter(
		operation => !removedOperations.has(operation),
	) as FunctionHookCapability[];
	const operations = expandedOperations(capabilities);
	return normalizeFunctionHookGrant({
		capabilities,
		networkDestinations: operations.has("network.fetch") ? grant.networkDestinations : [],
		filesystemRoots: operations.has("filesystem.read") ? grant.filesystemRoots : [],
	});
}

export function functionHookGrantHash(grant: FunctionHookGrant): string {
	const canonical = JSON.stringify({
		capabilities: [...expandedOperations(grant.capabilities)].sort(),
		networkDestinations: [...grant.networkDestinations].sort(),
		filesystemRoots: [...grant.filesystemRoots].sort(),
	});
	return createHash("sha256").update(canonical).digest("hex");
}

function boundedText(value: string, maxLength: number): string {
	return redactCrashSecrets(value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")).slice(0, maxLength);
}

function sensitiveKey(key: string): boolean {
	return /(?:token|secret|password|passwd|credential|authorization|cookie|private|api[-_]?key|bearer)/i.test(key);
}

/** Bounded JSON-shaped redaction for diagnostics and audit sinks. Accessors are never invoked. */
export function redactFunctionHookValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return boundedText(value, 512);
	if (typeof value === "bigint") return "<bigint>";
	if (typeof value !== "object") return `<${typeof value}>`;
	if (seen.has(value)) return "<cycle>";
	if (depth >= 5) return "<depth-limit>";
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.slice(0, 32).map(item => redactFunctionHookValue(item, depth + 1, seen));
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort().slice(0, 32)) {
			const safeKey = boundedText(key, 80);
			if (sensitiveKey(key)) {
				output[safeKey] = "<redacted>";
				continue;
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor)) {
				output[safeKey] = "<accessor>";
				continue;
			}
			output[safeKey] = redactFunctionHookValue(descriptor.value, depth + 1, seen);
		}
		return output;
	} catch {
		return "<unreadable>";
	} finally {
		seen.delete(value);
	}
}

export function functionHookPayloadHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(redactFunctionHookValue(value)))
		.digest("hex");
}

export function isPlainFunctionHookData(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.every(item => isPlainFunctionHookData(item, seen));
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		return Object.keys(value).every(key => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return Boolean(descriptor && "value" in descriptor && isPlainFunctionHookData(descriptor.value, seen));
		});
	} catch {
		return false;
	} finally {
		seen.delete(value);
	}
}

export function isSafeFunctionHookValue(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (value === undefined) return true;
	if (typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.every(item => isSafeFunctionHookValue(item, seen));
		if (!isPlainFunctionHookData(value)) return false;
		return Object.keys(value).every(key => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && "value" in descriptor && isSafeFunctionHookValue(descriptor.value, seen);
		});
	} catch {
		return false;
	} finally {
		seen.delete(value);
	}
}

function isFunctionHookContent(value: unknown): boolean {
	if (!isPlainFunctionHookData(value) || value === null || typeof value !== "object") return false;
	const content = value as Record<string, unknown>;
	if (content.type === "text")
		return (
			typeof content.text === "string" &&
			(content.textSignature === undefined || typeof content.textSignature === "string")
		);
	if (content.type === "image") return typeof content.data === "string" && typeof content.mimeType === "string";
	return false;
}

function isFunctionHookImage(value: unknown): boolean {
	return (
		isPlainFunctionHookData(value) &&
		value !== null &&
		typeof value === "object" &&
		(value as Record<string, unknown>).type === "image" &&
		typeof (value as Record<string, unknown>).data === "string" &&
		typeof (value as Record<string, unknown>).mimeType === "string"
	);
}

function isFunctionHookAssistantContent(value: unknown): boolean {
	if (isFunctionHookContent(value)) return true;
	if (!isPlainFunctionHookData(value) || value === null || typeof value !== "object") return false;
	const content = value as Record<string, unknown>;
	if (content.type === "thinking") return typeof content.thinking === "string";
	if (content.type === "redactedThinking") return typeof content.data === "string";
	if (content.type === "toolCall") {
		return (
			typeof content.id === "string" &&
			typeof content.name === "string" &&
			content.arguments !== null &&
			typeof content.arguments === "object" &&
			!Array.isArray(content.arguments) &&
			isPlainFunctionHookData(content.arguments)
		);
	}
	return false;
}

function isFunctionHookMessage(value: unknown): boolean {
	if (!isPlainFunctionHookData(value) || value === null || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	if (typeof message.role !== "string") return false;
	if (message.role === "user" || message.role === "developer") {
		return (
			(typeof message.content === "string" ||
				(Array.isArray(message.content) && message.content.every(isFunctionHookContent))) &&
			typeof message.timestamp === "number" &&
			Number.isFinite(message.timestamp)
		);
	}
	if (message.role === "toolResult") {
		return (
			typeof message.toolCallId === "string" &&
			typeof message.toolName === "string" &&
			Array.isArray(message.content) &&
			message.content.every(isFunctionHookContent) &&
			typeof message.isError === "boolean" &&
			typeof message.timestamp === "number" &&
			Number.isFinite(message.timestamp)
		);
	}
	if (message.role === "assistant") {
		return (
			Array.isArray(message.content) &&
			message.content.every(isFunctionHookAssistantContent) &&
			typeof message.api === "string" &&
			typeof message.provider === "string" &&
			typeof message.model === "string" &&
			typeof message.stopReason === "string" &&
			typeof message.timestamp === "number" &&
			Number.isFinite(message.timestamp)
		);
	}
	return isSafeFunctionHookValue(message);
}

export function isValidFunctionHookEventValue(event: ExtensionEvent): boolean {
	try {
		if (!isPlainFunctionHookData(event) || typeof event.type !== "string") return false;
		switch (event.type) {
			case "tool_call":
				return (
					typeof event.toolName === "string" &&
					typeof event.toolCallId === "string" &&
					event.input !== null &&
					typeof event.input === "object" &&
					!Array.isArray(event.input) &&
					isSafeFunctionHookValue(event.input)
				);
			case "tool_result":
				return (
					typeof event.toolName === "string" &&
					typeof event.toolCallId === "string" &&
					Array.isArray(event.content) &&
					event.content.every(isFunctionHookContent) &&
					typeof event.isError === "boolean" &&
					(event.details === undefined || isSafeFunctionHookValue(event.details))
				);
			case "input":
				return (
					typeof event.text === "string" &&
					(event.images === undefined ||
						(Array.isArray(event.images) && event.images.every(isFunctionHookImage))) &&
					(event.source === "interactive" || event.source === "sdk" || event.source === "extension")
				);
			case "context":
				return Array.isArray(event.messages) && event.messages.every(isFunctionHookMessage);
			case "before_agent_start":
				return (
					typeof event.prompt === "string" &&
					Array.isArray(event.systemPrompt) &&
					event.systemPrompt.every(item => typeof item === "string") &&
					(event.images === undefined || (Array.isArray(event.images) && event.images.every(isFunctionHookImage)))
				);
			case "before_provider_request":
				return isSafeFunctionHookValue(event.payload);
			case "after_provider_response":
				return (
					typeof event.status === "number" &&
					Number.isFinite(event.status) &&
					isSafeFunctionHookValue(event.headers) &&
					(event.requestId === undefined || event.requestId === null || typeof event.requestId === "string") &&
					(event.metadata === undefined || isSafeFunctionHookValue(event.metadata))
				);
			default:
				return false;
		}
	} catch {
		return false;
	}
}

export function functionHookEventIdentityMatches(original: ExtensionEvent, candidate: ExtensionEvent): boolean {
	if (original.type !== candidate.type) return false;
	if (original.type === "tool_call" && candidate.type === "tool_call")
		return original.toolName === candidate.toolName && original.toolCallId === candidate.toolCallId;
	if (original.type === "tool_result" && candidate.type === "tool_result")
		return original.toolName === candidate.toolName && original.toolCallId === candidate.toolCallId;
	if (original.type === "input" && candidate.type === "input") return original.source === candidate.source;
	return true;
}

export function cloneFunctionHookData<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}

/** Security-boundary clone for transformed events; never aliases caller-owned data. */
export function cloneFunctionHookDataStrict<T>(value: T): T {
	const cloned = structuredClone(value);
	if (!isPlainFunctionHookData(cloned)) throw new Error("Function hook snapshot is not plain data");
	return cloned;
}

function boundedUiKey(value: string): string {
	return boundedText(value, 80);
}

function boundedUiLines(value: string[]): string[] {
	return value.slice(0, 32).map(line => boundedText(line, 512));
}

function allowedUrl(value: string | URL, destinations: readonly string[]): URL | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && destinations.includes(url.origin) ? url : undefined;
	} catch {
		return undefined;
	}
}

export interface FunctionHookCapabilityBindings {
	readonly cwd: string;
	readonly ui: ExtensionUIContext;
	readonly sessionMetadata?: ExtensionSessionMetadata;
	readonly isActive?: () => boolean;
	readonly emitMessage: (
		message: FunctionHookMessage,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
	) => void;
	readonly appendAudit: (evidence: Record<string, unknown>) => void;
	readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
	readonly readFile: (filePath: string, roots: readonly string[]) => Promise<string>;
}

function assertActive(bindings: FunctionHookCapabilityBindings): void {
	if (bindings.isActive && !bindings.isActive()) throw new Error("Function hook invocation is no longer active");
}

export function createFunctionHookCapabilities(
	grant: FunctionHookGrant,
	bindings: FunctionHookCapabilityBindings,
): FunctionHookCapabilities {
	const operations = expandedOperations(grant.capabilities);
	const result: FunctionHookCapabilities = {};
	if (operations.has("tool.inspect") || operations.has("tool.transform") || operations.has("tool.deny")) {
		Object.assign(result, {
			tool: Object.freeze({
				canInspect: operations.has("tool.inspect"),
				canTransform: operations.has("tool.transform"),
				canDeny: operations.has("tool.deny"),
			}),
		});
	}
	if (
		operations.has("ui.status") ||
		operations.has("ui.widget") ||
		operations.has("ui.notify") ||
		operations.has("ui.transform")
	) {
		Object.assign(result, {
			ui: Object.freeze({
				canTransform: operations.has("ui.transform"),
				setStatus: (key: string, text: string | undefined) => {
					assertActive(bindings);
					if (!operations.has("ui.status")) throw new Error("Function hook ui.status capability is required");
					bindings.ui.setStatus(boundedUiKey(key), text === undefined ? undefined : boundedText(text, 512));
				},
				setWidget: (key: string, content: string[] | undefined) => {
					assertActive(bindings);
					if (!operations.has("ui.widget")) throw new Error("Function hook ui.widget capability is required");
					bindings.ui.setWidget(boundedUiKey(key), content === undefined ? undefined : boundedUiLines(content));
				},
				notify: (message: string, type?: "info" | "warning" | "error") => {
					assertActive(bindings);
					if (!operations.has("ui.notify")) throw new Error("Function hook ui.notify capability is required");
					bindings.ui.notify(boundedText(message, 512), type);
				},
			}),
		});
	}
	if (operations.has("session.read") || operations.has("session.message") || operations.has("session.deny")) {
		const metadata =
			operations.has("session.read") && bindings.sessionMetadata
				? Object.freeze(cloneFunctionHookData(bindings.sessionMetadata))
				: undefined;
		Object.assign(result, {
			session: Object.freeze({
				canRead: operations.has("session.read"),
				canDeny: operations.has("session.deny"),
				metadata,
				emitMessage: (
					message: FunctionHookMessage,
					options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
				) => {
					assertActive(bindings);
					if (!operations.has("session.message"))
						throw new Error("Function hook session.message capability is required");
					bindings.emitMessage(
						{
							customType: boundedUiKey(message.customType),
							content:
								typeof message.content === "string"
									? boundedText(message.content, 2048)
									: cloneFunctionHookData(message.content),
							display: message.display ?? false,
							details: redactFunctionHookValue(message.details),
							attribution: message.attribution,
						},
						options ?? { triggerTurn: message.triggerTurn, deliverAs: message.deliverAs },
					);
				},
			}),
		});
	}
	if (operations.has("audit.append")) {
		Object.assign(result, {
			audit: Object.freeze({
				append: (evidence: Record<string, unknown>) => {
					assertActive(bindings);
					bindings.appendAudit(evidence);
				},
			}),
		});
	}
	if (operations.has("network.fetch")) {
		Object.assign(result, {
			network: Object.freeze({
				fetch: (input: string | URL, init?: RequestInit) => {
					assertActive(bindings);
					const url = allowedUrl(input, grant.networkDestinations);
					if (!url) throw new Error("Function hook network destination is outside its declared grant");
					return bindings.fetch(url, { ...init, redirect: "error" });
				},
			}),
		});
	}
	if (operations.has("filesystem.read")) {
		Object.assign(result, {
			filesystem: Object.freeze({
				readFile: (filePath: string) => {
					assertActive(bindings);
					return bindings.readFile(filePath, grant.filesystemRoots);
				},
			}),
		});
	}
	return Object.freeze(result);
}

export function compatibilityPayloadForFunctionHook(
	event: ExtensionEvent,
	grant: FunctionHookGrant,
	wildcard: boolean,
): ExtensionEvent {
	const operations = expandedOperations(grant.capabilities);
	if ((event.type === "tool_call" || event.type === "tool_result") && !operations.has("tool.inspect")) {
		const redacted = redactFunctionHookValue(event) as Record<string, unknown>;
		redacted.input = "<redacted>";
		if (event.type === "tool_result") {
			redacted.content = "<redacted>";
			redacted.details = "<redacted>";
		}
		return deepFreezeFunctionHookData(redacted) as unknown as ExtensionEvent;
	}
	const canInspectNonTool =
		(event.type.startsWith("session_") && operations.has("session.read")) ||
		(!event.type.startsWith("session_") && operations.has("ui.transform"));
	if ((wildcard || !canInspectNonTool) && event.type !== "tool_call" && event.type !== "tool_result")
		return Object.freeze({ type: event.type }) as ExtensionEvent;
	return deepFreezeFunctionHookData(cloneFunctionHookData(event));
}

function deepFreezeFunctionHookData<T>(value: T, seen = new WeakSet<object>()): T {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
	if (seen.has(value)) return value;
	seen.add(value);
	try {
		for (const key of Object.keys(value as object)) {
			const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
			if (descriptor && "value" in descriptor) deepFreezeFunctionHookData(descriptor.value, seen);
		}
		return Object.freeze(value);
	} catch {
		return value;
	} finally {
		seen.delete(value);
	}
}

export function functionHookTransformAllowed(event: ExtensionEvent, grant: FunctionHookGrant): boolean {
	const operations = expandedOperations(grant.capabilities);
	if (event.type === "tool_call" || event.type === "tool_result") return operations.has("tool.transform");
	if (
		event.type === "input" ||
		event.type === "context" ||
		event.type === "before_agent_start" ||
		event.type === "before_provider_request"
	)
		return operations.has("ui.transform");
	return false;
}

export function functionHookDenyAllowed(event: ExtensionEvent, grant: FunctionHookGrant): boolean {
	const operations = expandedOperations(grant.capabilities);
	if (event.type === "tool_call" || event.type === "tool_result") return operations.has("tool.deny");
	if (
		event.type === "input" ||
		event.type === "before_agent_start" ||
		event.type === "before_provider_request" ||
		event.type === "context"
	)
		return operations.has("ui.transform");
	return event.type.startsWith("session_before_") && operations.has("session.deny");
}

export function sanitizeFunctionHookReason(reason: unknown, fallback: string): string {
	return typeof reason === "string" && reason.trim() ? boundedText(reason, 512) : fallback;
}

/** Root-confined, realpath-checked read used only by the filesystem capability. */
export async function readConstrainedFunctionHookFile(
	filePath: string,
	cwd: string,
	roots: readonly string[],
): Promise<string> {
	if (roots.length === 0) throw new Error("Function hook filesystem.read has no declared root");
	const candidateReal = await fs.realpath(path.resolve(cwd, filePath));
	for (const root of roots) {
		const rootReal = await fs.realpath(path.resolve(cwd, root));
		const relative = path.relative(rootReal, candidateReal);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
			const handle = await fs.open(candidateReal, "r");
			try {
				return (await handle.readFile("utf8")).slice(0, 1_000_000);
			} finally {
				await handle.close();
			}
		}
	}
	throw new Error("Function hook filesystem path is outside its declared grant");
}
