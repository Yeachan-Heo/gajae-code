import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { AgentMessage } from "@gajae-code/agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderDispatch,
	SimpleStreamOptions,
	Tool,
} from "@gajae-code/ai/core";
import { toolWireSchema } from "@gajae-code/ai/core";
import { convertAnthropicMessages } from "@gajae-code/ai/providers/anthropic";

/** Upper bound for one (decompressed) request body the ledger will parse. */
export const BTW_PREFIX_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Anthropic looks back at most 20 content positions from a cache breakpoint; the final user turn takes one. */
export const BTW_PREFIX_MAX_APPENDED_BLOCKS = 19;
/** Headroom (tokens) kept below the context window on top of the conservative estimate. */
export const BTW_PREFIX_BUDGET_MARGIN_TOKENS = 2048;

/**
 * Dispatch safety margin: the server cache may expire while the request body is still uploading.
 * Subtracted from the TTL; this does not claim a cache hit (server eviction/TTL is unverified).
 */
export const BTW_PREFIX_TTL_SAFETY_MARGIN_MS = 30_000;

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const CANONICAL_URL_PREFIX = "https://api.anthropic.com/v1/messages";
const NO_RESULT_TEXT = "No result provided";

/** Headers that vary per attempt/transport and never decide cache identity. */
const VOLATILE_HEADERS: ReadonlySet<string> = new Set([
	"content-length",
	"content-encoding",
	"content-type",
	"accept",
	"accept-encoding",
	"connection",
	"host",
	"transfer-encoding",
	"idempotency-key",
	"request-id",
	"x-request-id",
	"x-client-request-id",
	"x-stainless-retry-count",
	"x-stainless-timeout",
]);

/** Fixed rejection codes; no code ever embeds request data. */
export type BtwPrefixRejection =
	| "unsupported_dispatch"
	| "unsupported_body"
	| "server_tool"
	| "route_mismatch"
	| "ttl_expired"
	| "root_mismatch"
	| "prefix_mismatch"
	| "suffix_shape"
	| "lookback_exceeded"
	| "budget_exceeded";

export interface BtwPrefixCandidate {
	/** Independent copy: main llmContext plus the final complete assistant answer. The caller appends BTW turns. */
	context: Context;
	/** Allowlisted replay options; contains no credential, hook, signal, client, or header. */
	options: SimpleStreamOptions;
	/** Throws a fixed-reason error before any network send when the actual request is not a safe prefix extension. */
	validateDispatch: (dispatch: ProviderDispatch) => void;
	wasDispatchRejected: () => boolean;
	rejectionReason: () => string | undefined;
}

export interface BtwMainObservation {
	onProviderDispatch: (dispatch: ProviderDispatch) => void;
	complete: (message: AssistantMessage) => void;
	failed: () => void;
}

export interface BtwPrefixLedgerOptions {
	/** Monotonic millisecond clock. */
	now?: () => number;
	/** Wall-clock millisecond clock (epoch); covers system suspend where the monotonic clock may pause. */
	wallNow?: () => number;
}

class PrefixRejection extends Error {
	constructor(readonly code: BtwPrefixRejection) {
		super(`BTW prefix dispatch rejected: ${code}`);
		this.name = "BtwPrefixRejection";
	}
}

interface ParsedDispatch {
	urlMac: Buffer;
	headerMac: Buffer;
	body: Record<string, unknown>;
	rootKeys: string[];
	messages: Record<string, unknown>[];
	ttlMs: number;
	maxTokens: number;
}

/** Route/auth identity and an independent, not yet decoded body copy; holds no URL/header plaintext. */
interface InspectedDispatch {
	urlMac: Buffer;
	headerMac: Buffer;
	raw: string | Uint8Array;
	gzip: boolean;
}

interface PendingMain extends InspectedDispatch {
	dispatchedAt: number;
	dispatchedWall: number;
}

interface MainRequest {
	urlMac: Buffer;
	headerMac: Buffer;
	rootKeys: string[];
	ttlMs: number;
	maxTokens: number;
	lastRole: unknown;
	hasThinking: boolean;
	rootFields: Map<string, string>;
	messageJson: string[];
	/** Clocks sampled once at the main dispatch; never refreshed by completion. */
	dispatchedAt: number;
	dispatchedWall: number;
}

interface CapturedMain {
	context: Context;
	options: SimpleStreamOptions;
	model: Pick<Model<Api>, "api" | "provider" | "id" | "baseUrl" | "contextWindow">;
}

interface Snapshot extends CapturedMain {
	request: MainRequest;
	message: AssistantMessage;
	messageDigest: string;
	mainInputTokens: number;
	historyDigest?: string[];
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Independent copy of the main context. Tools are reduced to what the Anthropic serializer sends
 * (name/description/strict + a JSON wire schema): native tools carry Zod schemas and executor functions that
 * cannot be structuredCloned, and executors must never reach a side-chat scope.
 */
function cloneMainContext(context: Context): Context {
	const cloned: Context = { messages: structuredClone(context.messages) };
	if (context.systemPrompt !== undefined) cloned.systemPrompt = structuredClone(context.systemPrompt);
	if (context.tools !== undefined) {
		cloned.tools = context.tools.map(tool => {
			const wire: Record<string, unknown> = {
				name: tool.name,
				description: tool.description,
				parameters: structuredClone(toolWireSchema(tool)),
			};
			if (tool.strict !== undefined) wire.strict = tool.strict;
			return wire as unknown as Tool;
		});
	}
	return cloned;
}

/** Cheap early gate: first-party canonical Anthropic base URL, API-key auth, no caller-owned transport. */
function eligibleForPrefix(model: Model<Api>, options: SimpleStreamOptions): boolean {
	if (model.api !== "anthropic-messages") return false;
	const flags = options as { fetch?: unknown; client?: unknown; isOAuth?: unknown; authCredentialType?: unknown };
	// A caller-owned fetch/client may transform or replace the request, so the dispatch hook is not the last hop.
	if (flags.fetch !== undefined || flags.client !== undefined) return false;
	if (flags.authCredentialType === "oauth" || flags.isOAuth === true) return false;
	try {
		const base = new URL(model.baseUrl);
		return (
			base.protocol === "https:" &&
			base.hostname === "api.anthropic.com" &&
			base.port === "" &&
			base.username === "" &&
			base.password === ""
		);
	} catch {
		return false;
	}
}

/** Completion facts that must hold before the request body is decoded and parsed. */
function completionEligible(message: AssistantMessage, captured: CapturedMain): boolean {
	if (message.stopReason !== "stop" || message.api !== "anthropic-messages") return false;
	if (message.provider !== captured.model.provider || message.model !== captured.model.id) return false;
	if (message.content.some(block => block.type === "toolCall")) return false;
	const usage = message.usage;
	if (!(usage.cacheRead + usage.cacheWrite > 0)) return false;
	return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, captured.model.contextWindow].every(
		validCount,
	);
}

function validCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with recursively sorted object keys, for order-insensitive digests. Throws on cycles. */
function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, v) => {
		if (isRecord(v)) {
			const sorted: Record<string, unknown> = {};
			for (const key of Object.keys(v).sort()) sorted[key] = v[key];
			return sorted;
		}
		return v;
	});
}

/** Semantic digest: assistant messages ignore cost/latency/telemetry fields that legitimately change later. */
function digestMessage(message: AgentMessage): string {
	if ((message as { role?: string }).role === "assistant") {
		const m = message as AssistantMessage;
		return sha256(
			stableStringify({
				role: m.role,
				api: m.api,
				provider: m.provider,
				model: m.model,
				timestamp: m.timestamp,
				stopReason: m.stopReason,
				content: m.content,
				providerPayload: m.providerPayload,
				responseId: m.responseId,
				serviceTier: m.serviceTier,
				errorMessage: m.errorMessage,
			}),
		);
	}
	return sha256(stableStringify(message));
}

function digestHistory(messages: readonly AgentMessage[]): string[] {
	return messages.map(digestMessage);
}

function sameDigests(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((digest, index) => digest === b[index]);
}

/**
 * Conservative family/version predicate for models that keep prior thinking blocks in the cached prefix.
 * Opus >= 4.5, Sonnet >= 4.6, Haiku >= 5.5 only; anything unparseable is treated as not preserving.
 */
function modelPreservesThinking(modelId: string): boolean {
	const match = /claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d{1,2})(?!\d))?/i.exec(modelId);
	if (!match) return false;
	const family = (match[1] ?? "").toLowerCase();
	const major = Number(match[2]);
	const minor = match[3] === undefined ? 0 : Number(match[3]);
	const [minMajor, minMinor] = family === "opus" ? [4, 5] : family === "sonnet" ? [4, 6] : [5, 5];
	return major > minMajor || (major === minMajor && minor >= minMinor);
}

function hasThinkingBlock(messages: readonly unknown[]): boolean {
	for (const message of messages) {
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (
				isRecord(block) &&
				(block.type === "thinking" || block.type === "redacted_thinking" || block.type === "redactedThinking")
			)
				return true;
		}
	}
	return false;
}

const SERVER_BLOCK_TYPE = /^(server_tool_use|mcp_.+|.+_tool_result|container_upload)$/;
const FORBIDDEN_ROOT_KEYS = ["mcp_servers", "container"];

function ttlOf(control: unknown): number {
	if (!isRecord(control) || control.type !== "ephemeral") throw new PrefixRejection("unsupported_body");
	for (const key of Object.keys(control)) {
		if (key !== "type" && key !== "ttl") throw new PrefixRejection("unsupported_body");
	}
	if (control.ttl === undefined || control.ttl === "5m") return FIVE_MINUTES_MS;
	if (control.ttl === "1h") return ONE_HOUR_MS;
	throw new PrefixRejection("unsupported_body");
}

/** Only client-executed custom function tools: anything the server could run on its own is refused. */
function assertClientToolsOnly(body: Record<string, unknown>): void {
	for (const key of FORBIDDEN_ROOT_KEYS) {
		if (key in body) throw new PrefixRejection("server_tool");
	}
	if (body.tools === undefined) return;
	if (!Array.isArray(body.tools)) throw new PrefixRejection("unsupported_body");
	for (const tool of body.tools) {
		if (!isRecord(tool)) throw new PrefixRejection("unsupported_body");
		if (tool.type !== undefined && tool.type !== "custom") throw new PrefixRejection("server_tool");
		if (!isRecord(tool.input_schema)) throw new PrefixRejection("server_tool");
	}
}

function assertNoServerBlocks(messages: readonly Record<string, unknown>[]): void {
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (isRecord(block) && typeof block.type === "string" && SERVER_BLOCK_TYPE.test(block.type)) {
				// "tool_result" has no "_tool_result" suffix match (the regex needs a prefix), so it passes.
				throw new PrefixRejection("server_tool");
			}
		}
	}
}

/** Cheap checks only: encoding whitelist, size cap and an independent body copy. No decompression or parsing. */
function inspectBody(dispatch: ProviderDispatch): { raw: string | Uint8Array; gzip: boolean } {
	const body = dispatch.body;
	if (body === undefined) throw new PrefixRejection("unsupported_body");
	const encoding = dispatch.headers.get("content-encoding")?.trim().toLowerCase();
	if (encoding === "gzip") {
		if (typeof body === "string" || body.byteLength > BTW_PREFIX_MAX_BODY_BYTES) {
			throw new PrefixRejection("unsupported_body");
		}
		return { raw: body.slice(), gzip: true };
	}
	if (encoding === undefined || encoding === "" || encoding === "identity") {
		const size = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
		if (size > BTW_PREFIX_MAX_BODY_BYTES) throw new PrefixRejection("unsupported_body");
		return { raw: typeof body === "string" ? body : body.slice(), gzip: false };
	}
	throw new PrefixRejection("unsupported_body");
}

function decodeBody(inspected: Pick<InspectedDispatch, "raw" | "gzip">): string {
	const { raw, gzip } = inspected;
	let bytes: Uint8Array;
	if (gzip) {
		try {
			bytes = gunzipSync(raw as Uint8Array, { maxOutputLength: BTW_PREFIX_MAX_BODY_BYTES });
		} catch {
			throw new PrefixRejection("unsupported_body");
		}
	} else {
		bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
	}
	if (bytes.byteLength > BTW_PREFIX_MAX_BODY_BYTES) throw new PrefixRejection("unsupported_body");
	try {
		return utf8Decoder.decode(bytes);
	} catch {
		throw new PrefixRejection("unsupported_body");
	}
}

/** Route/auth gate plus HMAC identities. Never retains URL or header plaintext. */
function inspectDispatch(dispatch: ProviderDispatch, key: Buffer): InspectedDispatch {
	if (dispatch.api !== "anthropic-messages" || dispatch.method.toUpperCase() !== "POST") {
		throw new PrefixRejection("unsupported_dispatch");
	}
	let url: URL;
	try {
		url = new URL(dispatch.url);
	} catch {
		throw new PrefixRejection("unsupported_dispatch");
	}
	const canonical =
		url.protocol === "https:" &&
		url.hostname === "api.anthropic.com" &&
		url.port === "" &&
		url.username === "" &&
		url.password === "" &&
		url.pathname === "/v1/messages" &&
		url.hash === "" &&
		dispatch.url.startsWith(CANONICAL_URL_PREFIX);
	if (!canonical) throw new PrefixRejection("unsupported_dispatch");

	// API-key auth only: x-api-key present, no bearer/OAuth credential.
	if (!dispatch.headers.get("x-api-key") || dispatch.headers.has("authorization")) {
		throw new PrefixRejection("unsupported_dispatch");
	}
	const headerLines: string[] = [];
	for (const [name, value] of dispatch.headers) {
		const lower = name.toLowerCase();
		if (VOLATILE_HEADERS.has(lower)) continue;
		headerLines.push(`${lower}:${value}`);
	}
	headerLines.sort();
	const urlMac = createHmac("sha256", key).update("url\0").update(dispatch.url).digest();
	const headerMac = createHmac("sha256", key).update("headers\0").update(headerLines.join("\n")).digest();
	return { urlMac, headerMac, ...inspectBody(dispatch) };
}

function parseBody(inspected: InspectedDispatch): ParsedDispatch {
	const text = decodeBody(inspected);
	let body: unknown;
	try {
		body = JSON.parse(text);
		// Canonical only: guarantees key order/values survive a re-serialization byte-for-byte.
		if (JSON.stringify(body) !== text) throw new Error("noncanonical");
	} catch {
		throw new PrefixRejection("unsupported_body");
	}
	if (!isRecord(body) || !Array.isArray(body.messages)) throw new PrefixRejection("unsupported_body");
	const messages = body.messages;
	if (messages.length === 0 || !messages.every(isRecord)) throw new PrefixRejection("unsupported_body");
	assertClientToolsOnly(body);
	assertNoServerBlocks(messages);
	if (body.cache_control === undefined) throw new PrefixRejection("unsupported_body");
	const ttlMs = ttlOf(body.cache_control);
	const maxTokens = body.max_tokens;
	if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
		throw new PrefixRejection("unsupported_body");
	}
	return {
		urlMac: inspected.urlMac,
		headerMac: inspected.headerMac,
		body,
		rootKeys: Object.keys(body),
		messages,
		ttlMs,
		maxTokens,
	};
}

function parseDispatch(dispatch: ProviderDispatch, key: Buffer): ParsedDispatch {
	return parseBody(inspectDispatch(dispatch, key));
}

/** Slim main record: only root strings, message JSON, last role and the thinking flag survive. */
function toMainRequest(parsed: ParsedDispatch, dispatchedAt: number, dispatchedWall: number): MainRequest {
	const rootFields = new Map<string, string>();
	for (const key of parsed.rootKeys) {
		if (key !== "messages") rootFields.set(key, JSON.stringify(parsed.body[key]));
	}
	return {
		urlMac: parsed.urlMac,
		headerMac: parsed.headerMac,
		rootKeys: parsed.rootKeys,
		ttlMs: parsed.ttlMs,
		maxTokens: parsed.maxTokens,
		lastRole: parsed.messages[parsed.messages.length - 1]?.role,
		hasThinking: hasThinkingBlock(parsed.messages),
		rootFields,
		messageJson: parsed.messages.map(m => JSON.stringify(m)),
		dispatchedAt,
		dispatchedWall,
	};
}

function macEqual(a: Buffer, b: Buffer): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}

function blockCount(message: Record<string, unknown>): number {
	return Array.isArray(message.content) ? message.content.length : 1;
}

function onlyTextBlocks(message: Record<string, unknown>): boolean {
	if (typeof message.content === "string") return true;
	return Array.isArray(message.content) && message.content.every(b => isRecord(b) && b.type === "text");
}

/** True when every assistant tool call has a real result and no result is orphaned or synthesized. */
function toolPairsComplete(messages: readonly Message[]): boolean {
	const pending = new Set<string>();
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size > 0) return false;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				// Duplicate ids (within or across turns) make pairing ambiguous.
				if (!block.id || seen.has(block.id)) return false;
				seen.add(block.id);
				pending.add(block.id);
			}
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) return false;
			const synthetic =
				message.isError && message.content.some(c => c.type === "text" && c.text.includes(NO_RESULT_TEXT));
			if (synthetic) return false;
		} else if (pending.size > 0) {
			return false;
		}
	}
	return pending.size === 0;
}

/**
 * Wire form of the final assistant answer exactly as the native Anthropic serializer would emit it
 * after `context`. Undefined when the serializer drops it or yields an unexpected shape (C refused).
 */
function expectedFinalWire(contextMessages: Message[], model: Model<Api>): string | undefined {
	try {
		const anthropicModel = model as Model<"anthropic-messages">;
		const withFinal = convertAnthropicMessages(structuredClone(contextMessages), anthropicModel, false);
		const base = convertAnthropicMessages(structuredClone(contextMessages.slice(0, -1)), anthropicModel, false);
		const tail = withFinal[withFinal.length - 1];
		const trimmed = tail?.role === "user" && tail.content === "Continue." ? withFinal.slice(0, -1) : withFinal;
		if (trimmed.length !== base.length + 1) return undefined;
		const finalWire = trimmed[trimmed.length - 1];
		if (finalWire?.role !== "assistant" || !Array.isArray(finalWire.content)) return undefined;
		// The serializer may drop or collapse blocks (adjacent thinking/redacted runs, empty or unsigned thinking).
		// A wire F that lost any block of the original answer is not "the same answer": refuse C instead of
		// treating the lossy form as expected.
		const original = contextMessages[contextMessages.length - 1];
		if (original?.role !== "assistant") return undefined;
		const countOf = (types: readonly string[], blocks: readonly { type: string }[]) =>
			blocks.filter(block => types.includes(block.type)).length;
		const wireBlocks = finalWire.content as { type: string }[];
		if (
			countOf(["thinking", "redactedThinking"], original.content) !==
				countOf(["thinking", "redacted_thinking"], wireBlocks) ||
			countOf(["text"], original.content) !== countOf(["text"], wireBlocks) ||
			original.content.length !== wireBlocks.length
		) {
			return undefined;
		}
		for (const block of original.content) {
			if (block.type === "thinking" && !block.thinkingSignature?.trim()) return undefined;
		}
		return JSON.stringify(finalWire);
	} catch {
		return undefined;
	}
}

const REPLAY_OPTION_KEYS = [
	"reasoning",
	"disableReasoning",
	"hideThinkingSummary",
	"thinkingBudgets",
	"maxTokens",
	"temperature",
	"topP",
	"topK",
	"stopSequences",
	"serviceTier",
	"metadata",
	"cacheRetention",
	"authCredentialType",
	"toolChoice",
] as const;

/** Allowlisted replay options only: never credentials, hooks, clients, signals, or arbitrary headers. */
function copyReplayOptions(options: SimpleStreamOptions): SimpleStreamOptions {
	const source = options as unknown as Record<string, unknown>;
	const copy: Record<string, unknown> = {};
	for (const key of REPLAY_OPTION_KEYS) {
		if (source[key] !== undefined) copy[key] = structuredClone(source[key]);
	}
	// Opaque immutable routing snapshot (no credentials); it cannot survive structuredClone.
	if (source.endpointConfiguration !== undefined) copy.endpointConfiguration = source.endpointConfiguration;
	return copy as SimpleStreamOptions;
}

export class BtwPrefixLedger {
	readonly #key = randomBytes(32);
	readonly #now: () => number;
	readonly #wallNow: () => number;
	#generation = 0;
	#releaseObserver: (() => void) | undefined;
	#snapshot: Snapshot | undefined;

	constructor(options: BtwPrefixLedgerOptions = {}) {
		this.#now = options.now ?? (() => performance.now());
		this.#wallNow = options.wallNow ?? (() => Date.now());
	}

	/** True when the cache TTL has elapsed or the clocks are untrustworthy (fail closed). */
	#ttlExpired(main: MainRequest): boolean {
		const mono = this.#now() - main.dispatchedAt;
		const wall = this.#wallNow() - main.dispatchedWall;
		if (!Number.isFinite(mono) || !Number.isFinite(wall) || mono < 0 || wall < 0) return true;
		return Math.max(mono, wall) + BTW_PREFIX_TTL_SAFETY_MARGIN_MS >= main.ttlMs;
	}

	beginMain(model: Model<Api>, context: Context, options: SimpleStreamOptions): BtwMainObservation | undefined {
		this.#releaseObserver?.();
		this.#releaseObserver = undefined;
		this.#generation += 1;
		this.#snapshot = undefined;
		if (!eligibleForPrefix(model, options)) return undefined;
		const generation = this.#generation;
		let pending: PendingMain | undefined;
		let captured: CapturedMain | undefined;
		let settled = false;
		try {
			// Context and JSON wire tools must be frozen now; later the history can move on.
			captured = {
				context: cloneMainContext(context),
				options: copyReplayOptions(options),
				model: {
					api: model.api,
					provider: model.provider,
					id: model.id,
					baseUrl: model.baseUrl,
					contextWindow: model.contextWindow,
				},
			};
		} catch {
			captured = undefined;
		}
		// Drop every captured/raw reference once the observation can no longer produce a snapshot.
		const release = () => {
			settled = true;
			pending = undefined;
			captured = undefined;
		};
		this.#releaseObserver = release;
		return {
			onProviderDispatch: dispatch => {
				try {
					if (settled || !captured) return;
					const at = this.#now();
					const wall = this.#wallNow();
					if (!Number.isFinite(at) || !Number.isFinite(wall)) throw new Error("clock");
					pending = { ...inspectDispatch(dispatch, this.#key), dispatchedAt: at, dispatchedWall: wall };
				} catch {
					pending = undefined;
				}
			},
			complete: message => {
				try {
					if (settled || generation !== this.#generation || !captured || !pending) return;
					const ctx = captured;
					const inspected = pending;
					release();
					if (this.#releaseObserver === release) this.#releaseObserver = undefined;
					// Parse the (possibly large) body only for a completion that can become a snapshot.
					if (!completionEligible(message, ctx)) return;
					const request = toMainRequest(parseBody(inspected), inspected.dispatchedAt, inspected.dispatchedWall);
					this.#snapshot = this.#buildSnapshot(message, request, ctx);
				} catch {
					if (generation === this.#generation) this.#snapshot = undefined;
				}
			},
			failed: () => {
				release();
				if (this.#releaseObserver === release) this.#releaseObserver = undefined;
				if (generation === this.#generation) this.#snapshot = undefined;
			},
		};
	}

	#buildSnapshot(message: AssistantMessage, request: MainRequest, captured: CapturedMain): Snapshot | undefined {
		const usage = message.usage;
		if (request.lastRole !== "user") return undefined;
		if (!toolPairsComplete([...captured.context.messages, message])) return undefined;
		return {
			...captured,
			request,
			message: structuredClone(message),
			messageDigest: digestMessage(message),
			// Usage buckets are disjoint (input = uncached), so the sum has no double counting.
			mainInputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
		};
	}

	bindHistory(messages: readonly AgentMessage[]): void {
		const snapshot = this.#snapshot;
		if (!snapshot) return;
		try {
			const last = messages[messages.length - 1];
			if (
				!last ||
				(last as { role?: string }).role !== "assistant" ||
				digestMessage(last) !== snapshot.messageDigest
			) {
				this.#snapshot = undefined;
				return;
			}
			snapshot.historyDigest = digestHistory(messages);
		} catch {
			this.#snapshot = undefined;
		}
	}

	getCandidate(model: Model<Api>, messages: readonly AgentMessage[]): BtwPrefixCandidate | undefined {
		const snapshot = this.#snapshot;
		if (!snapshot?.historyDigest) return undefined;
		try {
			const m = snapshot.model;
			if (
				model.api !== m.api ||
				model.provider !== m.provider ||
				model.id !== m.id ||
				model.baseUrl !== m.baseUrl ||
				model.contextWindow !== m.contextWindow
			) {
				return undefined;
			}
			if (!sameDigests(digestHistory(messages), snapshot.historyDigest)) return undefined;
			if (this.#ttlExpired(snapshot.request)) return undefined;
			const context = structuredClone(snapshot.context);
			context.messages = [...context.messages, structuredClone(snapshot.message)];
			const thinking = hasThinkingBlock(context.messages) || snapshot.request.hasThinking;
			if (thinking && !modelPreservesThinking(model.id)) return undefined;
			const expectedFinal = expectedFinalWire(context.messages, model);
			if (expectedFinal === undefined) return undefined;
			const floor = snapshot.mainInputTokens + snapshot.request.maxTokens + BTW_PREFIX_BUDGET_MARGIN_TOKENS;
			if (floor > m.contextWindow) return undefined;
			return this.#candidate(snapshot, context, expectedFinal);
		} catch {
			return undefined;
		}
	}

	#candidate(snapshot: Snapshot, context: Context, expectedFinal: string): BtwPrefixCandidate {
		let rejection: BtwPrefixRejection | undefined;
		return {
			context,
			options: copyReplayOptions(snapshot.options),
			validateDispatch: dispatch => {
				try {
					this.#validate(snapshot, dispatch, expectedFinal);
				} catch (error) {
					rejection = error instanceof PrefixRejection ? error.code : "unsupported_dispatch";
					throw new PrefixRejection(rejection);
				}
			},
			wasDispatchRejected: () => rejection !== undefined,
			rejectionReason: () => rejection,
		};
	}

	#validate(snapshot: Snapshot, dispatch: ProviderDispatch, expectedFinal: string): void {
		if (this.#snapshot !== snapshot) throw new PrefixRejection("prefix_mismatch");
		const main = snapshot.request;
		const side = parseDispatch(dispatch, this.#key);
		if (!macEqual(side.urlMac, main.urlMac) || !macEqual(side.headerMac, main.headerMac)) {
			throw new PrefixRejection("route_mismatch");
		}
		// TTL starts at the main dispatch, not at response completion.
		if (this.#ttlExpired(main)) throw new PrefixRejection("ttl_expired");

		if (side.rootKeys.length !== main.rootKeys.length) throw new PrefixRejection("root_mismatch");
		for (let i = 0; i < side.rootKeys.length; i += 1) {
			const key = side.rootKeys[i] as string;
			if (key !== main.rootKeys[i]) throw new PrefixRejection("root_mismatch");
			if (key !== "messages" && JSON.stringify(side.body[key]) !== main.rootFields.get(key)) {
				throw new PrefixRejection("root_mismatch");
			}
		}

		const mainCount = main.messageJson.length;
		if (side.messages.length < mainCount + 2) throw new PrefixRejection("suffix_shape");
		for (let i = 0; i < mainCount; i += 1) {
			if (JSON.stringify(side.messages[i]) !== main.messageJson[i]) throw new PrefixRejection("prefix_mismatch");
		}
		const suffix = side.messages.slice(mainCount);
		const first = suffix[0] as Record<string, unknown>;
		const last = suffix[suffix.length - 1] as Record<string, unknown>;
		// Whole final answer F (text, signed thinking, redacted thinking) must equal the native serializer output.
		if (first.role !== "assistant" || JSON.stringify(first) !== expectedFinal || last.role !== "user") {
			throw new PrefixRejection("suffix_shape");
		}
		for (const message of suffix.slice(1)) {
			if ((message.role !== "user" && message.role !== "assistant") || !onlyTextBlocks(message)) {
				throw new PrefixRejection("suffix_shape");
			}
		}
		if (hasThinkingBlock(side.messages) && !modelPreservesThinking(snapshot.model.id)) {
			throw new PrefixRejection("suffix_shape");
		}
		const blocks = suffix.reduce((total, message) => total + blockCount(message), 0);
		if (blocks > BTW_PREFIX_MAX_APPENDED_BLOCKS) throw new PrefixRejection("lookback_exceeded");

		// Upper bound: one token per UTF-8 byte of the appended JSON, plus main input, output cap and margin.
		// F's thinking may be opaque/summarized, so its real token cost can exceed its wire bytes: take the larger.
		const finalBytes = byteLength(JSON.stringify(first));
		const finalTokens = Math.max(finalBytes, snapshot.message.usage.output);
		const restBytes = suffix.slice(1).reduce((total, message) => total + byteLength(JSON.stringify(message)), 0);
		const estimate =
			snapshot.mainInputTokens + finalTokens + restBytes + main.maxTokens + BTW_PREFIX_BUDGET_MARGIN_TOKENS;
		if (
			!Number.isFinite(estimate) ||
			!validCount(snapshot.model.contextWindow) ||
			estimate > snapshot.model.contextWindow
		) {
			throw new PrefixRejection("budget_exceeded");
		}
	}

	clear(): void {
		this.#releaseObserver?.();
		this.#releaseObserver = undefined;
		this.#generation += 1;
		this.#snapshot = undefined;
	}
}
