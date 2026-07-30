import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { Snowflake } from "@gajae-code/utils";
import { validateGoalObjective } from "../../goals/runtime";
import { type GoalStatus as GjcGoalStatus, type Goal, type GoalModeState, normalizeGoal } from "../../goals/state";
import {
	buildSessionContext,
	type FileEntry,
	loadEntriesFromFile,
	type ModeChangeEntry,
	type SessionEntry,
} from "../../session/session-manager";
import type { HandlerContext, HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;
type ProtocolGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
type SupportedGoalStatus = "active" | "paused" | "complete";

type LiveGoalRuntime = {
	createGoal?: (input: { objective: string }) => Promise<GoalModeState>;
	replaceGoal?: (input: { objective: string }) => Promise<GoalModeState>;
	resumeGoal?: () => Promise<GoalModeState>;
	pauseGoal?: () => Promise<GoalModeState | undefined>;
	dropGoal?: () => Promise<Goal | undefined>;
	completeGoalFromTool?: () => Promise<Goal>;
};

type LiveGoalSession = {
	getGoalModeState?: () => unknown;
	goalRuntime?: LiveGoalRuntime;
};

type GoalContext = HandlerContext & {
	/** Optional live session seam installed by an app-server host. */
	goalSession?: unknown;
	session?: unknown;
	agentSession?: unknown;
	/** Optional resolver installed by an app-server host. */
	getGoalSession?: (threadId: string) => unknown | Promise<unknown>;
	getThreadSession?: (threadId: string) => unknown | Promise<unknown>;
	/** Test and host seam for a persisted session file. */
	sessionFile?: unknown;
	getSessionFile?: (threadId: string) => string | undefined | Promise<string | undefined>;
	threadStartAdapter?: unknown;
};

type GoalResource = { live?: LiveGoalSession; sessionFile?: string };
type PersistedGoalState = { goal: Goal; mode: "goal" | "goal_paused" } | undefined;

type WireGoal = {
	threadId: string;
	objective: string;
	status: SupportedGoalStatus;
	tokenBudget: null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
};

const persistedFileTails = new Map<string, Promise<void>>();
const goalStatuses = new Set<ProtocolGoalStatus>([
	"active",
	"paused",
	"blocked",
	"usageLimited",
	"budgetLimited",
	"complete",
]);
const unsupportedStatuses = new Set<ProtocolGoalStatus>(["blocked", "usageLimited", "budgetLimited"]);

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

function isHandlerResult(value: Goal | HandlerResult): value is HandlerResult {
	return typeof value === "object" && value !== null && Object.hasOwn(value, "ok");
}

function isGoalStatus(value: unknown): value is ProtocolGoalStatus {
	return typeof value === "string" && goalStatuses.has(value as ProtocolGoalStatus);
}

function supportedStatus(value: GjcGoalStatus): value is SupportedGoalStatus {
	return value === "active" || value === "paused" || value === "complete";
}

function goalToWire(threadId: string, goal: Goal): WireGoal | undefined {
	if (!supportedStatus(goal.status)) return undefined;
	return {
		threadId,
		objective: goal.objective,
		status: goal.status,
		tokenBudget: null,
		tokensUsed: goal.tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
	};
}

function cloneGoal(goal: Goal): Goal {
	return { ...goal, ...(goal.provenance ? { provenance: { ...goal.provenance } } : {}) };
}

function goalFromState(value: unknown): Goal | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return normalizeGoal(value) ?? undefined;
}

function stateGoal(value: unknown): Goal | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value as RecordValue;
	return goalFromState(candidate.goal);
}

function liveSession(value: unknown): LiveGoalSession | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value as RecordValue;
	const getGoalModeState = candidate.getGoalModeState;
	const goalRuntime = candidate.goalRuntime;
	if (typeof getGoalModeState !== "function" && (typeof goalRuntime !== "object" || goalRuntime === null))
		return undefined;
	return candidate as unknown as LiveGoalSession;
}

function sessionFileFromValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value as RecordValue;
	const direct = candidate.sessionFile;
	const directPath = candidate.path;
	if (typeof directPath === "string" && directPath.length > 0) return directPath;
	if (typeof direct === "string" && direct.length > 0) return direct;
	const sessionManager = candidate.sessionManager;
	if (typeof sessionManager === "object" && sessionManager !== null && !Array.isArray(sessionManager)) {
		const getter = (sessionManager as RecordValue).getSessionFile;
		if (typeof getter === "function") {
			try {
				const file = getter.call(sessionManager);
				if (typeof file === "string" && file.length > 0) return file;
			} catch {
				return undefined;
			}
		}
	}
	const getter = candidate.getSessionFile;
	if (typeof getter === "function") {
		try {
			const file = getter.call(value);
			if (typeof file === "string" && file.length > 0) return file;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

async function resolveResource(threadId: string, context?: HandlerContext): Promise<GoalResource | undefined> {
	const candidate = (context ?? {}) as GoalContext;
	if (typeof candidate.getGoalSession === "function") {
		const resolved = liveSession(await candidate.getGoalSession(threadId));
		if (resolved) return { live: resolved };
	}
	if (typeof candidate.getThreadSession === "function") {
		const resolved = liveSession(await candidate.getThreadSession(threadId));
		if (resolved) return { live: resolved };
	}
	const directSession = liveSession(candidate.goalSession ?? candidate.session ?? candidate.agentSession);
	if (directSession) return { live: directSession };
	const directFile = sessionFileFromValue(candidate.sessionFile);
	if (directFile) return { sessionFile: directFile };
	if (typeof candidate.getSessionFile === "function") {
		const file = await candidate.getSessionFile(threadId);
		if (file) return { sessionFile: file };
	}

	const adapter = candidate.threadStartAdapter as RecordValue | undefined;
	const manager = adapter && typeof adapter === "object" ? adapter.manager : undefined;
	if (typeof manager !== "object" || manager === null || Array.isArray(manager)) return undefined;
	const get = (manager as RecordValue).get;
	if (typeof get !== "function") return undefined;
	const managed = get.call(manager, threadId) as RecordValue | undefined;
	if (!managed) return undefined;
	const managedSession = liveSession(managed.session ?? managed.agentSession ?? managed.clientSession);
	if (managedSession) return { live: managedSession };
	const managedFile =
		sessionFileFromValue(managed) ??
		sessionFileFromValue(managed.effectiveSettings) ??
		sessionFileFromValue((managed.effectiveSettings as RecordValue | undefined)?.thread);
	return managedFile ? { sessionFile: managedFile } : undefined;
}

async function withPersistedFileLock<T>(sessionFile: string, fn: () => Promise<T>): Promise<T> {
	const previous = persistedFileTails.get(sessionFile) ?? Promise.resolve();
	const current = previous.then(fn, fn);
	persistedFileTails.set(
		sessionFile,
		current.then(
			() => undefined,
			() => undefined,
		),
	);
	return current;
}

async function readPersistedGoal(sessionFile: string, threadId: string): Promise<PersistedGoalState> {
	let entries: FileEntry[];
	try {
		entries = await loadEntriesFromFile(sessionFile);
	} catch (error) {
		if ((error as { code?: unknown })?.code === "ENOENT")
			throw Object.assign(new Error("Session not found."), { code: "notFound" });
		throw error;
	}
	if (entries.length === 0) throw Object.assign(new Error("Session not found."), { code: "notFound" });
	const header = entries.find(entry => entry.type === "session");
	if (header?.type === "session" && header.id !== threadId)
		throw Object.assign(new Error("Session not found."), { code: "notFound" });
	const context = buildSessionContext(entries.filter((entry): entry is SessionEntry => entry.type !== "session"));
	if (context.mode !== "goal" && context.mode !== "goal_paused") return undefined;
	const goal = goalFromState(context.modeData?.goal);
	if (!goal || !supportedStatus(goal.status)) throw new Error("Persisted goal state is invalid.");
	return { goal, mode: context.mode };
}

async function appendModeChange(
	sessionFile: string,
	entries: readonly FileEntry[],
	mode: string,
	goal?: Goal,
): Promise<void> {
	const parentId = entries.filter(entry => entry.type !== "session").at(-1)?.id ?? null;
	const entry: ModeChangeEntry = {
		type: "mode_change",
		id: randomUUID(),
		parentId,
		timestamp: new Date().toISOString(),
		mode,
		...(goal ? { data: { goal: cloneGoal(goal) } } : {}),
	};
	await fs.appendFile(sessionFile, `${JSON.stringify(entry)}\n`);
}

function createGoal(objective: string): Goal {
	const now = Date.now();
	return {
		id: String(Snowflake.next()),
		objective,
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
		provenance: { source: "user" },
	};
}

function updatedGoal(goal: Goal, status: SupportedGoalStatus): Goal {
	return { ...cloneGoal(goal), status, updatedAt: Date.now() };
}

function transitionError(): HandlerResult {
	return invalidParams();
}

async function liveGoal(resource: GoalResource): Promise<Goal | undefined> {
	if (!resource.live?.getGoalModeState) return undefined;
	return stateGoal(await resource.live.getGoalModeState());
}

async function liveSet(resource: GoalResource, params: RecordValue): Promise<Goal | HandlerResult> {
	const session = resource.live;
	const runtime = session?.goalRuntime;
	if (!session || !runtime) return notSupported();
	const current = await liveGoal(resource);
	const rawObjective = params.objective;
	const hasObjective = rawObjective !== undefined && rawObjective !== null;
	let objective: string | undefined;
	if (hasObjective) {
		if (typeof rawObjective !== "string") return invalidParams();
		try {
			objective = validateGoalObjective(rawObjective, "replace");
		} catch {
			return invalidParams();
		}
	}
	const rawStatus = params.status;
	if (rawStatus !== undefined && rawStatus !== null && !isGoalStatus(rawStatus)) return invalidParams();
	const status = rawStatus === undefined || rawStatus === null ? undefined : (rawStatus as ProtocolGoalStatus);
	if (status && unsupportedStatuses.has(status)) return notSupported();
	if (params.tokenBudget !== undefined && params.tokenBudget !== null) return notSupported();
	try {
		if (!current) {
			if (!objective || (status !== undefined && status !== "active")) return transitionError();
			if (!runtime.createGoal) return notSupported();
			return (await runtime.createGoal({ objective })).goal;
		}
		if (objective !== undefined) {
			if (current.status !== "active" || (status !== undefined && status !== "active")) return transitionError();
			if (!runtime.replaceGoal) return notSupported();
			return (await runtime.replaceGoal({ objective })).goal;
		}
		if (status === undefined) return current;
		if (status === current.status) return status === "active" ? current : transitionError();
		if (status === "active") {
			if (current.status !== "paused" || !runtime.resumeGoal) return transitionError();
			return (await runtime.resumeGoal()).goal;
		}
		if (status === "paused") {
			if (current.status !== "active" || !runtime.pauseGoal) return transitionError();
			const paused = await runtime.pauseGoal();
			return paused?.goal ?? transitionError();
		}
		if (status === "complete") {
			if ((current.status !== "active" && current.status !== "paused") || !runtime.completeGoalFromTool)
				return transitionError();
			return await runtime.completeGoalFromTool();
		}
		return transitionError();
	} catch {
		return transitionError();
	}
}

async function persistedSet(sessionFile: string, threadId: string, params: RecordValue): Promise<Goal | HandlerResult> {
	return await withPersistedFileLock(sessionFile, async () => {
		let entries: FileEntry[];
		try {
			entries = await loadEntriesFromFile(sessionFile);
		} catch (error) {
			if ((error as { code?: unknown })?.code === "ENOENT") return notFound();
			return { ok: false, errorKey: "internalError" };
		}
		if (entries.length === 0) return notFound();
		const header = entries.find(entry => entry.type === "session");
		if (header?.type === "session" && header.id !== threadId) return notFound();
		const current = await readPersistedGoal(sessionFile, threadId).catch(error => {
			if ((error as { code?: unknown })?.code === "notFound") return undefined;
			throw error;
		});
		const rawObjective = params.objective;
		const hasObjective = rawObjective !== undefined && rawObjective !== null;
		let objective: string | undefined;
		if (hasObjective) {
			if (typeof rawObjective !== "string") return invalidParams();
			try {
				objective = validateGoalObjective(rawObjective, "replace");
			} catch {
				return invalidParams();
			}
		}
		const rawStatus = params.status;
		if (rawStatus !== undefined && rawStatus !== null && !isGoalStatus(rawStatus)) return invalidParams();
		const status = rawStatus === undefined || rawStatus === null ? undefined : (rawStatus as ProtocolGoalStatus);
		if (status && unsupportedStatuses.has(status)) return notSupported();
		if (params.tokenBudget !== undefined && params.tokenBudget !== null) return notSupported();

		if (!current) {
			if (!objective || (status !== undefined && status !== "active")) return transitionError();
			const goal = createGoal(objective);
			await appendModeChange(sessionFile, entries, "goal", goal);
			return goal;
		}
		const currentGoal = current.goal;
		if (objective !== undefined) {
			if (
				current.mode !== "goal" ||
				currentGoal.status !== "active" ||
				(status !== undefined && status !== "active")
			)
				return transitionError();
			const goal = createGoal(objective);
			await appendModeChange(sessionFile, entries, "goal", goal);
			return goal;
		}
		if (status === undefined) return currentGoal;
		if (status === currentGoal.status) return status === "active" ? currentGoal : transitionError();
		if (status === "active") {
			if (currentGoal.status !== "paused") return transitionError();
			const goal = updatedGoal(currentGoal, "active");
			await appendModeChange(sessionFile, entries, "goal", goal);
			return goal;
		}
		if (status === "paused") {
			if (currentGoal.status !== "active") return transitionError();
			const goal = updatedGoal(currentGoal, "paused");
			await appendModeChange(sessionFile, entries, "goal_paused", goal);
			return goal;
		}
		if (status === "complete") {
			if (currentGoal.status !== "active" && currentGoal.status !== "paused") return transitionError();
			const goal = updatedGoal(currentGoal, "complete");
			await appendModeChange(sessionFile, entries, "goal", goal);
			return goal;
		}
		return transitionError();
	});
}

async function persistedClear(sessionFile: string, threadId: string): Promise<HandlerResult> {
	return await withPersistedFileLock(sessionFile, async () => {
		let entries: FileEntry[];
		try {
			entries = await loadEntriesFromFile(sessionFile);
		} catch (error) {
			if ((error as { code?: unknown })?.code === "ENOENT") return notFound();
			return { ok: false, errorKey: "internalError" };
		}
		if (entries.length === 0) return notFound();
		const header = entries.find(entry => entry.type === "session");
		if (header?.type === "session" && header.id !== threadId) return notFound();
		const current = await readPersistedGoal(sessionFile, threadId).catch(error => {
			if ((error as { code?: unknown })?.code === "notFound") return undefined;
			throw error;
		});
		if (!current) return { ok: true, result: { cleared: false } };
		await appendModeChange(sessionFile, entries, "none");
		return { ok: true, result: { cleared: true } };
	});
}

function emitGoalUpdated(threadId: string, goal: Goal, context?: HandlerContext): void {
	const wire = goalToWire(threadId, goal);
	if (!wire) return;
	try {
		context?.broadcastThread?.(threadId, "thread/goal/updated", { threadId, turnId: null, goal: wire });
	} catch {
		// Notification delivery is best effort after the durable state commit.
	}
}

function emitGoalCleared(threadId: string, context?: HandlerContext): void {
	try {
		context?.broadcastThread?.(threadId, "thread/goal/cleared", { threadId });
	} catch {
		// Notification delivery is best effort after the durable state commit.
	}
}

export const threadGoalGetHandler: MethodHandler = async (params, context) => {
	const p = record(params);
	if (!p || typeof p.threadId !== "string" || p.threadId.length === 0) return invalidParams();
	let resource: GoalResource | undefined;
	try {
		resource = await resolveResource(p.threadId, context);
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
	if (!resource) return notFound();
	try {
		const goal = resource.live
			? await liveGoal(resource)
			: resource.sessionFile
				? (await readPersistedGoal(resource.sessionFile, p.threadId))?.goal
				: undefined;
		return { ok: true, result: { goal: goal ? (goalToWire(p.threadId, goal) ?? null) : null } };
	} catch (error) {
		if ((error as { code?: unknown })?.code === "notFound") return notFound();
		return { ok: false, errorKey: "internalError" };
	}
};

export const threadGoalSetHandler: MethodHandler = async (params, context) => {
	const p = record(params);
	if (!p || typeof p.threadId !== "string" || p.threadId.length === 0) return invalidParams();
	let resource: GoalResource | undefined;
	try {
		resource = await resolveResource(p.threadId, context);
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
	if (!resource) return notFound();
	try {
		const outcome = resource.live
			? await liveSet(resource, p)
			: resource.sessionFile
				? await persistedSet(resource.sessionFile, p.threadId, p)
				: notSupported();
		if (isHandlerResult(outcome)) return outcome;
		const wire = goalToWire(p.threadId, outcome);
		if (!wire) return { ok: false, errorKey: "internalError" };
		emitGoalUpdated(p.threadId, outcome, context);
		return { ok: true, result: { goal: wire } };
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

export const threadGoalClearHandler: MethodHandler = async (params, context) => {
	const p = record(params);
	if (!p || typeof p.threadId !== "string" || p.threadId.length === 0) return invalidParams();
	let resource: GoalResource | undefined;
	try {
		resource = await resolveResource(p.threadId, context);
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
	if (!resource) return notFound();
	try {
		if (resource.live) {
			const current = await liveGoal(resource);
			if (!current) return { ok: true, result: { cleared: false } };
			if (!resource.live.goalRuntime?.dropGoal) return notSupported();
			await resource.live.goalRuntime.dropGoal();
			emitGoalCleared(p.threadId, context);
			return { ok: true, result: { cleared: true } };
		}
		if (!resource.sessionFile) return notSupported();
		const result = await persistedClear(resource.sessionFile, p.threadId);
		if (result.ok && (result.result as RecordValue).cleared === true) emitGoalCleared(p.threadId, context);
		return result;
	} catch (error) {
		if ((error as { code?: unknown })?.code === "notFound") return notFound();
		return { ok: false, errorKey: "internalError" };
	}
};

export const goalsReviewHandlers: Record<string, MethodHandler> = {
	"thread/goal/get": threadGoalGetHandler,
	"thread/goal/set": threadGoalSetHandler,
	"thread/goal/clear": threadGoalClearHandler,
};
