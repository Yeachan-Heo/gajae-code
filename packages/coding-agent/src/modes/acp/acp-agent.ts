import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AuthMethod,
	type AvailableCommand,
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
	RequestError,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionInfo,
	type SessionNotification,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { getAgentDir, logger } from "@gajae-code/utils";
import packageJson from "../../../package.json" with { type: "json" };
import {
	type AcpProviderRegistration,
	type AcpReverseConnection,
	AcpSdkAdapter,
	AcpSdkAdapterError,
} from "../../sdk/acp";
import { resolveAcpFinalText } from "../../sdk/acp/final-text";
import { ACP_MCP_LIFECYCLE_TIMEOUT_MS, type SessionLifecycleMcpServer } from "../../sdk/acp/mcp";
import { ensureBroker } from "../../sdk/broker/ensure";
import { readSdkBrokerDiscovery, SdkClient, SdkClientError } from "../../sdk/client";
import type { SdkPromptTerminalOutcome } from "../../sdk/prompt-status";
import {
	buildToolCallStartUpdate,
	mapAgentSessionEventToAcpSessionUpdates,
	mapAgentWireEventPayloadToAcpSessionUpdates,
} from "./acp-event-mapper";
import { resolveAcpPermissionMode } from "./permission-mode";
import type { AcpStartupOptions } from "./startup-options";
import { ACP_TERMINAL_AUTH_FLAG } from "./terminal-auth";

const ACP_DEFAULT_MODE_ID = "default";
const ACP_PLAN_MODE_ID = "plan";
const MODE_CONFIG_ID = "mode";
const MODEL_CONFIG_ID = "model";
const MODEL_PRESET_CONFIG_KEY = "modelPreset";
const ACP_CUSTOM_MODEL_PRESET = "__custom__";
const THINKING_CONFIG_ID = "thinking";
const SESSION_PAGE_SIZE = 50;
export const ACP_BOOTSTRAP_RACE_GUARD_MS = 50;
const MAX_ACP_REPLAY_PAGES = 10_000;
/** Bounded retention of settled prompt correlations so late duplicates stay closed. */
const SETTLED_PROMPT_CORRELATION_RETENTION = 16;

type JsonObject = Record<string, unknown>;
interface PromptWaiter {
	acknowledged: boolean;
	/** Highest inbound frame sequence already observed when the prompt was acknowledged. */
	boundary: number;
	correlation: PromptCorrelation;
	messageProgress?: { textEmitted: boolean; thoughtEmitted: boolean };
	emittedAssistantText: string;
	settled: boolean;
	terminal?: { outcome: SdkPromptTerminalOutcome; correlation: PromptCorrelation };
	/** Frames for an already-settled correlation held until acknowledgement resolves ownership. */
	deferredFrames: JsonObject[];
	resolve: (response: PromptResponse) => void;
	reject: (error: Error) => void;
}

type PromptCorrelation = { commandId?: string; turnId?: string };

type BrokerConnection = { adapter: AcpSdkAdapter; client: SdkClient };
type PendingAttachment = { epoch: number; task: Promise<void> };

type SessionRecord = {
	cwd: string;
	adapter: AcpSdkAdapter;
	closeIdempotencyKey: string;
	unsubscribe: () => void;
	reconnectUnsubscribe: () => void;
	/** Per-session frame work queue; callbacks never race prompt ownership. */
	frameTail: Promise<void>;
	/** Monotonic at WebSocket ingress, before queued work begins. */
	inboundSequence: number;
	/** Updated at ingress so a prompt acknowledgement can distinguish a steer from a fresh turn. */
	busy: boolean;
	/** Start/update args retained because tool_execution_end does not carry them. */
	toolArgs: Map<string, unknown>;
	/** Actionable model-profile authentication failure detected before prompt dispatch. */
	connectionId?: string;
	/** Bounded set of correlations already settled; they stay closed for publication. */
	settledPromptCorrelations: PromptCorrelation[];
	authFailure?: string;
	activePrompt?: PromptWaiter;
};
type Endpoint = { url: string; token: string };

type BrokerSession = {
	sessionId: string;
	locator?: { repo?: string };
	live?: boolean;
	endpointGeneration?: number;
	endpointMtimeMs?: number;
	title?: string;
	updatedAt?: string;
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

function aggregateAcpFailure(code: string, message: string, failures: unknown[]): AcpSdkAdapterError {
	const aggregate = new AggregateError(failures, message);
	return Object.assign(new AcpSdkAdapterError(code, aggregate.message), {
		cause: aggregate,
		errors: aggregate.errors,
	});
}

/** Applies ACP's offset cursor after narrowing the broker listing to the requested cwd. */
export function paginateAcpSessions(
	listed: unknown[],
	cwd: string | undefined,
	offset: number,
	sessionMetadata: ReadonlyMap<string, { title?: string; updatedAt?: string }> = new Map(),
): ListSessionsResponse {
	const filtered = listed
		.map(value => object(value) as BrokerSession | undefined)
		.filter(
			(value): value is BrokerSession & { locator: { repo: string } } =>
				typeof value?.sessionId === "string" && typeof value.locator?.repo === "string",
		)
		.filter(value => !cwd || value.locator.repo === cwd);
	const sessions = filtered.slice(offset, offset + SESSION_PAGE_SIZE).map(value => {
		const metadata = sessionMetadata.get(value.sessionId);
		const updatedAt =
			typeof metadata?.updatedAt === "string"
				? metadata.updatedAt
				: typeof value.updatedAt === "string"
					? value.updatedAt
					: typeof value.endpointMtimeMs === "number" && Number.isFinite(value.endpointMtimeMs)
						? new Date(value.endpointMtimeMs).toISOString()
						: undefined;
		return {
			sessionId: value.sessionId,
			cwd: value.locator.repo,
			title:
				typeof metadata?.title === "string" && metadata.title
					? metadata.title
					: typeof value.title === "string" && value.title
						? value.title
						: value.sessionId,
			...(updatedAt ? { updatedAt } : {}),
		} satisfies SessionInfo;
	});
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

/** Build the ACP command palette from the shared builtins and live SDK skill state. */
export function acpAvailableCommandsFromSkills(query: unknown): AvailableCommand[] {
	const commands = new Map<string, AvailableCommand>();
	for (const item of pageItems(query)) {
		const skill = object(item);
		if (typeof skill?.name !== "string" || !skill.name) continue;
		const name = `skill:${skill.name}`;
		if (commands.has(name)) continue;
		commands.set(name, {
			name,
			description:
				typeof skill.description === "string" && skill.description
					? skill.description
					: `Run the ${skill.name} skill`,
			input: { hint: "[request]" },
		});
	}
	return [...commands.values()];
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

function hasCorrelation(correlation: PromptCorrelation): boolean {
	return correlation.commandId !== undefined || correlation.turnId !== undefined;
}
function correlationsMatch(expected: PromptCorrelation, actual: PromptCorrelation): boolean {
	return (
		hasCorrelation(actual) &&
		(expected.commandId === undefined || expected.commandId === actual.commandId) &&
		(expected.turnId === undefined || expected.turnId === actual.turnId)
	);
}

function hasCompleteCorrelation(correlation: PromptCorrelation): correlation is { commandId: string; turnId: string } {
	return (
		typeof correlation.commandId === "string" &&
		correlation.commandId.trim().length > 0 &&
		typeof correlation.turnId === "string" &&
		correlation.turnId.trim().length > 0
	);
}

function correlationsExactlyMatch(expected: PromptCorrelation, actual: PromptCorrelation): boolean {
	return (
		hasCompleteCorrelation(expected) &&
		hasCompleteCorrelation(actual) &&
		expected.commandId === actual.commandId &&
		expected.turnId === actual.turnId
	);
}

function promptAcknowledgement(value: unknown): PromptCorrelation | undefined {
	const candidate = object(value);
	if (
		!candidate ||
		candidate.ok === false ||
		candidate.error !== undefined ||
		(candidate.accepted !== undefined && candidate.accepted !== true)
	)
		return undefined;
	const payload = object(candidate.result) ?? candidate;
	if (payload.accepted !== true) return undefined;
	if (typeof payload.commandId !== "string" || payload.commandId.trim().length === 0) return undefined;
	if (typeof payload.turnId !== "string" || payload.turnId.trim().length === 0) return undefined;
	return { commandId: payload.commandId, turnId: payload.turnId };
}
function strictCorrelationFrom(...values: unknown[]): PromptCorrelation | undefined {
	const correlation: PromptCorrelation = {};
	let malformed = false;
	for (const value of values) {
		const candidate = object(value);
		if (!candidate) continue;
		for (const [field, aliases] of [
			["commandId", ["commandId", "command_id"]],
			["turnId", ["turnId", "turn_id"]],
		] as const) {
			for (const alias of aliases) {
				if (!Object.hasOwn(candidate, alias)) continue;
				const identity = candidate[alias];
				if (typeof identity !== "string" || identity.trim().length === 0) {
					malformed = true;
					continue;
				}
				const previous = correlation[field];
				if (previous !== undefined && previous !== identity) malformed = true;
				correlation[field] = identity;
			}
		}
	}
	return malformed ? undefined : correlation;
}

function terminalOutcome(event: JsonObject): SdkPromptTerminalOutcome | undefined {
	const outcome = object(event.outcome);
	if (!outcome) return undefined;
	if (
		outcome.kind === "stopped" &&
		(outcome.reason === "end_turn" ||
			outcome.reason === "max_tokens" ||
			outcome.reason === "max_turn_requests" ||
			outcome.reason === "refusal" ||
			outcome.reason === "cancelled") &&
		(outcome.provenance === "agent" || outcome.provenance === "client_cancel")
	)
		return outcome as SdkPromptTerminalOutcome;
	if (
		outcome.kind === "failed" &&
		(outcome.code === "prompt_failed" || outcome.code === "prompt_deadline_exceeded") &&
		typeof outcome.message === "string" &&
		(outcome.provenance === "agent_failed" || outcome.provenance === "deadline")
	)
		return outcome as SdkPromptTerminalOutcome;
	return undefined;
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
	images: { available: false; reason: "historical_transcript_images_unavailable" };
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
		images: { available: false, reason: "historical_transcript_images_unavailable" },
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
	if (frame.type === "activity") return undefined;
	if (frame.type === "agent_start" || frame.type === "agent_end" || frame.type === "agent_failed")
		return { event: frame };
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

function modelPresetConfigOptions(query: unknown, current: string): { value: string; name: string }[] {
	const options = new Map<string, string>();
	for (const item of pageItems(query)) {
		const profile = object(item);
		if (!profile || typeof profile.id !== "string") continue;
		if (profile.available === false && profile.id !== current) continue;
		options.set(profile.id, typeof profile.displayName === "string" ? profile.displayName : profile.id);
	}
	if (current === ACP_CUSTOM_MODEL_PRESET) options.set(ACP_CUSTOM_MODEL_PRESET, "Custom (current model)");
	else if (!options.has(current)) options.set(current, current);
	return [...options].map(([value, name]) => ({ value, name }));
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

/** Maps live canonical SDK config and the selected model catalog into the ACP 1.2.1 session state surface. */
export function acpSessionStateFromConfig(query: unknown, modelCatalogQuery?: unknown, modelPreset?: string) {
	const values = configValues(query);
	const useModelPresets = modelPreset !== undefined;
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
				const value =
					option.id === MODEL_CONFIG_ID && useModelPresets
						? (values.get(MODEL_PRESET_CONFIG_KEY) ?? ACP_CUSTOM_MODEL_PRESET)
						: values.get(option.id);
				if (value === undefined) return [];
				const options =
					option.id === MODEL_CONFIG_ID
						? useModelPresets
							? modelPresetConfigOptions(modelCatalogQuery, value)
							: modelConfigOptions(modelCatalogQuery, value)
						: option.id === THINKING_CONFIG_ID
							? THINKING_CONFIG_OPTIONS
							: [...option.options];
				return [
					{
						...option,
						...(option.id === MODEL_CONFIG_ID && useModelPresets ? { name: "Preset" } : {}),
						type: "select" as const,
						currentValue: value,
						options,
					},
				];
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

/**
 * `AcpSdkAdapterError.code` is an internal string, but the SDK only derives a
 * JSON-RPC code from a `RequestError`. Everything else collapses to an opaque
 * `-32603 Internal error`, which hides the reason and defeats client-side
 * recovery (an ACP client cannot see that it must authenticate). Map the codes
 * that have a defined ACP/JSON-RPC counterpart onto a real `RequestError`.
 */
export function acpRequestFailure(error: unknown): unknown {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	if (typeof code !== "string") return error;
	const message = error instanceof Error ? error.message : code;
	switch (code) {
		case "authentication_failed":
			return RequestError.authRequired({ code, details: message }, message);
		// `not_found` stays -32603 with its discriminator in `data`: ACP's
		// `resourceNotFound` (-32002) is a URI-addressed resource error, and an unknown
		// session id is not a resource URI. Pinned ACP core-v1 conformance also requires
		// -32603/-32000 for a prompt against an unknown session.
		case "invalid_input":
		case "unsupported":
		case "unsupported_content":
			return RequestError.invalidParams({ code, details: message }, message);
		default:
			// The remaining internal codes (conflict, unavailable, busy, …) have no ACP
			// counterpart and stay -32603. Keep the discriminator in `data` so a client can
			// branch on retry/reconnect instead of parsing an English message.
			return RequestError.internalError({ code, details: message }, message);
	}
}

/** Registers a permission provider only when the ACP client requires prompts. */
export function acpProviderRegistrations(
	capabilities: ClientCapabilities | undefined,
	env: NodeJS.ProcessEnv = process.env,
): AcpProviderRegistration[] {
	return [
		// `fs.readTextFile` and `fs.writeTextFile` are independently optional, so the
		// advertised methods travel with the lease instead of being inferred as both.
		...(capabilities?.fs?.readTextFile || capabilities?.fs?.writeTextFile
			? [
					{
						capability: "fs",
						definitions: [
							...(capabilities.fs.readTextFile ? [{ name: "fs.readTextFile" }] : []),
							...(capabilities.fs.writeTextFile ? [{ name: "fs.writeTextFile" }] : []),
						],
					},
				]
			: []),
		...(capabilities?.terminal ? [{ capability: "terminal", definitions: [] }] : []),
		...(resolveAcpPermissionMode(capabilities, env) === "prompt"
			? [{ capability: "permission", definitions: [] }]
			: []),
		...(capabilities?.elicitation?.form ? [{ capability: "ui", definitions: [] }] : []),
	];
}

export function createAcpReverseConnection(connection: AgentSideConnection, sessionId: string): AcpReverseConnection {
	const methods: Record<string, string> = {
		request: "session/request_permission",
		"permission.request": "session/request_permission",
		"fs.readTextFile": "fs/read_text_file",
		"fs.writeTextFile": "fs/write_text_file",
		"terminal.create": "terminal/create",
		"ui.elicit": "elicitation/create",
	};
	return {
		request: async (
			method: string,
			params: JsonObject,
			options?: { cancellationSignal?: AbortSignal },
		): Promise<unknown> => {
			const name = methods[method];
			if (!name)
				throw new AcpSdkAdapterError("acp_reverse_unavailable", `ACP reverse method is unavailable: ${method}`);
			const rawRequest = (connection as unknown as Record<string, unknown>).request;
			if (typeof rawRequest !== "function")
				throw new AcpSdkAdapterError("acp_reverse_unavailable", "ACP reverse request surface is unavailable.");
			return await (
				rawRequest as (
					method: string,
					input: JsonObject,
					options?: { cancellationSignal?: AbortSignal },
				) => Promise<unknown>
			).call(connection, name, { ...params, sessionId }, options);
		},
	};
}

/** Maps ACP permission handling to the session's canonical SDK policy. */
export async function applyAcpPermissionMode(
	adapter: Pick<AcpSdkAdapter, "control">,
	capabilities: ClientCapabilities | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const mode = resolveAcpPermissionMode(capabilities, env);
	await adapter.control("permission_mode.set", { mode: mode === "prompt" ? "prompt" : "allow" });
}

/** Applies CLI-provided ACP startup settings through SDK controls before session exposure. */
export async function applyAcpStartupOptions(
	adapter: Pick<AcpSdkAdapter, "setModel" | "control">,
	options: AcpStartupOptions | undefined,
): Promise<void> {
	if (options?.modelId) await adapter.setModel(options.modelId);
	if (options?.thinkingLevel) await adapter.control("thinking.set", { level: options.thinkingLevel });
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
	readonly #knownSessionCwds = new Map<string, string>();
	readonly #knownSessionMetadata = new Map<string, { title?: string; updatedAt?: string }>();
	readonly #pendingDeleteLocators = new Map<string, { cwd: string; path: string }>();
	readonly #pendingCloseIdempotencyKeys = new Map<string, string>();
	readonly #sessionEpochs = new Map<string, number>();
	readonly #tearingDown = new Map<string, number>();
	readonly #closing = new Map<string, Promise<CloseSessionResponse>>();
	#clientCapabilities: ClientCapabilities | undefined;
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
			agentInfo: { name: "gajae-code", title: "Gajae Code", version: packageJson.version },
			authMethods,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { embeddedContext: true, image: true },
				mcpCapabilities: { http: true, sse: true },
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
		const mcpServers = this.#mcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		this.#assertNoAdditionalDirectories(params.additionalDirectories);
		const result = await this.#launchSessionWithMcp(
			"session.create",
			{
				cwd: params.cwd,
				target: { path: params.cwd },
				...(this.#startupOptions?.modelPreset ? { modelPreset: this.#startupOptions.modelPreset } : {}),
				...(mcpServers.length > 0 ? { mcpServers, readinessTimeoutMs: ACP_MCP_LIFECYCLE_TIMEOUT_MS } : {}),
			},
			randomUUID(),
			mcpServers,
		);
		const id = sessionId(result);
		this.#knownSessionCwds.set(id, params.cwd);
		try {
			await this.#attach(id, params.cwd, endpoint(result));
			await applyAcpStartupOptions(this.#adapter(id), this.#startupOptions);
			this.#scheduleBootstrap(id);
			return { sessionId: id, ...(await this.#sessionState(id, true)) };
		} catch (error) {
			await this.#discardNewSession(id);
			throw error;
		}
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		const mcpServers = this.#mcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		this.#assertNoAdditionalDirectories(params.additionalDirectories);
		await this.#attachExisting(params.sessionId, params.cwd, mcpServers);
		await this.#replaySession(params.sessionId);
		this.#scheduleBootstrap(params.sessionId);
		return await this.#sessionState(params.sessionId);
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		const mcpServers = this.#mcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		this.#assertNoAdditionalDirectories(params.additionalDirectories);
		await this.#attachExisting(params.sessionId, params.cwd, mcpServers);
		this.#scheduleBootstrap(params.sessionId);
		return await this.#sessionState(params.sessionId);
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		const mcpServers = this.#mcpServers(params);
		this.#assertAbsoluteCwd(params.cwd);
		this.#assertNoAdditionalDirectories(params.additionalDirectories);
		const source = await this.#resolveSavedSession(params.sessionId, params.cwd);
		const result = await this.#launchSessionWithMcp(
			"session.fork",
			{
				cwd: params.cwd,
				sourceSessionId: params.sessionId,
				sourceSessionPath: source,
				target: { path: params.cwd },
				...(mcpServers.length > 0 ? { mcpServers, readinessTimeoutMs: ACP_MCP_LIFECYCLE_TIMEOUT_MS } : {}),
			},
			randomUUID(),
			mcpServers,
		);
		const id = sessionId(result);
		this.#knownSessionCwds.set(id, params.cwd);
		try {
			await this.#attach(id, params.cwd, endpoint(result));
			this.#scheduleBootstrap(id);
			return { sessionId: id, ...(await this.#sessionState(id)) };
		} catch (error) {
			await this.#discardNewSession(id);
			throw error;
		}
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		if (params.cwd) this.#assertAbsoluteCwd(params.cwd);
		const result = object(await (await this.#brokerAdapter()).global("session.list"));
		const listing = object(result?.result) ?? result;
		const listed = Array.isArray(listing?.sessions) ? listing.sessions : [];
		if (params.cwd) {
			const discovered = new Set<string>();
			for (const session of listed) {
				const candidate = object(session) as BrokerSession | undefined;
				if (
					typeof candidate?.sessionId !== "string" ||
					typeof candidate.locator?.repo !== "string" ||
					path.resolve(candidate.locator.repo) !== path.resolve(params.cwd)
				)
					continue;
				if (discovered.has(candidate.sessionId))
					throw new AcpSdkAdapterError("conflict", `Broker returned duplicate session id: ${candidate.sessionId}`);
				discovered.add(candidate.sessionId);
				const knownCwd = this.#knownSessionCwds.get(candidate.sessionId);
				if (knownCwd && path.resolve(knownCwd) !== path.resolve(params.cwd))
					throw new AcpSdkAdapterError(
						"conflict",
						`ACP session ${candidate.sessionId} has conflicting cwd authority.`,
					);
				this.#knownSessionCwds.set(candidate.sessionId, params.cwd);
			}
		}
		return paginateAcpSessions(
			listed,
			params.cwd ?? undefined,
			this.#cursor(params.cursor),
			this.#knownSessionMetadata,
		);
	}

	closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		const cwd = record?.cwd ?? this.#knownSessionCwds.get(params.sessionId);
		// ACP close has no cwd. Only connection-owned sessions may reach broker lifecycle control.
		if (!cwd) return Promise.resolve({});
		const existing = this.#closing.get(params.sessionId);
		if (existing) return existing;
		const deferred = Promise.withResolvers<CloseSessionResponse>();
		this.#closing.set(params.sessionId, deferred.promise);
		void this.#closeOwnedSession(params.sessionId).then(deferred.resolve, deferred.reject);
		const cleanup = deferred.promise.finally(() => {
			if (this.#closing.get(params.sessionId) === deferred.promise) this.#closing.delete(params.sessionId);
		});
		void cleanup.catch(() => undefined);
		return deferred.promise;
	}

	async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		const pendingLocator = this.#pendingDeleteLocators.get(params.sessionId);
		const cwd = record?.cwd ?? this.#knownSessionCwds.get(params.sessionId) ?? pendingLocator?.cwd;
		// ACP's delete request has no cwd. Unknown ids remain the protocol no-op,
		// while the broker can reconstruct an authenticated pending locator from its durable ledger.
		if (!cwd) {
			await (await this.#brokerAdapter()).global(
				"session.delete",
				{ sessionId: params.sessionId },
				this.#lifecycleIdempotencyKey(params.sessionId, "session.delete"),
			);
			return {};
		}
		this.#beginTeardown(params.sessionId);
		try {
			await this.#teardownSession(params.sessionId, "deleted", true);
			let saved = pendingLocator?.cwd === cwd ? pendingLocator.path : undefined;
			if (!saved) {
				try {
					saved = await this.#resolveSavedSession(params.sessionId, cwd);
				} catch (error) {
					if (error instanceof AcpSdkAdapterError && error.code === "not_found") {
						this.#knownSessionCwds.delete(params.sessionId);
						this.#knownSessionMetadata.delete(params.sessionId);
						return {};
					}
					throw error;
				}
			}
			this.#pendingDeleteLocators.set(params.sessionId, { cwd, path: saved });
			await (await this.#brokerAdapter()).global(
				"session.delete",
				{ sessionId: params.sessionId, sessionPath: saved, cwd, target: { path: cwd } },
				this.#lifecycleIdempotencyKey(params.sessionId, "session.delete"),
			);
			this.#knownSessionCwds.delete(params.sessionId);
			this.#knownSessionMetadata.delete(params.sessionId);
			this.#pendingDeleteLocators.delete(params.sessionId);
			return {};
		} finally {
			this.#finishTeardown(params.sessionId);
		}
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		if (params.modeId !== ACP_DEFAULT_MODE_ID && params.modeId !== ACP_PLAN_MODE_ID)
			throw new Error(`Unsupported ACP mode: ${params.modeId}`);
		await this.#adapter(params.sessionId).control("mode.plan.set", { on: params.modeId === ACP_PLAN_MODE_ID });
		await this.#publishSessionUpdate(params.sessionId, {
			sessionId: params.sessionId,
			update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
		});
		return {};
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		if (typeof params.value !== "string")
			throw new Error(`Unsupported boolean ACP config option: ${params.configId}`);
		switch (params.configId) {
			case MODE_CONFIG_ID:
				await this.setSessionMode({ sessionId: params.sessionId, modeId: params.value });
				break;
			case MODEL_CONFIG_ID:
				if (this.#startupOptions?.modelPreset === undefined) {
					await this.#adapter(params.sessionId).setModel(params.value);
				} else if (params.value !== ACP_CUSTOM_MODEL_PRESET) {
					await this.#adapter(params.sessionId).control("model.profile.set", { id: params.value });
				}
				break;
			case THINKING_CONFIG_ID:
				await this.#adapter(params.sessionId).control("thinking.set", { level: params.value });
				break;
			default: {
				const operation = ACP_CONFIG_CONTROL_OPERATIONS[params.configId];
				if (!operation) throw new Error(`Unknown ACP config option: ${params.configId}`);
				await this.#adapter(params.sessionId).control(operation, { mode: params.value });
			}
		}
		const state = await this.#sessionState(params.sessionId);
		await this.#publishSessionUpdate(params.sessionId, {
			sessionId: params.sessionId,
			update: { sessionUpdate: "config_option_update", configOptions: state.configOptions ?? [] },
		});
		return { configOptions: state.configOptions ?? [] };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const record = this.#sessions.get(params.sessionId);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unknown session, not found: ${params.sessionId}`);
		if (record.activePrompt) throw new AcpSdkAdapterError("conflict", "ACP session already has an active prompt.");
		if (record.authFailure) throw new AcpSdkAdapterError("authentication_failed", record.authFailure);
		const payload = acpPromptPayload(params.prompt);
		let waiter!: PromptWaiter;
		const response = new Promise<PromptResponse>((resolve, reject) => {
			waiter = {
				acknowledged: false,
				boundary: record.inboundSequence,
				correlation: {},
				emittedAssistantText: "",
				settled: false,
				deferredFrames: [],
				resolve,
				reject,
			};
			record.activePrompt = waiter;
		});
		try {
			const acknowledgement = await record.adapter.prompt({
				text: payload.text,
				...(payload.images.length ? { images: payload.images } : {}),
			});
			const acknowledgementCorrelation = promptAcknowledgement(acknowledgement);
			if (!acknowledgementCorrelation)
				throw new AcpSdkAdapterError(
					"invalid_prompt_acknowledgement",
					"SDK prompt acknowledgement must accept the prompt and include commandId and turnId.",
				);
			// Retain the acknowledgement ingress boundary with its complete correlation.
			waiter.boundary = record.inboundSequence;
			waiter.correlation = acknowledgementCorrelation;
			waiter.acknowledged = true;
			// Frames held while ownership was unknown belong to this prompt only when the
			// acknowledgement proves their complete correlation matches exactly.
			const deferred = waiter.deferredFrames.splice(0);
			for (const deferredFrame of deferred)
				if (correlationsExactlyMatch(waiter.correlation, correlationFrom(deferredFrame)))
					record.frameTail = record.frameTail.then(
						async () => await this.#handleSdkFrame(params.sessionId, record.adapter, deferredFrame),
					);
			this.#settlePrompt(record, waiter);
		} catch (error) {
			waiter.deferredFrames.length = 0;
			waiter.terminal = undefined;
			waiter.settled = true;
			if (record.activePrompt === waiter) record.activePrompt = undefined;
			throw error;
		}
		return await response;
	}

	async cancel(params: { sessionId: string }): Promise<void> {
		const record = this.#sessions.get(params.sessionId);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unknown session, not found: ${params.sessionId}`);
		const acknowledgement = await record.adapter.cancel();
		const result = object(object(acknowledgement)?.result) ?? object(acknowledgement);
		if (result?.aborted !== true)
			throw new AcpSdkAdapterError(
				"abort_unacknowledged",
				"SDK did not acknowledge cancellation of the active prompt.",
			);
	}

	async extMethod(method: string, params: JsonObject): Promise<JsonObject> {
		// An unrecognized extension method is a protocol failure, not an application
		// result: it must reach the client as JSON-RPC -32601 rather than a resolved
		// payload. Recognized `_gjc/*` methods keep their `{ok:false}` result contract.
		if (
			method !== "session/set_model" &&
			method !== "_gjc/sdk/global" &&
			method !== "_gjc/sdk/control" &&
			method !== "_gjc/sdk/query"
		)
			throw RequestError.methodNotFound(method);
		try {
			if (method === "session/set_model") {
				const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
				const modelId = typeof params.modelId === "string" ? params.modelId : undefined;
				if (!sessionId) throw new AcpSdkAdapterError("invalid_input", "sessionId is required.");
				if (!modelId) throw new AcpSdkAdapterError("invalid_input", "modelId is required.");
				await this.setSessionConfigOption({ sessionId, configId: MODEL_CONFIG_ID, value: modelId });
				return {};
			}
			if (method === "_gjc/sdk/global") {
				const result = await (await this.#brokerAdapter()).handle(method, params);
				return object(result) ?? {};
			}
			const id = typeof params.sessionId === "string" ? params.sessionId : undefined;
			if (!id) throw new AcpSdkAdapterError("invalid_input", "sessionId is required.");
			const result = await this.#adapter(id).handle(method, params);
			return object(result) ?? {};
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

	#lifecycleIdempotencyKey(id: string, operation: "session.close" | "session.delete"): string {
		return `acp:${operation}:${id}`;
	}

	#isAlreadyGone(error: unknown): boolean {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			((error.code === "not_found" || error.code === "resource_gone") as boolean)
		);
	}

	#isDefinitiveBrokerResponse(error: unknown): boolean {
		// Response-derived client errors retain the broker error as details. Responses
		// that represent ongoing or ambiguous lifecycle work must keep their key.
		if (!(error instanceof SdkClientError)) return false;
		const details = object(error.details);
		if (details?.code !== error.code || details.message !== error.message) return false;
		return !["terminal_uncertain", "cleanup_pending", "broker_restarting", "unavailable"].includes(error.code);
	}

	async #attachExisting(id: string, cwd: string, mcpServers: SessionLifecycleMcpServer[] = []): Promise<void> {
		const epoch = this.#sessionEpoch(id);
		const attached = this.#sessions.get(id);
		if (attached) {
			if (path.resolve(attached.cwd) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			// ACP clients replay their declared MCP servers when reconnecting. The live
			// session host remains authoritative for its immutable configuration, so
			// attachment must not reinterpret the replay as a mutation request.
			return;
		}
		const knownCwd = this.#knownSessionCwds.get(id);
		if (knownCwd && path.resolve(knownCwd) !== path.resolve(cwd))
			throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
		const resolving = this.#resolvingExisting.get(id);
		if (resolving?.epoch === epoch) {
			await resolving.task;
			this.#assertSessionEpoch(id, epoch);
			const resolved = this.#sessions.get(id);
			if (!resolved) throw new AcpSdkAdapterError("unavailable", `ACP session ${id} did not attach.`);
			if (path.resolve(resolved.cwd) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			return;
		}

		const task = this.#resolveExistingAttachment(id, cwd, epoch, mcpServers);
		const pending = { epoch, task };
		this.#resolvingExisting.set(id, pending);
		try {
			await task;
			this.#assertSessionEpoch(id, epoch);
		} finally {
			if (this.#resolvingExisting.get(id) === pending) this.#resolvingExisting.delete(id);
		}
	}

	async #resolveExistingAttachment(
		id: string,
		cwd: string,
		epoch: number,
		mcpServers: SessionLifecycleMcpServer[],
	): Promise<void> {
		this.#assertSessionEpoch(id, epoch);
		const indexed = await this.#scopedBrokerSession(id, cwd);
		this.#assertSessionEpoch(id, epoch);
		if (indexed?.live) {
			// A reconnect may repeat the client's MCP declaration. Attaching to the
			// existing endpoint preserves the live host's immutable configuration.
			const result = await this.#brokerEndpoint(id, indexed.endpointGeneration);
			this.#assertSessionEpoch(id, epoch);
			await this.#attach(id, cwd, endpoint(result), epoch);
			return;
		}

		const saved = await this.#resolveSavedSession(id, cwd);
		this.#assertSessionEpoch(id, epoch);
		const result = await this.#launchSessionWithMcp(
			"session.resume",
			{
				cwd,
				sessionId: id,
				sessionPath: saved,
				target: { path: cwd },
				...(mcpServers.length > 0 ? { mcpServers, readinessTimeoutMs: ACP_MCP_LIFECYCLE_TIMEOUT_MS } : {}),
			},
			randomUUID(),
			mcpServers,
		);
		this.#assertSessionEpoch(id, epoch);
		await this.#attach(id, cwd, endpoint(result), epoch);
	}

	async #scopedBrokerSession(id: string, cwd: string): Promise<BrokerSession | undefined> {
		const response = object(await (await this.#brokerAdapter()).global("session.list", { cwd }));
		const result = object(response?.result) ?? response;
		const matches: BrokerSession[] = [];
		for (const item of Array.isArray(result?.sessions) ? result.sessions : []) {
			const session = object(item) as BrokerSession | undefined;
			if (session?.sessionId !== id) continue;
			if (typeof session.locator?.repo !== "string" || path.resolve(session.locator.repo) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `Broker returned conflicting session scope for ${id}.`);
			matches.push(session);
		}
		if (matches.length > 1) throw new AcpSdkAdapterError("conflict", `Broker returned duplicate session id: ${id}`);
		return matches[0];
	}

	async #attach(id: string, cwd: string, discovered: Endpoint, epoch = this.#sessionEpoch(id)): Promise<void> {
		this.#assertSessionEpoch(id, epoch);
		const existing = this.#sessions.get(id);
		if (existing) {
			if (path.resolve(existing.cwd) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
			return;
		}
		const attaching = this.#attaching.get(id);
		if (attaching?.epoch === epoch) {
			await attaching.task;
			this.#assertSessionEpoch(id, epoch);
			const attached = this.#sessions.get(id);
			if (!attached) throw new AcpSdkAdapterError("unavailable", `ACP session ${id} did not attach.`);
			if (path.resolve(attached.cwd) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
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
			adapter = await AcpSdkAdapter.connect({
				url: discovered.url,
				token: discovered.token,
				connection: this.#reverseConnection(id),
				providers: this.#providers(),
			});
			let capabilities: JsonObject | undefined;
			try {
				const response = object(await adapter.query("runtime.capabilities"));
				const result = object(response?.result) ?? response;
				// Q18 is a paged query surface: the capability object arrives as the single
				// page item, so fall back to the envelope only for direct-result hosts.
				capabilities = object(pageItems(result)[0]) ?? result;
			} catch {}
			if (capabilities?.promptTerminalOutcomeVersion !== 1)
				throw new AcpSdkAdapterError(
					"unavailable",
					"This ACP client requires a newer GJC SDK session; restart the session.",
				);
			this.#assertSessionEpoch(id, epoch);
			const record: SessionRecord = {
				cwd,
				adapter,
				closeIdempotencyKey: randomUUID(),
				unsubscribe: () => {},
				reconnectUnsubscribe: () => {},
				frameTail: Promise.resolve(),
				settledPromptCorrelations: [],
				inboundSequence: 0,
				connectionId: adapter.connectionId,
				busy: false,
				toolArgs: new Map(),
			};
			record.unsubscribe = adapter.onFrame(frame => this.#enqueueSdkFrame(id, adapter!, frame));
			record.reconnectUnsubscribe = adapter.onReconnectFailed(error =>
				this.#recoverSessionAfterTransportFailure(id, adapter!, error),
			);
			this.#sessions.set(id, record);
			this.#knownSessionCwds.set(id, cwd);
			await applyAcpPermissionMode(adapter, this.#clientCapabilities);
			this.#assertSessionEpoch(id, epoch);
			this.#pendingCloseIdempotencyKeys.delete(id);
		} catch (error) {
			if (adapter && this.#sessions.get(id)?.adapter === adapter) {
				try {
					await this.#teardownSession(id, "attachment failed", false);
				} finally {
					this.#knownSessionCwds.delete(id);
				}
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
		if (this.#disposed || this.#knownSessionCwds.get(id) !== cwd) return;
		try {
			await this.#attachExisting(id, cwd);
		} catch {
			// The affected prompt was rejected and the stale adapter was removed. A later load/resume retries discovery.
		}
	}

	async #discardNewSession(id: string): Promise<void> {
		await this.#teardownSession(id, "discarded", true);
		this.#knownSessionCwds.delete(id);
		this.#knownSessionMetadata.delete(id);
	}

	async #closeOwnedSession(id: string): Promise<CloseSessionResponse> {
		this.#beginTeardown(id);
		try {
			const attaching = this.#attaching.get(id);
			// The record is published before permission initialization. Let a canceled
			// provisional attachment retire it before selecting the generation key.
			if (attaching) await Promise.allSettled([attaching.task]);
			await this.#teardownSession(id, "closed", true);
			this.#knownSessionCwds.delete(id);
			this.#knownSessionMetadata.delete(id);
			return {};
		} finally {
			this.#finishTeardown(id);
		}
	}

	/**
	 * All local session disposal follows one path: remove ownership and reject a
	 * waiting prompt before any awaited socket or broker work. A failed close is
	 * terminally uncertain, not a reason to leave a usable-looking ACP record.
	 */
	async #teardownSession(id: string, reason: string, closeRemote: boolean): Promise<void> {
		const record = this.#sessions.get(id);
		const ownershipBound = record !== undefined || this.#knownSessionCwds.has(id);
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

			const failures: unknown[] = [];
			try {
				await record?.adapter.close();
			} catch (error) {
				failures.push(error);
			}
			if (closeRemote) {
				const closeIdempotencyKey =
					record?.closeIdempotencyKey ?? this.#pendingCloseIdempotencyKeys.get(id) ?? randomUUID();
				this.#pendingCloseIdempotencyKeys.set(id, closeIdempotencyKey);
				try {
					await (await this.#brokerAdapter()).global("session.close", { sessionId: id }, closeIdempotencyKey);
				} catch (error) {
					if (this.#isDefinitiveBrokerResponse(error)) this.#pendingCloseIdempotencyKeys.delete(id);
					if (!(ownershipBound && this.#isAlreadyGone(error))) failures.push(error);
				}
			}
			if (failures.length > 0) {
				const detail = failures
					.map(failure => (failure instanceof Error ? failure.message : String(failure)))
					.join("; ");
				throw aggregateAcpFailure("terminal_uncertain", `ACP session cleanup is uncertain: ${detail}`, failures);
			}
			if (closeRemote) this.#pendingCloseIdempotencyKeys.delete(id);
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
	async #brokerEndpoint(sessionId: string, endpointGeneration: number | undefined): Promise<unknown> {
		const input = { sessionId, ...(endpointGeneration === undefined ? {} : { endpointGeneration }) };
		return await (await this.#brokerConnection()).client.global("session.get_endpoint", input);
	}

	async #brokerConnection(): Promise<BrokerConnection> {
		if (!this.#broker) {
			let pending!: Promise<BrokerConnection>;
			pending = (async () => {
				await ensureBroker({ agentDir: this.#agentDir });
				const discovery = await readSdkBrokerDiscovery(this.#agentDir);
				if (!discovery) throw new AcpSdkAdapterError("unavailable", "SDK broker discovery is unavailable.");
				const client = await SdkClient.connect(discovery.url, discovery.token);
				const adapter = new AcpSdkAdapter({ url: discovery.url, token: discovery.token, client });
				adapter.onReconnectFailed(() => {
					if (this.#broker === pending) this.#broker = undefined;
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
			if (this.#broker === pending) this.#broker = undefined;
			throw error;
		}
	}

	#adapter(id: string): AcpSdkAdapter {
		const record = this.#sessions.get(id);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unknown session, not found: ${id}`);
		return record.adapter;
	}

	async #resolveSavedSession(id: string, cwd: string): Promise<string> {
		const response = object(
			await (await this.#brokerAdapter()).global("session.list", { resolveSessionId: id, cwd }),
		);
		const result = object(response?.result) ?? response;
		const saved = object(result?.savedSession);
		if (saved?.id !== id || typeof saved.path !== "string")
			throw new AcpSdkAdapterError("not_found", `Saved ACP session does not exist: ${id}`);
		return saved.path;
	}

	#providers(): AcpProviderRegistration[] {
		return acpProviderRegistrations(this.#clientCapabilities);
	}

	#reverseConnection(sessionId: string): AcpReverseConnection {
		return createAcpReverseConnection(this.#connection, sessionId);
	}

	#observeSessionActivity(record: SessionRecord, frame: JsonObject): void {
		if (frame.type === "activity") {
			if (frame.state === "busy") record.busy = true;
			else if (frame.state === "idle") record.busy = false;
			return;
		}
		const event = receivedSdkEvent(frame)?.event;
		if (event?.type === "agent_start") record.busy = true;
		else if (event?.type === "agent_end" || event?.type === "agent_failed") record.busy = false;
	}

	#frameProcessingFailure(error: unknown): AcpSdkAdapterError {
		if (error instanceof AcpSdkAdapterError && error.code === "frame_processing_failed") return error;
		const detail = error instanceof Error ? error.message : String(error);
		return new AcpSdkAdapterError("frame_processing_failed", `ACP session frame processing failed: ${detail}`);
	}

	#enqueueSdkFrame(id: string, adapter: AcpSdkAdapter, frame: JsonObject): void {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		// Ingress ordering is recorded before queued work begins.
		this.#observeSessionActivity(record, frame);
		++record.inboundSequence;
		const task = record.frameTail.then(async () => await this.#handleSdkFrame(id, adapter, frame));
		record.frameTail = task.catch(
			async error => await this.#failSession(id, adapter, this.#frameProcessingFailure(error)),
		);
	}

	async #handleSdkFrame(id: string, adapter: AcpSdkAdapter, frame: JsonObject): Promise<void> {
		const record = this.#sessions.get(id);
		if (!record || record.adapter !== adapter) return;
		if ((frame.type === "hello" || frame.type === "server_hello") && typeof frame.connectionId === "string") {
			const reconnected = record.connectionId !== undefined && record.connectionId !== frame.connectionId;
			record.connectionId = frame.connectionId;
			if (reconnected) {
				const waiter = record.activePrompt;
				if (waiter && !waiter.settled && !waiter.terminal) {
					record.activePrompt = undefined;
					waiter.settled = true;
					if (hasCorrelation(waiter.correlation)) {
						record.settledPromptCorrelations.push(waiter.correlation);
						while (record.settledPromptCorrelations.length > SETTLED_PROMPT_CORRELATION_RETENTION)
							record.settledPromptCorrelations.shift();
					}
					waiter.reject(
						new AcpSdkAdapterError(
							"connection_closed",
							"The prompt owner connection was lost before completion.",
						),
					);
				}
			}
			return;
		}
		const received = receivedSdkEvent(frame);
		if (!received) return;
		const { event, wirePayload } = received;
		const isTerminal = event.type === "agent_end" || event.type === "agent_failed";
		const correlation = (isTerminal ? strictCorrelationFrom(frame, event) : correlationFrom(frame, event)) ?? {};
		const activePrompt = record.activePrompt;
		const outcome = isTerminal ? terminalOutcome(event) : undefined;
		if (isTerminal) {
			// Terminal ownership requires a complete identity. Unowned, partial, and
			// duplicate terminals are never allowed to publish or query anything.
			if (!hasCompleteCorrelation(correlation) || !activePrompt || activePrompt.settled) return;
			if (!activePrompt.acknowledged) {
				// Hold the entire frame until the prompt acknowledgement proves ownership.
				activePrompt.deferredFrames.push(frame);
				return;
			}
			if (!correlationsExactlyMatch(activePrompt.correlation, correlation) || activePrompt.terminal) return;
			if (!outcome) {
				const detail =
					typeof (event as { error?: { message?: unknown } }).error?.message === "string"
						? (event as { error: { message: string } }).error.message
						: "the prompt terminal omitted a valid normalized outcome";
				this.#rejectPrompt(
					record,
					activePrompt,
					new AcpSdkAdapterError("connection_closed", `ACP prompt terminal was invalid: ${detail}`),
				);
				return;
			}
			activePrompt.terminal = { outcome, correlation };
		}
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		if (
			toolCallId &&
			(event.type === "tool_execution_start" || event.type === "tool_execution_update") &&
			"args" in event
		) {
			record.toolArgs.set(toolCallId, event.args);
		}
		const settledCorrelation = record.settledPromptCorrelations.some(settled =>
			correlationsMatch(settled, correlation),
		);
		if (settledCorrelation) {
			// Frames for an already-settled correlation stay closed until an active prompt
			// acknowledges the exact same identity.
			if (activePrompt && !activePrompt.settled && !activePrompt.acknowledged) {
				activePrompt.deferredFrames.push(frame);
				return;
			}
			if (!activePrompt || activePrompt.settled || !correlationsMatch(activePrompt.correlation, correlation)) return;
		}
		// After a correlated settlement with no active prompt, correlationless wire frames
		// have no prompt to belong to and must not publish further updates.
		if (!record.activePrompt && record.settledPromptCorrelations.length > 0 && !hasCorrelation(correlation)) return;
		if (wirePayload) {
			for (const notification of mapAgentWireEventPayloadToAcpSessionUpdates(wirePayload as never, id, {
				cwd: record.cwd,
				getToolArgs: id => record.toolArgs.get(id),
				getMessageProgress: message => {
					if (!activePrompt || !object(message)) return undefined;
					activePrompt.messageProgress ??= { textEmitted: false, thoughtEmitted: false };
					return activePrompt.messageProgress;
				},
			})) {
				if (
					activePrompt &&
					notification.update.sessionUpdate === "agent_message_chunk" &&
					notification.update.content.type === "text"
				)
					activePrompt.emittedAssistantText += notification.update.content.text;
				await this.#publishSessionUpdate(id, notification, adapter);
			}
		}
		if (toolCallId && event.type === "tool_execution_end") record.toolArgs.delete(toolCallId);
		if (event.type === "agent_start") {
			await this.#publishSessionUpdate(
				id,
				{
					sessionId: id,
					update: {
						sessionUpdate: "session_info_update",
						updatedAt: new Date().toISOString(),
						_meta: { gjcPhase: "working", running: true, gjcRunning: true },
					},
				},
				adapter,
			);
		}
		if (event.type === "message_end" && object(event.message)?.role === "assistant" && activePrompt)
			activePrompt.messageProgress = undefined;
		if (event.type === "agent_end") {
			const finalText = typeof event.finalText === "string" ? event.finalText : "";
			if (activePrompt && finalText) {
				const resolution = resolveAcpFinalText(activePrompt.emittedAssistantText, finalText);
				if (resolution.kind === "emit") {
					activePrompt.emittedAssistantText += resolution.text;
					await this.#publishSessionUpdate(
						id,
						{
							sessionId: id,
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: resolution.text },
								...(resolution.final.truncated ? { _meta: { gjcFinalTextTruncated: true } } : {}),
							},
						},
						adapter,
					);
				} else if (resolution.kind === "divergent") {
					logger.warn("acp_final_text_diverged", {
						sessionId: id,
						...(activePrompt.correlation.commandId ? { commandId: activePrompt.correlation.commandId } : {}),
						...(activePrompt.correlation.turnId ? { turnId: activePrompt.correlation.turnId } : {}),
						streamedLength: activePrompt.emittedAssistantText.length,
						finalLength: resolution.final.text.length,
					});
				}
			}
			await this.#emitEndOfTurnUpdates(id, adapter);
		} else if (event.type === "agent_failed") {
			await this.#emitEndOfTurnUpdates(id, adapter);
		}
		if (activePrompt) this.#settlePrompt(record, activePrompt);
	}

	#rejectPrompt(record: SessionRecord, waiter: PromptWaiter, error: AcpSdkAdapterError): void {
		if (record.activePrompt !== waiter || waiter.settled) return;
		record.activePrompt = undefined;
		waiter.settled = true;
		waiter.deferredFrames.length = 0;
		waiter.terminal = undefined;
		if (hasCompleteCorrelation(waiter.correlation)) {
			record.settledPromptCorrelations.push(waiter.correlation);
			while (record.settledPromptCorrelations.length > SETTLED_PROMPT_CORRELATION_RETENTION)
				record.settledPromptCorrelations.shift();
		}
		waiter.reject(error);
	}

	#settlePrompt(record: SessionRecord, waiter: PromptWaiter): void {
		if (record.activePrompt !== waiter || waiter.settled || !waiter.acknowledged || !waiter.terminal) return;
		// A terminal captured before acknowledgement is only this prompt's terminal when the
		// eventual acknowledgement correlates with it; otherwise it belonged to an earlier prompt.
		if (!correlationsExactlyMatch(waiter.correlation, waiter.terminal.correlation)) {
			waiter.terminal = undefined;
			return;
		}
		record.activePrompt = undefined;
		waiter.settled = true;
		if (hasCorrelation(waiter.correlation)) {
			record.settledPromptCorrelations.push(waiter.correlation);
			while (record.settledPromptCorrelations.length > SETTLED_PROMPT_CORRELATION_RETENTION)
				record.settledPromptCorrelations.shift();
		}
		const { outcome } = waiter.terminal;
		if (outcome.kind === "stopped") {
			waiter.resolve({ stopReason: outcome.reason });
			return;
		}
		waiter.reject(new AcpSdkAdapterError(outcome.code, outcome.message));
	}

	async #emitEndOfTurnUpdates(id: string, adapter: AcpSdkAdapter): Promise<void> {
		let usage: JsonObject | undefined;
		let title: string | undefined;
		try {
			const response = object(await adapter.query("context.get"));
			const result = object(response?.result) ?? response;
			usage = object(result?.usage);
		} catch {
			// Context usage is advisory ACP metadata; prompt completion remains authoritative.
		}
		try {
			const response = object(await adapter.query("session.metadata"));
			const result = object(response?.result) ?? response;
			const metadata = pageItems(result)[0];
			const item = object(metadata);
			if (typeof item?.name === "string" && item.name) title = item.name;
		} catch {
			// Session naming is advisory; prompt completion remains authoritative.
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
		const updatedAt = new Date().toISOString();
		this.#knownSessionMetadata.set(id, { ...(title ? { title } : {}), updatedAt });
		await this.#publishSessionUpdate(
			id,
			{
				sessionId: id,
				update: {
					sessionUpdate: "session_info_update",
					...(title ? { title } : {}),
					updatedAt,
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

	async #sessionState(
		id: string,
		rejectUnavailableStartupPreset = false,
	): Promise<Pick<NewSessionResponse, "configOptions" | "modes">> {
		const record = this.#sessions.get(id);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unknown session, not found: ${id}`);
		const modelPreset = this.#startupOptions?.modelPreset;
		const [config, modelCatalog] = await Promise.all([
			record.adapter.query("config.list/get"),
			record.adapter.query(modelPreset === undefined ? "models.list/current" : "models.profiles.list"),
		]);
		record.authFailure = undefined;
		if (modelPreset !== undefined) {
			const activePreset = configValues(config).get(MODEL_PRESET_CONFIG_KEY);
			const activeProfile = pageItems(modelCatalog)
				.map(item => object(item))
				.find(item => item?.id === activePreset);
			if (activePreset && activeProfile?.available === false) {
				record.authFailure =
					`Model preset "${activePreset}" has no usable provider credentials. ` +
					"Authenticate the required provider in Gajae Code or select an available preset before prompting.";
				if (rejectUnavailableStartupPreset && activePreset === modelPreset)
					throw new AcpSdkAdapterError("authentication_failed", record.authFailure);
			}
		}
		return acpSessionStateFromConfig(config, modelCatalog, modelPreset);
	}

	async #publishAvailableCommands(id: string, adapter: AcpSdkAdapter): Promise<void> {
		let skills: unknown;
		try {
			skills = await adapter.query("skill.list/state");
		} catch {
			// Builtins remain useful when an older SDK host cannot expose skill state.
		}
		await this.#publishSessionUpdate(
			id,
			{
				sessionId: id,
				update: {
					sessionUpdate: "available_commands_update",
					availableCommands: acpAvailableCommandsFromSkills(skills),
				},
			},
			adapter,
		);
	}

	async #replaySession(id: string): Promise<void> {
		const adapter = this.#adapter(id);
		const record = this.#sessions.get(id);
		if (!record) return;
		let cursor: string | undefined;
		let imageLimitationReported = false;
		const replayTools = new Map<string, { name: string; args: unknown }>();
		for (let pageCount = 0; pageCount < MAX_ACP_REPLAY_PAGES; pageCount++) {
			const response = object(await adapter.query("transcript.list", {}, cursor));
			const result = object(response?.result) ?? response;
			const page = object(result?.page);
			for (const item of Array.isArray(page?.items) ? page.items : []) {
				const message = object(item);
				if (!message) continue;
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
				const richContent = Array.isArray(message.content) ? message.content : undefined;
				if ((message.role === "user" || message.role === "assistant") && richContent) {
					for (const rawBlock of richContent) {
						const block = object(rawBlock);
						if (!block || typeof block.type !== "string") continue;
						if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
							await this.#publishSessionUpdate(
								id,
								{
									sessionId: id,
									update: {
										sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
										content: { type: "text", text: block.text },
										...(messageId ? { messageId } : {}),
									},
								},
								adapter,
							);
						} else if (
							message.role === "assistant" &&
							block.type === "thinking" &&
							typeof block.thinking === "string" &&
							block.thinking.length > 0
						) {
							await this.#publishSessionUpdate(
								id,
								{
									sessionId: id,
									update: {
										sessionUpdate: "agent_thought_chunk",
										content: { type: "text", text: block.thinking },
										...(messageId ? { messageId } : {}),
									},
								},
								adapter,
							);
						} else if (
							message.role === "assistant" &&
							block.type === "toolCall" &&
							typeof block.id === "string" &&
							typeof block.name === "string"
						) {
							const args = block.arguments ?? {};
							replayTools.set(block.id, { name: block.name, args });
							await this.#publishSessionUpdate(
								id,
								{
									sessionId: id,
									update: buildToolCallStartUpdate({
										toolCallId: block.id,
										toolName: block.name,
										args,
										cwd: record.cwd,
									}),
								},
								adapter,
							);
						}
					}
					continue;
				}
				if (message.role === "toolResult" && typeof message.toolCallId === "string") {
					const replayTool = replayTools.get(message.toolCallId);
					const toolName = typeof message.toolName === "string" ? message.toolName : replayTool?.name;
					if (!toolName) continue;
					const resultContent = richContent
						?.map(object)
						.filter(
							(block): block is JsonObject =>
								block !== undefined && block.type === "text" && typeof block.text === "string",
						)
						.map(block => ({ type: "text" as const, text: String(block.text) }));
					for (const notification of mapAgentSessionEventToAcpSessionUpdates(
						{
							type: "tool_execution_end",
							toolCallId: message.toolCallId,
							toolName,
							result: { content: resultContent ?? content.blocks },
							isError: message.isError === true,
						} as never,
						id,
						{ cwd: record.cwd, getToolArgs: toolCallId => replayTools.get(toolCallId)?.args },
					)) {
						await this.#publishSessionUpdate(id, notification, adapter);
					}
					replayTools.delete(message.toolCallId);
					continue;
				}
				if (message.role !== "user" && message.role !== "assistant") continue;
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
			void (async () => {
				await this.#publishAvailableCommands(id, record.adapter);
				if (record.authFailure) {
					await this.#publishSessionUpdate(
						id,
						{
							sessionId: id,
							update: {
								sessionUpdate: "agent_thought_chunk",
								content: { type: "text", text: `[error:auth] ${record.authFailure}\n` },
							},
						},
						record.adapter,
					);
				}
				await this.#publishSessionUpdate(
					id,
					{
						sessionId: id,
						update: {
							sessionUpdate: "session_info_update",
							_meta: { gjcPhase: "idle", running: false, gjcRunning: false },
						},
					},
					record.adapter,
				);
			})().catch(() => undefined);
		}, ACP_BOOTSTRAP_RACE_GUARD_MS);
	}

	#cursor(cursor: string | null | undefined): number {
		if (!cursor) return 0;
		const value = Number.parseInt(cursor, 10);
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ACP session cursor: ${cursor}`);
		return value;
	}

	#assertAbsoluteCwd(cwd: string): void {
		if (!path.isAbsolute(cwd)) throw new Error(`ACP cwd must be an absolute path: ${cwd}`);
	}

	#assertNoAdditionalDirectories(directories: string[] | null | undefined): void {
		if (directories && directories.length > 0)
			throw new AcpSdkAdapterError("unsupported", "ACP additional directories are not supported.");
	}

	#mcpServers(params: { mcpServers?: unknown[] }): SessionLifecycleMcpServer[] {
		const servers = params.mcpServers ?? [];
		if (servers.length > 64)
			throw new AcpSdkAdapterError("unsupported", "ACP supports at most 64 MCP servers per session.");
		const result: SessionLifecycleMcpServer[] = [];
		const names = new Set<string>();
		for (const value of servers) {
			if (typeof value !== "object" || value === null || Array.isArray(value))
				throw new AcpSdkAdapterError("invalid_input", "ACP MCP server definitions must be objects.");
			const server = value as Record<string, unknown>;
			if (typeof server.name !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(server.name) || names.has(server.name))
				throw new AcpSdkAdapterError("invalid_input", "ACP MCP servers must have unique safe names.");
			names.add(server.name);
			if (server.type === "http" || server.type === "sse") {
				if (
					typeof server.url !== "string" ||
					server.url.length > 8_192 ||
					!Array.isArray(server.headers) ||
					server.headers.length > 100
				)
					throw new AcpSdkAdapterError("invalid_input", "ACP remote MCP servers require a valid URL and headers.");
				let parsedUrl: URL;
				try {
					parsedUrl = new URL(server.url);
				} catch {
					throw new AcpSdkAdapterError("invalid_input", "ACP MCP URL is invalid.");
				}
				if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
					throw new AcpSdkAdapterError("invalid_input", "ACP MCP URLs must use HTTP or HTTPS.");
				const headers: Record<string, string> = {};
				for (const value of server.headers) {
					const header = object(value);
					if (
						typeof header?.name !== "string" ||
						header.name.length === 0 ||
						header.name.length > 256 ||
						header.name.includes("\r") ||
						header.name.includes("\n") ||
						typeof header.value !== "string" ||
						header.value.length > 8_192 ||
						header.value.includes("\r") ||
						header.value.includes("\n") ||
						Object.hasOwn(headers, header.name)
					)
						throw new AcpSdkAdapterError(
							"invalid_input",
							"ACP MCP headers must have unique valid names and values.",
						);
					headers[header.name] = header.value;
				}
				result.push({
					type: server.type,
					name: server.name,
					url: parsedUrl.toString(),
					...(Object.keys(headers).length > 0 ? { headers } : {}),
				});
				continue;
			}
			if (
				(server.type !== undefined && server.type !== "stdio") ||
				typeof server.command !== "string" ||
				server.command.length > 4_096 ||
				!path.isAbsolute(server.command) ||
				!Array.isArray(server.args) ||
				server.args.length > 100 ||
				!server.args.every(argument => typeof argument === "string" && argument.length <= 8_192) ||
				!Array.isArray(server.env) ||
				server.env.length > 100
			)
				throw new AcpSdkAdapterError(
					"invalid_input",
					"ACP stdio MCP servers require an absolute command and bounded arguments and environment variables.",
				);
			const env: Record<string, string> = {};
			for (const value of server.env) {
				const variable = object(value);
				if (
					typeof variable?.name !== "string" ||
					!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name) ||
					typeof variable.value !== "string" ||
					variable.value.length > 32_768 ||
					Object.hasOwn(env, variable.name)
				)
					throw new AcpSdkAdapterError(
						"invalid_input",
						"ACP MCP environment variables must have unique valid names and string values.",
					);
				env[variable.name] = variable.value;
			}
			result.push({
				name: server.name,
				command: server.command,
				args: server.args as string[],
				...(Object.keys(env).length > 0 ? { env } : {}),
			});
		}
		return result;
	}

	async #launchSessionWithMcp(
		operation: "session.create" | "session.fork" | "session.resume",
		input: JsonObject,
		idempotencyKey: string,
		mcpServers: SessionLifecycleMcpServer[],
	): Promise<unknown> {
		try {
			return await (await this.#brokerAdapter()).global(operation, input, idempotencyKey);
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
					? error.code
					: undefined;
			if (
				mcpServers.length === 0 ||
				code === "invalid_input" ||
				code === "authentication_failed" ||
				code === "unknown_model_profile" ||
				code === "model_profile_registry_error"
			)
				throw error;
			const names = mcpServers
				.slice(0, 8)
				.map(server => server.name)
				.join(", ");
			const suffix = mcpServers.length > 8 ? `, and ${mcpServers.length - 8} more` : "";
			throw new AcpSdkAdapterError("unavailable", `MCP server request failed to start (${names}${suffix}).`);
		}
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
				await this.#teardownSession(id, "connection closed", false);
			} catch (error) {
				failures.push(error);
			}
		}
		this.#attaching.clear();
		this.#resolvingExisting.clear();
		this.#knownSessionCwds.clear();
		this.#knownSessionMetadata.clear();
		this.#pendingDeleteLocators.clear();
		this.#pendingCloseIdempotencyKeys.clear();
		if (this.#closing.size === 0) this.#closing.clear();
		this.#tearingDown.clear();
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
