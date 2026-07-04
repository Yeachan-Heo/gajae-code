import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { logger, postmortem } from "@gajae-code/utils";

export const GJC_COORDINATOR_SESSION_STATE_FILE_ENV = "GJC_COORDINATOR_SESSION_STATE_FILE";
export const GJC_COORDINATOR_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";
export const GJC_COORDINATOR_SESSION_BRANCH_ENV = "GJC_COORDINATOR_SESSION_BRANCH";

export type RuntimeState = "ready_for_input" | "running" | "needs_user_input" | "completed" | "errored";

type FinalResponseSource = "agent_end" | "launch_error";
const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 2000;

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

function stateForEvent(event: RuntimeStateEvent): RuntimeState | null {
	if (event.type === "agent_start" || event.type === "turn_start") return "running";
	if (event.type === "agent_end") {
		const assistant = lastAssistant(event.messages);
		return assistant?.stopReason === "error" ? "errored" : "completed";
	}
	if (event.type === "notice") return null;
	return null;
}

function readPreviousPayload(stateFile: string): Record<string, unknown> {
	try {
		return JSON.parse(fsSync.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function shouldPreserveTerminalPayload(previous: RuntimeStateSidecarPayload): boolean {
	if (previous.state !== "completed" && previous.state !== "errored") return false;
	const source = previous.final_response?.source;
	return source === "agent_end" || source === "launch_error";
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
}): Record<string, unknown> {
	return {
		schema_version: 1,
		session_id: process.env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || input.context.sessionId,
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

function postmortemExitDetails(reason: postmortem.Reason): {
	state: RuntimeState;
	reason: string;
	exitKind: string;
	exitCode: number | null;
	signal: string | null;
	error?: { code: string; message: string; recoverable: true };
} {
	if (reason === postmortem.Reason.EXIT || reason === postmortem.Reason.MANUAL) {
		const exitCode = numericProcessExitCode(0) ?? 0;
		const state: RuntimeState = exitCode === 0 ? "completed" : "errored";
		return {
			state,
			reason: reason === postmortem.Reason.EXIT ? "process_exit" : "manual_cleanup",
			exitKind: reason,
			exitCode,
			signal: null,
			...(state === "errored"
				? {
						error: {
							code: "process_exit",
							message: publicSafeErrorMessage(`GJC process exited with code ${exitCode}`),
							recoverable: true,
						},
					}
				: {}),
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
	};
}

function writeStateFileSync(stateFile: string, payload: Record<string, unknown>): void {
	fsSync.mkdirSync(path.dirname(stateFile), { recursive: true });
	fsSync.writeFileSync(stateFile, `${JSON.stringify(payload, null, 2)}\n`);
}

async function writeStateFile(stateFile: string, payload: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.dirname(stateFile), { recursive: true });
	await Bun.write(stateFile, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function persistCoordinatorRuntimeStateFromEvent(
	event: RuntimeStateEvent,
	context: RuntimeStateContext,
): Promise<void> {
	const stateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	if (!stateFile) return;
	const state = stateForEvent(event);
	if (!state) return;
	const now = new Date().toISOString();
	const previous = readPreviousPayload(stateFile);
	const finalResponse = finalResponseForEvent(event);
	const payload = {
		...basePayload({ context, previous, state, now, source: "agent_session_event", event: event.type, reason: null }),
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
	try {
		await writeStateFile(stateFile, payload);
	} catch (error) {
		logger.warn("Failed to persist coordinator runtime state", { error: String(error), stateFile });
	}
}

export function persistCoordinatorRuntimeStateFromPostmortem(
	reason: postmortem.Reason,
	context: RuntimeStateContext,
): void {
	const stateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	if (!stateFile) return;
	const previous = readPreviousPayload(stateFile);
	if (shouldPreserveTerminalPayload(previous as RuntimeStateSidecarPayload)) return;
	const now = new Date().toISOString();
	const details = postmortemExitDetails(reason);
	const payload = {
		...basePayload({
			context,
			previous,
			state: details.state,
			now,
			source: "process_postmortem",
			event: "process_exit",
			reason: details.reason,
		}),
		ended_at: now,
		detected_at: now,
		exit_kind: details.exitKind,
		exit_code: details.exitCode,
		signal: details.signal,
		...(details.error ? { error: details.error } : {}),
	};
	try {
		writeStateFileSync(stateFile, payload);
	} catch (error) {
		logger.warn("Failed to persist coordinator runtime state during postmortem", { error: String(error), stateFile });
	}
}

export function registerCoordinatorRuntimeStateFinalizer(context: RuntimeStateContext): () => void {
	if (!process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim()) return () => {};
	return postmortem.register("coordinator-runtime-state", reason => {
		persistCoordinatorRuntimeStateFromPostmortem(reason, context);
	});
}
