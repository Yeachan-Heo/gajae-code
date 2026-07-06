import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { logger, postmortem } from "@gajae-code/utils";
import { sessionRuntimeDir } from "./session-layout";

export const GJC_COORDINATOR_SESSION_STATE_FILE_ENV = "GJC_COORDINATOR_SESSION_STATE_FILE";
export const GJC_COORDINATOR_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";
export const GJC_COORDINATOR_SESSION_BRANCH_ENV = "GJC_COORDINATOR_SESSION_BRANCH";
const GJC_SESSION_PROMPT_ACCEPTED_JSON_ENV = "GJC_SESSION_PROMPT_ACCEPTED_JSON";
const GJC_SESSION_WORKTREE_BASELINE_DIRTY_ENV = "GJC_SESSION_WORKTREE_BASELINE_DIRTY";

export type RuntimeState = "ready_for_input" | "running" | "needs_user_input" | "completed" | "errored";

type FinalResponseSource = "agent_end" | "launch_error";
const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 2000;
const HEARTBEAT_MS = 1000;

type LastPayloadCacheEntry = { mtimeMs: number; size: number; payload: Record<string, unknown> };
const lastPayloadByStateFile = new Map<string, LastPayloadCacheEntry>();

/** Test-only counters for runtime sidecar hot-path assertions. */
export const __sessionStateSidecarPerfCounters = {
	persistFromEventCalls: 0,
	reset(): void {
		this.persistFromEventCalls = 0;
	},
};

const lastWrittenPayloadByStateFile = new Map<string, Record<string, unknown>>();

interface RuntimeStateEvent {
	type: string;
	messages?: unknown[];
}

interface RuntimeStateContext {
	sessionId: string;
	cwd: string;
	sessionFile?: string | null;
	branch?: string | null;
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
				| "session_id_mismatch"
				| "cwd_mismatch"
				| "session_file_mismatch"
				| "non_terminal_state";
	  };

function sameResolvedPath(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right);
}

function isCoordinatorOwnedStateFile(stateFile: string): boolean {
	const coordinatorStateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	return !!coordinatorStateFile && sameResolvedPath(coordinatorStateFile, stateFile);
}

export async function readTerminalRuntimeStateMarker(input: {
	stateFile?: string | null;
	sessionId?: string | null;
	cwd?: string | null;
	sessionFile?: string | null;
}): Promise<TerminalRuntimeStateStatus> {
	const stateFile = input.stateFile?.trim();
	const sessionId = input.sessionId?.trim();
	if (!stateFile || !sessionId) return { terminal: false, reason: "missing_state_file" };
	let payload: RuntimeStateSidecarPayload;
	try {
		payload = JSON.parse(await Bun.file(stateFile).text()) as RuntimeStateSidecarPayload;
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return {
			terminal: false,
			reason: code === "ENOENT" || code === "ENOTDIR" ? "missing_state_file" : "invalid_json",
		};
	}
	if (payload.session_id !== sessionId) return { terminal: false, reason: "session_id_mismatch" };
	if (input.cwd && typeof payload.cwd === "string" && !sameResolvedPath(payload.cwd, input.cwd)) {
		return { terminal: false, reason: "cwd_mismatch" };
	}
	if (
		input.sessionFile &&
		typeof payload.session_file === "string" &&
		!sameResolvedPath(payload.session_file, input.sessionFile)
	) {
		return { terminal: false, reason: "session_file_mismatch" };
	}
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

function readPreviousPayload(stateFile: string): Record<string, unknown> {
	try {
		return JSON.parse(fsSync.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

async function readPreviousPayloadForEvent(stateFile: string): Promise<Record<string, unknown>> {
	if (!isCoordinatorOwnedStateFile(stateFile)) {
		const cachedWritten = lastWrittenPayloadByStateFile.get(stateFile);
		if (cachedWritten) return cachedWritten;
	}
	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(stateFile);
	} catch {
		lastPayloadByStateFile.delete(stateFile);
		return {};
	}
	const cached = lastPayloadByStateFile.get(stateFile);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.payload;
	try {
		const payload = JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>;
		lastPayloadByStateFile.set(stateFile, { mtimeMs: stat.mtimeMs, size: stat.size, payload });
		return payload;
	} catch {
		lastPayloadByStateFile.delete(stateFile);
		return {};
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
	lastWrittenPayloadByStateFile.set(stateFile, payload);
	try {
		const stat = fsSync.statSync(stateFile);
		lastPayloadByStateFile.set(stateFile, { mtimeMs: stat.mtimeMs, size: stat.size, payload });
	} catch {
		lastPayloadByStateFile.delete(stateFile);
	}
}
function shouldPreserveTerminalPayload(
	previous: RuntimeStateSidecarPayload,
	input: { sessionId: string; cwd: string; sessionFile?: string | null },
): boolean {
	if (previous.state !== "completed" && previous.state !== "errored") return false;
	const source = previous.final_response?.source;
	if (source !== "agent_end" && source !== "launch_error") return false;
	if (typeof previous.session_id === "string" && previous.session_id !== input.sessionId) return false;
	if (typeof previous.cwd === "string" && !sameResolvedPath(previous.cwd, input.cwd)) return false;
	if (typeof previous.workdir === "string" && !sameResolvedPath(previous.workdir, input.cwd)) return false;
	if (
		input.sessionFile &&
		typeof previous.session_file === "string" &&
		!sameResolvedPath(previous.session_file, input.sessionFile)
	) {
		return false;
	}
	return true;
}

function cachedTerminalPayload(
	stateFile: string,
	input: { sessionId: string; cwd: string; sessionFile?: string | null },
): RuntimeStateSidecarPayload | null {
	const cached = lastWrittenPayloadByStateFile.get(stateFile) as RuntimeStateSidecarPayload | undefined;
	return cached && shouldPreserveTerminalPayload(cached, input) ? cached : null;
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
	return {
		schema_version: 1,
		session_id: input.sessionId,
		state: input.state,
		ready_for_input: input.state === "completed" || input.state === "ready_for_input",
		updated_at: input.now,
		current_turn_id: typeof input.previous.current_turn_id === "string" ? input.previous.current_turn_id : null,
		last_turn_id: typeof input.previous.last_turn_id === "string" ? input.previous.last_turn_id : null,
		live: input.state === "running",
		reason: input.reason,
		source: input.source,
		event: input.event,
		cwd: input.context.cwd,
		workdir: input.context.cwd,
		branch: branchForContext(input.context),
		session_file: input.context.sessionFile ?? null,
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
	if (reason === postmortem.Reason.EXIT || reason === postmortem.Reason.MANUAL) {
		const exitCode = numericProcessExitCode(0) ?? 0;
		const exitedBeforeTerminalState =
			exitCode === 0 && reason === postmortem.Reason.EXIT && previous.state === "running";
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

function writeStateFileSync(stateFile: string, payload: Record<string, unknown>): void {
	fsSync.mkdirSync(path.dirname(stateFile), { recursive: true });
	fsSync.writeFileSync(stateFile, `${JSON.stringify(payload)}\n`);
	rememberWrittenPayload(stateFile, payload);
}

async function writeStateFile(stateFile: string, payload: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.dirname(stateFile), { recursive: true });
	await Bun.write(stateFile, `${JSON.stringify(payload)}\n`);
	rememberWrittenPayload(stateFile, payload);
}

export async function persistCoordinatorRuntimeStateFromEvent(
	event: RuntimeStateEvent,
	context: RuntimeStateContext,
): Promise<void> {
	__sessionStateSidecarPerfCounters.persistFromEventCalls += 1;
	const stateFile = runtimeStateFileForContext(context);
	if (!stateFile) return;
	const state = stateForEvent(event);
	if (!state) return;
	const nowMs = Date.now();
	const now = new Date(nowMs).toISOString();
	const previous = await readPreviousPayloadForEvent(stateFile);
	const finalResponse = finalResponseForEvent(event);
	const sessionId = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim()
		? process.env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || context.sessionId
		: context.sessionId;
	const payload = {
		...basePayload({
			context,
			previous,
			state,
			now,
			source: "agent_session_event",
			event: event.type,
			reason: null,
			sessionId,
		}),
		...(state === "completed" || state === "errored" ? { ended_at: now } : {}),
		...(finalResponse ? { final_response: finalResponse } : {}),
		...(state === "errored"
			? {
					error: {
						code: "agent_error",
						message: publicSafeErrorMessage(lastAssistant(event.messages)?.errorMessage ?? "agent_error"),
						recoverable: true,
					},
				}
			: {}),
	};
	if (state === "completed" || state === "errored") rememberWrittenPayload(stateFile, payload);
	try {
		if (shouldSkipRuntimeStateWrite(previous, payload, nowMs)) return;
		await writeStateFile(stateFile, payload);
	} catch (error) {
		logger.warn("Failed to persist coordinator runtime state", { error: String(error), stateFile });
	}
}

export function persistCoordinatorRuntimeStateFromPostmortem(
	reason: postmortem.Reason,
	context: RuntimeStateContext,
): void {
	const stateFile = runtimeStateFileForContext(context);
	if (!stateFile) return;
	const sessionId = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim()
		? process.env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || context.sessionId
		: context.sessionId;
	const preserveInput = { sessionId, cwd: context.cwd, sessionFile: context.sessionFile };
	const cachedTerminal = cachedTerminalPayload(stateFile, preserveInput);
	const previous: Record<string, unknown> = cachedTerminal
		? (cachedTerminal as unknown as Record<string, unknown>)
		: readPreviousPayload(stateFile);
	if (cachedTerminal || shouldPreserveTerminalPayload(previous as RuntimeStateSidecarPayload, preserveInput)) return;
	const previousForDetails: RuntimeStateSidecarPayload =
		(previous as RuntimeStateSidecarPayload).state === "completed" ||
		(previous as RuntimeStateSidecarPayload).state === "errored"
			? { ...(previous as RuntimeStateSidecarPayload), state: "running" }
			: (previous as RuntimeStateSidecarPayload);
	const now = new Date().toISOString();
	const details = postmortemExitDetails(reason, previousForDetails, context.cwd);
	const payload = {
		...basePayload({
			context,
			previous,
			state: details.state,
			now,
			source: "process_postmortem",
			event: "process_exit",
			reason: details.reason,
			sessionId,
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
	try {
		writeStateFileSync(stateFile, payload);
	} catch (error) {
		logger.warn("Failed to persist coordinator runtime state during postmortem", { error: String(error), stateFile });
	}
}

export function registerCoordinatorRuntimeStateFinalizer(context: RuntimeStateContext): () => void {
	if (!runtimeStateFileForContext(context)) return () => {};
	return postmortem.register("coordinator-runtime-state", reason => {
		persistCoordinatorRuntimeStateFromPostmortem(reason, context);
	});
}
