// app-server child bridge: transactional lifecycle boundary for one loaded thread.
//
// The real broker child is intentionally supplied by an injected adapter. This keeps the
// component contract deterministic while the sandbox-blocked broker spawn remains a separate
// G2 acceptance concern. A successful load retains its session client in the manager until the
// thread is evicted, terminated, or detached.

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Turn } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/Turn";
import { experimentalValidators, stableValidators } from "../protocol-source/schema-validators.generated";
import type {
	AdmissionReservation,
	EndpointAuthority,
	ManagedThread,
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
	/**
	 * Resolve and activate a model override for one turn. The returned disposer MUST restore the
	 * previous model before another turn is admitted; adapters must reject unresolved models.
	 */
	setModelForTurn?: (requestedModel: string) => Promise<() => Promise<void>>;
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
	/**
	 * Ownership the adapter's children have when the request does not state one. An in-process
	 * child is `attached`: there is no separate endpoint process to fence with authority.
	 */
	readonly ownership?: ThreadOwnership;
	/** Authority-only compatibility adapter. */
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
	/** Optional process-wide adapter shutdown hook, invoked after all loaded threads close. */
	readonly shutdown?: () => Promise<void> | void;
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

interface PropertyRead {
	readonly value: unknown;
	readonly failed: boolean;
	readonly error: unknown;
}

function readProperty(record: Record<string, unknown>, key: string): PropertyRead {
	try {
		return { value: record[key], failed: false, error: undefined };
	} catch (error) {
		return { value: undefined, failed: true, error };
	}
}

interface RecordValueRead {
	readonly record: Record<string, unknown> | undefined;
	readonly failure: PropertyRead | undefined;
	readonly malformed: boolean;
}

function readRecordValue(value: unknown): RecordValueRead {
	try {
		return isRecord(value)
			? { record: value, failure: undefined, malformed: false }
			: { record: undefined, failure: undefined, malformed: true };
	} catch (error) {
		return {
			record: undefined,
			failure: { value: undefined, failed: true, error },
			malformed: false,
		};
	}
}

function firstReadFailure(reads: readonly PropertyRead[]): PropertyRead | undefined {
	return reads.find(read => read.failed);
}

function assertSessionClient(
	value: Record<string, unknown>,
	closeRead: PropertyRead,
): asserts value is Record<string, unknown> & SessionClient {
	for (const method of [
		"onFrame",
		"onReconnect",
		"onReconnectFailed",
		"request",
		"query",
		"control",
		"close",
	] as const) {
		const read = method === "close" ? closeRead : readProperty(value, method);
		if (read.failed) throw read.error;
		if (typeof read.value !== "function") throw new Error(`Child session client is missing ${method}().`);
	}
}

function requireDisposer(value: unknown, name: string): () => void {
	if (typeof value !== "function") throw new Error(`Child session client ${name}() did not return a disposer.`);
	return value as () => void;
}

interface EndpointAuthorityRead {
	readonly authority: EndpointAuthority | undefined;
	readonly failure: PropertyRead | undefined;
	readonly malformed: boolean;
}

function readEndpointAuthority(value: unknown): EndpointAuthorityRead {
	if (value === undefined) return { authority: undefined, failure: undefined, malformed: false };
	const recordRead = readRecordValue(value);
	if (recordRead.failure) return { authority: undefined, failure: recordRead.failure, malformed: false };
	if (!recordRead.record) return { authority: undefined, failure: undefined, malformed: true };
	const record = recordRead.record;
	const generation = readProperty(record, "endpointGeneration");
	const incarnation = readProperty(record, "endpointIncarnation");
	const mtime = readProperty(record, "endpointMtimeMs");
	const pid = readProperty(record, "pid");
	const failure = firstReadFailure([generation, incarnation, mtime, pid]);
	if (failure) return { authority: undefined, failure, malformed: false };
	if (
		typeof generation.value !== "number" ||
		!Number.isInteger(generation.value) ||
		typeof incarnation.value !== "string" ||
		incarnation.value.length === 0 ||
		typeof mtime.value !== "number" ||
		!Number.isFinite(mtime.value) ||
		typeof pid.value !== "number" ||
		!Number.isInteger(pid.value)
	)
		return { authority: undefined, failure: undefined, malformed: true };
	return {
		authority: {
			endpointGeneration: generation.value,
			endpointIncarnation: incarnation.value,
			endpointMtimeMs: mtime.value,
			pid: pid.value,
		},
		failure: undefined,
		malformed: false,
	};
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

export function projectThreadResponse(
	runtime: {
		readonly sessionId: string;
		readonly cwd: string;
		readonly effectiveSettings: ThreadEffectiveSettings;
	},
	experimentalApi: boolean,
	turns?: readonly Turn[],
	method: "thread/start" | "thread/resume" = "thread/start",
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
		turns: [...(turns ?? sourceThread.turns)],
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
		if (!Object.hasOwn(settings, "runtimeWorkspaceRoots") || settings.runtimeWorkspaceRoots === undefined)
			throw new Error(`Experimental ${method} response is missing runtimeWorkspaceRoots.`);
		if (!Object.hasOwn(settings, "activePermissionProfile"))
			throw new Error(`Experimental ${method} response is missing activePermissionProfile.`);
		if (!Object.hasOwn(settings, "multiAgentMode"))
			throw new Error(`Experimental ${method} response is missing multiAgentMode.`);
		if (!Object.hasOwn(sourceThread, "extra"))
			throw new Error(`Experimental ${method} response is missing thread.extra.`);
		if (!Object.hasOwn(sourceThread, "historyMode"))
			throw new Error(`Experimental ${method} response is missing thread.historyMode.`);
		if (!Object.hasOwn(sourceThread, "canAcceptDirectInput"))
			throw new Error(`Experimental ${method} response is missing thread.canAcceptDirectInput.`);
		thread.extra = sourceThread.extra;
		thread.historyMode = sourceThread.historyMode;
		thread.canAcceptDirectInput = sourceThread.canAcceptDirectInput;
		response.runtimeWorkspaceRoots = [...settings.runtimeWorkspaceRoots];
		response.activePermissionProfile = settings.activePermissionProfile;
		response.multiAgentMode = settings.multiAgentMode;
		if (method === "thread/resume") {
			response.initialTurnsPage = null;
			response.turnsBackwardsCursor = null;
			response.itemsBackwardsCursor = null;
		}
	}
	const validator = experimentalApi
		? experimentalValidators.clientRequestResults[method]
		: stableValidators.clientRequestResults[method];
	if (!validator(response)) throw new Error(`Child adapter produced an invalid ${method} response.`);
	return response;
}

/**
 * The string overload preserves the legacy adapter API; the request overload is the production boundary.
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
	const request =
		typeof threadIdOrRequest === "string"
			? { threadId: threadIdOrRequest, ownership: legacyOwnership, connectionId: legacyConnectionId }
			: threadIdOrRequest;
	const ownership = request.ownership ?? opts.ownership ?? "spawned";
	const adapter = opts.create;

	wireCloseCallback(opts);
	if (!adapter) {
		if (!opts.spawn) throw new Error("No child lifecycle adapter was supplied.");
		const closeLegacyChild = ownership === "spawned" ? opts.close : undefined;
		if (ownership === "spawned" && !closeLegacyChild)
			throw new Error("Legacy spawned child requires authority-fenced cleanup.");
		const threadId = requiredString(request.threadId, "threadId");
		const token = opts.manager.acquireSpawnToken();
		try {
			const authority = await opts.spawn(threadId, ownership);
			try {
				opts.manager.register(threadId, ownership, authority, request.connectionId, {
					closeChild: closeLegacyChild ? captured => closeLegacyChild(threadId, ownership, captured) : undefined,
				});
				return;
			} catch (error) {
				if (closeLegacyChild) {
					try {
						await closeLegacyChild(threadId, ownership, authority);
					} catch {
						// Preserve the publication failure after attempting authority-fenced cleanup.
					}
				}
				throw error;
			}
		} finally {
			token.release();
		}
	}

	const cwd = normalizedCwd(request);
	const idempotencyKey = request.idempotencyKey ?? `thread-start:${randomUUID()}`;
	const provisionalThreadId = request.threadId ?? `pending:${idempotencyKey}`;
	let reservation: AdmissionReservation | undefined;
	let observerClose: CloseOnce | undefined;
	let token: { release: () => void } | undefined;
	let attachmentOwnsClient = false;
	let attachmentClose: CloseOnce | undefined;
	let clientClose: CloseOnce | undefined;
	let childClose: CloseOnce | undefined;

	let publishedThreadId: string | undefined;
	let publishedThread: ManagedThread | undefined;

	const closeResources = async (): Promise<void> => {
		let firstError: unknown;
		try {
			if (observerClose) await observerClose();
		} catch (error) {
			firstError = error;
		}
		let attachmentCloseFailed = false;
		try {
			if (attachmentClose) await attachmentClose();
		} catch (error) {
			attachmentCloseFailed = true;
			firstError ??= error;
		}
		if (clientClose && (!attachmentOwnsClient || attachmentCloseFailed)) {
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

		// Read every potentially resource-bearing field independently so one throwing accessor
		// cannot prevent cleanup handles from being captured from the remaining fields.
		const childCloseRead = readProperty(child, "closeChild");
		const authorityRead = readProperty(child, "authority");
		const clientRead = readProperty(child, "client");
		const sessionIdRead = readProperty(child, "sessionId");
		const cwdRead = readProperty(child, "cwd");
		const awaitReadyRead = readProperty(child, "awaitReady");
		const effectiveSettingsRead = readProperty(child, "effectiveSettings");
		const childCloseHook =
			typeof childCloseRead.value === "function"
				? (childCloseRead.value as (authority: EndpointAuthority | undefined) => void | Promise<void>)
				: undefined;
		const authoritySnapshot = readEndpointAuthority(authorityRead.value);
		const childAuthority = authoritySnapshot.authority;
		const clientRecordRead = readRecordValue(clientRead.value);
		const clientRecord = clientRecordRead.record;
		const clientCloseRead = clientRecord ? readProperty(clientRecord, "close") : undefined;
		let cleanupThreadId = createRequest.threadId;
		if (clientRecord && typeof clientCloseRead?.value === "function") {
			const closeClient = clientCloseRead.value;
			clientClose = closeOnce(async () => {
				await closeClient.call(clientRecord);
			});
		}
		if (childCloseHook || typeof opts.close === "function") {
			childClose = closeOnce(() => {
				if (childCloseHook) return childCloseHook.call(child, childAuthority);
				if (typeof opts.close === "function") return opts.close(cleanupThreadId, ownership, childAuthority);
			});
		}
		const propertyFailure = firstReadFailure([
			childCloseRead,
			authorityRead,
			clientRead,
			sessionIdRead,
			cwdRead,
			awaitReadyRead,
			effectiveSettingsRead,
			...(clientCloseRead ? [clientCloseRead] : []),
		]);
		if (propertyFailure) throw propertyFailure.error;
		if (clientRecordRead.failure) throw clientRecordRead.failure.error;
		if (clientRecordRead.malformed) throw new Error("Child adapter did not retain a session client.");
		if (authoritySnapshot.failure) throw authoritySnapshot.failure.error;
		if (authoritySnapshot.malformed) throw new Error("Child adapter provided malformed endpoint authority.");
		if (childCloseRead.value !== undefined && !childCloseHook)
			throw new Error("Child adapter provided an invalid closeChild callback.");

		const sessionId = requiredString(sessionIdRead.value, "sessionId");
		cleanupThreadId = sessionId;
		const actualCwd = requiredString(cwdRead.value, "cwd");
		if (!clientRecord || !clientCloseRead) throw new Error("Child adapter did not retain a session client.");
		assertSessionClient(clientRecord, clientCloseRead);
		const client = clientRecord;
		const authority = childAuthority;
		if (ownership === "spawned" && !authority) throw new Error("Spawned child did not provide endpoint authority.");
		if (ownership === "spawned" && !childCloseHook && typeof opts.close !== "function")
			throw new Error("Spawned child did not provide authority-fenced cleanup.");
		if (typeof awaitReadyRead.value !== "function") throw new Error("Child adapter did not provide awaitReady().");
		const awaitReady = awaitReadyRead.value as () => void | Promise<void>;
		const validatedChild: ChildCreateResult = {
			sessionId,
			cwd: actualCwd,
			authority,
			client,
			awaitReady,
			closeChild: childCloseHook,
			...(effectiveSettingsRead.value === undefined
				? {}
				: { effectiveSettings: effectiveSettingsRead.value as ThreadEffectiveSettings }),
		};

		await awaitReady.call(child);
		const observerClosers: Array<() => void> = [];
		observerClose = closeOnce(async () => {
			let firstError: unknown;
			for (const close of observerClosers) {
				try {
					close();
				} catch (error) {
					firstError ??= error;
				}
			}
			if (firstError) throw firstError;
		});

		// Install observers after semantic readiness but before publication so no post-ready
		// frame is lost. Callbacks must tolerate the runtime still being transactional/unpublished.
		observerClosers.push(
			requireDisposer(
				client.onFrame(frame => opts.onFrame?.(validatedChild, frame)),
				"onFrame",
			),
		);
		observerClosers.push(
			requireDisposer(
				client.onReconnect(() => opts.onReconnect?.(validatedChild)),
				"onReconnect",
			),
		);
		observerClosers.push(
			requireDisposer(
				client.onReconnectFailed(error => opts.onReconnectFailed?.(validatedChild, error)),
				"onReconnectFailed",
			),
		);

		if (opts.attachReverseLeaseController) {
			const attached = await opts.attachReverseLeaseController(client, validatedChild, request);
			if (attached !== undefined) {
				if (!isRecord(attached)) throw new Error("Reverse-lease attachment is malformed.");
				const closeRead = readProperty(attached, "close");
				if (typeof closeRead.value === "function") {
					const closeAttachment = closeRead.value;
					attachmentClose = closeOnce(async () => {
						await closeAttachment.call(attached);
					});
				}
				if (closeRead.failed) throw closeRead.error;
				if (!attachmentClose) throw new Error("Reverse-lease attachment did not provide close().");
				const ownsClientRead = readProperty(attached, "ownsClient");
				if (ownsClientRead.failed) throw ownsClientRead.error;
				if (ownsClientRead.value !== undefined && typeof ownsClientRead.value !== "boolean")
					throw new Error("Reverse-lease attachment ownsClient must be boolean.");
				attachmentOwnsClient = ownsClientRead.value === true;
			}
		}

		const effectiveSettings =
			validatedChild.effectiveSettings ??
			(opts.readEffectiveSettings ? await opts.readEffectiveSettings(client, validatedChild, request) : undefined);
		if (!effectiveSettings) throw new Error("Child adapter did not provide effective thread settings.");
		if (!isRecord(effectiveSettings)) throw new Error("Child adapter returned malformed effective thread settings.");
		if (effectiveSettings.cwd !== actualCwd)
			throw new Error("Child effective cwd does not match the captured child cwd.");

		const response = projectThreadResponse(
			{ sessionId, cwd: actualCwd, effectiveSettings },
			request.experimentalApi === true,
		);
		const runtime: LoadedThreadRuntime = {
			threadId: sessionId,
			sessionId,
			ownership,
			cwd: actualCwd,
			authority,
			client,
			effectiveSettings,
			response,
		};

		publishedThread = opts.manager.register(sessionId, ownership, authority, request.connectionId, {
			reservation,
			sessionId,
			cwd: actualCwd,
			client,
			effectiveSettings,
			closeChild: childClose,
			closeRuntime: closeResources,
			lifecycle: "committing",
		});
		publishedThreadId = sessionId;
		reservation = undefined;

		try {
			if (request.subscribe) await request.subscribe(sessionId);
			else if (opts.subscribe) await opts.subscribe(sessionId, request.connectionId);
			if (opts.manager.get(sessionId) !== publishedThread || !opts.manager.markActive(sessionId))
				throw new Error("Thread runtime publication was lost during subscription.");
		} catch (error) {
			try {
				if (request.unsubscribe) await request.unsubscribe(sessionId);
				else if (opts.unsubscribe) await opts.unsubscribe(sessionId, request.connectionId);
			} catch {
				// Preserve the original subscription or ownership failure while still rolling back.
			}
			if (opts.manager.get(sessionId) === publishedThread) opts.manager.remove(sessionId, false);
			publishedThread = undefined;
			publishedThreadId = undefined;
			try {
				await closeResources();
			} catch {
				// Preserve the primary failure; cleanup was attempted through idempotent closers.
			}
			throw error;
		}
		return runtime;
	} catch (error) {
		if (publishedThreadId && opts.manager.get(publishedThreadId) === publishedThread)
			opts.manager.remove(publishedThreadId, false);
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
		return (async () => {
			if (closeRuntime) {
				await closeRuntime();
				return;
			}
			if (client) await client.close();
			if (ownership === "spawned") {
				if (closeChild) await closeChild(authority);
				else if (opts.close) await opts.close(threadId, ownership, authority);
			}
		})();
	});
}
