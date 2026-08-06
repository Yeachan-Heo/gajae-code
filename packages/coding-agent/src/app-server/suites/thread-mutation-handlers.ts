import { stat } from "node:fs/promises";
import * as path from "node:path";

import type {
	FileEntry,
	SessionEntry,
	SessionHeader,
	SessionInfo,
	SessionManager,
} from "../../session/session-manager";
import { SessionManager as ConcreteSessionManager, loadEntriesFromFile } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import type { HandlerContext, HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;
type MutationContext = HandlerContext & {
	sessionFile?: unknown;
	sessionDir?: unknown;
	cwd?: unknown;
	agentDir?: unknown;
};
type GitInfo = { sha: string | null; branch: string | null; originUrl: string | null };
type PersistedMetadata = { isPinned: boolean; gitInfo: GitInfo | null };
type LocatedSession = {
	path: string;
	id: string;
	cwd: string;
	title?: string;
	firstMessage: string;
	createdAt: number;
	modifiedAt: number;
	managed: boolean;
};

/** Existing SessionManager custom-entry persistence is the native extension seam for app-server metadata. */
const THREAD_METADATA_CUSTOM_TYPE = "gjc.app-server.thread-metadata";

function record(value: unknown): RecordValue | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function invalidParams(): HandlerResult {
	return { ok: false, errorKey: "invalidParams" };
}

function notFound(): HandlerResult {
	return { ok: false, errorKey: "notFound" };
}

function notSupported(): HandlerResult {
	return { ok: false, errorKey: "notSupported" };
}

function internalError(): HandlerResult {
	return { ok: false, errorKey: "internalError" };
}

function contextRecord(context?: HandlerContext): MutationContext {
	return (context ?? {}) as MutationContext;
}

function firstMessage(entries: readonly FileEntry[]): string {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string")
				return (block as { text: string }).text;
		}
	}
	return "";
}

function metadataFromEntries(entries: readonly FileEntry[]): PersistedMetadata {
	let metadata: PersistedMetadata = { isPinned: false, gitInfo: null };
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== THREAD_METADATA_CUSTOM_TYPE) continue;
		const data = record(entry.data);
		if (!data) continue;
		if (typeof data.isPinned === "boolean") metadata = { ...metadata, isPinned: data.isPinned };
		if (Object.hasOwn(data, "gitInfo")) {
			if (data.gitInfo === null) {
				metadata = { ...metadata, gitInfo: null };
			} else {
				const patch = record(data.gitInfo);
				if (!patch) continue;
				const current = metadata.gitInfo ?? { sha: null, branch: null, originUrl: null };
				metadata = {
					...metadata,
					gitInfo: {
						sha: typeof patch.sha === "string" || patch.sha === null ? patch.sha : current.sha,
						branch: typeof patch.branch === "string" || patch.branch === null ? patch.branch : current.branch,
						originUrl:
							typeof patch.originUrl === "string" || patch.originUrl === null
								? patch.originUrl
								: current.originUrl,
					},
				};
			}
		}
	}
	return metadata;
}

function sessionInfoFromEntries(
	filePath: string,
	entries: FileEntry[],
	modifiedAt: number,
	managed: boolean,
): LocatedSession | undefined {
	const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
	if (!header || typeof header.id !== "string") return undefined;
	const parsedCreatedAt = Date.parse(header.timestamp);
	return {
		path: filePath,
		id: header.id,
		cwd: typeof header.cwd === "string" && header.cwd.length > 0 ? header.cwd : process.cwd(),
		title: header.title,
		firstMessage: firstMessage(entries),
		createdAt: Number.isFinite(parsedCreatedAt) ? Math.floor(parsedCreatedAt / 1000) : Math.floor(modifiedAt / 1000),
		modifiedAt,
		managed,
	};
}

function fromSessionInfo(info: SessionInfo, managed: boolean): LocatedSession {
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd || process.cwd(),
		title: info.title,
		firstMessage: info.firstMessage,
		createdAt: Math.floor(info.created.getTime() / 1000),
		modifiedAt: info.modified.getTime(),
		managed,
	};
}

async function locateSession(threadId: string, context?: HandlerContext): Promise<LocatedSession | undefined> {
	const ctx = contextRecord(context);
	if (typeof ctx.sessionFile === "string") {
		try {
			const entries = await loadEntriesFromFile(ctx.sessionFile, new FileSessionStorage());
			if (entries.length > 0) {
				const fileStat = await stat(ctx.sessionFile);
				const located = sessionInfoFromEntries(ctx.sessionFile, entries, fileStat.mtimeMs, false);
				if (located?.id === threadId) return located;
			}
		} catch {
			return undefined;
		}
	}

	const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
	try {
		if (typeof ctx.sessionDir === "string" && ctx.sessionDir.length > 0) {
			const sessions = await ConcreteSessionManager.list(cwd, ctx.sessionDir, new FileSessionStorage());
			const found = sessions.find(session => session.id === threadId);
			return found ? fromSessionInfo(found, false) : undefined;
		}
		const sessions = await ConcreteSessionManager.listAll(
			new FileSessionStorage(),
			typeof ctx.agentDir === "string" ? ctx.agentDir : undefined,
		);
		const found = sessions.find(session => session.id === threadId);
		return found ? fromSessionInfo(found, true) : undefined;
	} catch {
		return undefined;
	}
}

function destinationFor(location: LocatedSession, context?: HandlerContext) {
	const ctx = contextRecord(context);
	if (typeof ctx.sessionDir === "string" && ctx.sessionDir.length > 0)
		return ConcreteSessionManager.explicitDestination(ctx.sessionDir);
	if (location.managed)
		return ConcreteSessionManager.managedDestination(
			location.cwd,
			typeof ctx.agentDir === "string" ? ctx.agentDir : undefined,
		);
	return ConcreteSessionManager.explicitDestination(path.dirname(location.path));
}

async function openLocatedSession(location: LocatedSession, context?: HandlerContext): Promise<SessionManager> {
	return await ConcreteSessionManager.open(location.path, destinationFor(location, context));
}

function latestModel(entries: readonly SessionEntry[]): { model: string; provider: string } {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "model_change" || typeof entry.model !== "string") continue;
		const separator = entry.model.indexOf("/");
		return separator > 0
			? { model: entry.model.slice(separator + 1), provider: entry.model.slice(0, separator) }
			: { model: entry.model, provider: "unknown" };
	}
	return { model: "", provider: "unknown" };
}

async function threadFromManager(
	manager: SessionManager,
	metadata?: PersistedMetadata,
): Promise<Record<string, unknown>> {
	const header = manager.getHeader();
	if (!header) throw new Error("session_header_missing");
	const entries = manager.getEntries();
	const resolvedMetadata = metadata ?? metadataFromEntries(entries);
	const model = latestModel(entries);
	const sessionPath = manager.getSessionFile() ?? null;
	let modifiedAt = Date.parse(header.timestamp);
	if (sessionPath) {
		try {
			modifiedAt = (await stat(sessionPath)).mtimeMs;
		} catch {
			// A just-created in-memory snapshot can use its header timestamp.
		}
	}
	if (!Number.isFinite(modifiedAt)) modifiedAt = Date.now();
	const createdAt = Number.isFinite(Date.parse(header.timestamp))
		? Math.floor(Date.parse(header.timestamp) / 1000)
		: Math.floor(modifiedAt / 1000);
	const updatedAt = Math.floor(modifiedAt / 1000);
	return {
		id: manager.getSessionId(),
		sessionId: manager.getSessionId(),
		forkedFromId: header.parentSession ?? null,
		parentThreadId: null,
		preview: firstMessage([header, ...entries]),
		ephemeral: false,
		isPinned: resolvedMetadata.isPinned,
		modelProvider: model.provider,
		createdAt,
		updatedAt,
		recencyAt: updatedAt,
		status: { type: "notLoaded" },
		path: sessionPath,
		cwd: path.resolve(header.cwd || process.cwd()),
		cliVersion: "",
		source: "unknown",
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: resolvedMetadata.gitInfo,
		name: header.title ?? null,
		turns: [],
	};
}

function validateMetadataParams(p: RecordValue): HandlerResult | undefined {
	if (p.gitInfo !== undefined && p.gitInfo !== null) {
		const gitInfo = record(p.gitInfo);
		if (!gitInfo) return invalidParams();
		for (const key of ["sha", "branch", "originUrl"]) {
			if (gitInfo[key] !== undefined && gitInfo[key] !== null && typeof gitInfo[key] !== "string")
				return invalidParams();
		}
	}
	if (p.isPinned !== undefined && p.isPinned !== null && typeof p.isPinned !== "boolean") return invalidParams();
	return undefined;
}

function validateForkParams(p: RecordValue): HandlerResult | undefined {
	const nullableStrings = [
		"lastTurnId",
		"model",
		"modelProvider",
		"serviceTier",
		"cwd",
		"baseInstructions",
		"developerInstructions",
		"threadSource",
	];
	for (const key of nullableStrings) {
		if (p[key] !== undefined && p[key] !== null && typeof p[key] !== "string") return invalidParams();
		if (p[key] !== undefined && p[key] !== null) return notSupported();
	}
	if (p.ephemeral !== undefined && typeof p.ephemeral !== "boolean") return invalidParams();
	if (p.ephemeral === true) return notSupported();
	if (p.config !== undefined && p.config !== null && (typeof p.config !== "object" || Array.isArray(p.config)))
		return invalidParams();
	if (p.config !== undefined && p.config !== null) return notSupported();
	if (p.approvalPolicy !== undefined && p.approvalPolicy !== null) return notSupported();
	if (p.approvalsReviewer !== undefined && p.approvalsReviewer !== null) return notSupported();
	if (p.sandbox !== undefined && p.sandbox !== null) return notSupported();
	return undefined;
}

export const threadDeleteHandler: MethodHandler = async (params, context) => {
	const p = record(params);
	if (!p || typeof p.threadId !== "string" || p.threadId.length === 0) return invalidParams();
	const location = await locateSession(p.threadId, context);
	if (!location) return notFound();
	try {
		const manager = ConcreteSessionManager.create(location.cwd, destinationFor(location, context));
		try {
			await manager.dropSession(location.path);
		} finally {
			await manager.close();
		}
		return { ok: true, result: {} };
	} catch {
		return internalError();
	}
};

export const threadForkHandler: MethodHandler = async (params, context) => {
	const p = record(params);
	if (!p || typeof p.threadId !== "string" || p.threadId.length === 0) return invalidParams();
	const forkValidation = validateForkParams(p);
	if (forkValidation) return forkValidation;
	const location = await locateSession(p.threadId, context);
	if (!location) return notFound();
	let manager: SessionManager | undefined;
	try {
		manager = await ConcreteSessionManager.forkFrom(location.path, location.cwd, destinationFor(location, context));
		const entries = manager.getEntries();
		const thread = await threadFromManager(manager);
		const model = latestModel(entries);
		return {
			ok: true,
			result: {
				thread,
				model: model.model,
				modelProvider: model.provider,
				serviceTier: null,
				cwd: thread.cwd,
				instructionSources: [],
				approvalPolicy: "on-request",
				approvalsReviewer: "user",
				sandbox: { type: "dangerFullAccess" },
				reasoningEffort: null,
			},
		};
	} catch (error) {
		if (error instanceof Error && (error.message.includes("ENOENT") || error.message.includes("missing")))
			return notFound();
		return internalError();
	} finally {
		if (manager) await manager.close().catch(() => {});
	}
};

export const threadNameSetHandler: MethodHandler = async (params, context) => {
	const p = record(params);
	if (!p || typeof p.threadId !== "string" || p.threadId.length === 0 || typeof p.name !== "string")
		return invalidParams();
	if (p.name.trim().length === 0) return invalidParams();
	const location = await locateSession(p.threadId, context);
	if (!location) return notFound();
	let manager: SessionManager | undefined;
	try {
		manager = await openLocatedSession(location, context);
		await manager.ensureOnDisk();
		if (!(await manager.setSessionName(p.name, "user"))) return invalidParams();
		return { ok: true, result: {} };
	} catch {
		return internalError();
	} finally {
		if (manager) await manager.close().catch(() => {});
	}
};

export const threadMetadataUpdateHandler: MethodHandler = async (params, context) => {
	const p = record(params);
	if (!p || typeof p.threadId !== "string" || p.threadId.length === 0) return invalidParams();
	const validation = validateMetadataParams(p);
	if (validation) return validation;
	const location = await locateSession(p.threadId, context);
	if (!location) return notFound();
	let manager: SessionManager | undefined;
	try {
		manager = await openLocatedSession(location, context);
		await manager.ensureOnDisk();
		const patch: RecordValue = {};
		if (p.isPinned !== undefined) patch.isPinned = p.isPinned === null ? false : p.isPinned;
		if (p.gitInfo !== undefined) {
			if (p.gitInfo === null) patch.gitInfo = null;
			else {
				const gitInfo = record(p.gitInfo)!;
				patch.gitInfo = {
					...(gitInfo.sha !== undefined ? { sha: gitInfo.sha } : {}),
					...(gitInfo.branch !== undefined ? { branch: gitInfo.branch } : {}),
					...(gitInfo.originUrl !== undefined ? { originUrl: gitInfo.originUrl } : {}),
				};
			}
		}
		if (Object.keys(patch).length > 0) manager.appendCustomEntry(THREAD_METADATA_CUSTOM_TYPE, patch);
		const metadata = metadataFromEntries([manager.getHeader()!, ...manager.getEntries()]);
		return { ok: true, result: { thread: await threadFromManager(manager, metadata) } };
	} catch {
		return internalError();
	} finally {
		if (manager) await manager.close().catch(() => {});
	}
};

/** Only methods with real persisted-session backing are registered in this lane. */
export const threadMutationHandlers: Record<string, MethodHandler> = {
	"thread/delete": threadDeleteHandler,
	"thread/fork": threadForkHandler,
	"thread/name/set": threadNameSetHandler,
	"thread/metadata/update": threadMetadataUpdateHandler,
};

export const threadMetadataCustomType = THREAD_METADATA_CUSTOM_TYPE;
