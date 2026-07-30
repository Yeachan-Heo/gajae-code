import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import type { Thread } from "../../../vendor/codex-app-server-schema/experimental/typescript/v2/Thread";
import type { ThreadItem } from "../../../vendor/codex-app-server-schema/experimental/typescript/v2/ThreadItem";
import type { Turn } from "../../../vendor/codex-app-server-schema/experimental/typescript/v2/Turn";
import { readAppServerProjections } from "../../session/app-server-projection";
import {
	type FileEntry,
	loadEntriesFromFile,
	type SessionHeader,
	type SessionInfo,
	SessionManager,
} from "../../session/session-manager";
import { experimentalValidators, stableValidators } from "../protocol-source/schema-validators.generated";
import { reconstructTurnSnapshots } from "../thread-runtime/turn-projection";
import type { HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;
type SortDirection = "asc" | "desc";
type SortKey = "created_at" | "updated_at" | "recency_at";

interface PersistedSession {
	readonly info: SessionInfo;
	readonly header: SessionHeader;
	readonly entries: readonly FileEntry[];
	readonly turns: readonly Turn[];
	readonly thread: Thread;
	readonly text: string;
	readonly sourceKind: string;
}

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 10_000;
const UNKNOWN_MODEL_PROVIDER = "unknown";
const UNKNOWN_CLI_VERSION = "unknown";
const UNKNOWN_SOURCE = "unknown" as const;

const invalidParams = (): HandlerResult => ({ ok: false, errorKey: "invalidParams" });
const internalError = (): HandlerResult => ({ ok: false, errorKey: "internalError" });
const notFound = (): HandlerResult => ({ ok: false, errorKey: "notFound" });

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function paramsRecord(params: unknown): RecordValue | undefined {
	return isRecord(params) ? params : undefined;
}

function optionalStringIsValid(params: RecordValue, key: string): boolean {
	const value = params[key];
	return value === undefined || value === null || typeof value === "string";
}

function readLimit(value: unknown): number | undefined {
	if (value === undefined || value === null) return DEFAULT_PAGE_LIMIT;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_PAGE_LIMIT)
		return undefined;
	return value;
}

function readSortDirection(value: unknown, fallback: SortDirection): SortDirection | undefined {
	if (value === undefined || value === null) return fallback;
	return value === "asc" || value === "desc" ? value : undefined;
}

function readSortKey(value: unknown): SortKey | undefined {
	if (value === undefined || value === null) return "created_at";
	return value === "created_at" || value === "updated_at" || value === "recency_at" ? value : undefined;
}

function encodeCursor(kind: string, offset: number): string {
	return Buffer.from(JSON.stringify({ kind, offset }), "utf8").toString("base64url");
}

function decodeCursor(value: unknown, kind: string): number | undefined {
	if (value === undefined || value === null) return 0;
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		if (!isRecord(parsed) || parsed.kind !== kind) return undefined;
		const offset = parsed.offset;
		return typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
	} catch {
		return undefined;
	}
}

function page<T>(values: readonly T[], cursor: unknown, limit: number, kind: string) {
	const offset = decodeCursor(cursor, kind);
	if (offset === undefined) return undefined;
	const data = values.slice(offset, offset + limit);
	const end = offset + data.length;
	return {
		data,
		nextCursor: end < values.length ? encodeCursor(kind, end) : null,
		backwardsCursor: data.length > 0 ? encodeCursor(kind, offset) : null,
	};
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map(block => {
			if (!isRecord(block)) return "";
			return typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join(" ");
}

function messageText(value: unknown): string {
	if (!isRecord(value)) return "";
	const role = value.role;
	if (role !== "user" && role !== "assistant" && role !== "custom") return "";
	return textFromContent(value.content);
}

function entryText(entry: FileEntry): string {
	if (entry.type === "message") return messageText(entry.message);
	if (entry.type === "custom_message") return textFromContent(entry.content);
	return "";
}

function itemText(item: ThreadItem): string {
	if (item.type === "userMessage") return item.content.map(content => textFromContent([content])).join(" ");
	if (item.type === "agentMessage") return item.text;
	return "";
}

function modelProvider(entries: readonly FileEntry[]): string {
	for (const entry of entries.toReversed()) {
		if (entry.type !== "model_change" || typeof entry.model !== "string") continue;
		const separator = entry.model.indexOf("/");
		return separator > 0 ? entry.model.slice(0, separator) : UNKNOWN_MODEL_PROVIDER;
	}
	return UNKNOWN_MODEL_PROVIDER;
}

function secondsFromDate(value: Date, fallback = 0): number {
	const millis = value.getTime();
	return Number.isFinite(millis) ? Math.max(0, Math.floor(millis / 1000)) : fallback;
}

function sourceKindForHeader(_header: SessionHeader): string {
	// SessionHeader deliberately has no origin field. Unknown is the only honest
	// source classification for persisted sessions created outside the app-server.
	return "unknown";
}

function threadForSession(
	info: SessionInfo,
	header: SessionHeader,
	turns: readonly Turn[],
	parentThreadId: string | null,
): Thread {
	const createdAt = secondsFromDate(new Date(header.timestamp), secondsFromDate(info.created));
	const updatedAt = secondsFromDate(info.modified, createdAt);
	const cwd = path.resolve(header.cwd || info.cwd || process.cwd());
	const preview = info.firstMessage === "(no messages)" ? "" : info.firstMessage;
	return {
		id: header.id,
		extra: null,
		historyMode: "legacy",
		sessionId: header.id,
		forkedFromId: parentThreadId,
		parentThreadId: null,
		preview,
		ephemeral: false,
		isPinned: false,
		modelProvider: modelProvider([]),
		createdAt,
		updatedAt,
		recencyAt: updatedAt,
		status: { type: "notLoaded" },
		path: info.path,
		cwd,
		cliVersion: UNKNOWN_CLI_VERSION,
		source: UNKNOWN_SOURCE,
		canAcceptDirectInput: null,
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: null,
		name: header.title ?? info.title ?? null,
		turns: [...turns],
	};
}

function projectThread(
	info: SessionInfo,
	header: SessionHeader,
	entries: readonly FileEntry[],
	turns: readonly Turn[],
	parentThreadId: string | null,
	includeTurns: boolean,
): Thread {
	const thread = threadForSession(info, header, includeTurns ? turns : [], parentThreadId);
	return { ...thread, modelProvider: modelProvider(entries) };
}

function projectionTurns(entries: readonly FileEntry[]): readonly Turn[] {
	const store = {
		getEntries: () => entries,
		appendAppServerProjectionEntry: (_data: unknown) => {
			throw new Error("read-only projection store");
		},
		flush: async () => undefined,
	};
	const read = readAppServerProjections(store);
	return reconstructTurnSnapshots(read.records.map(record => record.envelope));
}

function resolveAgentDir(): string {
	const configured = process.env.GJC_AGENT_DIR ?? process.env.GJC_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
	return path.resolve(configured ?? getAgentDir());
}

async function loadSessions(): Promise<PersistedSession[]> {
	const infos = await SessionManager.listAll(undefined, resolveAgentDir());
	const raw: Array<{
		info: SessionInfo;
		header: SessionHeader;
		entries: readonly FileEntry[];
		turns: readonly Turn[];
		text: string;
		sourceKind: string;
	}> = [];
	for (const info of infos) {
		const entries = await loadEntriesFromFile(info.path);
		const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
		if (!header || header.id !== info.id) continue;
		const turns = projectionTurns(entries);
		const messageTextValues = entries.map(entryText).filter(Boolean);
		const projectionText = turns.flatMap(turn => turn.items.map(itemText)).filter(Boolean);
		raw.push({
			info,
			header,
			entries,
			turns,
			text: [...messageTextValues, ...projectionText].join(" "),
			sourceKind: sourceKindForHeader(header),
		});
	}
	const byPath = new Map(raw.map(record => [path.resolve(record.info.path), record.header.id]));
	const byId = new Map(raw.map(record => [record.header.id, record.header.id]));
	return raw.map(record => {
		const parent = record.header.parentSession;
		let parentId: string | null = null;
		if (parent) {
			parentId = byId.get(parent) ?? byPath.get(path.resolve(parent)) ?? null;
		}
		return {
			...record,
			thread: projectThread(record.info, record.header, record.entries, record.turns, parentId, false),
		};
	});
}

function sortValue(record: PersistedSession, key: SortKey): number {
	if (key === "created_at") return record.thread.createdAt;
	if (key === "recency_at") return record.thread.recencyAt ?? record.thread.updatedAt;
	return record.thread.updatedAt;
}

function sortSessions(
	records: readonly PersistedSession[],
	key: SortKey,
	direction: SortDirection,
): PersistedSession[] {
	return [...records].sort((left, right) => {
		const delta = sortValue(left, key) - sortValue(right, key);
		if (delta !== 0) return direction === "asc" ? delta : -delta;
		const idDelta = left.thread.id.localeCompare(right.thread.id);
		return direction === "asc" ? idDelta : -idDelta;
	});
}

function cwdMatches(thread: Thread, filter: unknown): boolean {
	if (filter === undefined || filter === null) return true;
	const values = typeof filter === "string" ? [filter] : Array.isArray(filter) ? filter : undefined;
	return values?.some(value => typeof value === "string" && path.resolve(value) === thread.cwd) ?? false;
}

function isDescendant(record: PersistedSession, ancestorId: string, records: readonly PersistedSession[]): boolean {
	const byId = new Map(records.map(candidate => [candidate.thread.id, candidate]));
	let current = record.thread.forkedFromId;
	const visited = new Set<string>();
	while (current && !visited.has(current)) {
		if (current === ancestorId) return true;
		visited.add(current);
		current = byId.get(current)?.thread.forkedFromId ?? null;
	}
	return false;
}

function listFilters(records: readonly PersistedSession[], params: RecordValue): PersistedSession[] | undefined {
	if (typeof params.useStateDbOnly !== "boolean") return undefined;
	if (!optionalStringIsValid(params, "cursor") || !optionalStringIsValid(params, "searchTerm")) return undefined;
	const modelProviders = params.modelProviders;
	if (
		modelProviders !== undefined &&
		modelProviders !== null &&
		(!Array.isArray(modelProviders) || !modelProviders.every(value => typeof value === "string"))
	)
		return undefined;
	const sourceKinds = params.sourceKinds;
	if (
		sourceKinds !== undefined &&
		sourceKinds !== null &&
		(!Array.isArray(sourceKinds) || !sourceKinds.every(value => typeof value === "string"))
	)
		return undefined;
	if (!optionalStringIsValid(params, "parentThreadId") || !optionalStringIsValid(params, "ancestorThreadId"))
		return undefined;
	if (
		params.parentThreadId !== undefined &&
		params.parentThreadId !== null &&
		params.ancestorThreadId !== undefined &&
		params.ancestorThreadId !== null
	)
		return undefined;
	if (params.archived !== undefined && params.archived !== null && typeof params.archived !== "boolean")
		return undefined;
	if (params.isPinned !== undefined && params.isPinned !== null && typeof params.isPinned !== "boolean")
		return undefined;
	const result = records.filter(record => {
		const thread = record.thread;
		if (!cwdMatches(thread, params.cwd)) return false;
		if (Array.isArray(modelProviders) && modelProviders.length > 0 && !modelProviders.includes(thread.modelProvider))
			return false;
		if (Array.isArray(sourceKinds) && sourceKinds.length > 0 && !sourceKinds.includes(record.sourceKind))
			return false;
		// GJC has no persisted archive/pin fields. `false` means the real unarchived/
		// unpinned inventory; `true` cannot be honestly satisfied by this seam.
		if (params.archived === true || params.isPinned === true) return false;
		if (params.archived !== undefined && params.archived !== null && params.archived !== false) return false;
		if (params.isPinned !== undefined && params.isPinned !== null && params.isPinned !== false) return false;
		if (typeof params.searchTerm === "string" && params.searchTerm.length > 0) {
			const needle = params.searchTerm.toLocaleLowerCase();
			const haystack = `${thread.name ?? ""} ${thread.preview}`.toLocaleLowerCase();
			if (!haystack.includes(needle)) return false;
		}
		if (typeof params.parentThreadId === "string" && thread.forkedFromId !== params.parentThreadId) return false;
		if (typeof params.ancestorThreadId === "string" && !isDescendant(record, params.ancestorThreadId, records))
			return false;
		return true;
	});
	return result;
}

function resultWithValidator(profile: "stable" | "experimental", method: string, result: unknown): HandlerResult {
	const validator = (profile === "stable" ? stableValidators : experimentalValidators).clientRequestResults[method];
	if (!validator?.(result)) return internalError();
	return { ok: true, result };
}

function threadForSearch(record: PersistedSession): Thread {
	return { ...record.thread, turns: [] };
}

function snippet(text: string, searchTerm: string): { snippet: string; start: number; end: number } | undefined {
	if (searchTerm.length === 0) return undefined;
	const index = text.toLocaleLowerCase().indexOf(searchTerm.toLocaleLowerCase());
	if (index < 0) return undefined;
	const start = Math.max(0, index - 80);
	const end = Math.min(text.length, index + searchTerm.length + 80);
	return { snippet: text.slice(start, end), start: index - start, end: index - start + searchTerm.length };
}

function visibleItemText(item: ThreadItem): string | undefined {
	if (item.type === "userMessage") return item.content.map(content => textFromContent([content])).join(" ");
	if (item.type === "agentMessage" && (item.phase === null || item.phase === "final_answer")) return item.text;
	return undefined;
}

export const threadListHandler: MethodHandler = async params => {
	const p = paramsRecord(params);
	if (!p) return invalidParams();
	const limit = readLimit(p.limit);
	const sortKey = readSortKey(p.sortKey);
	const sortDirection = readSortDirection(p.sortDirection, "desc");
	if (limit === undefined || sortKey === undefined || sortDirection === undefined) return invalidParams();
	const records = await loadSessions();
	const filtered = listFilters(records, p);
	if (!filtered) return invalidParams();
	const values = sortSessions(filtered, sortKey, sortDirection).map(record => ({ ...record.thread, turns: [] }));
	const result = page(values, p.cursor, limit, "thread-list");
	if (!result) return invalidParams();
	return resultWithValidator("stable", "thread/list", result);
};

export const threadReadHandler: MethodHandler = async params => {
	const p = paramsRecord(params);
	if (!p || typeof p.threadId !== "string" || typeof p.includeTurns !== "boolean") return invalidParams();
	const records = await loadSessions();
	const record = records.find(candidate => candidate.thread.id === p.threadId);
	if (!record) return notFound();
	const thread = projectThread(
		record.info,
		record.header,
		record.entries,
		record.turns,
		record.thread.forkedFromId,
		p.includeTurns,
	);
	return resultWithValidator("stable", "thread/read", { thread });
};

export const threadItemsListHandler: MethodHandler = async params => {
	const p = paramsRecord(params);
	if (!p || typeof p.threadId !== "string") return invalidParams();
	if (!optionalStringIsValid(p, "turnId") || !optionalStringIsValid(p, "cursor")) return invalidParams();
	const limit = readLimit(p.limit);
	const sortDirection = readSortDirection(p.sortDirection, "asc");
	if (limit === undefined || sortDirection === undefined) return invalidParams();
	const records = await loadSessions();
	const record = records.find(candidate => candidate.thread.id === p.threadId);
	if (!record) return notFound();
	const items = record.turns
		.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item })))
		.filter(entry => p.turnId === undefined || p.turnId === null || entry.turnId === p.turnId);
	if (sortDirection === "desc") items.reverse();
	const result = page(items, p.cursor, limit, "thread-items");
	if (!result) return invalidParams();
	return resultWithValidator("experimental", "thread/items/list", result);
};

export const threadTurnsListHandler: MethodHandler = async params => {
	const p = paramsRecord(params);
	if (!p || typeof p.threadId !== "string") return invalidParams();
	if (!optionalStringIsValid(p, "cursor")) return invalidParams();
	const limit = readLimit(p.limit);
	const sortDirection = readSortDirection(p.sortDirection, "desc");
	const itemsView = p.itemsView === undefined || p.itemsView === null ? "summary" : p.itemsView;
	if (
		limit === undefined ||
		sortDirection === undefined ||
		(itemsView !== "notLoaded" && itemsView !== "summary" && itemsView !== "full")
	)
		return invalidParams();
	const records = await loadSessions();
	const record = records.find(candidate => candidate.thread.id === p.threadId);
	if (!record) return notFound();
	const turns = record.turns.map(turn => {
		if (itemsView === "full") return { ...turn, items: [...turn.items], itemsView: "full" as const };
		return { ...turn, items: [], itemsView };
	});
	if (sortDirection === "desc") turns.reverse();
	const result = page(turns, p.cursor, limit, "thread-turns");
	if (!result) return invalidParams();
	return resultWithValidator("experimental", "thread/turns/list", result);
};

export const threadSearchHandler: MethodHandler = async params => {
	const p = paramsRecord(params);
	if (!p || typeof p.searchTerm !== "string") return invalidParams();
	const limit = readLimit(p.limit);
	const sortKey = readSortKey(p.sortKey);
	const sortDirection = readSortDirection(p.sortDirection, "desc");
	if (limit === undefined || sortKey === undefined || sortDirection === undefined) return invalidParams();
	const records = await loadSessions();
	const sourceKinds = p.sourceKinds;
	if (
		sourceKinds !== undefined &&
		sourceKinds !== null &&
		(!Array.isArray(sourceKinds) || !sourceKinds.every(value => typeof value === "string"))
	)
		return invalidParams();
	const matches = records.filter(record => {
		if (p.archived === true) return false;
		if (p.archived !== undefined && p.archived !== null && typeof p.archived !== "boolean") return false;
		if (Array.isArray(sourceKinds) && sourceKinds.length > 0 && !sourceKinds.includes(record.sourceKind))
			return false;
		return snippet(record.text, p.searchTerm) !== undefined;
	});
	const results = sortSessions(matches, sortKey, sortDirection).flatMap(record => {
		const found = snippet(record.text, p.searchTerm);
		return found ? [{ thread: threadForSearch(record), snippet: found.snippet }] : [];
	});
	const result = page(results, p.cursor, limit, "thread-search");
	if (!result) return invalidParams();
	return resultWithValidator("experimental", "thread/search", result);
};

export const threadSearchOccurrencesHandler: MethodHandler = async params => {
	const p = paramsRecord(params);
	if (!p || typeof p.threadId !== "string" || typeof p.searchTerm !== "string") return invalidParams();
	if (!optionalStringIsValid(p, "cursor")) return invalidParams();
	const limit = readLimit(p.limit);
	if (limit === undefined) return invalidParams();
	const records = await loadSessions();
	const record = records.find(candidate => candidate.thread.id === p.threadId);
	if (!record) return notFound();
	if (p.searchTerm.length === 0) {
		const result = { data: [], nextCursor: null };
		return resultWithValidator("experimental", "thread/searchOccurrences", result);
	}
	const occurrences = record.turns.flatMap((turn, turnIndex) =>
		turn.items.flatMap(item => {
			const text = visibleItemText(item);
			if (!text) return [];
			const lowerText = text.toLocaleLowerCase();
			const lowerTerm = p.searchTerm.toLocaleLowerCase();
			const found: Array<{
				turnId: string;
				itemId: string;
				snippet: string;
				snippetMatchRange: { start: number; end: number };
				turnCursor: string;
			}> = [];
			let index = lowerText.indexOf(lowerTerm);
			while (index >= 0) {
				const start = Math.max(0, index - 80);
				const end = Math.min(text.length, index + p.searchTerm.length + 80);
				found.push({
					turnId: turn.id,
					itemId: item.id,
					snippet: text.slice(start, end),
					snippetMatchRange: {
						start: index - start,
						end: index - start + p.searchTerm.length,
					},
					turnCursor: encodeCursor("thread-turn", turnIndex),
				});
				index = lowerText.indexOf(lowerTerm, index + Math.max(1, lowerTerm.length));
			}
			return found;
		}),
	);
	const result = page(occurrences, p.cursor, limit, "thread-search-occurrences");
	if (!result) return invalidParams();
	return resultWithValidator("experimental", "thread/searchOccurrences", {
		data: result.data,
		nextCursor: result.nextCursor,
	});
};

export const threadReadHandlers: Record<string, MethodHandler> = {
	"thread/list": threadListHandler,
	"thread/read": threadReadHandler,
	"thread/items/list": threadItemsListHandler,
	"thread/turns/list": threadTurnsListHandler,
	"thread/search": threadSearchHandler,
	"thread/searchOccurrences": threadSearchOccurrencesHandler,
};
