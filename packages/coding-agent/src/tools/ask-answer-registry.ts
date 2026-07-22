/**
 * Process-wide registry mapping a session id to its active {@link AskAnswerSource}.
 *
 * Decouples the `ask` tool (which reads the source via `AgentSession`) from the
 * notifications extension (which registers one), without threading a new method
 * through the extension/runner/controller wiring. A session has at most one
 * source; registering returns a disposer.
 */

import { logger } from "@gajae-code/utils";
import type { WorkflowGateEmitter } from "../modes/shared/agent-wire/workflow-gate-broker";
import type { AskAnswerSource } from "./index";

const sources = new Map<string, AskAnswerSource>();
const workflowGateEmitters = new Map<string, WorkflowGateEmitter>();
const workflowGateListeners = new Map<string, Set<(emitter: WorkflowGateEmitter | undefined) => void>>();

/** Register `source` for `sessionId`. Returns a disposer that clears it. */
export function registerAskAnswerSource(sessionId: string, source: AskAnswerSource): () => void {
	sources.set(sessionId, source);
	return () => {
		if (sources.get(sessionId) === source) sources.delete(sessionId);
	};
}

/** The answer source for `sessionId`, if one is registered. */
export function getAskAnswerSource(sessionId: string): AskAnswerSource | undefined {
	return sources.get(sessionId);
}

/** Publish a session's current workflow-gate emitter after mode initialization. */
export function notifyWorkflowGateEmitterChanged(sessionId: string, emitter: WorkflowGateEmitter | undefined): void {
	if (emitter) workflowGateEmitters.set(sessionId, emitter);
	else workflowGateEmitters.delete(sessionId);
	for (const listener of workflowGateListeners.get(sessionId) ?? []) {
		// Isolate each listener: a throwing observer must never escape into an
		// emitter suspend/bind/restore step, which runs inside session-transition
		// transactions (e.g. handoff) whose rollback/commit correctness depends on
		// this notification being no-throw.
		try {
			listener(emitter);
		} catch (error) {
			logger.warn("Workflow-gate emitter listener threw during notification", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/** Observe workflow-gate emitter installation even when it occurs after session_start. */
export function registerWorkflowGateEmitterListener(
	sessionId: string,
	listener: (emitter: WorkflowGateEmitter | undefined) => void,
): () => void {
	const listeners = workflowGateListeners.get(sessionId) ?? new Set();
	listeners.add(listener);
	workflowGateListeners.set(sessionId, listeners);
	listener(workflowGateEmitters.get(sessionId));
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) workflowGateListeners.delete(sessionId);
	};
}
