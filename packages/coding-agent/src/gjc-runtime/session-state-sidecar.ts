import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { logger } from "@gajae-code/utils";

export const GJC_COORDINATOR_SESSION_STATE_FILE_ENV = "GJC_COORDINATOR_SESSION_STATE_FILE";
export const GJC_COORDINATOR_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";

export type RuntimeState = "ready_for_input" | "running" | "needs_user_input" | "completed" | "errored";

interface RuntimeStateEvent {
	type: string;
	messages?: unknown[];
}

interface RuntimeStateContext {
	sessionId: string;
	cwd: string;
	sessionFile?: string | null;
}

interface RuntimeStateSidecarPayload {
	schema_version?: unknown;
	session_id?: unknown;
	state?: unknown;
	ready_for_input?: unknown;
	cwd?: unknown;
	session_file?: unknown;
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
	source: "agent_end";
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

export async function persistCoordinatorRuntimeStateFromEvent(
	event: RuntimeStateEvent,
	context: RuntimeStateContext,
): Promise<void> {
	const stateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	if (!stateFile) return;
	const state = stateForEvent(event);
	if (!state) return;
	const now = new Date().toISOString();
	let previous: Record<string, unknown> = {};
	try {
		previous = JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>;
	} catch {
		previous = {};
	}
	const finalResponse = finalResponseForEvent(event);
	const payload = {
		schema_version: 1,
		session_id: process.env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || context.sessionId,
		state,
		ready_for_input: state === "completed" || state === "ready_for_input",
		updated_at: now,
		current_turn_id: typeof previous.current_turn_id === "string" ? previous.current_turn_id : null,
		last_turn_id: typeof previous.last_turn_id === "string" ? previous.last_turn_id : null,
		live: typeof previous.live === "boolean" ? previous.live : null,
		reason: null,
		source: "agent_session_event",
		event: event.type,
		cwd: context.cwd,
		session_file: context.sessionFile ?? null,
		...(finalResponse ? { final_response: finalResponse } : {}),
		...(state === "errored"
			? {
					error: {
						code: "agent_error",
						message: lastAssistant(event.messages)?.errorMessage ?? "agent_error",
						recoverable: true,
					},
				}
			: {}),
	};
	try {
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await Bun.write(stateFile, `${JSON.stringify(payload, null, 2)}\n`);
	} catch (error) {
		logger.warn("Failed to persist coordinator runtime state", { error: String(error), stateFile });
	}
}
