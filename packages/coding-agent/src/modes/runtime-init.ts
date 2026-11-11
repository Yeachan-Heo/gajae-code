/**
 * Shared extension runtime wiring for non-interactive session callers.
 *
 * These callers initialize the extension runner with the same action handlers
 * that delegate to the {@link AgentSession}. Only error reporting, shutdown
 * behavior, and UI context differ between callers — those stay as
 * caller-supplied hooks.
 */

import type { ExtensionError, ExtensionUIContext } from "../extensibility/extensions/types";

import type { AgentSession } from "../session/agent-session";

const BROKER_LIFECYCLE_OPERATIONS = new Set([
	"session.new",
	"session.fork",
	"session.resume",
	"session.close",
	"session.switch",
	"session.branch",
	"session.handoff",
	"session.delete",
]);

function prohibitBrokerLifecycleOperation(operation: string): never {
	throw Object.assign(new Error(`${operation} is available only through the Broker lifecycle service.`), {
		code: "operation_prohibited",
	});
}

/** Action name for an extension-originated send failure. */
export type ExtensionSendAction = "extension_send" | "extension_send_user";

export interface InitializeExtensionsOptions {
	/** Reports an error thrown by an extension-initiated send. */
	reportSendError: (action: ExtensionSendAction, error: Error) => void;
	/** Reports a runtime error surfaced through {@link ExtensionRunner.onError}. */
	reportRuntimeError: (error: ExtensionError) => void;
	/** Optional shutdown hook for caller-specific lifecycle signaling. */
	onShutdown?: () => void;
	/** Optional interactive UI context; omitted for headless callers. */
	uiContext?: ExtensionUIContext;
}

/**
 * Initialize the session's extension runner with the standard action set
 * shared by non-interactive modes, then emit `session_start`.
 *
 * No-op when the session was constructed without an extension runner.
 */
export async function initializeExtensions(session: AgentSession, options: InitializeExtensionsOptions): Promise<void> {
	const runner = session.extensionRunner;
	if (!runner) return;

	const { reportSendError, reportRuntimeError, onShutdown, uiContext } = options;
	const shutdown = onShutdown ?? (() => {});

	runner.onError(reportRuntimeError);
	await runner.emit({ type: "session_start" });
}
