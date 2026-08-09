import { randomUUID } from "node:crypto";
import { PROMPT_CLIENT_REF_MAX_LENGTH } from "../../prompt-status.js";
import type { ActiveProviderDescriptor } from "../../providers.js";
import { ActiveProviderResolutionError } from "../../providers.js";
import {
	assertCursorSelector,
	type CursorEnvelope,
	CursorError,
	type CursorPosition,
	type CursorRegistry,
	type CursorSelector,
	cursorSelector,
} from "./cursor.js";
import type { RevisionStore } from "./revision-store.js";

export const TARGET_PAGE_BYTES = 256 * 1024;
export const RESPONSE_CEILING_BYTES = 1024 * 1024;

export interface SessionSurface {
	getTranscriptEntries(): unknown[] | Promise<unknown[]>;
	getContextSnapshot(): unknown | Promise<unknown>;
	getGoalState(): unknown | Promise<unknown>;
	getTodoState(): unknown | Promise<unknown>;
	getDiff(): unknown | Promise<unknown>;
	getUsage(): unknown | Promise<unknown>;
	getModels(): unknown | Promise<unknown>;
	getSkillState(): unknown | Promise<unknown>;
	getActiveProviders?(): ActiveProviderDescriptor[] | Promise<ActiveProviderDescriptor[]>;
	/** Q12 rows preserve workflow gate fields and include stable durable gate metadata. */
	getGates(): unknown | Promise<unknown>;
	getConfigItems(): unknown | Promise<unknown>;
	getSessionMetadata(): unknown | Promise<unknown>;
	getStats(): unknown | Promise<unknown>;
	getBranchCandidates(): unknown | Promise<unknown>;
	getLastAssistant(): unknown | Promise<unknown>;
	getCapabilities(): unknown | Promise<unknown>;
	getAuthProviders(): unknown | Promise<unknown>;
	getTools(): unknown | Promise<unknown>;
	getQueueMessages(): unknown | Promise<unknown>;
	getExtensions(): unknown | Promise<unknown>;
	getArtifactRange?(
		id: string,
		offset: number,
		length: number,
	):
		| { bytes: Uint8Array; totalBytes: number }
		| undefined
		| Promise<{ bytes: Uint8Array; totalBytes: number } | undefined>;

	getJobs(): unknown | Promise<unknown>;
	/** Q26 keyed lookup of a submitted prompt's authoritative reconciliation status. */
	getPromptStatus?(selector: { commandId?: string; turnId?: string; clientRef?: string }): unknown | Promise<unknown>;
	getSkillInvokeStatus?(selector: {
		commandId?: string;
		turnId?: string;
		clientRef?: string;
	}): unknown | Promise<unknown>;
	getTurnResult?(selector: {
		kind: "prompt" | "skill";
		clientRef?: string;
		commandId?: string;
		turnId?: string;
	}): unknown | Promise<unknown>;
	/** Q27 effective model-profile catalog from the live session registry. */
	getModelProfiles?(): unknown[] | Promise<unknown[]>;
	/**
	 * Q30 atomic checkpoint capture: the live transcript entries and the
	 * event-ring watermark read in ONE synchronous call, so the snapshot
	 * revision and the subscribe position can never straddle an append.
	 */
	getCheckpointSnapshot?(): { entries: unknown[]; watermark: SdkCheckpointRecord };
	/** Query rows backed by the session's installed binding map. */
	installedQueries?: ReadonlySet<string>;
}

export interface QueryRequest {
	id?: string;
	query: string;
	input?: Record<string, unknown>;
	cursor?: string;
	connectionId: string;
}
export interface QueryPage {
	items: unknown[];
	complete: boolean;
	continuationCursor?: string;
	revision: string;
	preview?: boolean;
}
export interface QueryResponse {
	id?: string;
	ok: boolean;
	page?: QueryPage;
	result?: unknown;
	error?: { code: string; message: string; restartQuery?: boolean; details?: unknown };
}
/**
 * Host-published durable transcript checkpoint (C9). `revision` is the
 * transcript high-watermark (entry count/offset) at checkpoint time and bounds
 * replay to exactly `[checkpointRevision, live)`; `generation`/`seq` anchor the
 * event-ring subscribe position carried by replay cursors.
 */
export interface SdkCheckpointRecord {
	revision: number;
	generation: number;
	seq: number;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isCheckpointRecord(value: unknown): value is SdkCheckpointRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	return (
		keys.length === 3 &&
		isNonNegativeSafeInteger(record.revision) &&
		isNonNegativeSafeInteger(record.generation) &&
		isNonNegativeSafeInteger(record.seq)
	);
}
const sources: Record<string, { resource: string; method: keyof SessionSurface; mvcc: boolean }> = {
	Q01: { resource: "transcript", method: "getTranscriptEntries", mvcc: true },
	Q03: { resource: "context", method: "getContextSnapshot", mvcc: false },
	Q04: { resource: "goal", method: "getGoalState", mvcc: true },
	Q05: { resource: "todo", method: "getTodoState", mvcc: true },
	Q06: { resource: "diff", method: "getDiff", mvcc: true },
	Q07: { resource: "diff", method: "getDiff", mvcc: true },
	Q08: { resource: "diff", method: "getDiff", mvcc: true },
	Q09: { resource: "usage", method: "getUsage", mvcc: false },
	Q10: { resource: "models", method: "getModels", mvcc: false },
	Q11: { resource: "skills", method: "getSkillState", mvcc: true },
	Q12: { resource: "gates", method: "getGates", mvcc: true },
	Q13: { resource: "config", method: "getConfigItems", mvcc: true },
	Q14: { resource: "metadata", method: "getSessionMetadata", mvcc: false },
	Q15: { resource: "stats", method: "getStats", mvcc: false },
	Q16: { resource: "branches", method: "getBranchCandidates", mvcc: false },
	Q17: { resource: "lastAssistant", method: "getLastAssistant", mvcc: false },
	Q18: { resource: "capabilities", method: "getCapabilities", mvcc: false },
	Q19: { resource: "auth", method: "getAuthProviders", mvcc: false },
	Q20: { resource: "tools", method: "getTools", mvcc: true },
	Q21: { resource: "queue", method: "getQueueMessages", mvcc: true },
	Q22: { resource: "extensions", method: "getExtensions", mvcc: true },
	Q25: { resource: "jobs", method: "getJobs", mvcc: false },
	Q29: { resource: "activeProviders", method: "getActiveProviders", mvcc: false },
	Q27: { resource: "modelProfiles", method: "getModelProfiles", mvcc: true },
};
const names = [
	"transcript.list",
	"transcript.body",
	"context.get",
	"goal.list/get",
	"todo.list",
	"diff.list_files",
	"diff.list_hunks",
	"diff.read_hunk",
	"usage.get",
	"models.list/current",
	"skill.list/state",
	"workflow.gates.list",
	"config.list/get",
	"session.metadata",
	"session.stats",
	"session.branch_candidates",
	"session.last_assistant",
	"runtime.capabilities",
	"auth.providers",
	"tools.list",
	"queue.messages.list",
	"extensions.list",
	"resource.body",
	"artifact.read",
	"runtime.jobs.list",
	"turn.result",
	"models.profiles.list",
	"skill.invoke_status",
	"providers.list/active",
	"session.checkpoint",
];

export class QueryHandlers {
	constructor(
		private readonly surface: SessionSurface,
		private readonly sessionId: string,
		private readonly revisions: RevisionStore,
		private readonly cursors: CursorRegistry,
	) {}
	async dispatch(request: QueryRequest): Promise<QueryResponse> {
		try {
			if (request.query === "turn.result") {
				if (this.surface.installedQueries instanceof Set && !this.surface.installedQueries.has("turn.result"))
					return this.#error(
						request,
						"operation_not_session_owned",
						false,
						"turn.result is not installed for this session.",
					);
				return await this.#turnResult(request);
			}
			if (request.query === "turn.prompt_status") return await this.#promptTurnResult(request);
			if (request.query === "skill.invoke_status") return await this.#skillTurnResult(request);

			const query = request.query.startsWith("Q")
				? request.query
				: request.query === "models.list" || request.query === "models.current"
					? "Q10"
					: `Q${String(names.indexOf(request.query) + 1).padStart(2, "0")}`;
			if (query === "Q26") {
				if (this.surface.installedQueries instanceof Set && !this.surface.installedQueries.has("turn.result"))
					return this.#error(
						request,
						"operation_not_session_owned",
						false,
						"turn.result is not installed for this session.",
					);
				return await this.#turnResult(request);
			}
			if (query === "Q28") return await this.#skillTurnResult(request);
			if (
				this.surface.installedQueries instanceof Set &&
				!this.surface.installedQueries.has(names[Number(query.slice(1)) - 1] ?? "")
			)
				return this.#error(
					request,
					"operation_not_session_owned",
					false,
					`${request.query} is not installed for this session.`,
				);
			// D1 strict raw checkpoint/cursor validation (approved authority contract):
			// `checkpointToken` is a signed checkpoint cursor accepted ONLY on Q01
			// (transcript.list), is mutually exclusive with a top-level cursor, and
			// empty cursors are rejected instead of silently dropped.
			if (request.cursor !== undefined && request.cursor === "")
				return this.#error(request, "invalid_input", false, "cursor must be a non-empty string");
			const checkpointToken = request.input?.checkpointToken;
			if (checkpointToken !== undefined) {
				if (typeof checkpointToken !== "string" || checkpointToken.trim() === "")
					return this.#error(request, "invalid_input", false, "checkpointToken must be a non-empty string");
				if (query !== "Q01" && query !== "Q30")
					return this.#error(
						request,
						"invalid_input",
						false,
						"checkpointToken is only supported on transcript.list and session.checkpoint",
					);
				if (request.cursor !== undefined)
					return this.#error(request, "invalid_input", false, "checkpointToken and cursor are mutually exclusive");
			}
			if (query === "Q02") return await this.#transcriptBody(request);
			if (query === "Q23") return await this.#resourceBody(request);
			if (query === "Q24") return await this.#artifact(request);
			if (query === "Q30") return await this.#checkpoint(request);
			if (query === "Q27" && request.input && Object.keys(request.input).length > 0)
				return this.#error(request, "invalid_request", false, "models.profiles.list does not accept input fields.");
			if (query === "Q27" && typeof this.surface.getModelProfiles !== "function")
				return this.#error(request, "unavailable", false, "models.profiles.list is unavailable for this session.");
			if (query === "Q29" && request.input && Object.keys(request.input).length > 0)
				return this.#error(
					request,
					"invalid_request",
					false,
					"providers.list/active does not accept input fields.",
				);
			if (query === "Q29" && typeof this.surface.getActiveProviders !== "function")
				return this.#error(request, "unavailable", false, "providers.list/active is unavailable for this session.");
			const source = sources[query];
			if (!source) return this.#error(request, "invalid_request");
			return await this.#pageSource(request, query, source);
		} catch (error) {
			if (error instanceof CursorError) return this.#error(request, error.code, error.restartQuery, error.message);
			if (isTypedError(error)) return this.#error(request, error.code, false, error.message, error.details);
			return this.#error(request, "internal", false, error instanceof Error ? error.message : String(error));
		}
	}

	async #pageSource(
		request: QueryRequest,
		queryId: string,
		source: { resource: string; method: keyof SessionSurface; mvcc: boolean },
	): Promise<QueryResponse> {
		let selector = selectorFor(queryId, request.input);
		let resourceId = selector.resourceId ?? "default";
		let revision: string;
		let position = 0;
		let byteOffset = 0;
		let snapshot: unknown;
		// The cursor may arrive either as the top-level continuation cursor or,
		// on Q01 only (validated in `dispatch`), as the `checkpointToken` resume
		// seed. Both are signed checkpoint cursors consumed through the same
		// CursorRegistry authority; neither mints a fresh snapshot.
		const rawCursorToken = request.cursor ?? (queryId === "Q01" ? request.input?.checkpointToken : undefined);
		if (rawCursorToken !== undefined && typeof rawCursorToken !== "string")
			return this.#error(request, "invalid_request", false, "checkpointToken must be a non-empty string.");
		const cursorToken = rawCursorToken;
		if (cursorToken !== undefined) {
			const cursor = this.cursors.consume(cursorToken, request.connectionId, {
				sessionId: this.sessionId,
				resource: source.resource,
				direction: "forward",
				pageShape: { targetBytes: TARGET_PAGE_BYTES },
			});
			selector = assertCursorSelector(cursorSelector(cursor.position), selector);
			resourceId = selector.resourceId ?? "default";
			revision = cursor.revision;
			position = Number((cursor.position as CursorPosition).offset ?? 0);
			byteOffset = Number((cursor.position as CursorPosition).byteOffset ?? 0);
			const page = await this.revisions.readPage(source.resource, resourceId, revision, position, TARGET_PAGE_BYTES);
			if (page) {
				if (page.items.length === 0 && !page.complete) {
					const item = await this.revisions.describeIndexedItem(source.resource, resourceId, revision, position);
					const continuations = item?.itemId
						? item.fields.map(field => ({
								query: "Q23",
								resourceKind: source.resource,
								resourceId,
								revision,
								itemId: item.itemId,
								field,
							}))
						: [];
					return this.#paginateIndexed(
						request,
						source.resource,
						resourceId,
						revision,
						[{ id: item?.itemId, error: { code: "item_too_large" }, continuations }],
						false,
						position,
						selector,
						source.resource === "transcript" ? { highWatermark: cursor.highWatermark } : {},
					);
				}
				return this.#paginateIndexed(
					request,
					source.resource,
					resourceId,
					revision,
					page.items,
					page.complete,
					position,
					selector,
					source.resource === "transcript" ? { highWatermark: cursor.highWatermark } : {},
				);
			}
			const range = await this.revisions.readRootRange(
				source.resource,
				resourceId,
				revision,
				byteOffset,
				TARGET_PAGE_BYTES,
			);
			if (!range) return this.#error(request, "resource_gone");
			return this.#chunkRange(
				request,
				source.resource,
				resourceId,
				revision,
				range,
				selector,
				source.resource === "transcript" ? { highWatermark: cursor.highWatermark } : {},
			);
		} else {
			try {
				snapshot = await (this.surface[source.method] as () => unknown)();
			} catch (error) {
				if (queryId === "Q29") throw new ActiveProviderResolutionError();
				throw error;
			}
			revision = await this.revisions.createRevision(source.resource, resourceId, snapshot);
		}
		if (snapshot === undefined) return this.#error(request, "resource_gone");
		if (Array.isArray(snapshot)) {
			const page = await this.revisions.readPage(source.resource, resourceId, revision, 0, TARGET_PAGE_BYTES);
			if (page?.items.length === 0 && !page.complete) {
				const item = await this.revisions.describeIndexedItem(source.resource, resourceId, revision, 0);
				const continuations = item?.itemId
					? item.fields.map(field => ({
							query: "Q23",
							resourceKind: source.resource,
							resourceId,
							revision,
							itemId: item.itemId,
							field,
						}))
					: [];
				return this.#paginateIndexed(
					request,
					source.resource,
					resourceId,
					revision,
					[{ id: item?.itemId, error: { code: "item_too_large" }, continuations }],
					false,
					0,
					selector,
					source.resource === "transcript" ? { highWatermark: lastId(snapshot) } : {},
				);
			}
			if (page)
				return this.#paginateIndexed(
					request,
					source.resource,
					resourceId,
					revision,
					page.items,
					page.complete,
					0,
					selector,
					source.resource === "transcript" ? { highWatermark: lastId(snapshot) } : {},
				);
		}
		const rootBytes = await this.revisions.revisionByteLength(source.resource, resourceId, revision);
		if (rootBytes === undefined) return this.#error(request, "resource_gone");
		if (rootBytes <= TARGET_PAGE_BYTES)
			return this.#paginate(
				request,
				source.resource,
				resourceId,
				revision,
				snapshot,
				0,
				selector,
				source.resource === "transcript" ? { highWatermark: lastId(snapshot) } : {},
			);
		const range = await this.revisions.readRootRange(source.resource, resourceId, revision, 0, TARGET_PAGE_BYTES);
		if (!range) return this.#error(request, "resource_gone");
		return this.#chunkRange(
			request,
			source.resource,
			resourceId,
			revision,
			range,
			selector,
			source.resource === "transcript" ? { highWatermark: lastId(snapshot) } : {},
		);
	}
	async #checkpoint(request: QueryRequest): Promise<QueryResponse> {
		if (request.cursor)
			return this.#error(
				request,
				"invalid_request",
				false,
				"session.checkpoint does not accept a cursor; issue a fresh checkpoint on reconnect.",
			);
		const input = request.input ?? {};
		const inputKeys = Object.keys(input);
		if (inputKeys.some(key => key !== "checkpointToken"))
			return this.#error(request, "invalid_request", false, "session.checkpoint accepts only checkpointToken.");
		if (input.checkpointToken !== undefined) {
			if (typeof input.checkpointToken !== "string" || input.checkpointToken.length === 0)
				return this.#error(request, "invalid_request", false, "checkpointToken must be a non-empty string.");
			try {
				const exchanged = await this.cursors.exchange(
					input.checkpointToken,
					request.connectionId,
					{
						sessionId: this.sessionId,
						resource: "transcript",
						direction: "forward",
						pageShape: { targetBytes: TARGET_PAGE_BYTES },
					},
					"transcript",
					"default",
				);
				return {
					id: request.id,
					ok: true,
					result: {
						checkpointToken: exchanged.cursor,
						checkpoint: exchanged.envelope.highWatermark,
						revisionId: exchanged.envelope.revision,
						issuedAt: exchanged.envelope.issuedAt,
						expiresAt: exchanged.envelope.expiresAt,
					},
				};
			} catch (error) {
				if (error instanceof CursorError)
					return this.#error(request, error.code, error.restartQuery, error.message);
				throw error;
			}
		}
		// Expired pins must be removed before payload-hash deduplication; otherwise
		// createRevision can return an expired revision that grant() immediately sweeps.
		this.cursors.sweep();
		// Atomic synchronous capture (C9): entries and event-ring watermark come
		// from the same host-owned call, so the pinned snapshot revision and the
		// subscribe position can never straddle a concurrent append.
		const captured =
			typeof this.surface.getCheckpointSnapshot === "function" ? this.surface.getCheckpointSnapshot() : undefined;
		const entries = captured !== undefined ? captured.entries : await this.surface.getTranscriptEntries();
		const head: SdkCheckpointRecord =
			captured !== undefined
				? captured.watermark
				: { revision: Array.isArray(entries) ? entries.length : 0, generation: 0, seq: 0 };
		// Mint the snapshot from the exact entries captured with the watermark;
		// entries appended after this point are excluded from replay by
		// construction (append-during-checkpoint), and the returned token is the
		// per-grant signed cursor pinned to this revision — never an unlocked
		// fresh replay authority.
		const snapshot = await this.revisions.createRevision("transcript", "default", entries);
		const nonce = randomUUID();
		const envelope: CursorEnvelope = {
			cursorVersion: 1,
			protocolMajor: 3,
			sessionId: this.sessionId,
			resource: "transcript",
			revision: snapshot,
			highWatermark: head,
			nonce,
			position: { offset: 0, selector: { queryId: "Q01" } },
			direction: "forward",
			pageShape: { targetBytes: TARGET_PAGE_BYTES },
		};
		const cursor = await this.cursors.grant(request.connectionId, envelope, "transcript", "default");
		return {
			id: request.id,
			ok: true,
			result: {
				checkpointToken: cursor,
				checkpoint: head,
				revisionId: snapshot,
				issuedAt: envelope.issuedAt,
				expiresAt: envelope.expiresAt,
			},
		};
	}

	async #transcriptBody(request: QueryRequest): Promise<QueryResponse> {
		let selector = selectorFor("Q02", request.input);
		let entryId = selector.entryId ?? "";
		let revision: string;
		let offset = 0;
		let highWatermark: unknown;
		if (request.cursor) {
			const cursor = this.cursors.consume(request.cursor, request.connectionId, {
				sessionId: this.sessionId,
				resource: "transcript",
				resourceId: "default",
				direction: "forward",
				pageShape: { targetBytes: TARGET_PAGE_BYTES },
			});
			selector = assertCursorSelector(cursorSelector(cursor.position), selector);
			entryId = selector.entryId ?? "";
			revision = cursor.revision;
			offset = Number((cursor.position as CursorPosition).byteOffset ?? 0);
			highWatermark = cursor.highWatermark;
		} else {
			const entries = await this.surface.getTranscriptEntries();
			revision = await this.revisions.createRevision("transcript", "default", entries);
			highWatermark = lastId(entries);
		}
		const range = await this.revisions.readTranscriptBodyRange(
			"default",
			revision,
			entryId,
			offset,
			TARGET_PAGE_BYTES,
		);
		if (!range) return this.#error(request, "resource_gone");
		return this.#chunkRange(request, "transcript", "default", revision, range, selector, { entryId, highWatermark });
	}
	async #turnResult(request: QueryRequest): Promise<QueryResponse> {
		const input = request.input ?? {};
		const keys = Object.keys(input);
		const kind = input.kind;
		const rawClientRef = typeof input.clientRef === "string" ? input.clientRef : undefined;
		const clientRef = rawClientRef?.trim();
		const hasClient = clientRef !== undefined;
		const hasPair = typeof input.commandId === "string" && typeof input.turnId === "string";
		if (
			(kind !== "prompt" && kind !== "skill") ||
			hasClient === hasPair ||
			keys.some(k => !["kind", "clientRef", "commandId", "turnId"].includes(k)) ||
			(hasClient && (!clientRef || clientRef.length > PROMPT_CLIENT_REF_MAX_LENGTH || keys.length !== 2)) ||
			(hasPair && (!input.commandId || !input.turnId || keys.length !== 3))
		)
			return this.#error(request, "invalid_request", false, "turn.result requires kind and exactly one selector");
		// Turn results carry bounded content (≤ TURN_RESULT_CONTENT_MAX_BYTES, 16 KiB)
		// and fit inline within a single query response. Cursored continuation is
		// unreachable: the bounded content cap is well under both RESPONSE_CEILING_BYTES
		// and TARGET_PAGE_BYTES, so no revision is ever created. Reject cursors
		// upfront instead of advertising a continuation path that can never fire.
		if (request.cursor) return this.#error(request, "invalid_cursor", false, "turn.result does not support cursors.");
		if (typeof this.surface.getTurnResult !== "function") return this.#error(request, "unavailable");
		const result = await this.surface.getTurnResult({
			kind,
			...(hasClient ? { clientRef } : { commandId: input.commandId as string, turnId: input.turnId as string }),
		});
		return { id: request.id, ok: true, result };
	}

	async #resourceBody(request: QueryRequest): Promise<QueryResponse> {
		let selector = selectorFor("Q23", request.input);
		let kind = selector.resourceKind ?? "";
		let id = selector.resourceId ?? "default";
		let itemId = selector.itemId;
		let field = selector.field ?? "body";
		let revision = String(request.input?.revision ?? "");
		let offset = Number(request.input?.byteOffset ?? 0);
		if (request.cursor) {
			const cursor = this.cursors.consume(request.cursor, request.connectionId, {
				sessionId: this.sessionId,
				direction: "forward",
				pageShape: { targetBytes: TARGET_PAGE_BYTES },
			});
			selector = assertCursorSelector(cursorSelector(cursor.position), selector);
			kind = selector.resourceKind ?? "";
			id = selector.resourceId ?? "default";
			itemId = selector.itemId;
			field = selector.field ?? "body";
			revision = cursor.revision;
			offset = Number((cursor.position as CursorPosition).byteOffset ?? 0);
		}
		const range =
			itemId === undefined
				? await this.revisions.readStringRange(kind, id, revision, field, offset, TARGET_PAGE_BYTES)
				: await this.revisions.readIndexedFieldRange(kind, id, revision, itemId, field, offset, TARGET_PAGE_BYTES);
		if (!range) return this.#error(request, "resource_gone");
		return this.#chunkRange(request, kind, id, revision, range, selector, {
			field,
			...(itemId === undefined ? {} : { itemId }),
		});
	}

	async #promptTurnResult(request: QueryRequest): Promise<QueryResponse> {
		if (this.surface.installedQueries instanceof Set && !this.surface.installedQueries.has("turn.result"))
			return this.#error(
				request,
				"operation_not_session_owned",
				false,
				"turn.result is not installed for this session.",
			);
		const input = request.input ?? {};
		if (input.kind !== undefined && input.kind !== "prompt")
			return this.#error(request, "invalid_request", false, "turn.prompt_status only accepts prompt selectors.");
		return await this.#turnResult({ ...request, input: { ...input, kind: "prompt" } });
	}
	async #skillTurnResult(request: QueryRequest): Promise<QueryResponse> {
		if (this.surface.installedQueries instanceof Set && !this.surface.installedQueries.has("skill.invoke_status"))
			return this.#error(
				request,
				"operation_not_session_owned",
				false,
				"skill.invoke_status is not installed for this session.",
			);
		const input = request.input ?? {};
		if (input.kind !== undefined && input.kind !== "skill")
			return this.#error(request, "invalid_request", false, "skill.invoke_status only accepts skill selectors.");
		return await this.#turnResult({ ...request, input: { ...input, kind: "skill" } });
	}
	async #artifact(request: QueryRequest): Promise<QueryResponse> {
		const input = request.input ?? {};
		const artifactId = String(input.artifactId ?? "");
		const start = Math.max(0, Number(input.offset ?? 0));
		const emptyResult = { artifactId, offset: start, bytes: "", complete: false };
		const baseBytes = Buffer.byteLength(JSON.stringify({ id: request.id, ok: true, result: emptyResult }));
		const maxRawBytes = Math.floor((RESPONSE_CEILING_BYTES - baseBytes) / 4) * 3;
		const requested = Math.max(0, Math.min(Number(input.length ?? TARGET_PAGE_BYTES), maxRawBytes));
		const artifact = await this.surface.getArtifactRange?.(artifactId, start, requested);
		if (!artifact) return this.#error(request, "resource_gone");
		const bytes = Buffer.from(artifact.bytes);
		if (bytes.length === 0 && start < artifact.totalBytes) return this.#error(request, "item_too_large");
		return {
			id: request.id,
			ok: true,
			result: {
				artifactId,
				offset: start,
				bytes: bytes.toString("base64"),
				complete: start + bytes.length >= artifact.totalBytes,
			},
		};
	}

	async #paginate(
		request: QueryRequest,
		resource: string,
		resourceId: string,
		revision: string,
		snapshot: unknown,
		offset: number,
		selector: CursorSelector,
		extra: Partial<CursorEnvelope>,
	): Promise<QueryResponse> {
		const values = Array.isArray(snapshot) ? snapshot : [snapshot];
		const items: unknown[] = [];
		let itemsBytes = 2; // []
		let index = offset;
		while (index < values.length) {
			const item = values[index]!;
			const itemBytes = Buffer.byteLength(JSON.stringify(item) ?? "null");
			const candidateBytes = itemsBytes + itemBytes + (items.length ? 1 : 0);
			if (candidateBytes > TARGET_PAGE_BYTES && items.length) break;
			if (candidateBytes > RESPONSE_CEILING_BYTES) break;
			items.push(item);
			itemsBytes = candidateBytes;
			index++;
		}
		const complete = index >= values.length;
		const page: QueryPage = { items, complete, revision };
		if (!complete) {
			const envelope: CursorEnvelope = {
				cursorVersion: 1,
				protocolMajor: 3,
				sessionId: this.sessionId,
				resource,
				revision,
				position: { offset: index, selector },
				direction: "forward",
				pageShape: { targetBytes: TARGET_PAGE_BYTES },
				...extra,
			};
			page.continuationCursor = await this.cursors.grant(request.connectionId, envelope, resource, resourceId);
			page.preview = true;
		}
		return { id: request.id, ok: true, page };
	}
	async #paginateIndexed(
		request: QueryRequest,
		resource: string,
		resourceId: string,
		revision: string,
		items: unknown[],
		complete: boolean,
		offset: number,
		selector: CursorSelector,
		extra: Partial<CursorEnvelope>,
	): Promise<QueryResponse> {
		const page: QueryPage = { items, complete, revision };
		if (!complete) {
			const envelope: CursorEnvelope = {
				cursorVersion: 1,
				protocolMajor: 3,
				sessionId: this.sessionId,
				resource,
				revision,
				position: { offset: offset + items.length, selector },
				direction: "forward",
				pageShape: { targetBytes: TARGET_PAGE_BYTES },
				...extra,
			};
			page.continuationCursor = await this.cursors.grant(request.connectionId, envelope, resource, resourceId);
			page.preview = true;
		}
		return { id: request.id, ok: true, page };
	}

	async #chunkRange(
		request: QueryRequest,
		kind: string,
		resourceId: string,
		revision: string,
		range: { body: string; complete: boolean; offset: number },
		selector: CursorSelector,
		extra: Record<string, unknown>,
	): Promise<QueryResponse> {
		const end = range.offset + Buffer.byteLength(range.body);
		const page: QueryPage = {
			items: [{ ...extra, byteOffset: range.offset, body: range.body, complete: range.complete }],
			complete: range.complete,
			revision,
		};
		if (!range.complete) {
			const envelope: CursorEnvelope = {
				cursorVersion: 1,
				protocolMajor: 3,
				sessionId: this.sessionId,
				resource: kind,
				revision,
				position: { byteOffset: end, selector },
				direction: "forward",
				pageShape: { targetBytes: TARGET_PAGE_BYTES },
				...extra,
			};
			page.continuationCursor = await this.cursors.grant(request.connectionId, envelope, kind, resourceId);
			page.preview = true;
		}
		return { id: request.id, ok: true, page };
	}

	#error(request: QueryRequest, code: string, restartQuery = false, message = code, details?: unknown): QueryResponse {
		return {
			id: request.id,
			ok: false,
			error: { code, message, ...(restartQuery ? { restartQuery: true } : {}), ...(details ? { details } : {}) },
		};
	}
}
function selectorFor(queryId: string, input: Record<string, unknown> | undefined): CursorSelector {
	const selector: CursorSelector = { queryId };
	for (const key of [
		"entryId",
		"field",
		"fileId",
		"hunkId",
		"resourceKind",
		"resourceId",
		"itemId",
		"kind",
		"clientRef",
		"commandId",
		"turnId",
	] as const)
		if (input?.[key] !== undefined) selector[key] = String(input[key]);
	return selector;
}

function idOf(value: unknown): string | undefined {
	return value && typeof value === "object" ? String((value as Record<string, unknown>).id ?? "") : undefined;
}
function lastId(value: unknown): string | undefined {
	return Array.isArray(value) ? idOf(value.at(-1)) : undefined;
}
function isTypedError(error: unknown): error is { code: string; message: string; details?: unknown } {
	return Boolean(
		error &&
			typeof error === "object" &&
			typeof (error as { code?: unknown }).code === "string" &&
			typeof (error as { message?: unknown }).message === "string",
	);
}
