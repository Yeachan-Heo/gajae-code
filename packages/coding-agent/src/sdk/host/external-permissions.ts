import { randomUUID } from "node:crypto";
import type {
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../../session/client-bridge";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PENDING = 64;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_AGGREGATE_REQUEST_BYTES = 192 * 1024;
const MAX_COMMENT_LENGTH = 4096;

type PermissionOutcome = ClientBridgePermissionOutcome;

export interface ExternalPermissionChannelInput {
	enabled: boolean;
}

export interface ExternalPermissionResponseInput {
	sessionId: string;
	id: string;
	optionId: string;
	comment?: string;
}

export interface ExternalPermissionRequest {
	id: string;
	sessionId: string;
	toolCall: ClientBridgePermissionToolCall;
	options: ClientBridgePermissionOption[];
	expiresAt: string;
}

export class ExternalPermissionError extends Error {
	constructor(
		readonly code: "invalid_input" | "resource_gone" | "too_many_outstanding" | "payload_too_large",
		message: string,
	) {
		super(message);
		this.name = "ExternalPermissionError";
	}
}

type PendingRequest = {
	request: ExternalPermissionRequest;
	resolve: (outcome: PermissionOutcome) => void;
	timer: Timer;
	signal?: AbortSignal;
	onAbort?: () => void;
};

function invalid(message: string): never {
	throw new ExternalPermissionError("invalid_input", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
	const keys = Object.keys(value);
	return (
		required.every(key => Object.hasOwn(value, key)) &&
		keys.every(key => required.includes(key) || optional.includes(key))
	);
}

function jsonSnapshot(value: unknown): unknown {
	const seen = new Set<object>();
	const validate = (item: unknown, depth: number): void => {
		if (depth > 64) invalid("Permission payload is too deeply nested");
		if (item === null || typeof item === "string" || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isFinite(item)) return;
		if (typeof item !== "object") invalid("Permission payload must contain only JSON values");
		if (seen.has(item)) invalid("Permission payload must not contain cycles");
		seen.add(item);
		if (Array.isArray(item)) {
			for (const child of item) validate(child, depth + 1);
		} else {
			if (!isRecord(item)) invalid("Permission payload objects must be plain JSON objects");
			for (const child of Object.values(item)) validate(child, depth + 1);
		}
		seen.delete(item);
	};
	validate(value, 0);
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		return invalid("Permission payload is not valid JSON");
	}
	if (new TextEncoder().encode(encoded).byteLength > MAX_PAYLOAD_BYTES) {
		throw new ExternalPermissionError("payload_too_large", "Permission payload exceeds 256 KB");
	}
	return JSON.parse(encoded) as unknown;
}

function nonEmptyBoundedString(value: unknown, _field: string, max = 4096): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function snapshotToolCall(value: ClientBridgePermissionToolCall): ClientBridgePermissionToolCall {
	if (
		!isRecord(value) ||
		!nonEmptyBoundedString(value.toolCallId, "toolCallId", 512) ||
		!nonEmptyBoundedString(value.toolName, "toolName", 512) ||
		!nonEmptyBoundedString(value.title, "title", 4096)
	) {
		return invalid("Invalid permission tool call");
	}
	if (value.kind !== undefined && !nonEmptyBoundedString(value.kind, "kind", 512))
		invalid("Invalid permission tool call kind");
	if (value.status !== undefined && !["pending", "in_progress", "completed", "failed"].includes(String(value.status)))
		invalid("Invalid permission tool call status");
	if (value.content !== undefined && !Array.isArray(value.content)) invalid("Invalid permission tool call content");
	if (
		value.locations !== undefined &&
		(!Array.isArray(value.locations) ||
			value.locations.some(
				location =>
					!isRecord(location) ||
					!nonEmptyBoundedString(location.path, "location.path", 4096) ||
					(location.line !== undefined && (!Number.isSafeInteger(location.line) || Number(location.line) < 1)),
			))
	) {
		invalid("Invalid permission tool call locations");
	}
	const snapshot = jsonSnapshot(value) as ClientBridgePermissionToolCall;
	const allowed = new Set(["toolCallId", "toolName", "title", "kind", "status", "rawInput", "content", "locations"]);
	if (Object.keys(snapshot).some(key => !allowed.has(key))) invalid("Unexpected permission tool call field");
	return snapshot;
}

function snapshotOptions(value: ClientBridgePermissionOption[]): ClientBridgePermissionOption[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 64) invalid("Invalid permission options");
	const seen = new Set<string>();
	const normalized = value.map(option => {
		if (
			!isRecord(option) ||
			!exactKeys(option, ["optionId", "name", "kind"]) ||
			!nonEmptyBoundedString(option.optionId, "optionId", 512) ||
			!nonEmptyBoundedString(option.name, "name", 1024) ||
			!["allow_once", "allow_always", "reject_once", "reject_always"].includes(String(option.kind))
		) {
			return invalid("Invalid permission option");
		}
		if (seen.has(option.optionId)) invalid("Permission option IDs must be unique");
		seen.add(option.optionId);
		return { optionId: option.optionId, name: option.name, kind: option.kind } as ClientBridgePermissionOption;
	});
	return jsonSnapshot(normalized) as ClientBridgePermissionOption[];
}

export class ExternalPermissionRuntime {
	readonly #sessionId: string;
	readonly #timeoutMs: number;
	readonly #maxPending: number;
	readonly #pending = new Map<string, PendingRequest>();
	#enabled = false;
	#disposed = false;

	constructor(sessionId: string, options: { timeoutMs?: number; maxPending?: number } = {}) {
		if (!nonEmptyBoundedString(sessionId, "sessionId", 512)) invalid("Invalid session ID");
		if (!isRecord(options) || !exactKeys(options, [], ["timeoutMs", "maxPending"]))
			invalid("Invalid runtime options");
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) invalid("Invalid timeoutMs");
		if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1024) invalid("Invalid maxPending");
		this.#sessionId = sessionId;
		this.#timeoutMs = timeoutMs;
		this.#maxPending = maxPending;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	configure(input: unknown): { enabled: boolean } {
		if (!isRecord(input) || !exactKeys(input, ["enabled"]) || typeof input.enabled !== "boolean")
			invalid("configure requires exactly { enabled: boolean }");
		if (this.#disposed && input.enabled)
			throw new ExternalPermissionError("resource_gone", "Permission runtime is disposed");
		this.#enabled = input.enabled;
		if (!this.#enabled) this.#cancelAll();
		return { enabled: this.#enabled };
	}

	request(
		toolCall: ClientBridgePermissionToolCall,
		options: ClientBridgePermissionOption[],
		signal?: AbortSignal,
	): Promise<PermissionOutcome> {
		if (this.#disposed || !this.#enabled)
			throw new ExternalPermissionError("resource_gone", "External permissions are disabled");
		if (signal !== undefined && !(signal instanceof AbortSignal)) invalid("Invalid abort signal");
		if (signal?.aborted) return Promise.resolve({ outcome: "cancelled" });
		if (this.#pending.size >= this.#maxPending)
			throw new ExternalPermissionError("too_many_outstanding", "Too many pending permission requests");
		const toolCallSnapshot = snapshotToolCall(toolCall);
		const optionsSnapshot = snapshotOptions(options);
		const id = randomUUID();
		const expiresAt = new Date(Date.now() + this.#timeoutMs).toISOString();
		const request = jsonSnapshot({
			id,
			sessionId: this.#sessionId,
			toolCall: toolCallSnapshot,
			options: optionsSnapshot,
			expiresAt,
		}) as ExternalPermissionRequest;
		const aggregate = {
			sessionId: this.#sessionId,
			enabled: this.#enabled,
			requests: [...this.#pending.values()].map(item => item.request).concat(request),
		};
		if (new TextEncoder().encode(JSON.stringify(aggregate)).byteLength > MAX_AGGREGATE_REQUEST_BYTES) {
			throw new ExternalPermissionError("payload_too_large", "Aggregate pending permission requests exceed 192 KB");
		}
		const promise = Promise.withResolvers<PermissionOutcome>();
		const pending: PendingRequest = {
			request,
			resolve: promise.resolve,
			timer: setTimeout(() => this.#finish(id, { outcome: "cancelled" }), this.#timeoutMs),
			signal,
		};
		if (signal) {
			pending.onAbort = () => this.#finish(id, { outcome: "cancelled" });
			signal.addEventListener("abort", pending.onAbort, { once: true });
		}
		this.#pending.set(id, pending);
		return promise.promise;
	}

	list(input?: unknown): { sessionId: string; enabled: boolean; requests: ExternalPermissionRequest[] } {
		if (input !== undefined && (!isRecord(input) || Object.keys(input).length !== 0))
			invalid("list accepts only an empty object or undefined");
		return jsonSnapshot({
			sessionId: this.#sessionId,
			enabled: this.#enabled,
			requests: [...this.#pending.values()].map(item => item.request),
		}) as {
			sessionId: string;
			enabled: boolean;
			requests: ExternalPermissionRequest[];
		};
	}

	respond(input: unknown): { accepted: true } {
		if (
			!isRecord(input) ||
			!exactKeys(input, ["sessionId", "id", "optionId"], ["comment"]) ||
			!nonEmptyBoundedString(input.sessionId, "sessionId", 512) ||
			!nonEmptyBoundedString(input.id, "id", 64) ||
			!nonEmptyBoundedString(input.optionId, "optionId", 512) ||
			(input.comment !== undefined &&
				(typeof input.comment !== "string" || input.comment.length > MAX_COMMENT_LENGTH))
		) {
			invalid("Invalid permission response");
		}
		if (input.sessionId !== this.#sessionId) invalid("Permission response belongs to another session");
		const pending = this.#pending.get(input.id);
		if (!pending) invalid("Permission request is stale or already answered");
		if (Date.now() >= Date.parse(pending.request.expiresAt)) {
			this.#finish(input.id, { outcome: "cancelled" });
			throw new ExternalPermissionError("resource_gone", "Permission request expired");
		}
		const option = pending.request.options.find(candidate => candidate.optionId === input.optionId);
		if (!option) invalid("Permission option was not offered");
		if (input.comment !== undefined && !option.kind.startsWith("reject"))
			invalid("Comments are only allowed for rejecting options");
		const outcome: PermissionOutcome = { outcome: "selected", optionId: option.optionId, kind: option.kind };
		if (input.comment !== undefined) outcome.comment = input.comment;
		this.#finish(input.id, outcome);
		return { accepted: true };
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#enabled = false;
		this.#cancelAll();
	}

	cancelPending(): void {
		this.#cancelAll();
	}

	#finish(id: string, outcome: PermissionOutcome): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		pending.resolve(outcome);
	}

	#cancelAll(): void {
		for (const id of this.#pending.keys()) this.#finish(id, { outcome: "cancelled" });
	}
}
