import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import {
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AuthMethod,
	type ClientCapabilities,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type DeleteSessionRequest,
	type DeleteSessionResponse,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionInfo,
	type SessionNotification,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { getAgentDir } from "@gajae-code/utils";
import packageJson from "../../../package.json" with { type: "json" };
import {
	type AcpProviderRegistration,
	type AcpReverseConnection,
	AcpSdkAdapter,
	AcpSdkAdapterError,
} from "../../sdk/acp";
import { ensureBroker } from "../../sdk/broker/ensure";
import { readSdkBrokerDiscovery, SdkClient } from "../../sdk/client";
import { mapAgentWireEventPayloadToAcpSessionUpdates } from "./acp-event-mapper";
import { resolveAcpPermissionMode } from "./permission-mode";
import type { AcpStartupOptions } from "./startup-options";
import { ACP_TERMINAL_AUTH_FLAG } from "./terminal-auth";

const ACP_DEFAULT_MODE_ID = "default";
const ACP_PLAN_MODE_ID = "plan";
const MODE_CONFIG_ID = "mode";
const MODEL_CONFIG_ID = "model";
const THINKING_CONFIG_ID = "thinking";
const SESSION_PAGE_SIZE = 50;
export const ACP_BOOTSTRAP_RACE_GUARD_MS = 50;
const MAX_ACP_REPLAY_PAGES = 10_000;

type JsonObject = Record<string, unknown>;
/**
 * ACP prompt completion is tied to a post-acknowledgement lifecycle boundary.
 * AgentSession events do not carry the command identity themselves, so the
 * host stamps command/turn identities into its replay ring and ACP also keeps
 * a per-endpoint ingress sequence. A frame observed before an acknowledgement
 * can never settle the waiter that acknowledgement creates.
 */
interface PromptWaiter {
	cancelRequested: boolean;
	acknowledged: boolean;
	activityObserved: boolean;
	/** The prompt was accepted while the host was already busy, so its next valid idle ends the steer. */
	steeringAtAcknowledgement: boolean;
	/** Highest inbound frame sequence already observed when the prompt was acknowledged. */
	boundary: number;
	correlation: PromptCorrelation;
	pendingTerminal?: PromptCorrelation;
	resolve: (response: PromptResponse) => void;
	reject: (error: Error) => void;
}

type PromptCorrelation = { commandId?: string; turnId?: string };

type BrokerConnection = {
	adapter: AcpSdkAdapter;
	client: SdkClient;
};
type PendingAttachment = { epoch: number; task: Promise<void> };
type ReverseGate = {
	sessionId: string;
	epoch: number;
	broker: BrokerIdentity;
	adapter: AcpSdkAdapter | undefined;
};

type SessionRecord = {
	cwd: string;
	canonicalCwd: string;
	broker: BrokerIdentity;
	adapter: AcpSdkAdapter;
	unsubscribe: () => void;
	reconnectUnsubscribe: () => void;
	/** Per-session frame work queue; callbacks never race prompt ownership. */
	frameTail: Promise<void>;
	/** Monotonic at WebSocket ingress, before queued work begins. */
	inboundSequence: number;
	/** Updated at ingress so a prompt acknowledgement can distinguish a steer from a fresh turn. */
	busy: boolean;
	activePrompt?: PromptWaiter;
};
type Endpoint = { url: string; token: string };

type BrokerSession = {
	sessionId: string;
	locator?: { repo?: string };
	canonicalCwd?: string;
	live?: boolean;
	endpointGeneration?: number;
	endpointIncarnation?: string;
	path?: string;
	sessionIdentity?: SavedSessionIdentity;
	workspaceIdentity?: WorkspaceIdentity;
};

/**
 * Descriptor-bound workspace identity for an opened directory: stringified
 * bigint `fstat` `{dev,ino}`. Additive broker evidence that binds a scope
 * without making its lexical path authoritative; lifecycle calls echo it so the
 * broker can rebind the descriptor, but it never overrides canonical cwd scope.
 */
type WorkspaceIdentity = { dev: string; ino: string };
/**
 * Broker-issued transcript identity for a saved session. Mirrors the broker's
 * {@link SessionLifecycleTranscriptIdentity} so ACP can revalidate that the
 * durable transcript under a session id has not been recreated.
 */
type SavedSessionIdentity = {
	dev: string;
	ino: string;
	size: number;
	mtimeMs: number;
	mtimeNs: string;
	sha256: string;
};
type LiveSessionAuthority = {
	endpointGeneration: number;
	endpointIncarnation: string;
};
type SavedSessionAuthority = { path: string; identity: SavedSessionIdentity };
/**
 * Broker boot identity exposed by discovery and every `session.list` result. The
 * random ownerId is the authority discriminator; package generation and start
 * time are diagnostic metadata and cannot extend authority across owner changes.
 */
type BrokerIdentity = {
	ownerId: string;
	packageGeneration: string;
	startedAt: number;
};

/**
 * Connection authority is broker-issued, not lexical. Each scoped observation
 * binds a session to its canonical cwd plus whatever live/saved authority the
 * broker exposes; lifecycle mutations revalidate this record before issuing.
 */
type SessionAuthority = {
	canonicalCwd: string;
	live?: LiveSessionAuthority;
	broker: BrokerIdentity;
	saved?: SavedSessionAuthority;
	workspaceIdentity?: WorkspaceIdentity;
	workspaceGrantId?: string;
};

function parseAcpStartupOptions(value: unknown): AcpStartupOptions | undefined {
	const candidate = object(value);
	if (!candidate) return undefined;
	const modelId = typeof candidate.modelId === "string" ? candidate.modelId : undefined;
	const modelPreset = typeof candidate.modelPreset === "string" ? candidate.modelPreset : undefined;
	const thinkingLevel = typeof candidate.thinkingLevel === "string" ? candidate.thinkingLevel : undefined;
	return modelId || modelPreset || thinkingLevel
		? {
				...(modelId ? { modelId } : {}),
				...(modelPreset ? { modelPreset } : {}),
				...(thinkingLevel ? { thinkingLevel } : {}),
			}
		: undefined;
}

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function savedSessionIdentity(value: unknown): SavedSessionIdentity | undefined {
	const candidate = object(value);
	if (!candidate) return undefined;
	const { dev, ino, size, mtimeMs, mtimeNs, sha256 } = candidate;
	if (
		typeof dev !== "string" ||
		!/^\d+$/.test(dev) ||
		typeof ino !== "string" ||
		!/^\d+$/.test(ino) ||
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size < 0 ||
		typeof mtimeMs !== "number" ||
		!Number.isFinite(mtimeMs) ||
		mtimeMs < 0 ||
		typeof mtimeNs !== "string" ||
		!/^\d+$/.test(mtimeNs) ||
		typeof sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(sha256)
	)
		return undefined;
	return { dev, ino, size, mtimeMs, mtimeNs, sha256 };
}

/** Live endpoint authority exposed by the broker for indexed live sessions. */
function liveAuthority(value: unknown): LiveSessionAuthority | undefined {
	const candidate = object(value);
	const endpointGeneration = candidate?.endpointGeneration;
	const endpointIncarnation = candidate?.endpointIncarnation;
	if (
		typeof endpointGeneration !== "number" ||
		!Number.isSafeInteger(endpointGeneration) ||
		endpointGeneration <= 0 ||
		typeof endpointIncarnation !== "string" ||
		!/^[a-f0-9]{64}$/.test(endpointIncarnation)
	)
		return undefined;
	return { endpointGeneration, endpointIncarnation };
}

/** Saved transcript authority exposed by the broker when resolving a saved session. */
function savedAuthority(value: unknown): SavedSessionAuthority | undefined {
	const candidate = object(value);
	const sessionPath = candidate?.path;
	const identity = savedSessionIdentity(candidate?.sessionIdentity);
	if (typeof sessionPath !== "string" || !sessionPath || !identity) return undefined;
	return { path: sessionPath, identity };
}
/** Descriptor-bound workspace identity (stringified bigint fstat {dev,ino}) exposed alongside canonicalCwd. */
function workspaceIdentity(value: unknown): WorkspaceIdentity | undefined {
	const candidate = object(value);
	const dev = candidate?.dev;
	const ino = candidate?.ino;
	if (typeof dev !== "string" || !/^\d+$/.test(dev) || typeof ino !== "string" || !/^\d+$/.test(ino)) return undefined;
	return { dev, ino };
}
/** Broker-issued, boot-transient workspace grant id exposed alongside canonicalCwd. */
function workspaceGrantId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
/** Broker boot identity exposed by discovery and every session.list result. */
function brokerIdentity(value: unknown): BrokerIdentity | undefined {
	const candidate = object(value);
	if (!candidate) return undefined;
	const { ownerId, packageGeneration, startedAt } = candidate;
	if (
		typeof ownerId !== "string" ||
		!ownerId ||
		typeof packageGeneration !== "string" ||
		!packageGeneration ||
		typeof startedAt !== "number" ||
		!Number.isSafeInteger(startedAt) ||
		startedAt <= 0
	)
		return undefined;
	return { ownerId, packageGeneration, startedAt };
}

function sameBrokerIdentity(left: BrokerIdentity, right: BrokerIdentity): boolean {
	return left.ownerId === right.ownerId;
}

/**
 * Canonical scope of a broker observation. The broker exposes a per-session
 * canonicalCwd (realpath-resolved) so symlink aliases of one workspace do not
 * split into conflicting scopes; fall back to the lexical locator repo.
 */
function brokerSessionScope(session: unknown): string | undefined {
	const candidate = object(session);
	const canonical = typeof candidate?.canonicalCwd === "string" ? candidate.canonicalCwd : undefined;
	if (canonical) return path.resolve(canonical);
	const repo = object(candidate?.locator)?.repo;
	return typeof repo === "string" ? path.resolve(repo) : undefined;
}

function sameSavedIdentity(left: SavedSessionIdentity, right: SavedSessionIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.mtimeNs === right.mtimeNs &&
		left.sha256 === right.sha256
	);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

/** Deterministic digest binding the delete idempotency key to the exact transcript identity. */
function savedIdentityDigest(identity: SavedSessionIdentity): string {
	return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

function aggregateAcpFailure(code: string, message: string, failures: unknown[]): AcpSdkAdapterError {
	const aggregate = new AggregateError(failures, message);
	return Object.assign(new AcpSdkAdapterError(code, aggregate.message), {
		cause: aggregate,
		errors: aggregate.errors,
	});
}

/** Applies ACP's offset cursor after narrowing the broker listing to the requested cwd. */
export function paginateAcpSessions(listed: unknown[], cwd: string | undefined, offset: number): ListSessionsResponse {
	const filtered = listed
		.map(value => object(value) as BrokerSession | undefined)
		.filter(
			(value): value is BrokerSession & { locator: { repo: string } } =>
				typeof value?.sessionId === "string" && typeof value.locator?.repo === "string",
		)
		.filter(value => {
			if (!cwd) return true;
			// Prefer the broker-issued canonical scope so symlink aliases of one
			// workspace do not split the listing; fall back to the lexical locator.
			const canonical = typeof value.canonicalCwd === "string" ? value.canonicalCwd : undefined;
			if (canonical) return path.resolve(canonical) === path.resolve(cwd);
			return path.resolve(value.locator.repo) === path.resolve(cwd);
		});
	const sessions = filtered.slice(offset, offset + SESSION_PAGE_SIZE).map(
		value =>
			({
				sessionId: value.sessionId,
				cwd: value.locator.repo,
				title: value.sessionId,
			}) satisfies SessionInfo,
	);
	return {
		sessions,
		nextCursor: offset + sessions.length < filtered.length ? String(offset + sessions.length) : undefined,
	};
}

function endpoint(value: unknown): Endpoint {
	const candidate = object(value);
	const result = object(candidate?.result) ?? candidate;
	const nested = object(result?.endpoint) ?? result;
	if (typeof nested?.url !== "string" || typeof nested.token !== "string")
		throw new AcpSdkAdapterError("unavailable", "SDK lifecycle response omitted a session endpoint.");
	return { url: nested.url, token: nested.token };
}

function sessionId(value: unknown): string {
	const candidate = object(value);
	const result = object(candidate?.result) ?? candidate;
	if (typeof result?.sessionId !== "string" || !result.sessionId)
		throw new AcpSdkAdapterError("unavailable", "SDK lifecycle response omitted a session id.");
	return result.sessionId;
}

function pageItems(value: unknown): unknown[] {
	const response = object(value);
	const result = object(response?.result) ?? response;
	const page = object(result?.page);
	return Array.isArray(page?.items) ? page.items : [];
}

function correlationFrom(...values: unknown[]): PromptCorrelation {
	const correlation: PromptCorrelation = {};
	for (const value of values) {
		const candidate = object(value);
		for (const record of [candidate, object(candidate?.result)]) {
			if (!record) continue;
			if (!correlation.commandId) {
				const commandId = record.commandId ?? record.command_id;
				if (typeof commandId === "string" && commandId) correlation.commandId = commandId;
			}
			if (!correlation.turnId) {
				const turnId = record.turnId ?? record.turn_id;
				if (typeof turnId === "string" && turnId) correlation.turnId = turnId;
			}
		}
	}
	return correlation;
}

function correlationsConflict(expected: PromptCorrelation, actual: PromptCorrelation): boolean {
	return (
		(expected.commandId !== undefined && actual.commandId !== undefined && expected.commandId !== actual.commandId) ||
		(expected.turnId !== undefined && actual.turnId !== undefined && expected.turnId !== actual.turnId)
	);
}

function correlationsMatch(expected: PromptCorrelation, actual: PromptCorrelation): boolean {
	return (
		(expected.commandId !== undefined && expected.commandId === actual.commandId) ||
		(expected.turnId !== undefined && expected.turnId === actual.turnId)
	);
}

function isPromptActivity(eventType: string): boolean {
	return [
		"agent_start",
		"turn_start",
		"message_start",
		"message_update",
		"message_end",
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
	].includes(eventType);
}

export type TranscriptReplayBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * The production transcript query exposes durable `{ body, textSummary }`
 * entries, not an ACP-shaped `content` array. Historical session JSONL has no
 * recoverable image bytes, so replay exposes that boundary rather than
 * pretending images were restored.
 */
export interface TranscriptReplayContent {
	blocks: TranscriptReplayBlock[];
	images: {
		available: false;
		reason: "historical_transcript_images_unavailable";
	};
}

export function transcriptReplayContent(entry: unknown): TranscriptReplayContent {
	const record = object(entry);
	if (typeof record?.body !== "string")
		throw new AcpSdkAdapterError(
			"transcript_body_unavailable",
			"ACP cannot replay a transcript entry without its production body.",
		);
	return {
		blocks: record.body.length > 0 ? [{ type: "text", text: record.body }] : [],
		images: {
			available: false,
			reason: "historical_transcript_images_unavailable",
		},
	};
}

type ReceivedSdkEvent = {
	event: JsonObject;
	/** Event payload accepted by the ACP event mapper, when this is an agent-wire frame. */
	wirePayload?: JsonObject;
};

/**
 * Native session hosts emit `activity` directly; test-only/legacy adapters may
 * wrap agent-wire events in `{ type: "event", payload }`. Normalize both
 * without treating notification-specific frames as agent lifecycle truth.
 */
function receivedSdkEvent(frame: JsonObject): ReceivedSdkEvent | undefined {
	if (frame.type === "activity") {
		const type = frame.state === "busy" ? "agent_start" : frame.state === "idle" ? "agent_end" : undefined;
		return type ? { event: { type, ...correlationFrom(frame) } } : undefined;
	}
	if (frame.type !== "event") return undefined;
	const payload = object(frame.payload);
	if (!payload) return undefined;
	const replayPayload = object(payload.payload);
	const event = object(payload.event) ?? replayPayload ?? payload;
	if (typeof event.type !== "string") return undefined;
	return {
		event,
		...(object(payload.event) ? { wirePayload: payload } : {}),
	};
}

const ACP_CONFIG_OPTIONS = [
	{ id: MODEL_CONFIG_ID, name: "Model", options: [] },
	{ id: THINKING_CONFIG_ID, name: "Thinking", options: [] },
	{
		id: "steeringMode",
		name: "Steering queue",
		options: [
			{ value: "all", name: "All" },
			{ value: "one-at-a-time", name: "One at a time" },
		],
	},
	{
		id: "followUpMode",
		name: "Follow-up queue",
		options: [
			{ value: "all", name: "All" },
			{ value: "one-at-a-time", name: "One at a time" },
		],
	},
	{
		id: "interruptMode",
		name: "Interrupt mode",
		options: [
			{ value: "immediate", name: "Immediate" },
			{ value: "wait", name: "Wait" },
		],
	},
] as const;

const ACP_CONFIG_CONTROL_OPERATIONS: Record<string, string> = {
	steeringMode: "queue.steering_mode.set",
	followUpMode: "queue.follow_up_mode.set",
	interruptMode: "queue.interrupt_mode.set",
};

function configValues(query: unknown): Map<string, string> {
	const values = new Map<string, string>();
	for (const item of pageItems(query)) {
		const record = object(item);
		if (!record) continue;
		if (typeof record.id === "string" && typeof record.value === "string") {
			values.set(record.id, record.value);
			continue;
		}
		for (const [id, value] of Object.entries(record)) {
			if (typeof value === "string") values.set(id, value);
		}
	}
	return values;
}

function modelConfigOptions(query: unknown, current: string | undefined): { value: string; name: string }[] {
	const options = new Map<string, string>();
	for (const item of pageItems(query)) {
		const model = object(item);
		if (!model || typeof model.provider !== "string" || typeof model.id !== "string") continue;
		const value = `${model.provider}/${model.id}`;
		options.set(value, typeof model.name === "string" ? model.name : value);
	}
	if (current && !options.has(current)) options.set(current, current);
	return [...options].map(([value, name]) => ({ value, name }));
}

const THINKING_CONFIG_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => ({
	value,
	name: value,
}));

/** Maps live canonical SDK config and model queries into the ACP 1.2.1 session state surface. */
export function acpSessionStateFromConfig(query: unknown, modelsQuery?: unknown) {
	const values = configValues(query);
	const currentModeId = values.get(MODE_CONFIG_ID) === ACP_PLAN_MODE_ID ? ACP_PLAN_MODE_ID : ACP_DEFAULT_MODE_ID;
	return {
		configOptions: [
			{
				id: MODE_CONFIG_ID,
				name: "Mode",
				type: "select" as const,
				currentValue: currentModeId,
				options: [
					{ value: ACP_DEFAULT_MODE_ID, name: "Default" },
					{ value: ACP_PLAN_MODE_ID, name: "Plan" },
				],
			},
			...ACP_CONFIG_OPTIONS.flatMap(option => {
				const value = values.get(option.id);
				if (value === undefined) return [];
				const options =
					option.id === MODEL_CONFIG_ID
						? modelConfigOptions(modelsQuery, value)
						: option.id === THINKING_CONFIG_ID
							? THINKING_CONFIG_OPTIONS
							: [...option.options];
				return [{ ...option, type: "select" as const, currentValue: value, options }];
			}),
		],
		modes: {
			availableModes: [
				{ id: ACP_DEFAULT_MODE_ID, name: "Default" },
				{ id: ACP_PLAN_MODE_ID, name: "Plan" },
			],
			currentModeId,
		},
	};
}

/** Convert every ACP prompt block the agent advertises without silently discarding context. */
export function acpPromptPayload(blocks: PromptRequest["prompt"]): {
	text: string;
	images: Array<{ data: string; mimeType: string }>;
} {
	const text: string[] = [];
	const images: Array<{ data: string; mimeType: string }> = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				text.push(block.text);
				break;
			case "image":
				if (block.uri) text.push(`[Image URI: ${block.uri}]`);
				images.push({ data: block.data, mimeType: block.mimeType });
				break;
			case "resource_link":
				text.push(
					[
						`[Resource: ${block.name}]`,
						`URI: ${block.uri}`,
						...(block.title ? [`Title: ${block.title}`] : []),
						...(block.description ? [block.description] : []),
						...(block.mimeType ? [`MIME: ${block.mimeType}`] : []),
						...(typeof block.size === "number" ? [`Size: ${block.size}`] : []),
					].join("\n"),
				);
				break;
			case "resource": {
				const resource = block.resource;
				if ("text" in resource) {
					text.push(
						[
							`[Resource: ${resource.uri}]`,
							...(resource.mimeType ? [`MIME: ${resource.mimeType}`] : []),
							resource.text,
						].join("\n"),
					);
					break;
				}
				const mimeType = resource.mimeType ?? "application/octet-stream";
				if (!mimeType.startsWith("image/"))
					throw new AcpSdkAdapterError(
						"unsupported_content",
						`Unsupported embedded resource MIME type: ${mimeType}`,
					);
				text.push(`[Resource: ${resource.uri}]\nMIME: ${mimeType}`);
				images.push({ data: resource.blob, mimeType });
				break;
			}
			case "audio":
				throw new AcpSdkAdapterError("unsupported_content", "ACP audio prompts are not supported.");
			default:
				throw new AcpSdkAdapterError("unsupported_content", "Unsupported ACP prompt content.");
		}
	}
	if (text.length === 0 && images.length === 0)
		throw new AcpSdkAdapterError("invalid_input", "ACP prompt must contain at least one supported content block.");
	return { text: text.join("\n"), images };
}

/** Registers a permission provider only when the ACP client requires prompts. */
export function acpProviderRegistrations(
	capabilities: ClientCapabilities | undefined,
	env: NodeJS.ProcessEnv = process.env,
): AcpProviderRegistration[] {
	return [
		...(capabilities?.fs?.readTextFile || capabilities?.fs?.writeTextFile
			? [{ capability: "fs", definitions: [] }]
			: []),
		...(capabilities?.terminal ? [{ capability: "terminal", definitions: [] }] : []),
		...(resolveAcpPermissionMode(capabilities, env) === "prompt"
			? [{ capability: "permission", definitions: [] }]
			: []),
		{ capability: "ui", definitions: [] },
	];
}

/** Maps ACP permission handling to the session's canonical SDK policy. */
export async function applyAcpPermissionMode(
	adapter: Pick<AcpSdkAdapter, "control">,
	capabilities: ClientCapabilities | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const mode = resolveAcpPermissionMode(capabilities, env);
	await adapter.control("permission_mode.set", {
		mode: mode === "prompt" ? "prompt" : "allow",
	});
}

/** Applies CLI-provided ACP startup settings through SDK controls before session exposure. */
export async function applyAcpStartupOptions(
	adapter: Pick<AcpSdkAdapter, "setModel" | "control">,
	options: AcpStartupOptions | undefined,
): Promise<void> {
	if (options?.modelId) await adapter.setModel(options.modelId);
	if (options?.thinkingLevel) await adapter.control("thinking.set", { level: options.thinkingLevel });
}

/** ACP form elicitation uses the client-facing reverse surface without owning a session runtime. */
export function createAcpExtensionUiContext(
	connection: AgentSideConnection,
	getSessionId: () => string,
	capabilities: ClientCapabilities | undefined,
): {
	select: (
		message: string,
		options: string[],
		dialog?: { signal?: AbortSignal; timeout?: number; onTimeout?: () => void },
	) => Promise<string | undefined>;
	confirm: (
		message: string,
		detail?: string,
		dialog?: { signal?: AbortSignal; timeout?: number; onTimeout?: () => void },
	) => Promise<boolean>;
	input: (
		message: string,
		placeholder?: string,
		dialog?: { signal?: AbortSignal; timeout?: number; onTimeout?: () => void },
	) => Promise<string | undefined>;
} {
	const elicit = async (
		kind: "select" | "confirm" | "input",
		message: string,
		options: string[] | undefined,
		dialog: { signal?: AbortSignal; timeout?: number; onTimeout?: () => void } | undefined,
	): Promise<unknown> => {
		if (!capabilities?.elicitation?.form || dialog?.signal?.aborted) return undefined;
		const request = (
			connection as unknown as {
				unstable_createElicitation(input: JsonObject): Promise<JsonObject>;
			}
		).unstable_createElicitation({
			sessionId: getSessionId(),
			message,
			requestedSchema: {
				type: "object",
				properties: {
					value:
						kind === "confirm" ? { type: "boolean" } : { type: "string", ...(options ? { enum: options } : {}) },
				},
				required: ["value"],
			},
		});
		let timer: NodeJS.Timeout | undefined;
		const timeout =
			dialog?.timeout === undefined
				? undefined
				: new Promise<undefined>(resolve => {
						timer = setTimeout(() => {
							dialog.onTimeout?.();
							resolve(undefined);
						}, dialog.timeout);
					});
		try {
			const response = timeout ? await Promise.race([request, timeout]) : await request;
			return object(object(response)?.content)?.value;
		} catch {
			return undefined;
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	return {
		select: async (message, options, dialog) => {
			const value = await elicit("select", message, options, dialog);
			return typeof value === "string" && options.includes(value) ? value : undefined;
		},
		confirm: async (message, detail, dialog) =>
			(await elicit("confirm", detail ? `${message}\n\n${detail}` : message, undefined, dialog)) === true,
		input: async (message, placeholder, dialog) => {
			const value = await elicit("input", placeholder ? `${message}\n\n${placeholder}` : message, undefined, dialog);
			return typeof value === "string" ? value : undefined;
		},
	};
}

/**
 * ACP is a pure SDK client. Session processes are created and resumed by the
 * broker, while all per-session operations use that session's authenticated SDK
 * endpoint. This class deliberately imports neither AgentSession nor any local
 * runtime host component.
 */
export class AcpAgent implements Agent {
	readonly #connection: AgentSideConnection;
	readonly #agentDir: string;
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #attaching = new Map<string, PendingAttachment>();
	readonly #resolvingExisting = new Map<string, PendingAttachment>();
	readonly #sessionAuthority = new Map<string, SessionAuthority>();
	readonly #ambiguousSessionIds = new Set<string>();
	readonly #sessionEpochs = new Map<string, number>();
	readonly #tearingDown = new Map<string, number>();
	readonly #sessionTombstones = new Set<string>();
	#poisoned = false;
	#clientCapabilities: ClientCapabilities | undefined;
	#brokerIdentity: BrokerIdentity | undefined;
	#broker: Promise<BrokerConnection> | undefined;
	readonly #startupOptions: AcpStartupOptions | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(
		connection: AgentSideConnection,
		options?: { agentDir?: string; startupOptions?: AcpStartupOptions } | unknown,
	) {
		this.#connection = connection;
		const candidate = object(options);
		this.#agentDir = typeof candidate?.agentDir === "string" ? candidate.agentDir : getAgentDir();
		this.#startupOptions = parseAcpStartupOptions(candidate?.startupOptions);
		queueMicrotask(() => {
			if (connection.signal.aborted) {
				this.#beginDispose();
			} else {
				connection.signal.addEventListener("abort", () => this.#beginDispose(), { once: true });
			}
		});
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		this.#clientCapabilities = params.clientCapabilities;
		const authMethods: AuthMethod[] = [
			{
				id: "agent",
				name: "Use existing local credentials",
				description: "Authenticate via the provider keys/OAuth state already configured under ~/.gjc.",
			},
		];
		if (params.clientCapabilities?.auth?.terminal === true) {
			authMethods.push({
				type: "terminal",
				id: "terminal",
				name: "Set up Gajae Code in terminal",
				description: "Launch the gjc TUI to add provider keys and select models.",
				args: [ACP_TERMINAL_AUTH_FLAG],
			});
		}
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: {
				name: "gajae-code",
				title: "Gajae Code",
				version: packageJson.version,
			},
			authMethods,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { embeddedContext: true, image: true },
				sessionCapabilities: {
					list: {},
					fork: {},
					resume: {},
					close: {},
					delete: {},
				},
			},
		};
	}

	async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
		const methods = this.#clientCapabilities?.auth?.terminal ? ["agent", "terminal"] : ["agent"];
		if (!methods.includes(params.methodId)) throw new Error(`Unknown ACP auth method: ${params.methodId}`);
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		this.#assertNoMcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		this.#assertConnectionNotPoisoned();
		const workspace = await this.#workspaceAuthority(params.cwd);
		const result = await (await this.#brokerAdapter()).global(
			"session.create",
			{
				cwd: params.cwd,
				target: { path: params.cwd },
				brokerOwnerId: this.#requireBrokerIdentity().ownerId,
				workspaceIdentity: workspace.identity,
				workspaceGrantId: workspace.grantId,
				...(this.#startupOptions?.modelPreset ? { modelPreset: this.#startupOptions.modelPreset } : {}),
			},
			randomUUID(),
		);
		const id = sessionId(result);
		try {
			await this.#scopedBrokerSession(id, params.cwd);
			await this.#attach(id, params.cwd, endpoint(result));
			await applyAcpStartupOptions(this.#adapter(id), this.#startupOptions);
			this.#scheduleBootstrap(id);
			return { sessionId: id, ...(await this.#sessionState(id)) };
		} catch (error) {
			if (!this.#ambiguousSessionIds.has(id)) await this.#discardNewSession(id);
			throw error;
		}
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		this.#assertNoMcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		await this.#attachExisting(params.sessionId, params.cwd);
		await this.#replaySession(params.sessionId);
		this.#scheduleBootstrap(params.sessionId);
		return await this.#sessionState(params.sessionId);
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		this.#assertNoMcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		await this.#attachExisting(params.sessionId, params.cwd);
		this.#scheduleBootstrap(params.sessionId);
		return await this.#sessionState(params.sessionId);
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		this.#assertNoMcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		this.#assertConnectionNotPoisoned();
		const source = await this.#resolveSavedSession(params.sessionId, params.cwd);
		const sourceAuthority = this.#sessionAuthority.get(params.sessionId);
		const result = await (await this.#brokerAdapter()).global(
			"session.fork",
			{
				cwd: params.cwd,
				sourceSessionId: params.sessionId,
				sourceSessionPath: source.path,
				sourceSessionIdentity: source.identity,
				brokerOwnerId: this.#sessionBrokerOwnerId(params.sessionId),
				target: { path: params.cwd },
				...(sourceAuthority?.workspaceIdentity ? { workspaceIdentity: sourceAuthority.workspaceIdentity } : {}),
				...(sourceAuthority?.workspaceGrantId ? { workspaceGrantId: sourceAuthority.workspaceGrantId } : {}),
			},
			randomUUID(),
		);
		const id = sessionId(result);
		try {
			await this.#scopedBrokerSession(id, params.cwd);
			await this.#attach(id, params.cwd, endpoint(result));
			this.#scheduleBootstrap(id);
			return { sessionId: id, ...(await this.#sessionState(id)) };
		} catch (error) {
			if (!this.#ambiguousSessionIds.has(id)) await this.#discardNewSession(id);
			throw error;
		}
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		if (params.cwd) this.#assertAbsoluteCwd(params.cwd);
		this.#assertConnectionNotPoisoned();
		const offset = this.#cursor(params.cursor);
		const adapter = await this.#brokerAdapter();
		const brokerOwnerId = this.#requireBrokerIdentity().ownerId;
		const response = object(
			await adapter.global("session.list", params.cwd ? { cwd: params.cwd, brokerOwnerId } : { brokerOwnerId }),
		);
		const listing = object(response?.result) ?? response;
		this.#observeBrokerIdentity(listing);
		const listed = Array.isArray(listing?.sessions) ? listing.sessions : [];
		const observations =
			Array.isArray(listing?.observations) && listing.observations.length > 0 ? listing.observations : listed;
		const canonicalCwd =
			params.cwd && typeof listing?.canonicalCwd === "string"
				? path.resolve(listing.canonicalCwd)
				: params.cwd
					? path.resolve(params.cwd)
					: undefined;
		const scopeWorkspace = workspaceIdentity(listing?.workspaceIdentity);
		const scopeGrantId = workspaceGrantId(listing?.workspaceGrantId);
		const observed = new Map<string, { count: number; scopes: Set<string> }>();
		for (const value of observations) {
			const candidate = object(value) as BrokerSession | undefined;
			if (typeof candidate?.sessionId !== "string") continue;
			const scope = brokerSessionScope(candidate);
			if (!scope) continue;
			const entry = observed.get(candidate.sessionId) ?? {
				count: 0,
				scopes: new Set<string>(),
			};
			entry.count++;
			entry.scopes.add(scope);
			observed.set(candidate.sessionId, entry);
		}
		const conflictingIds = new Set<string>();
		for (const [id, entry] of observed) {
			const known = this.#sessionAuthority.get(id)?.canonicalCwd;
			const conflictsWithKnown =
				known !== undefined && (entry.scopes.size !== 1 || !entry.scopes.has(path.resolve(known)));
			if (entry.count <= 1 && entry.scopes.size <= 1 && !conflictsWithKnown) continue;
			this.#markSessionAmbiguous(id);
			conflictingIds.add(id);
		}
		if (canonicalCwd) {
			// All-or-nothing: stage every in-scope binding against an immutable clone
			// and commit only after the whole batch validates. Any authority failure
			// permanently poisons the connection so no partial authority is published.
			const staging = new Map(this.#sessionAuthority);
			const order: string[] = [];
			for (const value of listed) {
				const candidate = object(value) as BrokerSession | undefined;
				if (typeof candidate?.sessionId !== "string") continue;
				if (brokerSessionScope(candidate) !== canonicalCwd) continue;
				if (conflictingIds.has(candidate.sessionId)) {
					this.#poisonConnection();
					throw new AcpSdkAdapterError("conflict", `Broker returned duplicate session id: ${candidate.sessionId}`);
				}
				try {
					staging.set(
						candidate.sessionId,
						this.#stageSessionAuthority(
							staging,
							candidate.sessionId,
							canonicalCwd,
							candidate,
							scopeWorkspace,
							scopeGrantId,
						),
					);
					order.push(candidate.sessionId);
				} catch (error) {
					this.#poisonConnection();
					throw error;
				}
			}
			for (const id of order) this.#sessionAuthority.set(id, staging.get(id)!);
		}
		return paginateAcpSessions(listed, canonicalCwd ?? params.cwd ?? undefined, offset);
	}

	async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		this.#assertSessionNotAmbiguous(params.sessionId);
		const authority = this.#sessionAuthority.get(params.sessionId);
		if (!authority) return {};
		const live = authority.live;
		if (!live) {
			this.#beginTeardown(params.sessionId);
			try {
				await this.#detachAndCloseAdapter(params.sessionId, "closed");
			} finally {
				this.#finishTeardown(params.sessionId);
			}
			this.#sessionAuthority.delete(params.sessionId);
			this.#tombstoneSession(params.sessionId);
			return {};
		}
		const current = await this.#currentLiveAuthority(params.sessionId, authority.canonicalCwd);
		this.#assertSessionNotAmbiguous(params.sessionId);
		if (
			!current ||
			current.endpointGeneration !== live.endpointGeneration ||
			current.endpointIncarnation !== live.endpointIncarnation
		) {
			this.#markSessionAmbiguous(params.sessionId);
			throw new AcpSdkAdapterError("conflict", `ACP session ${params.sessionId} live authority is stale.`);
		}

		this.#beginTeardown(params.sessionId);
		const failures: unknown[] = [];
		try {
			await this.#detachAndCloseAdapter(params.sessionId, "closed");
			try {
				await (await this.#brokerAdapter()).global(
					"session.close",
					{
						sessionId: params.sessionId,
						endpointGeneration: live.endpointGeneration,
						endpointIncarnation: live.endpointIncarnation,
						brokerOwnerId: authority.broker.ownerId,
					},
					this.#lifecycleIdempotencyKey(params.sessionId, "session.close", live.endpointIncarnation),
				);
			} catch (error) {
				if (!(this.#sessionAuthority.has(params.sessionId) && this.#isAlreadyGone(error))) failures.push(error);
			}
		} finally {
			this.#finishTeardown(params.sessionId);
		}
		this.#sessionAuthority.delete(params.sessionId);
		this.#tombstoneSession(params.sessionId);
		if (failures.length > 0)
			throw aggregateAcpFailure(
				"terminal_uncertain",
				`ACP session cleanup is uncertain: ${failures.map(failure => (failure instanceof Error ? failure.message : String(failure))).join("; ")}`,
				failures,
			);
		return {};
	}

	async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
		this.#assertSessionNotAmbiguous(params.sessionId);
		const authority = this.#sessionAuthority.get(params.sessionId);
		if (!authority) return {};
		const cwd = authority.canonicalCwd;
		const live = authority.live;
		if (!live && !authority.saved) return {};
		if (live) {
			const current = await this.#currentLiveAuthority(params.sessionId, cwd);
			this.#assertSessionNotAmbiguous(params.sessionId);
			if (
				!current ||
				current.endpointGeneration !== live.endpointGeneration ||
				current.endpointIncarnation !== live.endpointIncarnation
			) {
				this.#markSessionAmbiguous(params.sessionId);
				throw new AcpSdkAdapterError("conflict", `ACP session ${params.sessionId} live authority is stale.`);
			}
		}

		this.#beginTeardown(params.sessionId);
		try {
			await this.#detachAndCloseAdapter(params.sessionId, "deleted");
			if (live) {
				try {
					await (await this.#brokerAdapter()).global(
						"session.close",
						{
							sessionId: params.sessionId,
							endpointGeneration: live.endpointGeneration,
							endpointIncarnation: live.endpointIncarnation,
							brokerOwnerId: authority.broker.ownerId,
						},
						this.#lifecycleIdempotencyKey(params.sessionId, "session.close", live.endpointIncarnation),
					);
				} catch (error) {
					if (!this.#isAlreadyGone(error)) throw error;
				}
			}
			let saved: SavedSessionAuthority;
			try {
				saved = await this.#revalidateSavedAuthority(params.sessionId, cwd, live ? undefined : authority.saved);
			} catch (error) {
				if (error instanceof AcpSdkAdapterError && error.code === "not_found") {
					this.#sessionAuthority.delete(params.sessionId);
					this.#tombstoneSession(params.sessionId);
					return {};
				}
				throw error;
			}
			await (await this.#brokerAdapter()).global(
				"session.delete",
				{
					sessionId: params.sessionId,
					sessionPath: saved.path,
					sessionIdentity: saved.identity,
					brokerOwnerId: authority.broker.ownerId,
					...(authority.workspaceIdentity ? { workspaceIdentity: authority.workspaceIdentity } : {}),
					...(authority.workspaceGrantId ? { workspaceGrantId: authority.workspaceGrantId } : {}),
					cwd,
					target: { path: cwd },
				},
				this.#lifecycleIdempotencyKey(params.sessionId, "session.delete", savedIdentityDigest(saved.identity)),
			);
			this.#sessionAuthority.delete(params.sessionId);
			this.#tombstoneSession(params.sessionId);
			return {};
		} finally {
			this.#finishTeardown(params.sessionId);
		}
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		if (params.modeId !== ACP_DEFAULT_MODE_ID && params.modeId !== ACP_PLAN_MODE_ID)
			throw new Error(`Unsupported ACP mode: ${params.modeId}`);
		await this.#adapter(params.sessionId).control("mode.plan.set", {
			on: params.modeId === ACP_PLAN_MODE_ID,
		});
		await this.#publishSessionUpdate(params.sessionId, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "current_mode_update",
				currentModeId: params.modeId,
			},
		});
		return {};
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		if (typeof params.value !== "string")
			throw new Error(`Unsupported boolean ACP config option: ${params.configId}`);
		switch (params.configId) {
			case MODE_CONFIG_ID:
				await this.setSessionMode({
					sessionId: params.sessionId,
					modeId: params.value,
				});
				break;
			case MODEL_CONFIG_ID:
				await this.#adapter(params.sessionId).setModel(params.value);
				break;
			case THINKING_CONFIG_ID:
				await this.#adapter(params.sessionId).control("thinking.set", {
					level: params.value,
				});
				break;
			default: {
				const operation = ACP_CONFIG_CONTROL_OPERATIONS[params.configId];
				if (!operation) throw new Error(`Unknown ACP config option: ${params.configId}`);
				await this.#adapter(params.sessionId).control(operation, {
					mode: params.value,
				});
			}
		}
		const state = await this.#sessionState(params.sessionId);
		await this.#publishSessionUpdate(params.sessionId, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions: state.configOptions ?? [],
			},
		});
		return { configOptions: state.configOptions ?? [] };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		this.#assertSessionNotAmbiguous(params.sessionId);
		const record = this.#sessions.get(params.sessionId);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unsupported ACP session: ${params.sessionId}`);
		if (record.activePrompt) throw new AcpSdkAdapterError("conflict", "ACP session already has an active prompt.");
		const payload = acpPromptPayload(params.prompt);
		let waiter!: PromptWaiter;
		const response = new Promise<PromptResponse>((resolve, reject) => {
			waiter = {
				cancelRequested: false,
				acknowledged: false,
				activityObserved: false,
				steeringAtAcknowledgement: record.busy,
				boundary: record.inboundSequence,
				correlation: {},
				resolve,
				reject,
			};
			record.activePrompt = waiter;
		});
		try {
			const first = await Promise.race([
				record.adapter
					.prompt({
						text: payload.text,
						...(payload.images.length ? { images: payload.images } : {}),
					})
					.then(acknowledgement => ({
						kind: "acknowledged" as const,
						acknowledgement,
					})),
				response.then(value => ({ kind: "settled" as const, value })),
			]);
			if (first.kind === "settled") return first.value;
			const acknowledgement = first.acknowledgement;
			waiter.steeringAtAcknowledgement = record.busy;
			// Capture the ingress boundary after the command acknowledgement. Frames
			// queued before this point are stale with respect to this ACP prompt.
			waiter.boundary = record.inboundSequence;
			waiter.correlation = correlationFrom(acknowledgement);
			waiter.acknowledged = true;
			this.#settlePrompt(record, waiter);
		} catch (error) {
			if (record.activePrompt === waiter) record.activePrompt = undefined;
			throw error;
		}
		return await response;
	}

	async cancel(params: { sessionId: string }): Promise<void> {
		this.#assertSessionNotAmbiguous(params.sessionId);
		const record = this.#sessions.get(params.sessionId);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unsupported ACP session: ${params.sessionId}`);
		const waiter = record.activePrompt;
		const acknowledgement = await record.adapter.cancel();
		const result = object(object(acknowledgement)?.result) ?? object(acknowledgement);
		if (result?.aborted !== true)
			throw new AcpSdkAdapterError(
				"abort_unacknowledged",
				"SDK did not acknowledge cancellation of the active prompt.",
			);
		// Do not retroactively mark a waiter that already settled while the abort
		// request was in flight. A cancelled response means the abort itself won.
		if (waiter && record.activePrompt === waiter) waiter.cancelRequested = true;
	}

	async extMethod(method: string, params: JsonObject): Promise<JsonObject> {
		try {
			if (method === "_gjc/sdk/global") {
				const adapter = await this.#brokerAdapter();
				const input = object(params.input) ?? {};
				const result = await adapter.handle(method, {
					...params,
					input: {
						...input,
						brokerOwnerId: this.#requireBrokerIdentity().ownerId,
					},
				});
				return object(result) ?? {};
			}
			if (method === "_gjc/sdk/control" || method === "_gjc/sdk/query") {
				const id = typeof params.sessionId === "string" ? params.sessionId : undefined;
				if (!id) throw new AcpSdkAdapterError("invalid_input", "sessionId is required.");
				const result = await this.#adapter(id).handle(method, params);
				return object(result) ?? {};
			}
			throw new AcpSdkAdapterError("method_not_found", `Unknown ACP ext method: ${method}`);
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "internal";
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: { code, message } };
		}
	}

	async extNotification(_method: string, _params: JsonObject): Promise<void> {}
	get signal(): AbortSignal {
		return this.#connection.signal;
	}
	get closed(): Promise<void> {
		return this.#connection.closed;
	}

	#sessionEpoch(id: string): number {
		return this.#sessionEpochs.get(id) ?? 0;
	}

	#advanceSessionEpoch(id: string): void {
		this.#sessionEpochs.set(id, this.#sessionEpoch(id) + 1);
	}

	#assertSessionEpoch(id: string, epoch: number): void {
		if (this.#disposed || this.#tearingDown.has(id) || this.#sessionEpoch(id) !== epoch)
			throw new AcpSdkAdapterError("connection_closed", `ACP session ${id} was closed while attaching.`);
	}

	#beginTeardown(id: string): void {
		this.#tearingDown.set(id, (this.#tearingDown.get(id) ?? 0) + 1);
	}

	#finishTeardown(id: string): void {
		const remaining = (this.#tearingDown.get(id) ?? 1) - 1;
		if (remaining > 0) this.#tearingDown.set(id, remaining);
		else this.#tearingDown.delete(id);
	}

	#lifecycleIdempotencyKey(id: string, operation: "session.close" | "session.delete", scope?: string): string {
		return scope ? `acp:${operation}:${id}:${scope}` : `acp:${operation}:${id}`;
	}

	#sessionBrokerOwnerId(id: string): string {
		this.#assertSessionNotAmbiguous(id);
		const authority = this.#sessionAuthority.get(id);
		if (!authority)
			throw new AcpSdkAdapterError("unavailable", `Broker did not issue boot authority for ACP session ${id}.`);
		return authority.broker.ownerId;
	}

	#isAlreadyGone(error: unknown): boolean {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			((error.code === "not_found" || error.code === "resource_gone") as boolean)
		);
	}
	#assertSessionNotAmbiguous(id: string): void {
		if (this.#ambiguousSessionIds.has(id))
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} has ambiguous cwd authority.`);
	}
	/**
	 * A tombstoned id (ambiguity or successful close/delete) can never rebind
	 * authority on this connection. Checked only where new authority would be
	 * captured, so local teardown of an unbound id still returns cleanly.
	 */
	#assertSessionNotTombstoned(id: string): void {
		if (this.#sessionTombstones.has(id))
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} authority was permanently revoked.`);
	}
	/** Record a permanent per-id tombstone after a successful close or delete. */
	#tombstoneSession(id: string): void {
		this.#sessionTombstones.add(id);
	}
	/**
	 * A poisoned connection can never capture new authority. Set when a scoped
	 * session.list batch fails all-or-nothing validation; every authority-bearing
	 * session is revoked synchronously so no attached or reverse capability
	 * survives the failure.
	 */
	#assertConnectionNotPoisoned(): void {
		if (this.#poisoned) throw new AcpSdkAdapterError("conflict", "ACP connection authority was permanently revoked.");
	}
	#poisonConnection(): void {
		if (this.#poisoned) return;
		this.#poisoned = true;
		this.#markAllSessionsAmbiguous();
	}
	/**
	 * Capture the broker boot identity from discovery or a session.list result.
	 * Missing identity is fail-closed because no session authority may outlive or
	 * cross an unidentified broker process.
	 */
	#observeBrokerIdentity(result: JsonObject | undefined): void {
		const identity = brokerIdentity(result?.brokerIdentity);
		if (!identity) {
			this.#markAllSessionsAmbiguous();
			this.#brokerIdentity = undefined;
			throw new AcpSdkAdapterError("unavailable", "SDK broker did not issue a valid boot identity.");
		}
		const current = this.#brokerIdentity;
		this.#brokerIdentity = identity;
		if (current && !sameBrokerIdentity(current, identity)) this.#markAllSessionsAmbiguous();
	}

	#requireBrokerIdentity(): BrokerIdentity {
		const identity = this.#brokerIdentity;
		if (identity) return identity;
		this.#markAllSessionsAmbiguous();
		throw new AcpSdkAdapterError("unavailable", "SDK broker boot identity is unavailable.");
	}

	#markAllSessionsAmbiguous(): void {
		const ids = new Set([
			...this.#sessionAuthority.keys(),
			...this.#sessions.keys(),
			...this.#attaching.keys(),
			...this.#resolvingExisting.keys(),
		]);
		for (const id of ids) this.#markSessionAmbiguous(id);
	}

	/**
	 * Ambiguity is terminal for the connection. In addition to dropping the broker
	 * authority binding, the attached adapter is removed from authorization, its
	 * frame subscriptions are torn down, any active prompt is rejected, and the
	 * underlying socket is closed asynchronously. After this returns no prompt,
	 * cancel, ext control, or reverse capability can reach the session.
	 */
	#markSessionAmbiguous(id: string): void {
		this.#sessionAuthority.delete(id);
		this.#sessionTombstones.add(id);
		if (this.#ambiguousSessionIds.has(id)) return;
		this.#ambiguousSessionIds.add(id);
		this.#advanceSessionEpoch(id);
		this.#revokeAttachedControl(id);
	}

	#revokeAttachedControl(id: string): void {
		const record = this.#sessions.get(id);
		if (!record) return;
		this.#sessions.delete(id);
		record.unsubscribe();
		record.reconnectUnsubscribe();
		const waiter = record.activePrompt;
		record.activePrompt = undefined;
		waiter?.reject(new AcpSdkAdapterError("connection_closed", `ACP session ${id} authority was revoked.`));
		void record.adapter.close().catch(() => undefined);
	}

	#validateSessionAuthorityBinding(id: string, canonicalCwd: string): void {
		this.#assertSessionNotAmbiguous(id);
		this.#assertSessionNotTombstoned(id);
		const known = this.#sessionAuthority.get(id)?.canonicalCwd;
		if (!known || path.resolve(known) === path.resolve(canonicalCwd)) return;
		this.#markSessionAmbiguous(id);
		throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
	}

	#bindSessionAuthority(
		id: string,
		canonicalCwd: string,
		scopeWorkspace?: WorkspaceIdentity,
		scopeGrantId?: string,
	): void {
		this.#validateSessionAuthorityBinding(id, canonicalCwd);
		const existing = this.#sessionAuthority.get(id);
		const observedBroker = this.#requireBrokerIdentity();
		if (existing && !sameBrokerIdentity(existing.broker, observedBroker)) {
			this.#markSessionAmbiguous(id);
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} broker authority changed after issuance.`);
		}
		this.#sessionAuthority.set(id, {
			canonicalCwd: path.resolve(canonicalCwd),
			broker: observedBroker,
			live: existing?.live,
			saved: existing?.saved,
			workspaceIdentity: existing?.workspaceIdentity ?? scopeWorkspace,
			workspaceGrantId: existing?.workspaceGrantId ?? scopeGrantId,
		});
	}

	/**
	 * Pure validation + projection of a scoped broker observation against an
	 * existing authority entry. Throws on cwd, broker, live, or saved drift;
	 * never mutates connection state so callers can stage into an immutable clone.
	 */
	#computeSessionAuthority(
		existing: SessionAuthority | undefined,
		id: string,
		canonicalCwd: string,
		session: BrokerSession,
		scopeWorkspace: WorkspaceIdentity | undefined,
		scopeGrantId: string | undefined,
	): SessionAuthority {
		const known = existing?.canonicalCwd;
		if (known && path.resolve(known) !== path.resolve(canonicalCwd))
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
		const observedLive = liveAuthority(session);
		const observedSaved = savedAuthority(session);
		const observedBroker = this.#requireBrokerIdentity();
		if (
			(existing && !sameBrokerIdentity(existing.broker, observedBroker)) ||
			(existing?.live &&
				observedLive &&
				(existing.live.endpointGeneration !== observedLive.endpointGeneration ||
					existing.live.endpointIncarnation !== observedLive.endpointIncarnation)) ||
			(existing?.saved && observedSaved && !sameSavedIdentity(existing.saved.identity, observedSaved.identity))
		)
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} authority changed after issuance.`);
		return {
			canonicalCwd: path.resolve(canonicalCwd),
			broker: observedBroker,
			live: existing?.live ?? observedLive,
			saved: existing?.saved ?? observedSaved,
			workspaceIdentity: existing?.workspaceIdentity ?? scopeWorkspace,
			workspaceGrantId: existing?.workspaceGrantId ?? scopeGrantId,
		};
	}

	/** Merge broker-issued live/saved authority from a scoped observation. */
	#captureAuthority(
		id: string,
		canonicalCwd: string,
		session: BrokerSession,
		scopeWorkspace?: WorkspaceIdentity,
		scopeGrantId?: string,
	): void {
		this.#assertSessionNotTombstoned(id);
		const existing = this.#sessionAuthority.get(id);
		try {
			this.#sessionAuthority.set(
				id,
				this.#computeSessionAuthority(existing, id, canonicalCwd, session, scopeWorkspace, scopeGrantId),
			);
		} catch (error) {
			this.#markSessionAmbiguous(id);
			throw error;
		}
	}

	/**
	 * Stage a binding into an immutable clone without mutating live authority, so
	 * a scoped session.list batch commits only after every binding validates.
	 */
	#stageSessionAuthority(
		staging: Map<string, SessionAuthority>,
		id: string,
		canonicalCwd: string,
		session: BrokerSession,
		scopeWorkspace: WorkspaceIdentity | undefined,
		scopeGrantId: string | undefined,
	): SessionAuthority {
		this.#assertSessionNotTombstoned(id);
		return this.#computeSessionAuthority(staging.get(id), id, canonicalCwd, session, scopeWorkspace, scopeGrantId);
	}

	#captureSavedAuthority(id: string, saved: SavedSessionAuthority): void {
		const existing = this.#sessionAuthority.get(id);
		if (!existing) return;
		if (existing.saved && !sameSavedIdentity(existing.saved.identity, saved.identity)) {
			this.#markSessionAmbiguous(id);
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} saved transcript authority changed.`);
		}
		this.#sessionAuthority.set(id, {
			canonicalCwd: existing.canonicalCwd,
			broker: existing.broker,
			live: existing.live,
			saved,
			workspaceIdentity: existing.workspaceIdentity,
			workspaceGrantId: existing.workspaceGrantId,
		});
	}

	async #attachExisting(id: string, cwd: string): Promise<void> {
		this.#assertSessionNotAmbiguous(id);
		const epoch = this.#sessionEpoch(id);
		await this.#scopedBrokerSession(id, cwd);
		this.#assertSessionEpoch(id, epoch);
		const canonicalCwd = this.#sessionAuthority.get(id)?.canonicalCwd;
		if (!canonicalCwd) throw new AcpSdkAdapterError("unavailable", `Broker did not issue authority for ${id}.`);
		const attached = this.#sessions.get(id);
		if (attached) {
			if (attached.canonicalCwd !== canonicalCwd) {
				this.#markSessionAmbiguous(id);
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			}
			return;
		}
		const resolving = this.#resolvingExisting.get(id);
		if (resolving?.epoch === epoch) {
			await resolving.task;
			this.#assertSessionEpoch(id, epoch);
			const resolved = this.#sessions.get(id);
			if (!resolved) throw new AcpSdkAdapterError("unavailable", `ACP session ${id} did not attach.`);
			if (resolved.canonicalCwd !== canonicalCwd) {
				this.#markSessionAmbiguous(id);
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			}
			return;
		}

		const task = this.#resolveExistingAttachment(id, cwd, epoch);
		const pending = { epoch, task };
		this.#resolvingExisting.set(id, pending);
		try {
			await task;
			this.#assertSessionEpoch(id, epoch);
		} finally {
			if (this.#resolvingExisting.get(id) === pending) this.#resolvingExisting.delete(id);
		}
	}

	async #resolveExistingAttachment(id: string, cwd: string, epoch: number): Promise<void> {
		this.#assertSessionEpoch(id, epoch);
		const indexed = await this.#scopedBrokerSession(id, cwd);
		this.#assertSessionEpoch(id, epoch);
		if (indexed?.live) {
			const authority = liveAuthority(indexed);
			if (!authority) throw new AcpSdkAdapterError("unavailable", `Broker did not issue live authority for ${id}.`);
			const result = await this.#brokerEndpoint(id, authority);
			this.#assertSessionEpoch(id, epoch);
			await this.#revalidateLiveAuthority(id, authority);
			this.#assertSessionEpoch(id, epoch);
			await this.#attach(id, cwd, endpoint(result), epoch);
			return;
		}

		const saved = await this.#resolveSavedSession(id, cwd);
		this.#assertSessionEpoch(id, epoch);
		const result = await (await this.#brokerAdapter()).global(
			"session.resume",
			{
				cwd,
				sessionId: id,
				sessionPath: saved.path,
				sessionIdentity: saved.identity,
				brokerOwnerId: this.#sessionBrokerOwnerId(id),
				...(this.#sessionAuthority.get(id)?.workspaceIdentity
					? { workspaceIdentity: this.#sessionAuthority.get(id)!.workspaceIdentity! }
					: {}),
				...(this.#sessionAuthority.get(id)?.workspaceGrantId
					? { workspaceGrantId: this.#sessionAuthority.get(id)!.workspaceGrantId! }
					: {}),
				target: { path: cwd },
			},
			randomUUID(),
		);
		this.#assertSessionEpoch(id, epoch);
		await this.#scopedBrokerSession(id, cwd);
		this.#assertSessionEpoch(id, epoch);
		await this.#attach(id, cwd, endpoint(result), epoch);
	}

	async #workspaceAuthority(
		cwd: string,
	): Promise<{ canonicalCwd: string; identity: WorkspaceIdentity; grantId: string }> {
		const adapter = await this.#brokerAdapter();
		const response = object(
			await adapter.global("session.list", {
				cwd,
				brokerOwnerId: this.#requireBrokerIdentity().ownerId,
			}),
		);
		const result = object(response?.result) ?? response;
		this.#observeBrokerIdentity(result);
		const canonicalCwd = typeof result?.canonicalCwd === "string" ? path.resolve(result.canonicalCwd) : undefined;
		const identity = workspaceIdentity(result?.workspaceIdentity);
		const grantId = workspaceGrantId(result?.workspaceGrantId);
		if (!canonicalCwd || !identity || !grantId)
			throw new AcpSdkAdapterError("unavailable", "SDK broker did not issue opened workspace authority.");
		return { canonicalCwd, identity, grantId };
	}
	async #scopedBrokerSession(id: string, cwd: string): Promise<BrokerSession | undefined> {
		this.#assertSessionNotAmbiguous(id);
		this.#assertConnectionNotPoisoned();
		const response = object(
			await (await this.#brokerAdapter()).global("session.list", {
				cwd,
				brokerOwnerId: this.#requireBrokerIdentity().ownerId,
			}),
		);
		const result = object(response?.result) ?? response;
		this.#observeBrokerIdentity(result);
		const canonicalCwd =
			typeof result?.canonicalCwd === "string" ? path.resolve(result.canonicalCwd) : path.resolve(cwd);
		const scopeWorkspace = workspaceIdentity(result?.workspaceIdentity);
		const scopeGrantId = workspaceGrantId(result?.workspaceGrantId);
		const listed = Array.isArray(result?.sessions) ? result.sessions : [];
		const observations =
			Array.isArray(result?.observations) && result.observations.length > 0 ? result.observations : listed;
		const evidence = observations
			.map(item => object(item) as BrokerSession | undefined)
			.filter((session): session is BrokerSession => session?.sessionId === id);
		if (evidence.length > 1 || evidence.some(session => brokerSessionScope(session) !== canonicalCwd)) {
			this.#markSessionAmbiguous(id);
			throw new AcpSdkAdapterError("conflict", `Broker returned ambiguous session authority for ${id}.`);
		}
		const matches = listed
			.map(item => object(item) as BrokerSession | undefined)
			.filter((session): session is BrokerSession => session?.sessionId === id);
		if (matches.length > 1 || matches.some(session => brokerSessionScope(session) !== canonicalCwd)) {
			this.#markSessionAmbiguous(id);
			throw new AcpSdkAdapterError("conflict", `Broker returned conflicting session scope for ${id}.`);
		}
		this.#validateSessionAuthorityBinding(id, canonicalCwd);
		const match = matches[0];
		if (match) this.#captureAuthority(id, canonicalCwd, match, scopeWorkspace, scopeGrantId);
		else this.#bindSessionAuthority(id, canonicalCwd, scopeWorkspace, scopeGrantId);
		return match;
	}

	async #attach(id: string, cwd: string, discovered: Endpoint, epoch = this.#sessionEpoch(id)): Promise<void> {
		this.#assertSessionNotAmbiguous(id);
		this.#assertSessionEpoch(id, epoch);
		const canonicalCwd = this.#sessionAuthority.get(id)?.canonicalCwd;
		if (!canonicalCwd) throw new AcpSdkAdapterError("unavailable", `Broker did not issue authority for ${id}.`);
		const existing = this.#sessions.get(id);
		if (existing) {
			if (existing.canonicalCwd !== canonicalCwd) {
				this.#markSessionAmbiguous(id);
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			}
			return;
		}
		const attaching = this.#attaching.get(id);
		if (attaching?.epoch === epoch) {
			await attaching.task;
			this.#assertSessionEpoch(id, epoch);
			const attached = this.#sessions.get(id);
			if (!attached) throw new AcpSdkAdapterError("unavailable", `ACP session ${id} did not attach.`);
			if (attached.canonicalCwd !== canonicalCwd) {
				this.#markSessionAmbiguous(id);
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			}
			return;
		}

		const task = this.#attachEndpoint(id, cwd, discovered, epoch);
		const pending = { epoch, task };
		this.#attaching.set(id, pending);
		try {
			await task;
			this.#assertSessionEpoch(id, epoch);
		} finally {
			if (this.#attaching.get(id) === pending) this.#attaching.delete(id);
		}
	}

	async #attachEndpoint(id: string, cwd: string, discovered: Endpoint, epoch: number): Promise<void> {
		let adapter: AcpSdkAdapter | undefined;
		try {
			const authority = this.#sessionAuthority.get(id);
			if (!authority)
				throw new AcpSdkAdapterError("unavailable", `Broker did not issue authority for ACP session ${id}.`);
			const gate: ReverseGate = {
				sessionId: id,
				epoch,
				broker: authority.broker,
				adapter: undefined,
			};
			adapter = await AcpSdkAdapter.connect({
				url: discovered.url,
				token: discovered.token,
				connection: this.#reverseConnection(id, gate),
				providers: this.#providers(),
			});
			gate.adapter = adapter;
			this.#assertSessionEpoch(id, epoch);
			const record: SessionRecord = {
				cwd,
				canonicalCwd: authority.canonicalCwd,
				broker: authority.broker,
				adapter,
				unsubscribe: () => {},
				reconnectUnsubscribe: () => {},
				frameTail: Promise.resolve(),
				inboundSequence: 0,
				busy: false,
			};
			record.unsubscribe = adapter.onFrame(frame => this.#enqueueSdkFrame(id, adapter!, frame));
			record.reconnectUnsubscribe = adapter.onReconnectFailed(error =>
				this.#recoverSessionAfterTransportFailure(id, adapter!, error),
			);
			await applyAcpPermissionMode(adapter, this.#clientCapabilities);
			this.#assertSessionEpoch(id, epoch);
			// Final live generation+incarnation and broker-owner revalidation after
			// connect, permission/provider setup, and subscription construction,
			// immediately before the sole synchronous #sessions.set publication. A
			// same-generation successor that appeared in this await window is caught
			// here, before any reverse capability or adapter can reach the ACP client.
			// Reverse callbacks stay unusable until publication because the gate
			// requires the published record's exact adapter identity.
			await this.#revalidateAttachmentAuthority(id, epoch);
			this.#sessions.set(id, record);
		} catch (error) {
			if (adapter && this.#sessions.get(id)?.adapter === adapter) {
				await this.#teardownSession(id, "attachment failed");
			} else if (adapter) {
				try {
					await adapter.close();
				} catch {}
			}
			throw error;
		}
	}

	#recoverSessionAfterTransportFailure(id: string, adapter: AcpSdkAdapter, error: Error): void {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		const detail = error.message || "SDK transport reconnect failed.";
		const terminal = new AcpSdkAdapterError("connection_closed", `ACP session transport was lost: ${detail}`);
		void this.#recoverSessionAfterTransportFailureAsync(id, adapter, record.cwd, terminal);
	}

	async #recoverSessionAfterTransportFailureAsync(
		id: string,
		adapter: AcpSdkAdapter,
		cwd: string,
		error: AcpSdkAdapterError,
	): Promise<void> {
		await this.#failSession(id, adapter, error);
		if (this.#disposed || !this.#sessionAuthority.has(id)) return;
		try {
			await this.#attachExisting(id, cwd);
		} catch {
			// The affected prompt was rejected and the stale adapter was removed. A later load/resume retries discovery.
		}
	}

	async #discardNewSession(id: string): Promise<void> {
		await this.closeSession({ sessionId: id });
	}

	/**
	 * All local session disposal follows one path: remove ownership and reject a
	 * waiting prompt before any awaited socket or broker work. A failed close is
	 * terminally uncertain, not a reason to leave a usable-looking ACP record.
	 */
	async #teardownSession(id: string, reason: string): Promise<void> {
		const record = this.#sessions.get(id);
		this.#beginTeardown(id);
		try {
			this.#advanceSessionEpoch(id);
			if (record) {
				this.#sessions.delete(id);
				record.unsubscribe();
				record.reconnectUnsubscribe();
				const waiter = record.activePrompt;
				record.activePrompt = undefined;
				waiter?.reject(new AcpSdkAdapterError("connection_closed", `ACP session was ${reason}.`));
			}
			try {
				await record?.adapter.close();
			} catch (error) {
				throw aggregateAcpFailure("terminal_uncertain", "ACP session adapter cleanup is uncertain.", [error]);
			}
		} finally {
			this.#finishTeardown(id);
		}
	}

	async #failSession(id: string, adapter: AcpSdkAdapter, error: AcpSdkAdapterError): Promise<void> {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		this.#advanceSessionEpoch(id);
		this.#sessions.delete(id);
		record.unsubscribe();
		record.reconnectUnsubscribe();
		const waiter = record.activePrompt;
		record.activePrompt = undefined;
		waiter?.reject(error);
		try {
			await adapter.close();
		} catch {}
	}

	async #brokerAdapter(): Promise<AcpSdkAdapter> {
		return (await this.#brokerConnection()).adapter;
	}

	/** Machine-local endpoint lookup; never routed through ACP extension methods. */
	async #brokerEndpoint(sessionId: string, authority: LiveSessionAuthority): Promise<unknown> {
		return await (await this.#brokerConnection()).client.global("session.get_endpoint", {
			sessionId,
			brokerOwnerId: this.#sessionBrokerOwnerId(sessionId),
			endpointGeneration: authority.endpointGeneration,
			endpointIncarnation: authority.endpointIncarnation,
		});
	}

	/**
	 * Revalidate the full live authority tuple (generation + incarnation) after
	 * an endpoint lookup but before publishing the adapter, so a same-generation
	 * successor that appeared between list and get_endpoint is caught.
	 */
	async #revalidateLiveAuthority(id: string, expected: LiveSessionAuthority): Promise<void> {
		const canonicalCwd = this.#sessionAuthority.get(id)?.canonicalCwd;
		if (!canonicalCwd) return;
		const current = await this.#currentLiveAuthority(id, canonicalCwd);
		if (
			!current ||
			current.endpointGeneration !== expected.endpointGeneration ||
			current.endpointIncarnation !== expected.endpointIncarnation
		) {
			this.#markSessionAmbiguous(id);
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} live authority changed before attachment.`);
		}
	}
	/**
	 * Final live generation+incarnation and broker-owner revalidation performed
	 * after AcpSdkAdapter.connect, permission/provider setup, and subscription
	 * construction, immediately before the sole synchronous #sessions.set. The
	 * post-connect await window (socket open, provider handshake) is the last gap
	 * in which a same-generation successor or broker restart can appear before the
	 * adapter becomes reachable; any drift fails closed before publication.
	 */
	async #revalidateAttachmentAuthority(id: string, epoch: number): Promise<void> {
		this.#assertSessionNotAmbiguous(id);
		this.#assertSessionEpoch(id, epoch);
		const authority = this.#sessionAuthority.get(id);
		if (!authority?.live) return;
		const current = await this.#currentLiveAuthority(id, authority.canonicalCwd);
		this.#assertSessionNotAmbiguous(id);
		this.#assertSessionEpoch(id, epoch);
		if (
			!current ||
			current.endpointGeneration !== authority.live.endpointGeneration ||
			current.endpointIncarnation !== authority.live.endpointIncarnation
		) {
			this.#markSessionAmbiguous(id);
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} live authority changed before publication.`);
		}
	}

	async #brokerConnection(): Promise<BrokerConnection> {
		if (!this.#broker) {
			let pending!: Promise<BrokerConnection>;
			pending = (async () => {
				await ensureBroker({ agentDir: this.#agentDir });
				const discovery = await readSdkBrokerDiscovery(this.#agentDir);
				if (!discovery) throw new AcpSdkAdapterError("unavailable", "SDK broker discovery is unavailable.");
				this.#observeBrokerIdentity({
					brokerIdentity: discovery,
				});
				const client = await SdkClient.connect(discovery.url, discovery.token);
				const adapter = new AcpSdkAdapter({
					url: discovery.url,
					token: discovery.token,
					client,
				});
				adapter.onReconnectFailed(() => {
					if (this.#broker !== pending) return;
					this.#markAllSessionsAmbiguous();
					this.#brokerIdentity = undefined;
					this.#broker = undefined;
					void adapter.close().catch(() => undefined);
				});
				await adapter.start();
				return { adapter, client };
			})();
			this.#broker = pending;
		}
		const pending = this.#broker;
		try {
			return await pending;
		} catch (error) {
			if (this.#broker === pending) {
				this.#markAllSessionsAmbiguous();
				this.#brokerIdentity = undefined;
				this.#broker = undefined;
			}
			throw error;
		}
	}

	#adapter(id: string): AcpSdkAdapter {
		this.#assertSessionNotAmbiguous(id);
		const record = this.#sessions.get(id);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unsupported ACP session: ${id}`);
		return record.adapter;
	}

	async #resolveSavedSession(id: string, cwd: string): Promise<SavedSessionAuthority> {
		await this.#scopedBrokerSession(id, cwd);
		const saved = await this.#fetchSavedAuthority(id, cwd);
		if (!saved) throw new AcpSdkAdapterError("not_found", `Saved ACP session does not exist: ${id}`);
		this.#captureSavedAuthority(id, saved);
		return saved;
	}

	/** Fetch the broker-resolved saved session authority for an id scoped to cwd. */
	async #fetchSavedAuthority(id: string, cwd: string): Promise<SavedSessionAuthority | undefined> {
		const response = object(
			await (await this.#brokerAdapter()).global("session.list", {
				resolveSessionId: id,
				cwd,
				brokerOwnerId: this.#requireBrokerIdentity().ownerId,
			}),
		);
		const result = object(response?.result) ?? response;
		this.#observeBrokerIdentity(result);
		const savedSession = object(result?.savedSession);
		if (savedSession?.id !== id) return undefined;
		return savedAuthority(savedSession);
	}

	/**
	 * Revalidate the live endpoint incarnation currently indexed for id in canonicalCwd.
	 * Returns undefined when the session is no longer live in that scope.
	 */
	async #currentLiveAuthority(id: string, canonicalCwd: string): Promise<LiveSessionAuthority | undefined> {
		const response = object(
			await (await this.#brokerAdapter()).global("session.list", {
				cwd: canonicalCwd,
				brokerOwnerId: this.#requireBrokerIdentity().ownerId,
			}),
		);
		const result = object(response?.result) ?? response;
		this.#observeBrokerIdentity(result);
		const scope =
			typeof result?.canonicalCwd === "string" ? path.resolve(result.canonicalCwd) : path.resolve(canonicalCwd);
		const listed = Array.isArray(result?.sessions) ? result.sessions : [];
		const observations =
			Array.isArray(result?.observations) && result.observations.length > 0 ? result.observations : listed;
		const matches = observations
			.map(item => object(item) as BrokerSession | undefined)
			.filter((session): session is BrokerSession => session?.sessionId === id);
		if (matches.length > 1 || matches.some(session => brokerSessionScope(session) !== scope)) {
			this.#markSessionAmbiguous(id);
			throw new AcpSdkAdapterError("conflict", `Broker returned ambiguous live authority for ${id}.`);
		}
		return matches[0] ? liveAuthority(matches[0]) : undefined;
	}

	/**
	 * Revalidate that id is still scoped to cwd and that its saved transcript
	 * identity has not been recreated since the connection last observed it.
	 * Throws conflict on scope drift or transcript recreation; not_found if no
	 * saved session is resolvable in scope.
	 */
	async #revalidateSavedAuthority(
		id: string,
		cwd: string,
		stored: SavedSessionAuthority | undefined,
	): Promise<SavedSessionAuthority> {
		await this.#scopedBrokerSession(id, cwd);
		const saved = await this.#fetchSavedAuthority(id, cwd);
		if (!saved) throw new AcpSdkAdapterError("not_found", `Saved ACP session does not exist: ${id}`);
		if (stored && !sameSavedIdentity(stored.identity, saved.identity)) {
			this.#markSessionAmbiguous(id);
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} saved transcript authority is stale.`);
		}
		this.#captureSavedAuthority(id, saved);
		return saved;
	}

	/**
	 * Local disposal only: drop ownership, unsubscribe, reject any active prompt,
	 * advance the epoch, and close the adapter socket. Performs no broker work so
	 * callers control when (and whether) a lifecycle mutation is issued.
	 */
	async #detachAndCloseAdapter(id: string, reason: string): Promise<void> {
		this.#advanceSessionEpoch(id);
		const record = this.#sessions.get(id);
		if (!record) return;
		this.#sessions.delete(id);
		record.unsubscribe();
		record.reconnectUnsubscribe();
		const waiter = record.activePrompt;
		record.activePrompt = undefined;
		waiter?.reject(new AcpSdkAdapterError("connection_closed", `ACP session was ${reason}.`));
		try {
			await record.adapter.close();
		} catch {
			// Local socket cleanup is best-effort; a broker mutation (if any) is the authoritative teardown.
		}
	}

	#providers(): AcpProviderRegistration[] {
		return acpProviderRegistrations(this.#clientCapabilities);
	}

	#reverseConnection(sessionId: string, gate: ReverseGate): AcpReverseConnection {
		const methods: Record<string, string> = {
			"fs.readTextFile": "readTextFile",
			"fs.writeTextFile": "writeTextFile",
			"terminal.create": "createTerminal",
			"permission.request": "requestPermission",
			"ui.elicit": "unstable_createElicitation",
		};
		return {
			request: async (method: string, params: JsonObject): Promise<unknown> => {
				this.#assertReverseGate(sessionId, gate);
				const name = methods[method] ?? method;
				const target = (this.#connection as unknown as Record<string, unknown>)[name];
				if (typeof target !== "function")
					throw new AcpSdkAdapterError("acp_reverse_unavailable", `ACP reverse method is unavailable: ${method}`);
				const request = method === "permission.request" ? { ...params, sessionId } : params;
				return await (target as (input: JsonObject) => Promise<unknown>)(request);
			},
		};
	}

	/**
	 * Synchronously gate every reverse callback by session id, epoch, broker
	 * identity, current authority, and exact adapter identity. Ambiguity revokes
	 * the record and advances the epoch synchronously, so even while
	 * adapter.close is held a reverse request can never reach the ACP client.
	 */
	#assertReverseGate(id: string, gate: ReverseGate): void {
		if (this.#disposed || this.#ambiguousSessionIds.has(id) || this.#sessionEpoch(id) !== gate.epoch)
			throw new AcpSdkAdapterError("connection_closed", `ACP session ${id} authority was revoked.`);
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== gate.adapter)
			throw new AcpSdkAdapterError("connection_closed", `ACP session ${id} authority was revoked.`);
		const authority = this.#sessionAuthority.get(id);
		const currentBroker = this.#brokerIdentity;
		if (
			!authority ||
			!currentBroker ||
			!sameBrokerIdentity(gate.broker, authority.broker) ||
			!sameBrokerIdentity(gate.broker, record.broker) ||
			!sameBrokerIdentity(gate.broker, currentBroker)
		)
			throw new AcpSdkAdapterError("connection_closed", `ACP session ${id} authority was revoked.`);
	}

	#observeSessionActivity(record: SessionRecord, frame: JsonObject): void {
		const event = receivedSdkEvent(frame)?.event;
		if (event?.type === "agent_start") record.busy = true;
		else if (event?.type === "agent_end") record.busy = false;
	}

	#frameProcessingFailure(error: unknown): AcpSdkAdapterError {
		if (error instanceof AcpSdkAdapterError && error.code === "frame_processing_failed") return error;
		const detail = error instanceof Error ? error.message : String(error);
		return new AcpSdkAdapterError("frame_processing_failed", `ACP session frame processing failed: ${detail}`);
	}

	#enqueueSdkFrame(id: string, adapter: AcpSdkAdapter, frame: JsonObject): void {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		// Sequence and busy state are captured at ingress, before queued work begins.
		// A frame received before acknowledgement stays before that prompt's boundary.
		this.#observeSessionActivity(record, frame);
		const sequence = ++record.inboundSequence;
		const task = record.frameTail.then(async () => await this.#handleSdkFrame(id, adapter, frame, sequence));
		record.frameTail = task.catch(
			async error => await this.#failSession(id, adapter, this.#frameProcessingFailure(error)),
		);
	}

	async #handleSdkFrame(id: string, adapter: AcpSdkAdapter, frame: JsonObject, sequence: number): Promise<void> {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		const received = receivedSdkEvent(frame);
		if (!received) return;
		const { event, wirePayload } = received;
		const correlation = correlationFrom(frame, event);
		const activePrompt = record.activePrompt;
		// Prompt ownership is updated before publishing client notifications, but a
		// terminal waiter is resolved only after publication succeeds so a failed
		// sessionUpdate rejects the prompt instead of reporting false completion.
		if (
			activePrompt?.acknowledged &&
			sequence > activePrompt.boundary &&
			!correlationsConflict(activePrompt.correlation, correlation)
		) {
			if (isPromptActivity(String(event.type))) {
				activePrompt.activityObserved = true;
			} else if (event.type === "agent_end") {
				if (
					correlationsMatch(activePrompt.correlation, correlation) ||
					activePrompt.activityObserved ||
					activePrompt.steeringAtAcknowledgement
				)
					activePrompt.pendingTerminal = correlation;
			}
		}
		if (wirePayload) {
			for (const notification of mapAgentWireEventPayloadToAcpSessionUpdates(wirePayload as never, id, {
				cwd: record.cwd,
			}))
				await this.#publishSessionUpdate(id, notification, adapter);
		}
		if (event.type === "agent_end") await this.#emitEndOfTurnUpdates(id, adapter);
		if (activePrompt) this.#settlePrompt(record, activePrompt);
	}

	#settlePrompt(record: SessionRecord, waiter: PromptWaiter): void {
		if (record.activePrompt !== waiter || !waiter.acknowledged || !waiter.pendingTerminal) return;
		if (correlationsConflict(waiter.correlation, waiter.pendingTerminal)) return;
		if (
			!correlationsMatch(waiter.correlation, waiter.pendingTerminal) &&
			!waiter.activityObserved &&
			!waiter.steeringAtAcknowledgement
		)
			return;
		record.activePrompt = undefined;
		waiter.resolve({
			stopReason: waiter.cancelRequested ? "cancelled" : "end_turn",
		});
	}

	async #emitEndOfTurnUpdates(id: string, adapter: AcpSdkAdapter): Promise<void> {
		let usage: JsonObject | undefined;
		try {
			const response = object(await adapter.query("context.get"));
			const result = object(response?.result) ?? response;
			usage = object(result?.usage);
		} catch {
			// Context usage is advisory ACP metadata; prompt completion remains authoritative.
		}
		if (typeof usage?.tokens === "number" && typeof usage.contextWindow === "number") {
			await this.#publishSessionUpdate(
				id,
				{
					sessionId: id,
					update: {
						sessionUpdate: "usage_update",
						size: usage.contextWindow,
						used: usage.tokens,
					},
				},
				adapter,
			);
		}
		await this.#publishSessionUpdate(
			id,
			{
				sessionId: id,
				update: {
					sessionUpdate: "session_info_update",
					updatedAt: new Date().toISOString(),
					_meta: { gjcPhase: "idle", running: false, gjcRunning: false },
				},
			},
			adapter,
		);
	}

	async #publishSessionUpdate(
		id: string,
		notification: SessionNotification,
		expectedAdapter?: AcpSdkAdapter,
	): Promise<void> {
		const record = this.#sessions.get(id);
		if (!record || (expectedAdapter && record.adapter !== expectedAdapter)) return;
		try {
			await this.#connection.sessionUpdate(notification);
		} catch (error) {
			const failure = this.#frameProcessingFailure(error);
			await this.#failSession(id, record.adapter, failure);
			throw failure;
		}
	}

	async #sessionState(id: string): Promise<Pick<NewSessionResponse, "configOptions" | "modes">> {
		const record = this.#sessions.get(id);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unsupported ACP session: ${id}`);
		const [config, models] = await Promise.all([
			record.adapter.query("config.list/get"),
			record.adapter.query("models.list/current"),
		]);
		return acpSessionStateFromConfig(config, models);
	}

	async #replaySession(id: string): Promise<void> {
		const adapter = this.#adapter(id);
		let cursor: string | undefined;
		let imageLimitationReported = false;
		for (let pageCount = 0; pageCount < MAX_ACP_REPLAY_PAGES; pageCount++) {
			const response = object(await adapter.query("transcript.list", {}, cursor));
			const result = object(response?.result) ?? response;
			const page = object(result?.page);
			for (const item of Array.isArray(page?.items) ? page.items : []) {
				const message = object(item);
				if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
				const content = transcriptReplayContent(message);
				if (!imageLimitationReported) {
					imageLimitationReported = true;
					await this.#publishSessionUpdate(
						id,
						{
							sessionId: id,
							update: {
								sessionUpdate: "session_info_update",
								_meta: { gjcTranscriptImageReplay: content.images },
							},
						},
						adapter,
					);
				}
				const messageId = typeof message.id === "string" ? message.id : undefined;
				for (const block of content.blocks) {
					await this.#publishSessionUpdate(
						id,
						{
							sessionId: id,
							update: {
								sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
								content: block,
								...(messageId ? { messageId } : {}),
							},
						},
						adapter,
					);
				}
			}
			cursor = typeof page?.continuationCursor === "string" ? page.continuationCursor : undefined;
			if (!cursor) return;
		}
		throw new AcpSdkAdapterError("resource_exhausted", "ACP transcript replay exceeded the page limit.");
	}

	#scheduleBootstrap(id: string): void {
		setTimeout(() => {
			const record = this.#sessions.get(id);
			if (!record || this.#connection.signal.aborted) return;
			void this.#publishSessionUpdate(
				id,
				{
					sessionId: id,
					update: {
						sessionUpdate: "session_info_update",
						_meta: { gjcPhase: "idle", running: false, gjcRunning: false },
					},
				},
				record.adapter,
			).catch(() => undefined);
		}, ACP_BOOTSTRAP_RACE_GUARD_MS);
	}

	#cursor(cursor: string | null | undefined): number {
		if (cursor === null || cursor === undefined) return 0;
		if (!/^(0|[1-9]\d*)$/.test(cursor)) throw new Error(`Invalid ACP session cursor: ${cursor}`);
		const value = Number(cursor);
		if (!Number.isSafeInteger(value)) throw new Error(`Invalid ACP session cursor: ${cursor}`);
		return value;
	}

	#assertAbsoluteCwd(cwd: string): void {
		if (!path.isAbsolute(cwd)) throw new Error(`ACP cwd must be an absolute path: ${cwd}`);
	}

	#assertNoMcpServers(params: { mcpServers?: unknown[] }): void {
		if (params.mcpServers && params.mcpServers.length > 0)
			throw new AcpSdkAdapterError("unsupported", "MCP servers are unsupported under SDK-backed ACP.");
	}

	#beginDispose(): void {
		if (this.#disposePromise) return;
		this.#disposePromise = this.#dispose();
		// AbortSignal listeners cannot return a promise to their caller. Retain the
		// aggregate cleanup result while attaching a rejection handler so disposal
		// never creates a detached unhandled rejection.
		void this.#disposePromise.catch(() => undefined);
	}

	async #dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const failures: unknown[] = [];
		for (const id of [...this.#sessions.keys()]) {
			try {
				await this.#teardownSession(id, "connection closed");
			} catch (error) {
				failures.push(error);
			}
		}
		this.#attaching.clear();
		this.#resolvingExisting.clear();
		this.#sessionAuthority.clear();
		this.#ambiguousSessionIds.clear();
		this.#tearingDown.clear();
		this.#sessionTombstones.clear();
		this.#poisoned = true;
		if (this.#broker) {
			const broker = this.#broker;
			this.#broker = undefined;
			try {
				await (await broker).adapter.close();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			const detail = failures
				.map(failure => (failure instanceof Error ? failure.message : String(failure)))
				.join("; ");
			throw aggregateAcpFailure("terminal_uncertain", `ACP connection cleanup is uncertain: ${detail}`, failures);
		}
	}
}
