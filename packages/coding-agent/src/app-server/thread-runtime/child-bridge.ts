// app-server child bridge: transactional lifecycle boundary for one loaded thread.
//
// The real broker child is intentionally supplied by an injected adapter. This keeps the
// component contract deterministic while the sandbox-blocked broker spawn remains a separate
// G2 acceptance concern. A successful load retains its session client in the manager until the
// thread is evicted, terminated, or detached.

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { experimentalValidators, stableValidators } from "../protocol-source/schema-validators.generated";
import type {
	AdmissionReservation,
	EndpointAuthority,
	ThreadEffectiveSettings,
	ThreadOwnership,
	ThreadRuntimeManager,
} from "./thread-runtime-manager";

export interface SessionRequestOptions {
	readonly timeoutMs?: number;
	readonly idempotencyKey?: string;
	readonly confirm?: boolean;
}

/** Narrow retained-client surface shared with the public SdkClient. */
export interface SessionClient {
	readonly connectionId?: string;
	onFrame(handler: (frame: Record<string, unknown>) => void): () => void;
	onReconnect(handler: () => void): () => void;
	onReconnectFailed(handler: (error: Error) => void): () => void;
	request(frame: Record<string, unknown>, timeout?: number | SessionRequestOptions): Promise<Record<string, unknown>>;
	query(
		query: string,
		input?: Record<string, unknown>,
		cursor?: string,
		options?: SessionRequestOptions,
	): Promise<unknown>;
	control(operation: string, input?: Record<string, unknown>, options?: SessionRequestOptions): Promise<unknown>;
	close(): Promise<void>;
}

export interface ThreadLoadRequest {
	readonly threadId?: string;
	readonly ownership?: ThreadOwnership;
	readonly connectionId?: string;
	readonly cwd?: string;
	readonly params?: Readonly<Record<string, unknown>>;
	readonly idempotencyKey?: string;
	readonly experimentalApi?: boolean;
	readonly subscribe?: (threadId: string) => void | Promise<void>;
	readonly unsubscribe?: (threadId: string) => void | Promise<void>;
}

export interface ChildCreateRequest {
	readonly threadId: string;
	readonly ownership: ThreadOwnership;
	readonly connectionId?: string;
	readonly cwd: string;
	readonly idempotencyKey: string;
	readonly params: Readonly<Record<string, unknown>>;
}

export interface ReverseLeaseAttachment {
	close(): void | Promise<void>;
	/** Set when the attachment owns the client transport's close operation. */
	readonly ownsClient?: boolean;
}

export interface ChildCreateResult {
	readonly sessionId: string;
	readonly cwd: string;
	readonly authority?: EndpointAuthority;
	readonly client: SessionClient;
	readonly awaitReady: () => void | Promise<void>;
	readonly closeChild?: (authority: EndpointAuthority | undefined) => void | Promise<void>;
	readonly effectiveSettings?: ThreadEffectiveSettings;
}

export type ChildCreate = (request: ChildCreateRequest) => Promise<ChildCreateResult> | ChildCreateResult;

export type EffectiveSettingsReader = (
	client: SessionClient,
	child: ChildCreateResult,
	request: ThreadLoadRequest,
) => Promise<ThreadEffectiveSettings> | ThreadEffectiveSettings;

export type ReverseLeaseAttacher = (
	client: SessionClient,
	child: ChildCreateResult,
	request: ThreadLoadRequest,
) => Promise<ReverseLeaseAttachment | undefined> | ReverseLeaseAttachment | undefined;

export interface LoadedThreadRuntime {
	readonly threadId: string;
	readonly sessionId: string;
	readonly ownership: ThreadOwnership;
	readonly cwd: string;
	readonly authority: EndpointAuthority | undefined;
	readonly client: SessionClient;
	readonly effectiveSettings: ThreadEffectiveSettings;
	readonly response: Record<string, unknown>;
}

export interface ChildBridgeOptions {
	readonly manager: ThreadRuntimeManager;
	/** Transactional injected lifecycle adapter. */
	readonly create?: ChildCreate;
	/** Legacy authority-only seam retained for the manager's admission tests. */
	readonly spawn?: (threadId: string, ownership: ThreadOwnership) => Promise<EndpointAuthority | undefined>;
	/** Authority-fenced close for legacy spawns or children without a local close hook. */
	readonly close?: (
		threadId: string,
		ownership: ThreadOwnership,
		authority: EndpointAuthority | undefined,
	) => Promise<void> | void;
	readonly readEffectiveSettings?: EffectiveSettingsReader;
	readonly attachReverseLeaseController?: ReverseLeaseAttacher;
	readonly onFrame?: (child: ChildCreateResult, frame: Record<string, unknown>) => void;
	readonly onReconnect?: (child: ChildCreateResult) => void;
	readonly onReconnectFailed?: (child: ChildCreateResult, error: Error) => void;
	readonly subscribe?: (threadId: string, connectionId?: string) => void | Promise<void>;
	readonly unsubscribe?: (threadId: string, connectionId?: string) => void | Promise<void>;
}

const wiredManagers = new WeakSet<ThreadRuntimeManager>();

type CloseOnce = () => Promise<void>;

function closeOnce(close: () => void | Promise<void>): CloseOnce {
	let promise: Promise<void> | undefined;
	return () => {
		promise ??= Promise.resolve().then(close);
		return promise;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`Child adapter did not provide ${name}.`);
	return value;
}

function normalizedCwd(request: ThreadLoadRequest): string {
	const fromParams = request.params?.cwd;
	const cwd = request.cwd ?? (typeof fromParams === "string" ? fromParams : undefined) ?? process.cwd();
	return path.resolve(cwd);
}

function normalizedParams(request: ThreadLoadRequest): Record<string, unknown> {
	return isRecord(request.params) ? { ...request.params } : {};
}

function responseFor(
	runtime: {
		sessionId: string;
		cwd: string;
		effectiveSettings: ThreadEffectiveSettings;
	},
	experimentalApi: boolean,
): Record<string, unknown> {
	const settings = runtime.effectiveSettings;
	const sourceThread = settings.thread;
	const thread: Record<string, unknown> = {
		id: runtime.sessionId,
		sessionId: runtime.sessionId,
		forkedFromId: sourceThread.forkedFromId,
		parentThreadId: sourceThread.parentThreadId,
		preview: sourceThread.preview,
		ephemeral: sourceThread.ephemeral,
		isPinned: sourceThread.isPinned,
		modelProvider: settings.modelProvider,
		createdAt: sourceThread.createdAt,
		updatedAt: sourceThread.updatedAt,
		recencyAt: sourceThread.recencyAt,
		status: sourceThread.status,
		path: sourceThread.path,
		cwd: runtime.cwd,
		cliVersion: sourceThread.cliVersion,
		source: sourceThread.source,
		threadSource: sourceThread.threadSource,
		agentNickname: sourceThread.agentNickname,
		agentRole: sourceThread.agentRole,
		gitInfo: sourceThread.gitInfo,
		name: sourceThread.name,
		turns: [...sourceThread.turns],
	};
	const response: Record<string, unknown> = {
		thread,
		model: settings.model,
		modelProvider: settings.modelProvider,
		serviceTier: settings.serviceTier,
		cwd: runtime.cwd,
		instructionSources: [...settings.instructionSources],
		approvalPolicy: settings.approvalPolicy,
		approvalsReviewer: settings.approvalsReviewer,
		sandbox: settings.sandbox,
		reasoningEffort: settings.reasoningEffort,
	};
	if (experimentalApi) {
		if (settings.runtimeWorkspaceRoots === undefined)
			throw new Error("Experimental thread/start response is missing runtimeWorkspaceRoots.");
		if (!Object.hasOwn(settings, "activePermissionProfile"))
			throw new Error("Experimental thread/start response is missing activePermissionProfile.");
		if (!Object.hasOwn(settings, "multiAgentMode"))
			throw new Error("Experimental thread/start response is missing multiAgentMode.");
		if (!Object.hasOwn(sourceThread, "extra"))
			throw new Error("Experimental thread/start response is missing thread.extra.");
		if (!Object.hasOwn(sourceThread, "historyMode"))
			throw new Error("Experimental thread/start response is missing thread.historyMode.");
		if (!Object.hasOwn(sourceThread, "canAcceptDirectInput"))
			throw new Error("Experimental thread/start response is missing thread.canAcceptDirectInput.");
		thread.extra = sourceThread.extra;
		thread.historyMode = sourceThread.historyMode;
		thread.canAcceptDirectInput = sourceThread.canAcceptDirectInput;
		response.runtimeWorkspaceRoots = [...settings.runtimeWorkspaceRoots];
		response.activePermissionProfile = settings.activePermissionProfile;
		response.multiAgentMode = settings.multiAgentMode;
	}
	const validator = experimentalApi
		? experimentalValidators.clientRequestResults["thread/start"]
		: stableValidators.clientRequestResults["thread/start"];
	if (!validator(response)) throw new Error("Child adapter produced an invalid thread/start response.");
	return response;
}

async function invokeReadiness(child: ChildCreateResult): Promise<void> {
	await child.awaitReady();
}

async function invokeAttachmentClose(attachment: ReverseLeaseAttachment | undefined): Promise<void> {
	if (attachment) await attachment.close();
}

function requestFromLegacy(
	threadIdOrRequest: string | ThreadLoadRequest,
	ownership?: ThreadOwnership,
	connectionId?: string,
): ThreadLoadRequest {
	if (typeof threadIdOrRequest !== "string") return threadIdOrRequest;
	return { threadId: threadIdOrRequest, ownership, connectionId };
}

/**
 * Load one retained child transactionally. The string overload is a compatibility seam for
 * the original authority-only tests; the request overload is the production boundary.
 */
export async function loadThread(opts: ChildBridgeOptions, request: ThreadLoadRequest): Promise<LoadedThreadRuntime>;
export async function loadThread(
	opts: ChildBridgeOptions,
	threadId: string,
	ownership: ThreadOwnership,
	connectionId?: string,
): Promise<undefined>;
export async function loadThread(
	opts: ChildBridgeOptions,
	threadIdOrRequest: string | ThreadLoadRequest,
	legacyOwnership?: ThreadOwnership,
	legacyConnectionId?: string,
): Promise<LoadedThreadRuntime | undefined> {
	const request = requestFromLegacy(threadIdOrRequest, legacyOwnership, legacyConnectionId);
	const ownership = request.ownership ?? "spawned";
	const adapter = opts.create;

	// Preserve the authority-only manager seam for its focused admission tests.
	if (!adapter) {
		if (!opts.spawn) throw new Error("No child lifecycle adapter was supplied.");
		const threadId = requiredString(request.threadId, "threadId");
		const token = opts.manager.acquireSpawnToken();
		try {
			const authority = await opts.spawn(threadId, ownership);
			opts.manager.register(threadId, ownership, authority, request.connectionId);
			return;
		} finally {
			token.release();
		}
	}

	wireCloseCallback(opts);
	const cwd = normalizedCwd(request);
	const idempotencyKey = request.idempotencyKey ?? `thread-start:${randomUUID()}`;
	const provisionalThreadId = request.threadId ?? `pending:${idempotencyKey}`;
	let reservation: AdmissionReservation | undefined;
	let token: { release: () => void } | undefined;
	let attachment: ReverseLeaseAttachment | undefined;
	let attachmentClose: CloseOnce | undefined;
	let clientClose: CloseOnce | undefined;
	let childClose: CloseOnce | undefined;

	let publishedThreadId: string | undefined;

	const closeResources = async (): Promise<void> => {
		let firstError: unknown;
		try {
			if (attachmentClose) await attachmentClose();
		} catch (error) {
			firstError = error;
		}
		if (clientClose && attachment?.ownsClient !== true) {
			try {
				await clientClose();
			} catch (error) {
				firstError ??= error;
			}
		}
		if (childClose && ownership === "spawned") {
			try {
				await childClose();
			} catch (error) {
				firstError ??= error;
			}
		}
		if (firstError) throw firstError;
	};

	try {
		reservation = opts.manager.reserve(provisionalThreadId, request.connectionId);
		try {
			token = opts.manager.acquireSpawnToken();
		} catch (error) {
			reservation.release();
			reservation = undefined;
			throw error;
		}

		const createRequest: ChildCreateRequest = {
			threadId: request.threadId ?? provisionalThreadId,
			ownership,
			connectionId: request.connectionId,
			cwd,
			idempotencyKey,
			params: normalizedParams(request),
		};
		const child = await adapter(createRequest);
		if (!child || !isRecord(child)) throw new Error("Child adapter did not return a runtime.");
		const sessionId = requiredString(child.sessionId, "sessionId");
		const actualCwd = requiredString(child.cwd, "cwd");
		const client = child.client;
		if (!client) throw new Error("Child adapter did not retain a session client.");
		const childAuthority = child.authority;

		clientClose = closeOnce(() => client.close());
		childClose = closeOnce(() => {
			if (child.closeChild) return child.closeChild(childAuthority);
			if (opts.close) return opts.close(sessionId, ownership, childAuthority);
		});
		if (ownership === "spawned" && !childAuthority)
			throw new Error("Spawned child did not provide endpoint authority.");

		await invokeReadiness(child);

		// Install the complete retained-client observer surface after semantic readiness so
		// reconnect failures cannot be lost during the publication window.
		client.onFrame(frame => opts.onFrame?.(child!, frame));
		client.onReconnect(() => opts.onReconnect?.(child!));
		client.onReconnectFailed(error => opts.onReconnectFailed?.(child!, error));

		if (opts.attachReverseLeaseController) {
			attachment = (await opts.attachReverseLeaseController(client, child, request)) ?? undefined;
			if (attachment) attachmentClose = closeOnce(() => invokeAttachmentClose(attachment));
		}

		const effectiveSettings =
			child.effectiveSettings ??
			(opts.readEffectiveSettings ? await opts.readEffectiveSettings(client, child, request) : undefined);
		if (!effectiveSettings) throw new Error("Child adapter did not provide effective thread settings.");
		if (!isRecord(effectiveSettings)) throw new Error("Child adapter returned malformed effective thread settings.");
		if (effectiveSettings.cwd !== actualCwd)
			throw new Error("Child effective cwd does not match the captured child cwd.");

		const response = responseFor({ sessionId, cwd: actualCwd, effectiveSettings }, request.experimentalApi === true);
		const runtime: LoadedThreadRuntime = {
			threadId: sessionId,
			sessionId,
			ownership,
			cwd: actualCwd,
			authority: childAuthority,
			client,
			effectiveSettings,
			response,
		};

		opts.manager.register(sessionId, ownership, childAuthority, request.connectionId, {
			reservation,
			sessionId,
			cwd: actualCwd,
			client,
			effectiveSettings,
			closeChild: childClose,
			closeRuntime: closeResources,
		});
		publishedThreadId = sessionId;
		reservation = undefined;

		try {
			if (request.subscribe) await request.subscribe(sessionId);
			else if (opts.subscribe) await opts.subscribe(sessionId, request.connectionId);
		} catch (error) {
			try {
				if (request.unsubscribe) await request.unsubscribe(sessionId);
				else if (opts.unsubscribe) await opts.unsubscribe(sessionId, request.connectionId);
			} catch {
				// Preserve the original subscription failure while still rolling back the runtime.
			}
			opts.manager.remove(sessionId, false);
			publishedThreadId = undefined;
			try {
				await closeResources();
			} catch {
				// Preserve the subscription failure; cleanup was attempted through idempotent closers.
			}
			throw error;
		}
		return runtime;
	} catch (error) {
		if (publishedThreadId) opts.manager.remove(publishedThreadId, false);
		try {
			await closeResources();
		} catch {
			// Preserve the transaction failure; cleanup was attempted through idempotent closers.
		}
		throw error;
	} finally {
		token?.release();
		reservation?.release();
	}
}

/**
 * Wire manager eviction/termination to retained-client and authority-fenced child cleanup.
 * Installation is idempotent per manager, allowing every server request to use the same
 * bridge options without stacking duplicate callbacks.
 */
export function wireCloseCallback(opts: ChildBridgeOptions): void {
	if (wiredManagers.has(opts.manager)) return;
	wiredManagers.add(opts.manager);
	opts.manager.addCloseOwned((threadId, ownership, authority, client, closeChild, closeRuntime) => {
		void (async () => {
			if (closeRuntime) {
				await closeRuntime();
				return;
			}
			if (client) await client.close();
			if (ownership === "spawned") {
				if (closeChild) await closeChild(authority);
				else if (opts.close) await opts.close(threadId, ownership, authority);
			}
		})().catch(() => {});
	});
}
