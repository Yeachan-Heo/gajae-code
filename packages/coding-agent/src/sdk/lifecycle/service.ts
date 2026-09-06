import { createHash } from "node:crypto";
import path from "node:path";
import {
	resolvedScopeV1,
	resolveScopeRequest,
	type ScopeRequestV1,
	type SdkSearchResultV1,
	type SdkSearchRowV1,
	scopeRequestV1,
	searchRowV1,
} from "../broker/session-scope";
import {
	SessionListTraversalError,
	type SessionListTraversalPage,
	sessionListPageFromResponse,
	traverseSessionList,
} from "../session-list";

export type SessionLifecycleOperation =
	| "session.create"
	| "session.fork"
	| "session.resume"
	| "session.close"
	| "session.delete"
	| "session.reconcile_uncertain"
	| "session.list";

export interface SessionLifecycleActor {
	readonly id: string;
	readonly namespace: string;
}

export interface SessionLifecycleClientRequestOptions {
	readonly idempotencyKey?: string;
	readonly timeoutMs?: number;
}

/** The deliberately small client surface needed by the lifecycle facade. */
export interface SessionLifecycleClient {
	global(
		operation: SessionLifecycleOperation,
		input: Record<string, unknown>,
		options: SessionLifecycleClientRequestOptions,
	): Promise<unknown>;
}

export interface SessionLifecycleWorktreeTarget {
	readonly enabled: true;
	readonly name?: string;
}

export interface SessionLifecycleTranscriptIdentity {
	readonly dev: string;
	readonly ino: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly mtimeNs: string;
	readonly sha256: string;
}

export interface SessionLifecycleSavedSessionIdentity extends SessionLifecycleTranscriptIdentity {
	readonly nlink: string;
	readonly ctimeNs: string;
}

export interface SessionLifecycleSavedSession {
	readonly id: string;
	readonly path: string;
	readonly identity: SessionLifecycleSavedSessionIdentity;
}

export type SessionLifecycleCoordinatorTarget =
	| {
			readonly coordinatorStateDir?: undefined;
			readonly coordinatorSidecarSigningKey?: undefined;
			readonly coordinatorSidecarKeyId?: undefined;
			readonly coordinatorSessionId?: string;
			readonly coordinatorSessionBranch?: string;
	  }
	| {
			readonly coordinatorStateDir: string;
			readonly coordinatorSidecarSigningKey: string;
			readonly coordinatorSidecarKeyId: string;
			readonly coordinatorSessionId?: string;
			readonly coordinatorSessionBranch?: string;
	  };

export type SessionCreateTarget = SessionLifecycleCoordinatorTarget & {
	readonly cwd: string;
	readonly stateRoot?: string;
	readonly body?: string;
	readonly modelPreset?: string;
	readonly mcpServers?: readonly Record<string, unknown>[];
	readonly worktree?: SessionLifecycleWorktreeTarget;
	readonly readiness?: "immediate" | "deferred";
	readonly readinessTimeoutMs?: number;
};

export type SessionForkTarget = SessionLifecycleCoordinatorTarget & {
	readonly cwd: string;
	readonly stateRoot?: string;
	readonly sourceSessionId?: string;
	readonly sourceSessionPath?: string;
	readonly sourceSessionIdentity?: SessionLifecycleTranscriptIdentity;
	readonly body?: string;
	readonly modelPreset?: string;
	readonly mcpServers?: readonly Record<string, unknown>[];
	readonly worktree?: SessionLifecycleWorktreeTarget;
	readonly readinessTimeoutMs?: number;
};

export type SessionResumeTarget = SessionLifecycleCoordinatorTarget & {
	readonly sessionId: string;
	readonly cwd?: string;
	readonly stateRoot?: string;
	readonly sessionPath?: string;
	readonly sessionIdentity?: SessionLifecycleTranscriptIdentity;
	readonly body?: string;
	readonly modelPreset?: string;
	readonly mcpServers?: readonly Record<string, unknown>[];
	readonly worktree?: SessionLifecycleWorktreeTarget;
	readonly readinessTimeoutMs?: number;
};

export interface SessionCloseTarget {
	readonly sessionId: string;
	readonly endpointGeneration?: number;
	readonly endpointIncarnation?: string;
}

export interface SessionReconcileUncertainTarget {
	readonly sessionId: string;
	readonly cwd: string;
	readonly stateRoot: string;
	readonly endpointGeneration: number;
	readonly endpointMtimeMs: number;
	readonly endpointFileId?: string;
	readonly processIncarnation: string;
	readonly hostIncarnation: string;
	readonly lifecycleRequestId: string;
	readonly remoteCreateKey: string;
}

export interface SessionDeleteTarget {
	readonly sessionId: string;
	readonly cwd?: string;
	readonly stateRoot?: string;
	readonly sessionPath?: string;
}

export interface SessionListTarget {
	readonly cwd?: string;
	readonly resolveSessionId?: string;
	readonly scope?: ScopeRequestV1;
	readonly limit?: number;
	readonly cursor?: string;
}

interface SessionLifecycleMutationRequestBase<
	TOperation extends Exclude<SessionLifecycleOperation, "session.list">,
	TTarget,
> {
	readonly operation: TOperation;
	readonly actor: SessionLifecycleActor;
	readonly capability: TOperation;
	readonly requestKey: string;
	readonly target: TTarget;
	readonly timeoutMs?: number;
}

export type SessionCreateRequest = SessionLifecycleMutationRequestBase<"session.create", SessionCreateTarget>;
export type SessionForkRequest = SessionLifecycleMutationRequestBase<"session.fork", SessionForkTarget>;
export type SessionResumeRequest = SessionLifecycleMutationRequestBase<"session.resume", SessionResumeTarget>;
export type SessionCloseRequest = SessionLifecycleMutationRequestBase<"session.close", SessionCloseTarget>;
export type SessionDeleteRequest = SessionLifecycleMutationRequestBase<"session.delete", SessionDeleteTarget>;
export type SessionReconcileUncertainRequest = SessionLifecycleMutationRequestBase<
	"session.reconcile_uncertain",
	SessionReconcileUncertainTarget
>;
export interface SessionListRequest {
	readonly operation: "session.list";
	readonly actor: SessionLifecycleActor;
	readonly capability: "session.list";
	readonly target?: SessionListTarget;
	readonly timeoutMs?: number;
}

export type SessionLifecycleRequest = SessionLifecycleMutationRequest | SessionListRequest;

export type SessionLifecycleMutationRequest =
	| SessionCreateRequest
	| SessionForkRequest
	| SessionResumeRequest
	| SessionCloseRequest
	| SessionDeleteRequest
	| SessionReconcileUncertainRequest;

export type SessionLifecycleCertainty = "terminal" | "retryable" | "cleanup_pending" | "uncertain";

export interface SessionLifecycleSessionResult {
	readonly sessionId: string;
	readonly cwd?: string;
	readonly endpointGeneration?: number;
	readonly endpointFileId?: string;
	readonly reused?: boolean;
	readonly note?: string;
}

export interface SessionLifecycleListEntry {
	readonly sessionId: string;
	readonly live?: boolean;
	readonly endpointGeneration?: number;
	readonly terminalUncertain?: boolean;
	readonly cwd?: string;
	readonly locator?: { readonly cwd: string; readonly worktreeRoot: string | null; readonly stateRoot: string };
}

export interface SessionLifecycleListResult {
	readonly indexSeq: number;
	readonly sessions: readonly SessionLifecycleListEntry[];
	readonly warnings: readonly string[];
	readonly savedSession?: SessionLifecycleSavedSession;
}

export type SessionScopedListResult = SdkSearchResultV1;

export interface SessionCreateResult {
	readonly ok: true;
	readonly operation: "session.create";
	readonly result: SessionLifecycleSessionResult;
}
export interface SessionForkResult {
	readonly ok: true;
	readonly operation: "session.fork";
	readonly result: SessionLifecycleSessionResult;
}
export interface SessionResumeResult {
	readonly ok: true;
	readonly operation: "session.resume";
	readonly result: SessionLifecycleSessionResult;
}
export interface SessionCloseResult {
	readonly ok: true;
	readonly operation: "session.close";
	readonly result: SessionLifecycleSessionResult;
}
export interface SessionDeleteResult {
	readonly ok: true;
	readonly operation: "session.delete";
	readonly result: SessionLifecycleSessionResult;
}
export interface SessionReconcileUncertainResult {
	readonly ok: true;
	readonly operation: "session.reconcile_uncertain";
	readonly result: SessionLifecycleSessionResult;
}
export interface SessionListSuccessResult {
	readonly ok: true;
	readonly operation: "session.list";
	readonly result: SessionLifecycleListResult | SessionScopedListResult;
}

export interface SessionLifecycleError {
	readonly code: string;
	readonly message: string;
}

export type SessionCreateFailure = {
	readonly ok: false;
	readonly operation: "session.create";
	readonly certainty: SessionLifecycleCertainty;
	readonly error: SessionLifecycleError;
};
export type SessionForkFailure = {
	readonly ok: false;
	readonly operation: "session.fork";
	readonly certainty: SessionLifecycleCertainty;
	readonly error: SessionLifecycleError;
};
export type SessionResumeFailure = {
	readonly ok: false;
	readonly operation: "session.resume";
	readonly certainty: SessionLifecycleCertainty;
	readonly error: SessionLifecycleError;
};
export type SessionCloseFailure = {
	readonly ok: false;
	readonly operation: "session.close";
	readonly certainty: SessionLifecycleCertainty;
	readonly error: SessionLifecycleError;
};
export type SessionDeleteFailure = {
	readonly ok: false;
	readonly operation: "session.delete";
	readonly certainty: SessionLifecycleCertainty;
	readonly error: SessionLifecycleError;
};
export type SessionReconcileUncertainFailure = {
	readonly ok: false;
	readonly operation: "session.reconcile_uncertain";
	readonly certainty: SessionLifecycleCertainty;
	readonly error: SessionLifecycleError;
};
export type SessionListFailure = {
	readonly ok: false;
	readonly operation: "session.list";
	readonly certainty: SessionLifecycleCertainty;
	readonly error: SessionLifecycleError;
	readonly result?: SessionScopedListResult;
};

export type SessionCreateOutcome = SessionCreateResult | SessionCreateFailure;
export type SessionForkOutcome = SessionForkResult | SessionForkFailure;
export type SessionResumeOutcome = SessionResumeResult | SessionResumeFailure;
export type SessionCloseOutcome = SessionCloseResult | SessionCloseFailure;
export type SessionDeleteOutcome = SessionDeleteResult | SessionDeleteFailure;
export type SessionReconcileUncertainOutcome = SessionReconcileUncertainResult | SessionReconcileUncertainFailure;
export type SessionListOutcome = SessionListSuccessResult | SessionListFailure;
export type SessionLifecycleResult =
	| SessionCreateOutcome
	| SessionForkOutcome
	| SessionResumeOutcome
	| SessionCloseOutcome
	| SessionDeleteOutcome
	| SessionReconcileUncertainOutcome
	| SessionListOutcome;

/** Shared, side-effect-free validation for lifecycle mutation requests. */
export type SessionLifecycleMutationValidation =
	| {
			readonly ok: true;
			readonly operation: Exclude<SessionLifecycleOperation, "session.list">;
			readonly actor: SessionLifecycleActor;
			readonly requestKey: string;
			readonly target: Readonly<Record<string, unknown>>;
	  }
	| SessionCreateFailure
	| SessionForkFailure
	| SessionResumeFailure
	| SessionCloseFailure
	| SessionDeleteFailure
	| SessionReconcileUncertainFailure;

const RETRYABLE_BROKER_ERRORS = new Set([
	"unavailable",
	"broker_restarting",
	"readiness_timeout",
	"startup_admission_timeout",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean" || typeof value === "number")
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.filter(key => value[key] !== undefined)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(String(value));
}

/** Derives a stable Broker idempotency key without exposing caller identity to Broker inputs. */
export function deriveSessionLifecycleIdempotencyKey(
	actor: SessionLifecycleActor,
	requestKey: string,
	operation: SessionLifecycleOperation,
): string {
	const identity = {
		actorNamespace: actor.namespace,
		actorId: actor.id,
		requestKey,
		operation,
	};
	return createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex");
}

function operationOf(value: unknown): SessionLifecycleOperation {
	if (
		value === "session.create" ||
		value === "session.fork" ||
		value === "session.resume" ||
		value === "session.close" ||
		value === "session.delete" ||
		value === "session.reconcile_uncertain" ||
		value === "session.list"
	)
		return value;
	return "session.list";
}

function failure<TOperation extends SessionLifecycleOperation>(
	operation: TOperation,
	certainty: SessionLifecycleCertainty,
	code: string,
	message: string,
): {
	ok: false;
	operation: TOperation;
	certainty: SessionLifecycleCertainty;
	error: SessionLifecycleError;
} {
	return { ok: false, operation, certainty, error: { code, message } };
}

function validActor(actor: unknown): actor is SessionLifecycleActor {
	return (
		isRecord(actor) &&
		typeof actor.id === "string" &&
		actor.id.length > 0 &&
		typeof actor.namespace === "string" &&
		actor.namespace.length > 0
	);
}

function validRequestKey(requestKey: unknown): requestKey is string {
	return typeof requestKey === "string" && requestKey.length > 0;
}

function validTarget(target: unknown): target is Readonly<Record<string, unknown>> {
	return isRecord(target);
}

export function validateSessionReconcileUncertainTarget(value: unknown): value is SessionReconcileUncertainTarget {
	if (!isRecord(value)) return false;
	const target = value;
	const bounded = (value: unknown, max: number): value is string =>
		typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
	return (
		bounded(target.sessionId, 256) &&
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(target.sessionId) &&
		bounded(target.cwd, 4096) &&
		path.isAbsolute(target.cwd) &&
		bounded(target.stateRoot, 4096) &&
		path.isAbsolute(target.stateRoot) &&
		path.resolve(target.stateRoot) === path.join(path.resolve(target.cwd), ".gjc", "state") &&
		typeof target.endpointGeneration === "number" &&
		Number.isSafeInteger(target.endpointGeneration) &&
		target.endpointGeneration > 0 &&
		typeof target.endpointMtimeMs === "number" &&
		Number.isFinite(target.endpointMtimeMs) &&
		target.endpointMtimeMs > 0 &&
		(target.endpointFileId === undefined || bounded(target.endpointFileId, 256)) &&
		bounded(target.processIncarnation, 256) &&
		bounded(target.hostIncarnation, 256) &&
		bounded(target.lifecycleRequestId, 128) &&
		/^[A-Za-z0-9._-]+$/u.test(target.lifecycleRequestId) &&
		bounded(target.remoteCreateKey, 256)
	);
}

/** Validates lifecycle authority and shape without contacting the Broker. */
export function validateSessionLifecycleMutationRequest(request: unknown): SessionLifecycleMutationValidation {
	const record = isRecord(request) ? request : {};
	const operation = operationOf(record.operation);
	if (operation === "session.list")
		return failure("session.create", "terminal", "invalid_request", "lifecycle mutation operation is required");
	if (!validActor(record.actor))
		return failure(operation, "terminal", "unauthorized", "authenticated actor is required");
	if (!validRequestKey(record.requestKey))
		return failure(operation, "terminal", "invalid_request", "requestKey is required");
	if (record.capability !== operation)
		return failure(operation, "terminal", "capability_denied", `capability does not authorize ${operation}`);
	if (!validTarget(record.target))
		return failure(operation, "terminal", "invalid_request", "target must be an object");
	if (operation === "session.reconcile_uncertain" && !validateSessionReconcileUncertainTarget(record.target))
		return failure(
			operation,
			"terminal",
			"invalid_request",
			"session.reconcile_uncertain target must carry complete identity-bound retirement proof",
		);
	return {
		ok: true,
		operation,
		actor: record.actor,
		requestKey: record.requestKey,
		target: record.target,
	};
}

function certaintyForBrokerCode(code: string): SessionLifecycleCertainty {
	if (code === "terminal_uncertain") return "uncertain";
	if (code === "cleanup_pending") return "cleanup_pending";
	if (RETRYABLE_BROKER_ERRORS.has(code)) return "retryable";
	return "terminal";
}

function credentialFreeRecord(value: Record<string, unknown>): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		if (key === "endpoint" || key === "token" || key === "url") continue;
		if (isRecord(nested)) output[key] = credentialFreeRecord(nested);
		else if (Array.isArray(nested))
			output[key] = nested.map(item => (isRecord(item) ? credentialFreeRecord(item) : item));
		else output[key] = nested;
	}
	return output;
}

function sessionResult(value: unknown, expectedSessionId?: string): SessionLifecycleSessionResult | undefined {
	if (!isRecord(value)) return undefined;
	const record = credentialFreeRecord(value);
	const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
	if (!sessionId || (expectedSessionId !== undefined && sessionId !== expectedSessionId)) return undefined;
	const result: {
		sessionId: string;
		cwd?: string;
		endpointGeneration?: number;
		endpointFileId?: string;
		reused?: boolean;
		note?: string;
	} = { sessionId };
	if (typeof record.cwd === "string") result.cwd = record.cwd;
	const endpointGeneration = record.endpointGeneration;
	if (typeof endpointGeneration === "number" && Number.isSafeInteger(endpointGeneration) && endpointGeneration > 0)
		result.endpointGeneration = endpointGeneration;
	if (typeof record.endpointFileId === "string" && record.endpointFileId.length > 0)
		result.endpointFileId = record.endpointFileId;
	if (typeof record.reused === "boolean") result.reused = record.reused;
	if (typeof record.note === "string") result.note = record.note;
	return result;
}

function reconcileUncertainResult(
	value: unknown,
	target: SessionReconcileUncertainTarget,
): SessionLifecycleSessionResult | undefined {
	if (!isRecord(value)) return undefined;
	const endpointFileId =
		typeof value.endpointFileId === "string" && value.endpointFileId.length > 0 ? value.endpointFileId : undefined;
	if (
		value.sessionId !== target.sessionId ||
		value.retired !== true ||
		value.ledgerState !== "terminal_error" ||
		value.indexType !== "session_closed" ||
		value.stateRoot !== target.stateRoot ||
		value.endpointGeneration !== target.endpointGeneration ||
		value.endpointMtimeMs !== target.endpointMtimeMs ||
		(target.endpointFileId !== undefined && endpointFileId !== target.endpointFileId) ||
		value.processIncarnation !== target.processIncarnation ||
		value.hostIncarnation !== target.hostIncarnation ||
		value.lifecycleRequestId !== target.lifecycleRequestId ||
		value.remoteCreateKey !== target.remoteCreateKey
	)
		return undefined;
	return {
		sessionId: target.sessionId,
		endpointGeneration: target.endpointGeneration,
		...(endpointFileId === undefined ? {} : { endpointFileId }),
	};
}

function savedSessionTranscriptIdentity(value: unknown): SessionLifecycleSavedSessionIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const { dev, ino, nlink, size, mtimeMs, mtimeNs, ctimeNs, sha256 } = value;
	if (
		typeof dev !== "string" ||
		!/^\d+$/.test(dev) ||
		typeof ino !== "string" ||
		!/^\d+$/.test(ino) ||
		typeof nlink !== "string" ||
		!/^\d+$/.test(nlink) ||
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size < 0 ||
		typeof mtimeMs !== "number" ||
		!Number.isFinite(mtimeMs) ||
		mtimeMs < 0 ||
		typeof mtimeNs !== "string" ||
		!/^\d+$/.test(mtimeNs) ||
		typeof ctimeNs !== "string" ||
		!/^\d+$/.test(ctimeNs) ||
		typeof sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(sha256)
	)
		return undefined;
	return { dev, ino, nlink, size, mtimeMs, mtimeNs, ctimeNs, sha256 };
}

function savedSessionFromResult(value: unknown): SessionLifecycleSavedSession | undefined {
	if (!isRecord(value)) return undefined;
	const identity = savedSessionTranscriptIdentity(value.identity);
	if (typeof value.id !== "string" || typeof value.path !== "string" || value.path.length === 0 || !identity)
		return undefined;
	return { id: value.id, path: value.path, identity };
}

function listResult(value: unknown): SessionLifecycleListResult | undefined {
	if (!isRecord(value) || !Array.isArray(value.sessions)) return undefined;
	const indexSeq = value.indexSeq;
	if (
		typeof indexSeq !== "number" ||
		!Number.isSafeInteger(indexSeq) ||
		indexSeq < 0 ||
		!Array.isArray(value.warnings)
	)
		return undefined;
	const sessions: SessionLifecycleListEntry[] = [];
	for (const entry of value.sessions) {
		if (!isRecord(entry) || typeof entry.sessionId !== "string") return undefined;
		const item: {
			sessionId: string;
			live?: boolean;
			endpointGeneration?: number;
			terminalUncertain?: boolean;
			cwd?: string;
			locator?: { cwd: string; worktreeRoot: string | null; stateRoot: string };
		} = { sessionId: entry.sessionId };
		if (typeof entry.live === "boolean") item.live = entry.live;
		if (typeof entry.endpointGeneration === "number") item.endpointGeneration = entry.endpointGeneration;
		if (typeof entry.terminalUncertain === "boolean") item.terminalUncertain = entry.terminalUncertain;
		if (isRecord(entry.locator) && typeof entry.locator.cwd === "string") item.cwd = entry.locator.cwd;
		if (
			isRecord(entry.locator) &&
			typeof entry.locator.cwd === "string" &&
			(entry.locator.worktreeRoot === null || typeof entry.locator.worktreeRoot === "string") &&
			typeof entry.locator.stateRoot === "string"
		)
			item.locator = {
				cwd: entry.locator.cwd,
				worktreeRoot: entry.locator.worktreeRoot,
				stateRoot: entry.locator.stateRoot,
			};
		sessions.push(item);
	}
	const warnings: string[] = [];
	for (const warning of value.warnings) {
		if (typeof warning !== "string") return undefined;
		warnings.push(warning);
	}
	const savedSessionPresent = Object.hasOwn(value, "savedSession");
	const savedSession = savedSessionPresent ? savedSessionFromResult(value.savedSession) : undefined;
	if (savedSessionPresent && !savedSession) return undefined;
	return { indexSeq, sessions, warnings, ...(savedSession ? { savedSession } : {}) };
}

function scopedPage(value: unknown): { scope: SdkSearchResultV1["scope"]; observedAt: string } | undefined {
	if (!isRecord(value)) return undefined;
	const scope = resolvedScopeV1(value.scope);
	return scope && typeof value.observedAt === "string" ? { scope, observedAt: value.observedAt } : undefined;
}

function scopedSearchRows(sessions: readonly SessionLifecycleListEntry[]): SdkSearchRowV1[] | undefined {
	const rows: SdkSearchRowV1[] = [];
	for (const session of sessions) {
		const locator = session.locator;
		if (
			locator === undefined ||
			typeof locator.cwd !== "string" ||
			(locator.worktreeRoot !== null && typeof locator.worktreeRoot !== "string") ||
			typeof locator.stateRoot !== "string"
		)
			return undefined;
		rows.push(
			searchRowV1({
				sessionId: session.sessionId,
				locator: { cwd: locator.cwd, worktreeRoot: locator.worktreeRoot, stateRoot: locator.stateRoot },
				live: session.live === true,
			}),
		);
	}
	return rows;
}
type LifecycleListPage = {
	readonly result: SessionLifecycleListResult;
	readonly sessions: readonly SessionLifecycleListEntry[];
	readonly continuationCursor?: unknown;
	readonly scope?: SdkSearchResultV1["scope"];
	readonly observedAt?: string;
};

function brokerError(value: unknown): { code: string; message: string } | undefined {
	if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) return undefined;
	if (typeof value.error.code !== "string" || typeof value.error.message !== "string") return undefined;
	return { code: value.error.code, message: value.error.message };
}

class BrokerSessionListResponseError extends Error {
	readonly #brokerError: { readonly code: string; readonly message: string };

	constructor(error: { readonly code: string; readonly message: string }) {
		super(error.message);
		this.name = "BrokerSessionListResponseError";
		this.#brokerError = error;
	}

	get brokerError(): { readonly code: string; readonly message: string } {
		return this.#brokerError;
	}
}

function brokerErrorFromThrown(value: unknown): { code: string; message: string; requestSent?: boolean } | undefined {
	if (!isRecord(value)) return undefined;
	const details = isRecord(value.details) ? value.details : undefined;
	const code =
		typeof details?.code === "string" ? details.code : typeof value.code === "string" ? value.code : undefined;
	if (!code) return undefined;
	const message =
		typeof details?.message === "string"
			? details.message
			: typeof value.message === "string"
				? value.message
				: "lifecycle broker request failed";
	const requestSent =
		typeof details?.requestSent === "boolean"
			? details.requestSent
			: typeof value.requestSent === "boolean"
				? value.requestSent
				: undefined;
	return { code, message, ...(requestSent === undefined ? {} : { requestSent }) };
}

function unavailableScopedList(scope: SdkSearchResultV1["scope"]): SessionListFailure {
	return {
		ok: false,
		operation: "session.list",
		certainty: "retryable",
		error: { code: "unavailable", message: "broker search is unavailable" },
		result: {
			version: 1,
			scope,
			status: "unavailable",
			observedAt: new Date().toISOString(),
			rows: [],
			warnings: [],
			error: { code: "unavailable", message: "broker search is unavailable" },
		},
	};
}

const TRANSPORT_ERROR_CODES = new Set([
	"timeout",
	"connection_closed",
	"reconnect_exhausted",
	"unavailable",
	"protocol_error",
]);

function certaintyForThrownError(error: {
	readonly code: string;
	readonly requestSent?: boolean;
}): SessionLifecycleCertainty {
	if (error.code === "protocol_error") return error.requestSent === false ? "retryable" : "uncertain";
	if (!TRANSPORT_ERROR_CODES.has(error.code)) return certaintyForBrokerCode(error.code);
	if (error.requestSent === false) return "retryable";
	if (error.requestSent === true || error.code === "connection_closed") return "uncertain";
	return "retryable";
}

function brokerSuccess(value: unknown): unknown | undefined {
	if (!isRecord(value) || value.ok !== true) return undefined;
	return value.result;
}

export class SessionLifecycleService {
	readonly #client: SessionLifecycleClient;

	constructor(client: SessionLifecycleClient) {
		this.#client = client;
	}

	async scopedList(scope: ScopeRequestV1, limit?: number, cursor?: string): Promise<SessionListOutcome> {
		return await this.#list(
			{
				actor: { id: "gjc-sdk-search-cli", namespace: "sdk:search-cli" },
				capability: "session.list",
				target: {
					scope,
					...(limit === undefined ? {} : { limit }),
					...(cursor === undefined ? {} : { cursor }),
				},
			},
			true,
		);
	}

	async #singleScopedList(
		request: Omit<SessionListRequest, "operation">,
		target: Readonly<Record<string, unknown>>,
		locallyResolvedScope: SdkSearchResultV1["scope"],
	): Promise<SessionListOutcome> {
		let response: unknown;
		try {
			response = await this.#client.global(
				"session.list",
				{ ...target },
				{
					...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
				},
			);
		} catch (thrown) {
			const error = brokerError(thrown) ?? brokerErrorFromThrown(thrown);
			if (!error || error.code === "unavailable") return unavailableScopedList(locallyResolvedScope);
			return failure("session.list", certaintyForThrownError(error), error.code, error.message);
		}
		const error = brokerError(response);
		if (error) {
			if (error.code === "unavailable") return unavailableScopedList(locallyResolvedScope);
			return failure("session.list", certaintyForBrokerCode(error.code), error.code, error.message);
		}
		if (!isRecord(response) || response.ok !== true)
			return failure(
				"session.list",
				"uncertain",
				"malformed_response",
				"lifecycle broker returned a malformed scoped list result",
			);
		const page = sessionListPageFromResponse(response);
		const result = page === undefined ? undefined : listResult(page);
		const pageScope = page === undefined ? undefined : scopedPage(page);
		if (page === undefined || !result || !pageScope)
			return failure(
				"session.list",
				"uncertain",
				"malformed_response",
				"lifecycle broker returned a malformed scoped list result",
			);
		if (JSON.stringify(pageScope.scope) !== JSON.stringify(locallyResolvedScope))
			return failure(
				"session.list",
				"uncertain",
				"scope_observation_drift",
				"lifecycle broker scope does not match the locally resolved request scope",
			);
		const continuationCursor = page.continuationCursor;
		if (
			continuationCursor !== undefined &&
			(typeof continuationCursor !== "string" || continuationCursor.length === 0)
		)
			return failure(
				"session.list",
				"uncertain",
				"malformed_response",
				"lifecycle broker returned a malformed scoped list result",
			);
		const rows = scopedSearchRows(result.sessions);
		if (!rows)
			return failure(
				"session.list",
				"uncertain",
				"malformed_response",
				"lifecycle broker returned a malformed scoped list result",
			);
		return {
			ok: true,
			operation: "session.list",
			result: {
				version: 1,
				scope: pageScope.scope,
				status:
					pageScope.scope.resolution === "not-in-git-worktree"
						? "not-in-git-worktree"
						: rows.length === 0
							? "empty"
							: "populated",
				observedAt: pageScope.observedAt,
				indexSeq: result.indexSeq,
				rows,
				...(continuationCursor === undefined ? {} : { cursor: continuationCursor }),
				warnings: result.warnings,
			},
		};
	}

	async execute(
		request: SessionLifecycleMutationRequest,
		idempotencyKeyOverride?: string,
	): Promise<
		| SessionCreateOutcome
		| SessionForkOutcome
		| SessionResumeOutcome
		| SessionCloseOutcome
		| SessionDeleteOutcome
		| SessionReconcileUncertainOutcome
	> {
		const validation = validateSessionLifecycleMutationRequest(request);
		if (!validation.ok) return validation;
		const { operation, actor, requestKey, target } = validation;
		const normalizedTarget =
			operation === "session.reconcile_uncertain"
				? {
						...target,
						cwd: path.resolve((target as unknown as SessionReconcileUncertainTarget).cwd),
						stateRoot: path.join(
							path.resolve((target as unknown as SessionReconcileUncertainTarget).cwd),
							".gjc",
							"state",
						),
					}
				: target;
		const idempotencyKey =
			idempotencyKeyOverride ?? deriveSessionLifecycleIdempotencyKey(actor, requestKey, operation);
		let response: unknown;
		try {
			response = await this.#client.global(
				operation,
				{ ...normalizedTarget },
				{
					idempotencyKey,
					...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
				},
			);
		} catch (thrown) {
			const error = brokerError(thrown) ?? brokerErrorFromThrown(thrown);
			return error
				? failure(operation, certaintyForThrownError(error), error.code, error.message)
				: failure(operation, "retryable", "unavailable", "lifecycle broker request was unavailable");
		}

		const error = brokerError(response);
		if (error) return failure(operation, certaintyForBrokerCode(error.code), error.code, error.message);
		if (!isRecord(response) || response.ok !== true)
			return failure(operation, "uncertain", "malformed_response", "lifecycle broker returned a malformed response");
		const expectedSessionId =
			operation === "session.resume" ||
			operation === "session.close" ||
			operation === "session.delete" ||
			operation === "session.reconcile_uncertain"
				? typeof normalizedTarget.sessionId === "string"
					? normalizedTarget.sessionId
					: undefined
				: undefined;
		const parsed =
			operation === "session.reconcile_uncertain"
				? reconcileUncertainResult(
						brokerSuccess(response),
						normalizedTarget as unknown as SessionReconcileUncertainTarget,
					)
				: sessionResult(brokerSuccess(response), expectedSessionId);
		if (!parsed)
			return failure(
				operation,
				"uncertain",
				"malformed_response",
				"lifecycle broker returned a malformed session result",
			);
		return { ok: true, operation, result: parsed } as
			| SessionCreateOutcome
			| SessionForkOutcome
			| SessionResumeOutcome
			| SessionCloseOutcome
			| SessionDeleteOutcome
			| SessionReconcileUncertainOutcome;
	}

	async executeWithIdempotencyKey(
		request: SessionLifecycleMutationRequest,
		idempotencyKey: string,
	): Promise<
		| SessionCreateOutcome
		| SessionForkOutcome
		| SessionResumeOutcome
		| SessionCloseOutcome
		| SessionDeleteOutcome
		| SessionReconcileUncertainOutcome
	> {
		return this.execute(request, idempotencyKey);
	}

	async create(request: Omit<SessionCreateRequest, "operation">): Promise<SessionCreateOutcome> {
		return (await this.execute({ ...request, operation: "session.create" })) as SessionCreateOutcome;
	}

	async fork(request: Omit<SessionForkRequest, "operation">): Promise<SessionForkOutcome> {
		return (await this.execute({ ...request, operation: "session.fork" })) as SessionForkOutcome;
	}

	async resume(request: Omit<SessionResumeRequest, "operation">): Promise<SessionResumeOutcome> {
		return (await this.execute({ ...request, operation: "session.resume" })) as SessionResumeOutcome;
	}

	async close(request: Omit<SessionCloseRequest, "operation">): Promise<SessionCloseOutcome> {
		return (await this.execute({ ...request, operation: "session.close" })) as SessionCloseOutcome;
	}

	async delete(request: Omit<SessionDeleteRequest, "operation">): Promise<SessionDeleteOutcome> {
		return (await this.execute({ ...request, operation: "session.delete" })) as SessionDeleteOutcome;
	}

	async reconcileUncertain(
		request: Omit<SessionReconcileUncertainRequest, "operation">,
	): Promise<SessionReconcileUncertainOutcome> {
		return (await this.execute({
			...request,
			operation: "session.reconcile_uncertain",
		})) as SessionReconcileUncertainOutcome;
	}

	async list(request: Omit<SessionListRequest, "operation">): Promise<SessionListOutcome> {
		return await this.#list(request, false);
	}
	async #list(request: Omit<SessionListRequest, "operation">, singleScopedPage: boolean): Promise<SessionListOutcome> {
		if (!validActor((request as { actor?: unknown }).actor))
			return failure("session.list", "terminal", "unauthorized", "authenticated actor is required");
		if ((request as { capability?: unknown }).capability !== "session.list")
			return failure("session.list", "terminal", "capability_denied", "capability does not authorize session.list");
		const target = request.target ?? {};
		if (!validTarget(target))
			return failure("session.list", "terminal", "invalid_request", "target must be an object");
		const scopeRequest = target.scope === undefined ? undefined : scopeRequestV1(target.scope);
		if (target.scope !== undefined && !scopeRequest)
			return failure("session.list", "terminal", "invalid_request", "scope must be a valid ScopeRequestV1");
		let locallyResolvedScope: SdkSearchResultV1["scope"] | undefined;
		if (scopeRequest !== undefined) {
			try {
				locallyResolvedScope = await resolveScopeRequest(scopeRequest);
			} catch (cause) {
				return failure(
					"session.list",
					"terminal",
					"invalid_request",
					cause instanceof Error ? cause.message : "scope could not be resolved",
				);
			}
		}
		if (singleScopedPage && locallyResolvedScope !== undefined)
			return await this.#singleScopedList(request, target, locallyResolvedScope);
		let pages: readonly SessionListTraversalPage<unknown, LifecycleListPage>[];
		try {
			pages = await traverseSessionList<Record<string, unknown>, unknown, LifecycleListPage>(
				{ ...target },
				async input =>
					await this.#client.global("session.list", input, {
						...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
					}),
				response => {
					const error = brokerError(response);
					if (error) throw new BrokerSessionListResponseError(error);
					if (!isRecord(response) || response.ok !== true) return undefined;
					const page = sessionListPageFromResponse(response);
					if (!page) return undefined;
					const result = listResult(page);
					const scoped = scopedPage(page);
					return result
						? {
								result,
								sessions: result.sessions,
								continuationCursor: page.continuationCursor,
								...(scoped === undefined ? {} : scoped),
							}
						: undefined;
				},
			);
		} catch (thrown) {
			if (thrown instanceof BrokerSessionListResponseError) {
				const error = thrown.brokerError;
				if (error.code === "unavailable" && locallyResolvedScope)
					return unavailableScopedList(locallyResolvedScope);
				return failure("session.list", certaintyForBrokerCode(error.code), error.code, error.message);
			}
			if (thrown instanceof SessionListTraversalError)
				return failure(
					"session.list",
					"uncertain",
					thrown.kind === "malformed_page" ? "malformed_response" : "protocol_error",
					thrown.kind === "malformed_page"
						? "lifecycle broker returned a malformed list result"
						: thrown.kind === "repeated_cursor"
							? "session.list returned a repeated continuation cursor"
							: "session.list exceeded the page budget",
				);
			const error = brokerError(thrown) ?? brokerErrorFromThrown(thrown);
			if (locallyResolvedScope && (!error || error.code === "unavailable"))
				return unavailableScopedList(locallyResolvedScope);
			return error
				? failure("session.list", certaintyForThrownError(error), error.code, error.message)
				: failure("session.list", "retryable", "unavailable", "lifecycle broker request was unavailable");
		}
		const firstPage = pages[0];
		if (!firstPage)
			return failure(
				"session.list",
				"uncertain",
				"malformed_response",
				"lifecycle broker returned a malformed list result",
			);
		const { result } = firstPage.page;
		if (request.target?.scope !== undefined) {
			const scope = firstPage.page.scope;
			const observedAt = firstPage.page.observedAt;
			if (!scope || !observedAt)
				return failure(
					"session.list",
					"uncertain",
					"malformed_response",
					"lifecycle broker returned a malformed scoped list result",
				);
			const frozenScope = JSON.stringify(scope);
			const frozenIndexSeq = result.indexSeq;
			for (const page of pages) {
				const pageScope = page.page.scope;
				const pageObservedAt = page.page.observedAt;
				if (
					pageScope === undefined ||
					pageObservedAt !== observedAt ||
					page.page.result.indexSeq !== frozenIndexSeq ||
					JSON.stringify(pageScope) !== frozenScope
				)
					return failure(
						"session.list",
						"uncertain",
						"scope_observation_drift",
						"lifecycle broker changed the frozen scope observation across list pages",
					);
			}
			if (locallyResolvedScope && JSON.stringify(locallyResolvedScope) !== frozenScope)
				return failure(
					"session.list",
					"uncertain",
					"scope_observation_drift",
					"lifecycle broker scope does not match the locally resolved request scope",
				);
			const rows = scopedSearchRows(pages.flatMap(page => page.page.result.sessions));
			if (!rows)
				return failure(
					"session.list",
					"uncertain",
					"malformed_response",
					"lifecycle broker returned a malformed scoped list result",
				);
			return {
				ok: true,
				operation: "session.list",
				result: {
					version: 1,
					scope,
					status:
						scope.resolution === "not-in-git-worktree"
							? "not-in-git-worktree"
							: rows.length === 0
								? "empty"
								: "populated",
					observedAt,
					indexSeq: result.indexSeq,
					rows,
					warnings: result.warnings,
				},
			};
		}
		return {
			ok: true,
			operation: "session.list",
			result: {
				indexSeq: result.indexSeq,
				sessions: pages.flatMap(page => page.page.result.sessions),
				warnings: result.warnings,
				...(result.savedSession === undefined ? {} : { savedSession: result.savedSession }),
			},
		};
	}
}
