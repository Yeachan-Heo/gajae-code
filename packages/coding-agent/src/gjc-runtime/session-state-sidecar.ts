import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { normalizePathForComparison, postmortem } from "@gajae-code/utils";
import { sessionRuntimeDir } from "./session-layout";
import {
	isValidOwnerIntent,
	lifecyclePaths,
	type ObserveTerminalRequest,
	type OwnerIntent,
	type OwnerVerdict,
	observeOwnerTerminal,
	type TerminalSignal,
} from "./tmux-owner-isolation";

/** Managed tmux owner provenance propagated only to the launched child process. */
export const GJC_TMUX_OWNER_GENERATION_ENV = "GJC_TMUX_OWNER_GENERATION";
export const GJC_TMUX_OWNER_STATE_DIR_ENV = "GJC_TMUX_OWNER_STATE_DIR";
export const GJC_TMUX_OWNER_SERVER_KEY_ENV = "GJC_TMUX_OWNER_SERVER_KEY";
export const GJC_COORDINATOR_SESSION_STATE_FILE_ENV = "GJC_COORDINATOR_SESSION_STATE_FILE";
export const GJC_COORDINATOR_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";
export const GJC_COORDINATOR_SESSION_BRANCH_ENV = "GJC_COORDINATOR_SESSION_BRANCH";
export const GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV = "GJC_COORDINATOR_SESSION_LAUNCH_ID";
export const GJC_COORDINATOR_SESSION_READINESS_FILE_ENV = "GJC_COORDINATOR_SESSION_READINESS_FILE";

export type RuntimeInputReadyMarker = Readonly<{
	schema_version: 1;
	session_id: string;
	launch_id: string;
	state: "ready_for_input";
	event: "interactive_input_ready";
	source: "gjc_interactive_runtime";
	ready_for_input: true;
	created_at: string;
}>;

const GJC_SESSION_PROMPT_ACCEPTED_JSON_ENV = "GJC_SESSION_PROMPT_ACCEPTED_JSON";
const GJC_SESSION_WORKTREE_BASELINE_DIRTY_ENV = "GJC_SESSION_WORKTREE_BASELINE_DIRTY";

export type RuntimeState = "ready_for_input" | "running" | "needs_user_input" | "completed" | "errored";

type FinalResponseSource = "agent_end" | "launch_error";
const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 2000;
const HEARTBEAT_MS = 1000;

type LastPayloadCacheEntry = { mtimeMs: number; size: number; payload: Record<string, unknown> };
const lastPayloadByStateFile = new Map<string, LastPayloadCacheEntry>();
const stateFileWriteChains = new Map<string, Promise<void>>();

/** Test-only counters for runtime sidecar hot-path assertions. */
export const __sessionStateSidecarPerfCounters = {
	persistFromEventCalls: 0,
	reset(): void {
		this.persistFromEventCalls = 0;
	},
};

interface RuntimeStateEvent {
	type: string;
	messages?: unknown[];
}

export interface OwnerTerminalContext {
	generation: string;
	stateDir: string;
	socketKey: string;
	scope?: string | null;
	ownerPid?: number | null;
	ownerName?: string | null;
	operatorDispatchId?: string | null;
}

export interface RuntimeStateContext {
	sessionId: string;
	cwd: string;
	sessionFile?: string | null;
	/** Optional platform seam for deterministic cross-platform path identity checks. */
	platform?: NodeJS.Platform;
	branch?: string | null;
	/** Public-safe owner metadata used to persist the canonical terminal verdict. */
	ownerTerminal?: OwnerTerminalContext | null;
	/** Internal fail-closed marker set only when managed owner metadata is malformed or missing. */
	ownerTerminalMetadataInvalid?: boolean;
}

interface RuntimeStateIdentity {
	sessionId: string;
	cwd: string;
	workdir: string;
	sessionFile: string | null;
	platform: NodeJS.Platform;
}

interface RuntimeStateSidecarPayload {
	schema_version?: unknown;
	session_id?: unknown;
	state?: unknown;
	ready_for_input?: unknown;
	cwd?: unknown;
	workdir?: unknown;
	session_file?: unknown;
	final_response?: { source?: unknown };
}

export type TerminalRuntimeStateStatus =
	| { terminal: true; state: "completed" | "errored" }
	| {
			terminal: false;
			reason:
				| "missing_state_file"
				| "invalid_json"
				| "invalid_state_marker"
				| "session_id_mismatch"
				| "cwd_mismatch"
				| "session_file_mismatch"
				| "non_terminal_state";
	  };

function runtimeReadinessMarkerConflict(): Error {
	const error = new Error("runtime_readiness_marker_conflict");
	Object.assign(error, { code: "runtime_readiness_marker_conflict" });
	return error;
}

function isRuntimeInputReadyMarker(value: unknown): value is RuntimeInputReadyMarker {
	if (!value || typeof value !== "object") return false;
	const marker = value as Record<string, unknown>;
	return (
		marker.schema_version === 1 &&
		typeof marker.session_id === "string" &&
		typeof marker.launch_id === "string" &&
		marker.state === "ready_for_input" &&
		marker.event === "interactive_input_ready" &&
		marker.source === "gjc_interactive_runtime" &&
		marker.ready_for_input === true &&
		typeof marker.created_at === "string" &&
		marker.created_at.length > 0 &&
		Number.isFinite(Date.parse(marker.created_at))
	);
}

function immutableRuntimeInputReadyMarker(marker: RuntimeInputReadyMarker): RuntimeInputReadyMarker {
	return Object.freeze({ ...marker });
}

async function readRuntimeInputReadyMarker(readinessFile: string): Promise<RuntimeInputReadyMarker | null> {
	let text: string;
	try {
		text = await Bun.file(readinessFile).text();
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw runtimeReadinessMarkerConflict();
	}
	try {
		const marker = JSON.parse(text) as unknown;
		if (!isRuntimeInputReadyMarker(marker)) throw runtimeReadinessMarkerConflict();
		return immutableRuntimeInputReadyMarker(marker);
	} catch (error) {
		if ((error as { code?: unknown }).code === "runtime_readiness_marker_conflict") throw error;
		throw runtimeReadinessMarkerConflict();
	}
}

export async function persistCoordinatorRuntimeInputReady(): Promise<RuntimeInputReadyMarker | null> {
	const stateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	const sessionId = process.env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim();
	const launchId = process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV]?.trim();
	const readinessFile = process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV]?.trim();
	if (!stateFile || !sessionId || !launchId || !readinessFile) return null;

	const expected = { sessionId, launchId };
	const existing = await readRuntimeInputReadyMarker(readinessFile);
	if (existing) {
		if (existing.session_id !== expected.sessionId || existing.launch_id !== expected.launchId) {
			throw runtimeReadinessMarkerConflict();
		}
		return existing;
	}

	const marker = immutableRuntimeInputReadyMarker({
		schema_version: 1,
		session_id: expected.sessionId,
		launch_id: expected.launchId,
		state: "ready_for_input",
		event: "interactive_input_ready",
		source: "gjc_interactive_runtime",
		ready_for_input: true,
		created_at: new Date().toISOString(),
	});
	const tempFile = path.join(
		path.dirname(readinessFile),
		`.${path.basename(readinessFile)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await fs.mkdir(path.dirname(readinessFile), { recursive: true });
		await fs.writeFile(tempFile, `${JSON.stringify(marker)}\n`, { flag: "wx" });
		try {
			await fs.link(tempFile, readinessFile);
		} catch (error) {
			if ((error as { code?: unknown }).code !== "EEXIST") throw runtimeReadinessMarkerConflict();
			const raced = await readRuntimeInputReadyMarker(readinessFile);
			if (raced && raced.session_id === expected.sessionId && raced.launch_id === expected.launchId) return raced;
			throw runtimeReadinessMarkerConflict();
		}
		return marker;
	} finally {
		await fs.rm(tempFile, { force: true });
	}
}

function sameResolvedPath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
	return normalizePathForComparison(left, platform) === normalizePathForComparison(right, platform);
}

function normalizedIdentity(
	context: Pick<RuntimeStateContext, "sessionId" | "cwd" | "sessionFile" | "platform">,
): RuntimeStateIdentity {
	const explicitStateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	const sessionId = explicitStateFile
		? process.env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || context.sessionId.trim()
		: context.sessionId.trim();
	const cwd = context.cwd.trim();
	const platform = context.platform ?? process.platform;
	const pathApi = platform === "win32" ? path.win32 : path;
	if (!sessionId || !cwd) throw new PreviousRuntimeStateReadError();
	return {
		sessionId,
		cwd: pathApi.resolve(cwd),
		workdir: pathApi.resolve(cwd),
		sessionFile: context.sessionFile == null ? null : pathApi.resolve(context.sessionFile),
		platform,
	};
}

async function serializeStateFileWrite<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
	const prior = stateFileWriteChains.get(stateFile) ?? Promise.resolve();
	const current = prior.catch(() => {}).then(operation);
	const settled = current.then(
		() => undefined,
		() => undefined,
	);
	stateFileWriteChains.set(stateFile, settled);
	try {
		return await current;
	} finally {
		if (stateFileWriteChains.get(stateFile) === settled) stateFileWriteChains.delete(stateFile);
	}
}

function validRuntimeStateMarker(value: unknown): value is RuntimeStateSidecarPayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as RuntimeStateSidecarPayload;
	return (
		payload.schema_version === 1 &&
		typeof payload.session_id === "string" &&
		payload.session_id.trim().length > 0 &&
		payload.session_id === payload.session_id.trim() &&
		(payload.state === "ready_for_input" ||
			payload.state === "running" ||
			payload.state === "needs_user_input" ||
			payload.state === "completed" ||
			payload.state === "errored") &&
		typeof payload.cwd === "string" &&
		payload.cwd.trim().length > 0 &&
		typeof payload.workdir === "string" &&
		payload.workdir.trim().length > 0 &&
		Object.hasOwn(payload, "session_file") &&
		(payload.session_file === null ||
			(typeof payload.session_file === "string" && payload.session_file.trim().length > 0))
	);
}

export async function readTerminalRuntimeStateMarker(input: {
	stateFile?: string | null;
	sessionId?: string | null;
	cwd?: string | null;
	sessionFile?: string | null;
	platform?: NodeJS.Platform;
}): Promise<TerminalRuntimeStateStatus> {
	const platform = input.platform ?? process.platform;
	const pathApi = platform === "win32" ? path.win32 : path;
	const stateFile = input.stateFile?.trim();
	const sessionId = input.sessionId?.trim();
	const cwd = input.cwd?.trim();
	if (!stateFile || !sessionId || !cwd || input.sessionId !== sessionId)
		return { terminal: false, reason: "missing_state_file" };
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(stateFile).text());
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return {
			terminal: false,
			reason: code === "ENOENT" ? "missing_state_file" : "invalid_json",
		};
	}
	if (!validRuntimeStateMarker(value)) return { terminal: false, reason: "invalid_state_marker" };
	const payload = value;
	if (payload.session_id !== sessionId) return { terminal: false, reason: "session_id_mismatch" };
	if (
		!sameResolvedPath(payload.cwd as string, cwd, platform) ||
		!sameResolvedPath(payload.workdir as string, cwd, platform)
	)
		return { terminal: false, reason: "cwd_mismatch" };
	const sessionFile = input.sessionFile == null ? null : pathApi.resolve(input.sessionFile);
	if (
		payload.session_file !== sessionFile &&
		!(
			typeof payload.session_file === "string" &&
			typeof sessionFile === "string" &&
			sameResolvedPath(payload.session_file, sessionFile, platform)
		)
	)
		return { terminal: false, reason: "session_file_mismatch" };
	if (payload.state === "completed" || payload.state === "errored") return { terminal: true, state: payload.state };
	return { terminal: false, reason: "non_terminal_state" };
}

function lastAssistant(messages: unknown[] | undefined): AssistantMessage | undefined {
	if (!messages) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
			return message as AssistantMessage;
		}
	}
	return undefined;
}

function assistantText(assistant: AssistantMessage | undefined): string | null {
	if (!assistant) return null;
	const text = assistant.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n")
		.trim();
	return text.length > 0 ? text : null;
}

function finalResponseForEvent(event: RuntimeStateEvent): {
	text: string | null;
	format: "markdown";
	source: FinalResponseSource;
	artifact_path: null;
	truncated: false;
} | null {
	if (event.type !== "agent_end") return null;
	return {
		text: assistantText(lastAssistant(event.messages)),
		format: "markdown",
		source: "agent_end",
		artifact_path: null,
		truncated: false,
	};
}

export function stateForEvent(event: RuntimeStateEvent): RuntimeState | null {
	if (event.type === "agent_start" || event.type === "turn_start") return "running";
	if (event.type === "agent_end") {
		const assistant = lastAssistant(event.messages);
		return assistant?.stopReason === "error" ? "errored" : "completed";
	}
	if (event.type === "notice") return null;
	return null;
}

export function eventAffectsCoordinatorRuntimeState(event: RuntimeStateEvent): boolean {
	return stateForEvent(event) !== null;
}

class PreviousRuntimeStateReadError extends Error {
	constructor() {
		super("Existing runtime state marker is invalid or unreadable; refusing to overwrite.");
		this.name = "PreviousRuntimeStateReadError";
	}
}

function isAbsentStateFileError(error: unknown): boolean {
	return (error as { code?: unknown }).code === "ENOENT";
}

function parsePreviousPayload(raw: string): Record<string, unknown> {
	const payload: unknown = JSON.parse(raw);
	if (!validPreviousRuntimeStatePayload(payload)) throw new PreviousRuntimeStateReadError();
	return payload;
}

function validPreviousRuntimeStatePayload(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	if (
		payload.schema_version !== 1 ||
		typeof payload.session_id !== "string" ||
		payload.session_id.trim().length === 0 ||
		(payload.state !== "booting" &&
			payload.state !== "ready_for_input" &&
			payload.state !== "running" &&
			payload.state !== "needs_user_input" &&
			payload.state !== "completed" &&
			payload.state !== "errored" &&
			payload.state !== "stale" &&
			payload.state !== "unknown")
	)
		return false;
	if (typeof payload.cwd !== "string" || payload.cwd.trim().length === 0) return false;
	if (typeof payload.workdir !== "string" || payload.workdir.trim().length === 0) return false;
	if (
		!Object.hasOwn(payload, "session_file") ||
		(payload.session_file !== null && typeof payload.session_file !== "string")
	)
		return false;
	if (payload.ready_for_input !== undefined && typeof payload.ready_for_input !== "boolean") return false;
	if (payload.live !== undefined && payload.live !== null && typeof payload.live !== "boolean") return false;
	if (payload.reason !== undefined && payload.reason !== null && typeof payload.reason !== "string") return false;
	if (
		payload.updated_at !== undefined &&
		(typeof payload.updated_at !== "string" || !Number.isFinite(Date.parse(payload.updated_at)))
	)
		return false;
	if (payload.ready_for_input !== undefined) {
		const expectedReady = payload.state === "ready_for_input" || payload.state === "completed";
		if (payload.ready_for_input !== expectedReady) return false;
	}
	if (payload.live !== undefined && payload.live !== null && payload.live !== (payload.state === "running"))
		return false;
	return true;
}

function readPreviousPayload(stateFile: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = fsSync.readFileSync(stateFile, "utf8");
	} catch (error) {
		lastPayloadByStateFile.delete(stateFile);
		if (isAbsentStateFileError(error)) return {};
		throw new PreviousRuntimeStateReadError();
	}
	try {
		return parsePreviousPayload(raw);
	} catch (error) {
		lastPayloadByStateFile.delete(stateFile);
		if (error instanceof PreviousRuntimeStateReadError) throw error;
		throw new PreviousRuntimeStateReadError();
	}
}

async function readPreviousPayloadForEvent(stateFile: string): Promise<Record<string, unknown>> {
	let stat: fsSync.Stats;
	try {
		stat = await fs.stat(stateFile);
	} catch (error) {
		lastPayloadByStateFile.delete(stateFile);
		if (isAbsentStateFileError(error)) return {};
		throw new PreviousRuntimeStateReadError();
	}
	if (!stat.isFile()) {
		lastPayloadByStateFile.delete(stateFile);
		throw new PreviousRuntimeStateReadError();
	}
	const cached = lastPayloadByStateFile.get(stateFile);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.payload;
	try {
		const payload = parsePreviousPayload(await Bun.file(stateFile).text());
		lastPayloadByStateFile.set(stateFile, { mtimeMs: stat.mtimeMs, size: stat.size, payload });
		return payload;
	} catch (error) {
		lastPayloadByStateFile.delete(stateFile);
		if (error instanceof PreviousRuntimeStateReadError) throw error;
		throw new PreviousRuntimeStateReadError();
	}
}

function withoutUpdatedAt(payload: Record<string, unknown>): Record<string, unknown> {
	const { updated_at: _updatedAt, ...rest } = payload;
	return rest;
}

function shouldSkipRuntimeStateWrite(
	previous: Record<string, unknown>,
	payload: Record<string, unknown>,
	nowMs: number,
): boolean {
	if (payload.state === "completed" || payload.state === "errored") return false;
	if (previous.state !== payload.state) return false;
	if (previous.state !== "running" || payload.state !== "running") return false;
	if (JSON.stringify(withoutUpdatedAt(previous)) !== JSON.stringify(withoutUpdatedAt(payload))) return false;
	const previousUpdatedAt = typeof previous.updated_at === "string" ? Date.parse(previous.updated_at) : NaN;
	if (!Number.isFinite(previousUpdatedAt)) return false;
	return nowMs - previousUpdatedAt < HEARTBEAT_MS;
}

function rememberWrittenPayload(stateFile: string, payload: Record<string, unknown>): void {
	try {
		const stat = fsSync.statSync(stateFile);
		lastPayloadByStateFile.set(stateFile, { mtimeMs: stat.mtimeMs, size: stat.size, payload });
	} catch {
		lastPayloadByStateFile.delete(stateFile);
	}
}
function shouldPreserveTerminalPayload(previous: RuntimeStateSidecarPayload, input: RuntimeStateIdentity): boolean {
	if (!validRuntimeStateMarker(previous)) return false;
	if (previous.state !== "completed" && previous.state !== "errored") return false;
	const source = previous.final_response?.source;
	if (source !== "agent_end" && source !== "launch_error") return false;
	return (
		previous.session_id === input.sessionId &&
		sameResolvedPath(previous.cwd as string, input.cwd, input.platform) &&
		sameResolvedPath(previous.workdir as string, input.cwd, input.platform) &&
		(previous.session_file === input.sessionFile ||
			(typeof previous.session_file === "string" &&
				typeof input.sessionFile === "string" &&
				sameResolvedPath(previous.session_file, input.sessionFile, input.platform)))
	);
}

function assertPreviousRuntimeStateIdentity(previous: Record<string, unknown>, input: RuntimeStateIdentity): void {
	if (Object.keys(previous).length === 0) return;
	if (
		previous.session_id !== input.sessionId ||
		typeof previous.cwd !== "string" ||
		typeof previous.workdir !== "string" ||
		!sameResolvedPath(previous.cwd, input.cwd, input.platform) ||
		!sameResolvedPath(previous.workdir, input.cwd, input.platform) ||
		(previous.session_file !== input.sessionFile &&
			!(
				typeof previous.session_file === "string" &&
				typeof input.sessionFile === "string" &&
				sameResolvedPath(previous.session_file, input.sessionFile, input.platform)
			))
	)
		throw new PreviousRuntimeStateReadError();
}

function runtimeStateFileForContext(context: RuntimeStateContext): string | null {
	const explicit = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	if (explicit) return explicit;
	if (!context.sessionId.trim()) return null;
	return path.join(sessionRuntimeDir(context.cwd, context.sessionId), "runtime-state.json");
}
function branchForContext(context: RuntimeStateContext): string | null {
	return context.branch ?? (process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV]?.trim() || null);
}

function basePayload(input: {
	context: RuntimeStateContext;
	previous: Record<string, unknown>;
	state: RuntimeState;
	now: string;
	source: string;
	event: string;
	reason: string | null;
	sessionId: string;
}): Record<string, unknown> {
	const identity = normalizedIdentity(input.context);
	if (identity.sessionId !== input.sessionId) throw new PreviousRuntimeStateReadError();
	return {
		schema_version: 1,
		session_id: identity.sessionId,
		state: input.state,
		ready_for_input: input.state === "completed" || input.state === "ready_for_input",
		updated_at: input.now,
		current_turn_id: typeof input.previous.current_turn_id === "string" ? input.previous.current_turn_id : null,
		last_turn_id: typeof input.previous.last_turn_id === "string" ? input.previous.last_turn_id : null,
		live: input.state === "running",
		reason: input.reason,
		source: input.source,
		event: input.event,
		cwd: identity.cwd,
		workdir: identity.workdir,
		branch: branchForContext(input.context),
		session_file: identity.sessionFile,
		...(input.context.ownerTerminal ? { owner_generation: input.context.ownerTerminal.generation } : {}),
	};
}
function booleanFromUnknown(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return null;
}

function promptAcceptedFromEnv(): boolean {
	const promptAcceptedJson = process.env[GJC_SESSION_PROMPT_ACCEPTED_JSON_ENV]?.trim();
	if (!promptAcceptedJson) return false;
	try {
		return fsSync.statSync(promptAcceptedJson).size > 0;
	} catch {
		return false;
	}
}

function readJsonFileSync(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fsSync.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function worktreeBaselineDirtyFromEnvOrMarker(): boolean | null {
	const promptAcceptedJson = process.env[GJC_SESSION_PROMPT_ACCEPTED_JSON_ENV]?.trim();
	if (promptAcceptedJson) {
		const promptAccepted = readJsonFileSync(promptAcceptedJson);
		const promptBaseline = booleanFromUnknown(promptAccepted?.worktreeBaselineDirty);
		if (promptBaseline !== null) return promptBaseline;
	}
	const envValue = booleanFromUnknown(process.env[GJC_SESSION_WORKTREE_BASELINE_DIRTY_ENV]);
	if (envValue !== null) return envValue;
	return null;
}

function observedRecoverableWorktreeChanges(cwd: string): boolean {
	if (!cwd.trim()) return false;
	try {
		const proc = Bun.spawnSync(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "pipe" });
		return proc.exitCode === 0 && proc.stdout.byteLength > 0;
	} catch {
		return false;
	}
}

function publicSafeErrorMessage(message: string): string {
	const normalized = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
	if (normalized.length <= MAX_PUBLIC_ERROR_MESSAGE_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_PUBLIC_ERROR_MESSAGE_LENGTH)}…`;
}

function errorMessageForPostmortem(reason: postmortem.Reason): string {
	return publicSafeErrorMessage(`GJC process cleanup ran for ${reason}`);
}

function numericProcessExitCode(defaultCode: number | null): number | null {
	return typeof process.exitCode === "number" ? process.exitCode : defaultCode;
}

function postmortemExitDetails(
	reason: postmortem.Reason,
	previous: RuntimeStateSidecarPayload,
	cwd: string,
): {
	state: RuntimeState;
	reason: string;
	exitKind: string;
	exitCode: number | null;
	signal: string | null;
	error?: { code: string; message: string; recoverable: true };
	recovery?: { action: string; reason: string };
	promptAccepted: boolean;
	observedRecoverableWorktreeChanges: boolean;
	worktreeBaselineDirty: boolean | null;
	worktreeChangedSinceBaseline: boolean;
} {
	const promptAccepted = promptAcceptedFromEnv();
	const observedChanges = observedRecoverableWorktreeChanges(typeof previous.cwd === "string" ? previous.cwd : cwd);
	const worktreeBaselineDirty = worktreeBaselineDirtyFromEnvOrMarker();
	const worktreeChangedSinceBaseline = worktreeBaselineDirty === false && observedChanges;
	const previousStateIsTerminal = previous.state === "completed" || previous.state === "errored";
	if (reason === postmortem.Reason.EXIT || reason === postmortem.Reason.MANUAL) {
		const exitCode = numericProcessExitCode(0) ?? 0;
		const exitedBeforeTerminalState = exitCode === 0 && reason === postmortem.Reason.EXIT && !previousStateIsTerminal;
		const state: RuntimeState = exitCode === 0 && !exitedBeforeTerminalState ? "completed" : "errored";
		const exitReason = exitedBeforeTerminalState
			? "process_exit_before_terminal_state"
			: reason === postmortem.Reason.EXIT
				? "process_exit"
				: "manual_cleanup";
		let classifiedReason = exitReason;
		if (exitedBeforeTerminalState) {
			if (!promptAccepted) classifiedReason = "process_exit_before_prompt_acceptance";
			else if (worktreeChangedSinceBaseline)
				classifiedReason = "accepted_prompt_observed_recoverable_worktree_changes";
			else if (observedChanges)
				classifiedReason = "accepted_prompt_dirty_worktree_observed_without_new_change_proof";
			else classifiedReason = "accepted_prompt_no_useful_output";
		}
		return {
			state,
			reason: classifiedReason,
			exitKind: reason,
			exitCode,
			signal: null,
			...(state === "errored"
				? {
						error: {
							code: classifiedReason,
							message: publicSafeErrorMessage(
								exitedBeforeTerminalState
									? "GJC process exited before emitting terminal agent state"
									: `GJC process exited with code ${exitCode}`,
							),
							recoverable: true,
						},
						recovery: {
							action: "recover_or_resume_session",
							reason: exitedBeforeTerminalState
								? "previous runtime state was non-terminal; preserve the worktree and inspect the session before retrying"
								: "process exited with a non-zero status",
						},
					}
				: {}),
			promptAccepted,
			observedRecoverableWorktreeChanges: observedChanges,
			worktreeBaselineDirty,
			worktreeChangedSinceBaseline,
		};
	}
	const signalByReason: Partial<Record<postmortem.Reason, string>> = {
		[postmortem.Reason.SIGINT]: "SIGINT",
		[postmortem.Reason.SIGTERM]: "SIGTERM",
		[postmortem.Reason.SIGHUP]: "SIGHUP",
	};
	return {
		state: "errored",
		reason,
		exitKind: reason,
		exitCode: numericProcessExitCode(null),
		signal: signalByReason[reason] ?? null,
		error: { code: reason, message: errorMessageForPostmortem(reason), recoverable: true },
		recovery: { action: "recover_or_resume_session", reason: "process cleanup ran before terminal agent state" },
		promptAccepted,
		observedRecoverableWorktreeChanges: observedChanges,
		worktreeBaselineDirty,
		worktreeChangedSinceBaseline,
	};
}

async function writeStateFileSync(stateFile: string, payload: Record<string, unknown>): Promise<void> {
	await writeStateFile(stateFile, payload);
}

interface StateFileLockOwner {
	pid: number;
	start_time: string;
	token: string;
}

function processStartTime(pid: number): string | null {
	try {
		const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		const fields = stat
			.slice(close + 1)
			.trim()
			.split(/\s+/);
		return fields[19] ?? null;
	} catch {
		return null;
	}
}

function validLockOwner(value: unknown): value is StateFileLockOwner {
	if (!value || typeof value !== "object") return false;
	const owner = value as Partial<StateFileLockOwner>;
	return (
		typeof owner.pid === "number" &&
		Number.isSafeInteger(owner.pid) &&
		owner.pid > 0 &&
		typeof owner.start_time === "string" &&
		typeof owner.token === "string" &&
		owner.token.length > 0
	);
}

function lockOwnerIsAlive(value: unknown): boolean {
	if (!validLockOwner(value)) return false;
	const owner = value;
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		return true;
	}
	const currentStartTime = processStartTime(owner.pid);
	return currentStartTime === null || currentStartTime === owner.start_time;
}

async function reclaimStaleStateFileLock(lockFile: string): Promise<void> {
	let raw: string;
	try {
		raw = await fs.readFile(lockFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let owner: unknown;
	try {
		owner = JSON.parse(raw);
	} catch {
		owner = null;
	}
	if (!validLockOwner(owner)) {
		const stat = await fs.stat(lockFile);
		if (Date.now() - stat.mtimeMs < 30_000) return;
	} else if (lockOwnerIsAlive(owner)) return;
	try {
		if ((await fs.readFile(lockFile, "utf8")) === raw) await fs.rm(lockFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function withStateFileLock<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
	const lockFile = `${stateFile}.lock`;
	const owner: StateFileLockOwner = {
		pid: process.pid,
		start_time: processStartTime(process.pid) ?? "unknown",
		token: randomUUID(),
	};
	await fs.mkdir(path.dirname(stateFile), { recursive: true });
	for (let attempt = 0; attempt < 12_000; attempt++) {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(lockFile, "wx");
			try {
				await handle.writeFile(JSON.stringify(owner));
			} catch (error) {
				await handle.close().catch(() => undefined);
				handle = undefined;
				await fs.rm(lockFile, { force: true }).catch(() => undefined);
				throw error;
			}
			const outcome = await operation().then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			);
			await handle.close();
			try {
				if ((await fs.readFile(lockFile, "utf8")) === JSON.stringify(owner)) await fs.rm(lockFile);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (!outcome.ok) throw outcome.error;
			return outcome.value;
		} catch (error) {
			if (handle) throw error;
			if ((error as { code?: unknown }).code !== "EEXIST") throw error;
			await reclaimStaleStateFileLock(lockFile);
			await Bun.sleep(5);
		}
	}
	throw new PreviousRuntimeStateReadError();
}

function coordinatorTransactionLockFile(stateFile: string): string {
	return path.resolve(path.dirname(stateFile), "..", "locks", "mutation.lock");
}

async function withCoordinatorTransactionLock<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
	return await withStateFileLock(coordinatorTransactionLockFile(stateFile), operation);
}

async function writeStateFile(stateFile: string, payload: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.dirname(stateFile), { recursive: true });
	await Bun.write(stateFile, `${JSON.stringify(payload)}\n`);
	rememberWrittenPayload(stateFile, payload);
}

function contextWithManagedOwnerGeneration(context: RuntimeStateContext): RuntimeStateContext {
	if (context.ownerTerminal) return context;
	const ownerTerminal = ownerTerminalContextFromEnvironment();
	if (ownerTerminal === "invalid") throw new PreviousRuntimeStateReadError();
	return ownerTerminal ? { ...context, ownerTerminal } : context;
}

export async function persistCoordinatorRuntimeStateFromEvent(
	event: RuntimeStateEvent,
	context: RuntimeStateContext,
): Promise<void> {
	__sessionStateSidecarPerfCounters.persistFromEventCalls += 1;
	const stateFile = runtimeStateFileForContext(context);
	const state = stateForEvent(event);
	if (!stateFile || !state) return;
	context = contextWithManagedOwnerGeneration(context);
	const identity = normalizedIdentity(context);
	await serializeStateFileWrite(
		stateFile,
		async () =>
			await withCoordinatorTransactionLock(
				stateFile,
				async () =>
					await withStateFileLock(stateFile, async () => {
						const nowMs = Date.now();
						const now = new Date(nowMs).toISOString();
						const previous = await readPreviousPayloadForEvent(stateFile);
						assertPreviousRuntimeStateIdentity(previous, identity);
						const payload = {
							...basePayload({
								context,
								previous,
								state,
								now,
								source: "agent_session_event",
								event: event.type,
								reason: null,
								sessionId: identity.sessionId,
							}),
							...(state === "completed" || state === "errored" ? { ended_at: now } : {}),
							...(finalResponseForEvent(event) ? { final_response: finalResponseForEvent(event) } : {}),
							...(state === "errored"
								? { error: { code: "agent_error", message: "GJC agent reported an error", recoverable: true } }
								: {}),
						};
						if (shouldSkipRuntimeStateWrite(previous, payload, nowMs)) return;
						await writeStateFile(stateFile, payload);
					}),
			),
	);
}

function ownerTerminalSignal(reason: postmortem.Reason): TerminalSignal {
	if (reason === postmortem.Reason.SIGTERM) return "SIGTERM";
	if (reason === postmortem.Reason.SIGINT) return "SIGINT";
	if (reason === postmortem.Reason.SIGHUP) return "SIGHUP";
	if (reason === postmortem.Reason.EXIT) return "EXIT";
	if (reason === postmortem.Reason.MANUAL) return "MANUAL";
	return "UNKNOWN";
}

function ownerTerminalPayload(verdict: OwnerVerdict, _owner: OwnerTerminalContext): Record<string, unknown> {
	return {
		generation: verdict.generation,
		socket_key: verdict.server_key,
		signal: verdict.signal,
		result: verdict.result,
		classification: verdict.classification,
		observer: verdict.observer,
		observed_at: verdict.observed_at,
		...(verdict.intent_id ? { intent_id: verdict.intent_id } : {}),
		dedupe_key: verdict.dedupe_key,
	};
}

export function ownerTerminalContextFromEnvironment(): OwnerTerminalContext | "invalid" | null {
	const generation = process.env[GJC_TMUX_OWNER_GENERATION_ENV];
	const stateDir = process.env[GJC_TMUX_OWNER_STATE_DIR_ENV];
	const socketKey = process.env[GJC_TMUX_OWNER_SERVER_KEY_ENV];
	const supplied = [generation, stateDir, socketKey].some(value => value !== undefined);
	const managedLaunch = process.platform === "linux" && process.env.GJC_TMUX_LAUNCHED === "1";
	if (!supplied) return managedLaunch ? "invalid" : null;
	const normalizedGeneration = generation?.trim();
	const normalizedStateDir = stateDir?.trim();
	const normalizedSocketKey = socketKey?.trim();
	if (
		!normalizedGeneration ||
		!normalizedStateDir ||
		!normalizedSocketKey ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedGeneration) ||
		!path.isAbsolute(normalizedStateDir) ||
		/[\u0000-\u001f\u007f]/.test(normalizedSocketKey)
	) {
		return "invalid";
	}
	return { generation: normalizedGeneration, stateDir: normalizedStateDir, socketKey: normalizedSocketKey };
}

async function persistInvalidOwnerTerminalMetadata(
	reason: postmortem.Reason,
	context: RuntimeStateContext,
	stateFile: string,
	sessionId: string,
	previous: Record<string, unknown>,
): Promise<void> {
	const now = new Date().toISOString();
	await writeStateFileSync(stateFile, {
		...basePayload({
			context,
			previous,
			state: "errored",
			now,
			source: "process_postmortem",
			event: "owner_terminal",
			reason: "owner_metadata_invalid",
			sessionId,
		}),
		ended_at: now,
		detected_at: now,
		signal: ownerTerminalSignal(reason),
		error: {
			code: "owner_metadata_invalid",
			message: "GJC managed tmux owner metadata was unavailable or invalid",
			recoverable: true,
		},
		recovery: {
			action: "recover_or_resume_session",
			reason: "managed tmux owner provenance could not be validated",
		},
		previous_runtime_state: typeof previous.state === "string" ? previous.state : null,
	});
}

async function operatorDispatchIdForOwner(
	owner: OwnerTerminalContext,
	request: Omit<ObserveTerminalRequest, "operator_dispatch_id">,
): Promise<string | undefined> {
	try {
		const intent = JSON.parse(
			await Bun.file(lifecyclePaths(owner.stateDir, request.session_id, owner.generation).intentFile).text(),
		) as unknown;
		if (!isValidOwnerIntent(intent)) return undefined;
		const dispatchId = owner.operatorDispatchId ?? intent.dispatch_id;
		return isValidOwnerIntent(intent as OwnerIntent, { ...request, operator_dispatch_id: dispatchId })
			? dispatchId
			: undefined;
	} catch {
		return undefined;
	}
}

async function persistCoordinatorRuntimeStateFromOwnerTerminalPostmortem(
	reason: postmortem.Reason,
	context: RuntimeStateContext,
	stateFile: string,
	sessionId: string,
	previous: Record<string, unknown>,
): Promise<void> {
	const owner = context.ownerTerminal;
	if (!owner) return;
	try {
		const now = new Date().toISOString();
		const observation: Omit<ObserveTerminalRequest, "operator_dispatch_id"> = {
			schema_version: 1,
			op: "observe_terminal",
			session_id: sessionId,
			owner_generation: owner.generation,
			state_dir: owner.stateDir,
			socket_key: owner.socketKey,
			observer: "sidecar",
			observed_at: now,
			signal: ownerTerminalSignal(reason),
			exit_code: numericProcessExitCode(null),
			exit_kind: String(reason),
			reason: "process_postmortem",
		};
		const operatorDispatchId = await operatorDispatchIdForOwner(owner, observation);
		const verdict = await observeOwnerTerminal({
			...observation,
			...(operatorDispatchId ? { operator_dispatch_id: operatorDispatchId } : {}),
		});
		const expected = verdict.classification === "expected_operator_shutdown";
		const state: RuntimeState = expected ? "completed" : "errored";
		const payload = {
			...basePayload({
				context,
				previous,
				state,
				now,
				source: "process_postmortem",
				event: "owner_terminal",
				reason: verdict.classification,
				sessionId,
			}),
			ended_at: now,
			detected_at: now,
			owner_terminal: ownerTerminalPayload(verdict, owner),
			...(expected
				? {}
				: {
						error: {
							code: verdict.classification,
							message: "GJC owner terminal verdict requires session recovery",
							recoverable: true,
						},
						recovery: {
							action: "recover_or_resume_session",
							reason: "owner terminal verdict was not an expected operator shutdown",
						},
					}),
			previous_runtime_state: typeof previous.state === "string" ? previous.state : null,
		};
		await writeStateFileSync(stateFile, payload);
	} catch {
		const now = new Date().toISOString();
		await writeStateFileSync(stateFile, {
			...basePayload({
				context,
				previous,
				state: "errored",
				now,
				source: "process_postmortem",
				event: "owner_terminal",
				reason: "owner_verdict_unavailable",
				sessionId,
			}),
			ended_at: now,
			detected_at: now,
			error: {
				code: "owner_verdict_unavailable",
				message: "GJC owner terminal verdict was unavailable",
				recoverable: true,
			},
			recovery: {
				action: "recover_or_resume_session",
				reason: "owner terminal could not be authoritatively classified",
			},
			previous_runtime_state: typeof previous.state === "string" ? previous.state : null,
		});
	}
}

export async function persistCoordinatorRuntimeStateFromPostmortem(
	reason: postmortem.Reason,
	context: RuntimeStateContext,
): Promise<void> {
	const stateFile = runtimeStateFileForContext(context);
	if (!stateFile) return;
	const identity = normalizedIdentity(context);
	await serializeStateFileWrite(
		stateFile,
		async () =>
			await withCoordinatorTransactionLock(
				stateFile,
				async () =>
					await withStateFileLock(stateFile, async () => {
						const previous = readPreviousPayload(stateFile);
						assertPreviousRuntimeStateIdentity(previous, identity);
						if (shouldPreserveTerminalPayload(previous as RuntimeStateSidecarPayload, identity)) return;
						// The immutable owner verdict remains in its lifecycle artifact; never replace a
						// complete agent terminal payload merely to mirror that verdict here.
						if (context.ownerTerminalMetadataInvalid) {
							await persistInvalidOwnerTerminalMetadata(
								reason,
								context,
								stateFile,
								identity.sessionId,
								previous,
							);
							return;
						}
						if (context.ownerTerminal) {
							await persistCoordinatorRuntimeStateFromOwnerTerminalPostmortem(
								reason,
								context,
								stateFile,
								identity.sessionId,
								previous,
							);
							return;
						}
						const previousForDetails: RuntimeStateSidecarPayload =
							(previous as RuntimeStateSidecarPayload).state === "completed" ||
							(previous as RuntimeStateSidecarPayload).state === "errored"
								? { ...(previous as RuntimeStateSidecarPayload), state: "running" }
								: (previous as RuntimeStateSidecarPayload);
						const now = new Date().toISOString();
						const details = postmortemExitDetails(reason, previousForDetails, identity.cwd);
						const payload = {
							...basePayload({
								context,
								previous,
								state: details.state,
								now,
								source: "process_postmortem",
								event: "process_exit",
								reason: details.reason,
								sessionId: identity.sessionId,
							}),
							ended_at: now,
							detected_at: now,
							exit_kind: details.exitKind,
							exit_code: details.exitCode,
							signal: details.signal,
							...(details.error ? { error: details.error } : {}),
							...(details.recovery ? { recovery: details.recovery } : {}),
							previous_runtime_state: typeof previous.state === "string" ? previous.state : null,
							prompt_accepted: details.promptAccepted,
							observed_recoverable_worktree_changes: details.observedRecoverableWorktreeChanges,
							worktree_baseline_dirty: details.worktreeBaselineDirty,
							worktree_changed_since_baseline: details.worktreeChangedSinceBaseline,
						};
						await writeStateFileSync(stateFile, payload);
					}),
			),
	);
}

export function registerCoordinatorRuntimeStateFinalizer(context: RuntimeStateContext): () => void {
	if (!runtimeStateFileForContext(context)) return () => {};
	const ownerTerminal = ownerTerminalContextFromEnvironment();
	const finalizerContext: RuntimeStateContext =
		ownerTerminal === "invalid"
			? { ...context, ownerTerminalMetadataInvalid: true }
			: ownerTerminal
				? { ...context, ownerTerminal }
				: context;
	return postmortem.register("coordinator-runtime-state", async reason => {
		await persistCoordinatorRuntimeStateFromPostmortem(reason, finalizerContext);
	});
}
