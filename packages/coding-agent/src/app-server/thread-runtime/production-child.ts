import { randomUUID } from "node:crypto";
import { getAgentDir } from "@gajae-code/utils";
import packageMetadata from "../../../package.json" with { type: "json" };
import { toAgentWireEventPayload } from "../../modes/shared/agent-wire/event-envelope";
import { ensureBroker, stopOwnedBroker } from "../../sdk/broker/ensure";
import { SdkClient } from "../../sdk/client/client";

import { dispatchControl } from "../../sdk/host/control/dispatch";
import type { ControlSurface } from "../../sdk/host/control/operations";
import { OPERATIONS } from "../../sdk/protocol/operation-registry";
import type { CreateAgentSessionOptions, createAgentSession } from "../../sdk/session";
import type { AgentSession } from "../../session/agent-session";
import { appendAppServerProjection, readAppServerProjections } from "../../session/app-server-projection";
import { createReverseLeaseController, type ReverseLeaseController } from "../reverse-lease-controller";
import { type CodexApprovalRequester, createPermissionAdapter } from "../server-requests/permission-adapter";
import type {
	ChildBridgeOptions,
	ChildCreateRequest,
	ChildCreateResult,
	SessionClient,
	SessionRequestOptions,
	TurnPolicyOverride,
} from "./child-bridge";
import type { EndpointAuthority, ThreadEffectiveSettings } from "./thread-runtime-manager";

type Correlation = { commandId: string; turnId: string };
type CorrelationState = { current?: Correlation };

export interface ProductionThreadStartAdapterOptions {
	readonly agentDir?: string;
	/** In-process seam retained for focused unit tests; production defaults to the broker child path. */
	readonly createSession?: (options: CreateAgentSessionOptions) => ReturnType<typeof createAgentSession>;
	/** Optional app-server approval requester used by the production PermissionAdapter. */
	readonly requestApproval?: CodexApprovalRequester;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseResult(value: unknown): unknown {
	if (!record(value)) return value;
	if (value.ok === false) {
		const error = value.error;
		throw new Error(record(error) && typeof error.message === "string" ? error.message : "SDK request failed.");
	}
	return Object.hasOwn(value, "result") ? value.result : value;
}

function controlResponseResult(value: unknown): unknown {
	if (!record(value)) return value;
	if (value.ok === false) {
		const error = value.error;
		const code = record(error) && typeof error.code === "string" ? error.code : "internal";
		const message =
			record(error) && typeof error.message === "string" ? error.message : "SDK control request failed.";
		throw Object.assign(new Error(message), { code });
	}
	return Object.hasOwn(value, "result") ? value.result : value;
}

function responsePage(value: unknown): {
	readonly items: Record<string, unknown>[];
	readonly complete: boolean;
	readonly nextCursor?: string;
} {
	const result = responseResult(value);
	if (!record(result) || !record(result.page) || !Array.isArray(result.page.items))
		return { items: [], complete: true };
	const page = result.page;
	const rawItems = page.items as unknown[];
	return {
		items: rawItems.filter(record),
		complete: page.complete !== false,
		...(typeof page.continuationCursor === "string" ? { nextCursor: page.continuationCursor } : {}),
	};
}

async function allModelItems(client: SdkClient): Promise<Record<string, unknown>[]> {
	const items: Record<string, unknown>[] = [];
	let cursor: string | undefined;
	for (let pageCount = 0; pageCount < 1_000; pageCount += 1) {
		const page = responsePage(await client.query("models.current", {}, cursor));
		items.push(...page.items);
		if (page.complete || page.nextCursor === undefined || page.nextCursor === cursor) return items;
		cursor = page.nextCursor;
	}
	throw new Error("The child model catalog exceeded the pagination safety limit.");
}

function queryItem(value: unknown): Record<string, unknown> | undefined {
	const result = responseResult(value);
	if (!record(result)) return undefined;
	if (record(result.page) && Array.isArray(result.page.items)) {
		const first = result.page.items[0];
		return record(first) ? first : undefined;
	}
	return result;
}

function splitModelReference(requestedModel: string): { readonly provider: string; readonly id: string } | undefined {
	const slash = requestedModel.indexOf("/");
	if (slash <= 0 || slash === requestedModel.length - 1) return undefined;
	const provider = requestedModel.slice(0, slash);
	const id = requestedModel.slice(slash + 1);
	return provider && id ? { provider, id } : undefined;
}

function modelOverrideError(requestedModel: string): Error {
	return new Error(`Model override "${requestedModel}" could not be resolved.`);
}

function validateTurnPolicy(policy: TurnPolicyOverride): void {
	if (policy.approvalPolicy !== undefined && policy.approvalPolicy !== "never")
		throw new Error("The child only supports approvalPolicy=never for per-turn policy overrides.");
	if (policy.sandboxPolicy !== undefined && policy.sandboxPolicy.type !== "dangerFullAccess")
		throw new Error("The child only supports sandboxPolicy=dangerFullAccess for per-turn policy overrides.");
	if (
		policy.reasoningEffort !== undefined &&
		!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(policy.reasoningEffort)
	)
		throw new Error(`Unsupported per-turn reasoning effort "${policy.reasoningEffort}".`);
	if (policy.developerInstructions !== undefined && policy.developerInstructions.trim().length === 0)
		throw new Error("Per-turn developer instructions must be non-empty.");
}

function sandboxPolicyFromChildMetadata(value: unknown): { readonly type: "dangerFullAccess" } {
	if (!record(value) || !record(value.sandbox) || value.sandbox.type !== "dangerFullAccess")
		throw new Error("The child did not expose a dangerFullAccess sandbox execution policy.");
	return { type: "dangerFullAccess" };
}

function supportedReasoningEfforts(model: Record<string, unknown>): Set<string> {
	const thinking = record(model.thinking) ? model.thinking : undefined;
	const validLevels = thinking?.validLevels;
	if (Array.isArray(validLevels) && validLevels.every(level => typeof level === "string")) return new Set(validLevels);
	const supported = model.supportedReasoningEfforts;
	if (Array.isArray(supported)) {
		const efforts = supported
			.map(value => (record(value) && typeof value.reasoningEffort === "string" ? value.reasoningEffort : undefined))
			.filter((value): value is string => value !== undefined);
		if (efforts.length > 0) return new Set(["off", ...efforts]);
	}
	throw new Error("The child did not expose reasoning-effort capabilities for its current model.");
}

function assertReasoningEffortSupported(model: Record<string, unknown> | undefined, effort: string): void {
	if (!model) throw new Error("The child did not expose a current model for reasoning-effort validation.");
	const supported = supportedReasoningEfforts(model);
	if (supported.has(effort)) return;
	throw new Error(
		`Reasoning effort "${effort}" is not supported by the child model "${String(model.provider)}/${String(model.id)}".`,
	);
}

function endpointAuthority(value: unknown): EndpointAuthority {
	if (!record(value)) throw new Error("SDK broker session.create returned no endpoint authority.");
	const endpointGeneration = value.endpointGeneration;
	const endpointIncarnation = value.endpointIncarnation;
	const endpointMtimeMs = value.endpointMtimeMs;
	const pid = value.pid;
	if (
		typeof endpointGeneration !== "number" ||
		!Number.isSafeInteger(endpointGeneration) ||
		endpointGeneration <= 0 ||
		typeof endpointIncarnation !== "string" ||
		!/^[a-f0-9]{64}$/.test(endpointIncarnation) ||
		typeof endpointMtimeMs !== "number" ||
		!Number.isFinite(endpointMtimeMs) ||
		typeof pid !== "number" ||
		!Number.isSafeInteger(pid) ||
		pid <= 0
	)
		throw new Error("SDK broker session.create returned malformed endpoint authority.");
	return { endpointGeneration, endpointIncarnation, endpointMtimeMs, pid };
}

function endpointCredential(value: unknown): { url: string; token: string } {
	if (!record(value)) throw new Error("SDK broker session.create returned malformed endpoint credentials.");
	const url = value.url;
	const token = value.token;
	if (typeof url !== "string" || !url || typeof token !== "string" || !token)
		throw new Error("SDK broker session.create returned malformed endpoint credentials.");
	return { url, token };
}

function projectionStore(session: AgentSession) {
	return {
		append: (envelope: Record<string, unknown>) => appendAppServerProjection(session.sessionManager, envelope),
		read: (afterRevision = 0) => readAppServerProjections(session.sessionManager, afterRevision),
	};
}

function buildSurface(
	session: AgentSession,
	projections: ReturnType<typeof projectionStore>,
	correlation: CorrelationState,
): ControlSurface {
	const surface = {
		prompt: async (text: string, images?: unknown, clientRef?: string, developerInstructions?: string) => {
			if (!correlation.current) correlation.current = { commandId: randomUUID(), turnId: randomUUID() };
			const pair = correlation.current;
			await session.prompt(text, {
				images: Array.isArray(images) ? (images as never) : undefined,
				...(developerInstructions ? { developerInstructions } : {}),
				attribution: "user",
			});
			return { accepted: true, ...pair, ...(clientRef ? { clientRef } : {}) };
		},
		steer: (text: string) => session.steer(text),
		followUp: (text: string) => session.prompt(text, { streamingBehavior: "followUp" }),
		abort: () => session.abort(),
		abortAndPrompt: async (text: string) => {
			await session.abort();
			correlation.current = undefined;
			return surface.prompt(text);
		},
		runCompaction: () => session.compact(),
		setThinking: (level: unknown) => session.setThinkingLevel(level as never),
		setPermissionMode: (mode: unknown) => {
			if (mode !== "prompt" && mode !== "allow" && mode !== "deny") throw new Error("Invalid permission mode.");
			session.setSdkPermissionMode(mode);
			return { changed: true, mode };
		},
		appendProjection: (envelope: unknown) => projections.append(envelope as Record<string, unknown>),
		readProjection: (afterRevision?: number) => projections.read(afterRevision),
		installedOperations: new Set([
			"turn.prompt",
			"turn.steer",
			"thinking.set",
			"permission_mode.set",
			"turn.follow_up",
			"turn.abort",
			"turn.abort_and_prompt",
			"compaction.run",
			"projection.append",
			"projection.read",
		]),
	} as unknown as ControlSurface;
	return surface;
}

function queryResult(
	query: string,
	input: Record<string, unknown>,
	projections: ReturnType<typeof projectionStore>,
	promptStatus: () => Record<string, unknown>,
): unknown {
	if (query === "projection.read")
		return projections.read(typeof input.afterRevision === "number" ? input.afterRevision : 0);
	if (query === "turn.prompt_status") return promptStatus();
	throw Object.assign(new Error(`Query operation is unavailable: ${query}`), { code: "unavailable" });
}

function effectiveSettingsFor(session: AgentSession): ThreadEffectiveSettings {
	const cwd = session.sessionManager.getCwd();
	const now = Date.now();
	const model = session.model;
	if (!model) throw new Error("The GJC session has no active model, so thread settings cannot be projected.");
	return {
		model: model.id,
		modelProvider: model.provider,
		serviceTier: session.serviceTier ?? null,
		cwd,
		instructionSources: [],
		approvalPolicy:
			session.sdkPermissionMode === "allow"
				? "never"
				: session.sdkPermissionMode === "deny"
					? "untrusted"
					: "on-request",
		approvalsReviewer: "user",
		sandbox: { type: "dangerFullAccess" },
		reasoningEffort: session.thinkingLevel ?? null,
		thread: {
			id: session.sessionId,
			sessionId: session.sessionId,
			forkedFromId: null,
			parentThreadId: null,
			preview: "",
			ephemeral: false,
			isPinned: false,
			modelProvider: model.provider,
			createdAt: now,
			updatedAt: now,
			recencyAt: null,
			status: { type: "idle" },
			path: session.sessionManager.getSessionFile() ?? null,
			cwd,
			cliVersion: packageMetadata.version,
			source: "appServer",
			threadSource: null,
			agentNickname: null,
			agentRole: null,
			gitInfo: null,
			name: null,
			turns: [],
			extra: null,
			historyMode: "paginated",
			canAcceptDirectInput: true,
		},
		runtimeWorkspaceRoots: [cwd],
		activePermissionProfile: null,
		multiAgentMode: "explicitRequestOnly",
	};
}

async function effectiveSettingsForRemote(
	client: SdkClient,
	sessionId: string,
	cwd: string,
	requestedModel?: string,
): Promise<ThreadEffectiveSettings> {
	const metadata = queryItem(await client.query("session.metadata"));
	const modelItems = await allModelItems(client);
	const requestedSlash = requestedModel?.indexOf("/") ?? -1;
	const requested =
		requestedModel && requestedSlash > 0
			? { provider: requestedModel.slice(0, requestedSlash), id: requestedModel.slice(requestedSlash + 1) }
			: undefined;
	const model = requested ?? modelItems.find(item => item.current === true) ?? modelItems[0];
	if (!model || typeof model.id !== "string" || typeof model.provider !== "string")
		throw new Error("The SDK child did not expose a current model for thread settings.");
	const metadataCwd = record(metadata) && typeof metadata.cwd === "string" ? metadata.cwd : cwd;
	const currentThinkingLevel =
		typeof (model as Record<string, unknown>).currentThinkingLevel === "string"
			? ((model as Record<string, unknown>).currentThinkingLevel as string)
			: null;
	const now = Date.now();
	return {
		model: model.id,
		modelProvider: model.provider,
		serviceTier: null,
		cwd,
		instructionSources: [],
		approvalPolicy: "on-request",
		approvalsReviewer: "user",
		sandbox: sandboxPolicyFromChildMetadata(metadata),
		reasoningEffort: currentThinkingLevel,
		thread: {
			id: sessionId,
			sessionId,
			forkedFromId: null,
			parentThreadId: null,
			preview: "",
			ephemeral: false,
			isPinned: false,
			modelProvider: model.provider,
			createdAt: now,
			updatedAt: now,
			recencyAt: null,
			status: { type: "idle" },
			path: null,
			cwd: metadataCwd,
			cliVersion: packageMetadata.version,
			source: "appServer",
			threadSource: null,
			agentNickname: null,
			agentRole: null,
			gitInfo: null,
			name: null,
			turns: [],
			extra: null,
			historyMode: "paginated",
			canAcceptDirectInput: true,
		},
		runtimeWorkspaceRoots: [cwd],
		activePermissionProfile: null,
		multiAgentMode: "explicitRequestOnly",
	};
}

function assistantMessageFromRemoteFrame(frame: Record<string, unknown>): Record<string, unknown> | undefined {
	if (frame.type !== "event" || !record(frame.payload)) return undefined;
	const event = record(frame.payload.event) ? frame.payload.event : undefined;
	const message = event && record(event.message) ? event.message : undefined;
	return message && message.role === "assistant" ? message : undefined;
}
function remoteSessionClient(sdk: SdkClient, activeModelReference?: string): SessionClient {
	const unwrap = (value: unknown): unknown => responseResult(value);
	let permissionMode: "prompt" | "allow" | "deny" = "prompt";
	let thinkingLevel: string | undefined;
	return {
		connectionId: sdk.connectionId,
		onFrame: handler => {
			let latestAssistantMessage: Record<string, unknown> | undefined;
			return sdk.onFrame(frame => {
				const assistant = assistantMessageFromRemoteFrame(frame);
				if (assistant) latestAssistantMessage = assistant;
				if (frame.type === "agent_end" && !Array.isArray(frame.messages) && latestAssistantMessage) {
					handler({
						...frame,
						messages: [latestAssistantMessage],
						...(typeof frame.stopReason === "string" ? {} : { stopReason: "completed" }),
					});
					latestAssistantMessage = undefined;
					return;
				}
				handler(frame);
			});
		},
		onReconnect: handler => sdk.onReconnect(handler),
		onReconnectFailed: handler => sdk.onReconnectFailed(handler),
		request: (frame, timeout) => sdk.request(frame, timeout as never),
		query: async (query, input = {}) => unwrap(await sdk.query(query, input)),
		control: async (operation, input = {}, options) => unwrap(await sdk.control(operation, input, options)),
		appendProjection: async (envelope: Record<string, unknown>, options?: SessionRequestOptions) =>
			unwrap(await sdk.control("projection.append", { envelope }, options)),
		setModelForTurn: async requestedModel => {
			const reference = splitModelReference(requestedModel);
			if (activeModelReference === requestedModel) return async () => {};
			const models = await allModelItems(sdk);
			const target = reference
				? models.find(model => model.provider === reference.provider && model.id === reference.id)
				: undefined;
			if (!target || typeof target.provider !== "string" || typeof target.id !== "string")
				throw modelOverrideError(requestedModel);
			const current = models.find(model => model.current === true);
			const targetId = `${target.provider}/${target.id}`;
			const currentId =
				current && typeof current.provider === "string" && typeof current.id === "string"
					? `${current.provider}/${current.id}`
					: undefined;
			if (currentId === undefined)
				throw new Error("The child session did not expose its current model for a per-turn override.");
			if (currentId === targetId) return async () => {};
			await controlResponseResult(await sdk.control("model.set", { id: targetId }));
			return async () => {
				if (currentId !== undefined) await controlResponseResult(await sdk.control("model.set", { id: currentId }));
			};
		},
		setTurnPolicyForTurn: async policy => {
			validateTurnPolicy(policy);
			if (policy.sandboxPolicy !== undefined)
				sandboxPolicyFromChildMetadata(queryItem(await sdk.query("session.metadata")));
			const restores: Array<() => Promise<void>> = [];
			try {
				if (policy.approvalPolicy !== undefined) {
					const previous = permissionMode;
					await controlResponseResult(await sdk.control("permission_mode.set", { mode: "allow" }));
					permissionMode = "allow";
					restores.unshift(async () => {
						await controlResponseResult(await sdk.control("permission_mode.set", { mode: previous }));
						permissionMode = previous;
					});
				}
				if (policy.reasoningEffort !== undefined) {
					const models = await allModelItems(sdk);
					const current = models.find(model => model.current === true);
					assertReasoningEffortSupported(current, policy.reasoningEffort);
					const previous =
						thinkingLevel ??
						(typeof current?.currentThinkingLevel === "string" ? current.currentThinkingLevel : "inherit");
					await controlResponseResult(await sdk.control("thinking.set", { level: policy.reasoningEffort }));
					const applied = (await allModelItems(sdk)).find(model => model.current === true);
					thinkingLevel =
						typeof applied?.currentThinkingLevel === "string" ? applied.currentThinkingLevel : undefined;
					restores.unshift(async () => {
						await controlResponseResult(await sdk.control("thinking.set", { level: previous }));
						thinkingLevel = previous;
					});
				}
				return async () => {
					let failure: unknown;
					for (const restore of restores) {
						try {
							await restore();
						} catch (error) {
							failure ??= error;
						}
					}
					if (failure !== undefined) throw failure;
				};
			} catch (error) {
				for (const restore of restores) {
					try {
						await restore();
					} catch {
						// Preserve the original policy application failure; the turn controller fences restoration failures.
					}
				}
				throw error;
			}
		},
		close: () => sdk.close(),
	};
}

export function createProductionThreadStartAdapter(
	options: ProductionThreadStartAdapterOptions = {},
): Omit<ChildBridgeOptions, "manager"> {
	const rawClients = new WeakMap<SessionClient, SdkClient>();
	const reverseControllers = new WeakMap<SessionClient, ReverseLeaseController>();
	const agentDir = options.agentDir ?? getAgentDir();
	let shutdownPromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		shutdownPromise ??= options.createSession ? Promise.resolve() : stopOwnedBroker(agentDir);
		return shutdownPromise;
	};
	const create = async (request: ChildCreateRequest): Promise<ChildCreateResult> => {
		if (options.createSession) {
			const sessionOptions: CreateAgentSessionOptions = {
				cwd: request.cwd,
				...(options.agentDir ? { agentDir: options.agentDir } : {}),
				...(typeof request.params.model === "string" ? { modelPattern: request.params.model } : {}),
				...(typeof request.params.thinkingLevel === "string"
					? { thinkingLevel: request.params.thinkingLevel as never }
					: {}),
				hasUI: false,
				notificationHostModeSupported: false,
				sdkHostModeSupported: false,
			};
			const created = await options.createSession(sessionOptions);
			const session = created.session;
			const correlation: CorrelationState = {};
			let promptState: Record<string, unknown> = { status: "idle" };
			const listeners = new Set<(frame: Record<string, unknown>) => void>();
			const unsubscribe = session.subscribe(event => {
				if (event.type === "agent_start" && correlation.current)
					promptState = { status: "inProgress", ...correlation.current };
				if (event.type === "agent_end" || event.type === "turn_end") {
					if (correlation.current) promptState = { status: "completed", ...correlation.current };
				}
				if (!correlation.current) return;
				const payload = toAgentWireEventPayload(event);
				const frame = { type: "event", kind: event.type, payload, ...correlation.current };
				for (const listener of listeners) listener(frame);
				if (event.type === "agent_end") correlation.current = undefined;
			});
			const projections = projectionStore(session);
			const surface = buildSurface(session, projections, correlation);
			const client: SessionClient = {
				onFrame(handler) {
					listeners.add(handler);
					return () => listeners.delete(handler);
				},
				onReconnect: () => () => {},
				onReconnectFailed: () => () => {},
				request: async frame => frame,
				control: async (operation, input = {}, controlOptions) => {
					if (operation === "turn.prompt") {
						const pair = { commandId: randomUUID(), turnId: randomUUID() };
						correlation.current = pair;
						promptState = { status: "queued", ...pair, clientRef: input.clientRef };
					}
					const response = await dispatchControl(
						surface,
						OPERATIONS.find(row => row.kind === "control" && row.sdkId === operation),
						{
							id: randomUUID(),
							operation,
							input,
							confirm: controlOptions?.confirm,
							idempotencyKey: controlOptions?.idempotencyKey,
						},
					);
					return controlResponseResult(response);
				},
				appendProjection: async (envelope: Record<string, unknown>, controlOptions?: SessionRequestOptions) => {
					const response = await dispatchControl(
						surface,
						OPERATIONS.find(row => row.kind === "control" && row.sdkId === "projection.append"),
						{
							id: randomUUID(),
							operation: "projection.append",
							input: { envelope },
							confirm: controlOptions?.confirm,
							idempotencyKey: controlOptions?.idempotencyKey,
						},
					);
					return controlResponseResult(response);
				},
				setModelForTurn: async requestedModel => {
					const reference = splitModelReference(requestedModel);
					const target = reference ? session.modelRegistry.find(reference.provider, reference.id) : undefined;
					if (!target) throw modelOverrideError(requestedModel);
					const previous = session.model;
					if (!previous)
						throw new Error("The child session did not expose its current model for a per-turn override.");
					if (previous && previous.provider === target.provider && previous.id === target.id)
						return async () => {};
					const scope = await session.setModelTemporary(target, undefined, {
						cause: "temporary-operation",
						reason: "other",
					});
					return async () => {
						if (scope !== undefined && !session.restoreTemporaryProviderSessionScope(scope))
							throw new Error(`Model override "${requestedModel}" could not restore the previous model.`);
					};
				},
				setTurnPolicyForTurn: async policy => {
					validateTurnPolicy(policy);
					const previousPermissionMode = session.sdkPermissionMode;
					const previousThinkingLevel = session.thinkingLevel;
					if (policy.sandboxPolicy !== undefined) {
						const sandbox = effectiveSettingsFor(session).sandbox;
						if (!record(sandbox) || sandbox.type !== "dangerFullAccess")
							throw new Error("The child did not expose a dangerFullAccess sandbox execution policy.");
					}
					if (policy.approvalPolicy !== undefined) session.setSdkPermissionMode("allow");
					try {
						if (policy.reasoningEffort !== undefined) {
							const supported = session
								.getAvailableThinkingLevels()
								.some(level => String(level) === policy.reasoningEffort);
							if (policy.reasoningEffort !== "off" && !supported)
								throw new Error(
									`Reasoning effort "${policy.reasoningEffort}" is not supported by the child model "${String(session.model?.provider)}/${String(session.model?.id)}".`,
								);
							await session.setThinkingLevelForControl(policy.reasoningEffort as never, false);
						}
					} catch (error) {
						session.setSdkPermissionMode(previousPermissionMode);
						throw error;
					}
					return async () => {
						let failure: unknown;
						try {
							if (policy.reasoningEffort !== undefined) session.setThinkingLevel(previousThinkingLevel);
						} catch (error) {
							failure = error;
						}
						try {
							if (policy.approvalPolicy !== undefined) session.setSdkPermissionMode(previousPermissionMode);
						} catch (error) {
							failure ??= error;
						}
						if (failure !== undefined) throw failure;
					};
				},
				query: async (query, input = {}) => queryResult(query, input, projections, () => promptState),
				close: async () => {
					unsubscribe();
					listeners.clear();
					await session.dispose();
				},
			};
			return {
				sessionId: session.sessionId,
				cwd: session.sessionManager.getCwd(),
				effectiveSettings: effectiveSettingsFor(session),
				client,
				awaitReady: async () => session.workflowGateToolRestoration,
				closeChild: async () => client.close(),
			};
		}

		const discovery = await ensureBroker({ agentDir });
		const broker = await SdkClient.connect(discovery.url, discovery.token);
		let child: SdkClient | undefined;
		let createdSessionId: string | undefined;
		let createdAuthority: EndpointAuthority | undefined;
		try {
			const created = await broker.global(
				"session.create",
				{
					cwd: request.cwd,
					...(typeof request.params.model === "string" ? { modelId: request.params.model } : {}),
				},
				{ idempotencyKey: request.idempotencyKey },
			);
			const result = responseResult(created);
			if (!record(result)) throw new Error("SDK broker session.create returned a malformed result.");
			const sessionId = typeof result.sessionId === "string" && result.sessionId ? result.sessionId : undefined;
			const cwd = typeof result.cwd === "string" && result.cwd ? result.cwd : request.cwd;
			const authority = endpointAuthority(result);
			createdSessionId = sessionId;
			createdAuthority = authority;
			const credential = endpointCredential(result.endpoint);
			if (!sessionId) throw new Error("SDK broker session.create returned no session id.");
			child = await SdkClient.connect(credential.url, credential.token);
			const effectiveSettings = await effectiveSettingsForRemote(
				child,
				sessionId,
				cwd,
				typeof request.params.model === "string" ? request.params.model : undefined,
			);
			const activeModelReference = `${effectiveSettings.modelProvider}/${effectiveSettings.model}`;
			const client = remoteSessionClient(child, activeModelReference);
			rawClients.set(client, child);
			return {
				sessionId,
				cwd,
				authority,
				client,
				effectiveSettings,
				awaitReady: async () => {},
				closeChild: async captured => {
					const closeAuthority = captured ?? authority;
					try {
						await broker.global(
							"session.close",
							{
								sessionId,
								endpointGeneration: closeAuthority.endpointGeneration,
								endpointIncarnation: closeAuthority.endpointIncarnation,
							},
							{ idempotencyKey: `thread-close:${sessionId}:${randomUUID()}` },
						);
					} finally {
						await broker.close();
					}
				},
			};
		} catch (error) {
			await child?.close().catch(() => {});
			if (createdSessionId && createdAuthority) {
				try {
					await broker.global(
						"session.close",
						{
							sessionId: createdSessionId,
							endpointGeneration: createdAuthority.endpointGeneration,
							endpointIncarnation: createdAuthority.endpointIncarnation,
						},
						{ idempotencyKey: `thread-create-rollback:${createdSessionId}:${randomUUID()}` },
					);
				} catch {
					// Preserve the creation failure; the broker lifecycle ledger retains cleanup evidence.
				}
			}
			await broker.close().catch(() => {});
			throw error;
		}
	};
	return {
		create,
		ownership: options.createSession ? "attached" : "spawned",
		attachReverseLeaseController: async (client, validatedChild) => {
			const sdk = rawClients.get(client);
			if (!sdk) return undefined;
			const permission = createPermissionAdapter({
				conversationId: validatedChild.sessionId,
				cwd: validatedChild.cwd,
				requestApproval: options.requestApproval,
			});
			const controller = createReverseLeaseController({ client: sdk, providers: [permission.provider()] });
			try {
				await controller.start();
			} catch (error) {
				await controller.close().catch(() => {});
				throw error;
			}
			reverseControllers.set(client, controller);
			return { close: () => controller.close() };
		},
		shutdown,
	};
}
