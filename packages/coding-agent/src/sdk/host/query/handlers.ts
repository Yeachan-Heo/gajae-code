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
	error?: { code: string; message: string; restartQuery?: boolean };
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
			const query = request.query.startsWith("Q")
				? request.query
				: request.query === "models.list" || request.query === "models.current"
					? "Q10"
					: `Q${String(names.indexOf(request.query) + 1).padStart(2, "0")}`;
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
			if (query === "Q02") return await this.#transcriptBody(request);
			if (query === "Q23") return await this.#resourceBody(request);
			if (query === "Q24") return await this.#artifact(request);
			const source = sources[query];
			if (!source) return this.#error(request, "invalid_request");
			return await this.#pageSource(request, query, source);
		} catch (error) {
			if (error instanceof CursorError) return this.#error(request, error.code, error.restartQuery, error.message);
			if (isTypedError(error)) return this.#error(request, error.code, false, error.message);
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
		if (request.cursor) {
			const cursor = this.cursors.consume(request.cursor, request.connectionId, {
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
			snapshot = await (this.surface[source.method] as () => unknown)();
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
				: await this.revisions.readIndexedStringRange(kind, id, revision, itemId, field, offset, TARGET_PAGE_BYTES);
		if (!range) return this.#error(request, "resource_gone");
		return this.#chunkRange(request, kind, id, revision, range, selector, {
			field,
			...(itemId === undefined ? {} : { itemId }),
		});
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

	#error(request: QueryRequest, code: string, restartQuery = false, message = code): QueryResponse {
		return { id: request.id, ok: false, error: { code, message, ...(restartQuery ? { restartQuery: true } : {}) } };
	}
}
function selectorFor(queryId: string, input: Record<string, unknown> | undefined): CursorSelector {
	const selector: CursorSelector = { queryId };
	for (const key of ["entryId", "field", "fileId", "hunkId", "resourceKind", "resourceId", "itemId"] as const)
		if (input?.[key] !== undefined) selector[key] = String(input[key]);
	return selector;
}

function idOf(value: unknown): string | undefined {
	return value && typeof value === "object" ? String((value as Record<string, unknown>).id ?? "") : undefined;
}
function lastId(value: unknown): string | undefined {
	return Array.isArray(value) ? idOf(value.at(-1)) : undefined;
}
function isTypedError(error: unknown): error is { code: string; message: string } {
	return Boolean(
		error &&
			typeof error === "object" &&
			typeof (error as { code?: unknown }).code === "string" &&
			typeof (error as { message?: unknown }).message === "string",
	);
}
