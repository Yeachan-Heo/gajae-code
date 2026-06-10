import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { logger } from "@gajae-code/utils";

export const GJC_COORDINATOR_SESSION_STATE_FILE_ENV = "GJC_COORDINATOR_SESSION_STATE_FILE";
export const GJC_COORDINATOR_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";

type RuntimeState = "ready_for_input" | "running" | "needs_user_input" | "completed" | "errored";

interface RuntimeStateEvent {
	type: string;
	messages?: unknown[];
}

interface RuntimeStateContext {
	sessionId: string;
	cwd: string;
	sessionFile?: string | null;
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
	};
	try {
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await Bun.write(stateFile, `${JSON.stringify(payload, null, 2)}\n`);
	} catch (error) {
		logger.warn("Failed to persist coordinator runtime state", { error: String(error), stateFile });
	}
}
