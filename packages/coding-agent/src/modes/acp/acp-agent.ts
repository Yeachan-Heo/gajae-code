import { randomUUID } from "node:crypto";
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

type BrokerConnection = { adapter: AcpSdkAdapter; client: SdkClient };
type PendingAttachment = { epoch: number; task: Promise<void> };

type SessionRecord = {
	cwd: string;
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
	live?: boolean;
	endpointGeneration?: number;
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
export function paginateAcpSessions(listed: unknown[], cwd: string | undefined, offset: number): ListSessionsResponse {
	const filtered = listed
		.map(value => object(value) as BrokerSession | undefined)
		.filter(
			(value): value is BrokerSession & { locator: { repo: string } } =>
				typeof value?.sessionId === "string" && typeof value.locator?.repo === "string",
		)
		.filter(value => !cwd || value.locator.repo === cwd);
	const sessions = filtered
		.slice(offset, offset + SESSION_PAGE_SIZE)
		.map(
			value =>
				({ sessionId: value.sessionId, cwd: value.locator.repo, title: value.sessionId }) satisfies SessionInfo,
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
			connection as unknown as { unstable_createElicitation(input: JsonObject): Promise<JsonObject> }
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
	readonly #knownSessionCwds = new Map<string, string>();
	readonly #sessionEpochs = new Map<string, number>();
	readonly #tearingDown = new Map<string, number>();
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
				sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {}, delete: {} },
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
		const result = await (await this.#brokerAdapter()).global(
			"session.create",
			{
				cwd: params.cwd,
				target: { path: params.cwd },
				...(this.#startupOptions?.modelPreset ? { modelPreset: this.#startupOptions.modelPreset } : {}),
			},
			randomUUID(),
		);
		const id = sessionId(result);
		this.#knownSessionCwds.set(id, params.cwd);
		try {
			await this.#attach(id, params.cwd, endpoint(result));
			await applyAcpStartupOptions(this.#adapter(id), this.#startupOptions);
			this.#scheduleBootstrap(id);
			return { sessionId: id, ...(await this.#sessionState(id)) };
		} catch (error) {
			await this.#discardNewSession(id);
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
		const source = await this.#resolveSavedSession(params.sessionId, params.cwd);
		const result = await (await this.#brokerAdapter()).global(
			"session.fork",
			{
				cwd: params.cwd,
				sourceSessionId: params.sessionId,
				sourceSessionPath: source,
				target: { path: params.cwd },
			},
			randomUUID(),
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
		return paginateAcpSessions(listed, params.cwd ?? undefined, this.#cursor(params.cursor));
	}

	async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		const cwd = record?.cwd ?? this.#knownSessionCwds.get(params.sessionId);
		// ACP close has no cwd. Only connection-owned sessions may reach broker lifecycle control.
		if (!cwd) return {};
		this.#beginTeardown(params.sessionId);
		try {
			await this.#teardownSession(params.sessionId, "closed", true);
			this.#knownSessionCwds.delete(params.sessionId);
			return {};
		} finally {
			this.#finishTeardown(params.sessionId);
		}
	}

	async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		const cwd = record?.cwd ?? this.#knownSessionCwds.get(params.sessionId);
		// ACP's delete request has no cwd. Only delete sessions this connection has
		// already scoped through the broker; unknown ids remain the protocol no-op.
		if (!cwd) return {};
		this.#beginTeardown(params.sessionId);
		try {
			await this.#teardownSession(params.sessionId, "deleted", true);
			let saved: string;
			try {
				saved = await this.#resolveSavedSession(params.sessionId, cwd);
			} catch (error) {
				if (error instanceof AcpSdkAdapterError && error.code === "not_found") {
					this.#knownSessionCwds.delete(params.sessionId);
					return {};
				}
				throw error;
			}
			await (await this.#brokerAdapter()).global(
				"session.delete",
				{ sessionId: params.sessionId, sessionPath: saved, cwd, target: { path: cwd } },
				this.#lifecycleIdempotencyKey(params.sessionId, "session.delete"),
			);
			this.#knownSessionCwds.delete(params.sessionId);
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
				await this.#adapter(params.sessionId).setModel(params.value);
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
			const acknowledgement = await record.adapter.prompt({
				text: payload.text,
				...(payload.images.length ? { images: payload.images } : {}),
			});
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
				const result = await (await this.#brokerAdapter()).handle(method, params);
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

	async #attachExisting(id: string, cwd: string): Promise<void> {
		const epoch = this.#sessionEpoch(id);
		const attached = this.#sessions.get(id);
		if (attached) {
			if (path.resolve(attached.cwd) !== path.resolve(cwd))
				throw new AcpSdkAdapterError("conflict", `ACP session ${id} has conflicting cwd authority.`);
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
			const result = await this.#brokerEndpoint(id, indexed.endpointGeneration);
			this.#assertSessionEpoch(id, epoch);
			await this.#attach(id, cwd, endpoint(result), epoch);
			return;
		}

		const saved = await this.#resolveSavedSession(id, cwd);
		this.#assertSessionEpoch(id, epoch);
		const result = await (await this.#brokerAdapter()).global(
			"session.resume",
			{ cwd, sessionId: id, sessionPath: saved, target: { path: cwd } },
			randomUUID(),
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
			this.#assertSessionEpoch(id, epoch);
			const record: SessionRecord = {
				cwd,
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
			this.#sessions.set(id, record);
			this.#knownSessionCwds.set(id, cwd);
			await applyAcpPermissionMode(adapter, this.#clientCapabilities);
			this.#assertSessionEpoch(id, epoch);
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
				try {
					await (await this.#brokerAdapter()).global(
						"session.close",
						{ sessionId: id },
						this.#lifecycleIdempotencyKey(id, "session.close"),
					);
				} catch (error) {
					if (!(ownershipBound && this.#isAlreadyGone(error))) failures.push(error);
				}
			}
			if (failures.length > 0) {
				const detail = failures
					.map(failure => (failure instanceof Error ? failure.message : String(failure)))
					.join("; ");
				throw aggregateAcpFailure("terminal_uncertain", `ACP session cleanup is uncertain: ${detail}`, failures);
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
		if (!record) throw new AcpSdkAdapterError("not_found", `Unsupported ACP session: ${id}`);
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
		const methods: Record<string, string> = {
			"fs.readTextFile": "readTextFile",
			"fs.writeTextFile": "writeTextFile",
			"terminal.create": "createTerminal",
			"permission.request": "requestPermission",
			"ui.elicit": "unstable_createElicitation",
		};
		return {
			request: async (method: string, params: JsonObject): Promise<unknown> => {
				const name = methods[method] ?? method;
				const target = (this.#connection as unknown as Record<string, unknown>)[name];
				if (typeof target !== "function")
					throw new AcpSdkAdapterError("acp_reverse_unavailable", `ACP reverse method is unavailable: ${method}`);
				const request = method === "permission.request" ? { ...params, sessionId } : params;
				return await (target as (input: JsonObject) => Promise<unknown>)(request);
			},
		};
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
		waiter.resolve({ stopReason: waiter.cancelRequested ? "cancelled" : "end_turn" });
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
		if (!cursor) return 0;
		const value = Number.parseInt(cursor, 10);
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ACP session cursor: ${cursor}`);
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
				await this.#teardownSession(id, "connection closed", false);
			} catch (error) {
				failures.push(error);
			}
		}
		this.#attaching.clear();
		this.#resolvingExisting.clear();
		this.#knownSessionCwds.clear();
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
