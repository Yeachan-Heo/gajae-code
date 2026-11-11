import { type AttemptScope, attemptScopesEqual } from "@gajae-code/agent-core/attempt-scope";
import type { AgentSession } from "../session/agent-session";
import { getSessionMessageEntryId } from "../session/session-manager";

export const SDK_REVISION_MAX_BODY_CHARS = 65_536;

export type SdkRevisionErrorCode =
	| "invalid_input"
	| "busy"
	| "resource_gone"
	| "revision_cancelled"
	| "revision_not_applied"
	| "revision_failed"
	| "provider_failed";

const ERROR_MESSAGES: Record<SdkRevisionErrorCode, string> = {
	invalid_input:
		"Revision requires a session ID, a prompt entry ID, and nonempty well-formed text of at most 65536 characters.",
	busy: "Session is not idle for a prompt revision.",
	resource_gone: "The revision session or active branch has changed.",
	revision_cancelled: "The prompt revision was cancelled.",
	revision_not_applied: "The prompt revision did not produce a replacement and assistant response.",
	revision_failed: "The prompt revision could not complete.",
	provider_failed: "The revision provider request failed.",
};

/** Deliberately excludes provider errors, transcript text, and filesystem paths. */
export class SdkRevisionError extends Error {
	constructor(
		readonly code: SdkRevisionErrorCode,
		readonly rollbackFailed = false,
	) {
		super(ERROR_MESSAGES[code]);
		this.name = "SdkRevisionError";
	}
}

export interface SdkRevisionResult {
	sessionId: string;
	revised: true;
	/** The original user entry; it remains in the same session tree. */
	entryId: string;
	replacementEntryId: string;
	assistantEntryId: string;
	status: "completed";
}

/** Host-owned options, never read from the public operation's input. */
export interface SdkRevisionRuntimeOptions {
	sdkRunCapability?: unknown;
}

// Retain admission across navigation, normal prompt execution, and persistence.
// A replacement Host control object must not admit a second revision of this session.
const revisions = new WeakSet<AgentSession>();

function boundedId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= 128 &&
		value.isWellFormed() &&
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

function idle(session: AgentSession): void {
	if (session.sessionLifecycle.disposed) throw new SdkRevisionError("resource_gone");
	if (
		session.isRevisionControlBusy ||
		session.sessionLifecycle.transitioning ||
		session.isAwaitingIdle ||
		session.isCompacting ||
		session.isBashRunning ||
		session.hasPendingBashMessages ||
		session.hasPendingPythonMessages ||
		session.queuedMessageCount > 0 ||
		session.agent.hasQueuedMessages()
	)
		throw new SdkRevisionError("busy");
}

function failure(error: unknown): SdkRevisionError {
	if (error instanceof SdkRevisionError) return error;
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	if (error instanceof Error && (error.name === "PromptPreflightCancelledError" || error.name === "AbortError"))
		return new SdkRevisionError("revision_cancelled");
	if (code === "busy" || code === "resource_gone") return new SdkRevisionError(code);
	if (error instanceof Error && error.name === "AgentBusyError") return new SdkRevisionError("busy");
	return new SdkRevisionError("revision_failed");
}

/**
 * Trusted AgentSession service, not public operation authority. The Broker owns
 * authorization, lifecycle, and exact-run abort. Reuse the session's native
 * navigation and ordinary prompt engine; never fork or append a synthetic turn.
 */
export async function reviseSession(
	session: AgentSession,
	input: Record<string, unknown>,
	runtime: SdkRevisionRuntimeOptions = {},
): Promise<SdkRevisionResult> {
	if (
		Object.keys(input).some(key => key !== "sessionId" && key !== "entryId" && key !== "body") ||
		!boundedId(input.sessionId) ||
		!boundedId(input.entryId) ||
		typeof input.body !== "string" ||
		!input.body.trim() ||
		input.body.length > SDK_REVISION_MAX_BODY_CHARS ||
		!input.body.isWellFormed()
	)
		throw new SdkRevisionError("invalid_input");
	const { sessionId, entryId, body } = input;
	if (session.sessionId !== sessionId) throw new SdkRevisionError("resource_gone");
	if (revisions.has(session)) throw new SdkRevisionError("busy");
	idle(session);

	// Capture every identity before the first asynchronous boundary. Navigation
	// advances the lifecycle generation once, but must not adopt another session.
	const manager = session.sessionManager;
	const managerId = manager.getSessionId();
	const file = manager.getSessionFile();
	const identity = manager.getSessionIdentityGeneration();
	const agent = session.agent;
	const generation = session.sessionLifecycle.generation;
	const target = manager.getEntry(entryId);
	if (target?.type !== "message" || target.message.role !== "user") throw new SdkRevisionError("invalid_input");
	if (!manager.getBranch().some(entry => entry.id === entryId)) throw new SdkRevisionError("resource_gone");
	const previousLeaf = manager.getLeafId();
	const before = new Set(manager.getEntries().map(entry => entry.id));
	const sameIdentity = () =>
		!session.sessionLifecycle.disposed &&
		session.sessionManager === manager &&
		session.sessionId === sessionId &&
		session.agent === agent &&
		manager.getSessionId() === managerId &&
		manager.getSessionFile() === file &&
		manager.getSessionIdentityGeneration() === identity;
	const current = () => {
		if (!sameIdentity() || session.sessionLifecycle.generation !== generation + 1)
			throw new SdkRevisionError("resource_gone");
		if (session.sessionLifecycle.transitioning) throw new SdkRevisionError("busy");
	};
	const unchanged = () => {
		const entries = manager.getEntries();
		return entries.length === before.size && entries.every(entry => before.has(entry.id));
	};

	let acceptedScope: AttemptScope | undefined;
	let terminal: "completed" | "paused" | "cancelled" | "maintenance" | undefined;
	let providerFailed = false;
	let replacementEntryId: string | undefined;
	let assistantEntryId: string | undefined;
	let terminalLeaf: string | null | undefined;
	let interfered = false;
	const unsubscribe = session.subscribe(event => {
		if (!sameIdentity() || !acceptedScope || !("scope" in event) || !event.scope || typeof event.scope !== "object")
			return;
		if (!attemptScopesEqual(event.scope, acceptedScope)) {
			if (event.type === "agent_start") interfered = true;
			return;
		}
		if (event.type === "message_end") {
			const id = getSessionMessageEntryId(event.message);
			if (id && event.message.role === "user" && replacementEntryId === undefined) replacementEntryId = id;
			if (id && event.message.role === "assistant") assistantEntryId = id;
		}
		if (event.type === "agent_end") {
			terminal = event.stopReason;
			terminalLeaf = manager.getLeafId();
		}
		if (event.type === "agent_failed") providerFailed = true;
	});
	revisions.add(session);
	try {
		try {
			const navigation = await session.navigateTree(entryId, { summarize: false });
			if (!sameIdentity()) throw new SdkRevisionError("resource_gone");
			if (navigation.cancelled) throw new SdkRevisionError("revision_cancelled");
			current();
			idle(session);
			if (manager.getLeafId() !== target.parentId || !unchanged()) throw new SdkRevisionError("resource_gone");

			await session.prompt(body, {
				// An edit is user text, not permission to execute a slash command.
				expandPromptTemplates: false,
				...(runtime.sdkRunCapability !== undefined ? { sdkRunCapability: runtime.sdkRunCapability } : {}),
				onRunAccepted: handle => {
					acceptedScope = handle.scope;
					terminal = undefined;
					terminalLeaf = undefined;
					providerFailed = false;
				},
				onPreflightAccepted: () => {
					current();
					// Native prompt admission may have waited behind another prompt.
					// Refuse rather than append this edit to that competing turn.
					if (
						manager
							.getBranch()
							.some(
								entry =>
									!before.has(entry.id) &&
									entry.type === "message" &&
									(entry.message.role === "user" || entry.message.role === "assistant"),
							)
					)
						throw new SdkRevisionError("busy");
				},
			});
			current();
			const completedLeaf = manager.getLeafId();
			const completedBranch = manager.getBranch().map(entry => entry.id);
			if (interfered || (terminalLeaf !== undefined && terminalLeaf !== completedLeaf))
				throw new SdkRevisionError("resource_gone");
			await session.awaitSessionSettlement();
			current();
			const settledBranch = manager.getBranch();
			if (
				interfered ||
				manager.getLeafId() !== completedLeaf ||
				settledBranch.length !== completedBranch.length ||
				settledBranch.some((entry, index) => entry.id !== completedBranch[index])
			)
				throw new SdkRevisionError("resource_gone");
			if (terminal === "cancelled") throw new SdkRevisionError("revision_cancelled");
			if (providerFailed) throw new SdkRevisionError("provider_failed");
			const branch = manager.getBranch();
			if (branch.some(entry => entry.id === entryId)) throw new SdkRevisionError("resource_gone");
			const replacement = branch.find(
				entry =>
					entry.id === replacementEntryId &&
					!before.has(entry.id) &&
					entry.type === "message" &&
					entry.message.role === "user",
			);
			const assistant = branch.find(
				entry =>
					entry.id === assistantEntryId &&
					!before.has(entry.id) &&
					entry.type === "message" &&
					entry.message.role === "assistant",
			);
			if (assistant?.type === "message" && assistant.message.role === "assistant") {
				if (assistant.message.stopReason === "error") throw new SdkRevisionError("provider_failed");
				if (assistant.message.stopReason === "aborted") throw new SdkRevisionError("revision_cancelled");
			} else {
				throw new SdkRevisionError("revision_not_applied");
			}
			if (!replacement || terminal !== "completed") throw new SdkRevisionError("revision_not_applied");
			return {
				sessionId,
				revised: true,
				entryId,
				replacementEntryId: replacement.id,
				assistantEntryId: assistant.id,
				status: "completed",
			};
		} catch (error) {
			// Never erase appended work, move a competing branch, or touch a successor.
			// includeTarget restores a previous user leaf exactly, not its editor parent.
			if (
				sameIdentity() &&
				session.sessionLifecycle.generation === generation + 1 &&
				!session.sessionLifecycle.transitioning &&
				!session.isRevisionControlBusy &&
				previousLeaf !== null &&
				manager.getLeafId() === target.parentId &&
				unchanged()
			) {
				try {
					const restored = await session.navigateTree(previousLeaf, { summarize: false, includeTarget: true });
					if (!sameIdentity()) throw new SdkRevisionError("resource_gone");
					if (restored.cancelled || manager.getLeafId() !== previousLeaf)
						throw new SdkRevisionError("revision_failed", true);
				} catch (restoreError) {
					if (!sameIdentity()) throw new SdkRevisionError("resource_gone");
					throw new SdkRevisionError(failure(restoreError).code, true);
				}
			}
			throw failure(error);
		}
	} finally {
		unsubscribe();
		revisions.delete(session);
	}
}
