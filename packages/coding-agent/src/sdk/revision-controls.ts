import { type AttemptScope, attemptScopesEqual } from "@gajae-code/agent-core/attempt-scope";
import type { ImageContent } from "@gajae-code/ai/core";
import type { AgentSession } from "../session/agent-session";
import { getSessionMessageEntryId, type SessionManager } from "../session/session-manager";
import { PromptImageUploadStore, retirePromptImageReservation } from "./host/prompt-image-upload";
import { normalizeSdkRevisionInput, type SdkRevisionResult } from "./protocol/revision-contracts";

export { SDK_REVISION_MAX_BODY_CHARS, type SdkRevisionResult } from "./protocol/revision-contracts";

export type SdkRevisionErrorCode =
	| "invalid_input"
	| "busy"
	| "resource_gone"
	| "revision_cancelled"
	| "revision_not_applied"
	| "revision_failed"
	| "provider_failed";

const ERROR_MESSAGES: Record<SdkRevisionErrorCode, string> = {
	invalid_input: "Revision requires valid session and prompt IDs, and either a selection or bounded text and images.",
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

/** Host-owned options, never read from the public operation's input. */
export interface SdkRevisionRuntimeOptions {
	sdkRunCapability?: unknown;
}

// Retain admission across navigation, normal prompt execution, and persistence.
// A replacement Host control object must not admit a second revision of this session.
const revisions = new WeakSet<AgentSession>();

// Manager ownership prevents a successor session from inheriting remembered branches.
const rememberedLeaves = new WeakMap<SessionManager, { identity: number; leaves: Map<string, string> }>();
const MAX_REMEMBERED_PROMPTS = 4096;

function branchLeaves(manager: SessionManager): Map<string, string> {
	let state = rememberedLeaves.get(manager);
	const identity = manager.getSessionIdentityGeneration();
	if (!state || state.identity !== identity) {
		state = { identity, leaves: new Map() };
		rememberedLeaves.set(manager, state);
	}
	return state.leaves;
}

function rememberBranch(manager: SessionManager): void {
	const leaf = manager.getLeafId();
	if (!leaf) return;
	const leaves = branchLeaves(manager);
	for (const entry of manager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		leaves.delete(entry.id);
		leaves.set(entry.id, leaf);
		if (leaves.size > MAX_REMEMBERED_PROMPTS) leaves.delete(leaves.keys().next().value!);
	}
}

function selectionLeaf(manager: SessionManager, entryId: string): string {
	const remembered = branchLeaves(manager).get(entryId);
	if (remembered && manager.getEntry(remembered) && manager.getBranch(remembered).some(entry => entry.id === entryId))
		return remembered;
	const visited = new Set<string>();
	let current = entryId;
	while (!visited.has(current)) {
		visited.add(current);
		// Archived PromptRevisions semantics: newest direct child by timestamp,
		// retaining manager order for ties and unreadable timestamps.
		const next = manager
			.getChildren(current)
			.map((entry, order) => ({ entry, order, time: Date.parse(entry.timestamp) }))
			.sort((left, right) => {
				const elapsed = left.time - right.time;
				return (Number.isNaN(elapsed) ? 0 : elapsed) || left.order - right.order;
			})
			.at(-1)?.entry;
		if (!next) break;
		current = next.id;
	}
	return current;
}

function answeredBranch(manager: SessionManager, entryId: string, leaf: string): boolean {
	const branch = manager.getBranch(leaf);
	const index = branch.findIndex(entry => entry.id === entryId);
	return (
		index >= 0 &&
		branch.slice(index + 1).some(entry => entry.type === "message" && entry.message.role === "assistant")
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
	if (code === "busy" || code === "resource_gone" || code === "invalid_input") return new SdkRevisionError(code);
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
	const request = normalizeSdkRevisionInput(input);
	if (!request) throw new SdkRevisionError("invalid_input");
	const { sessionId, entryId } = request;
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
	if (request.action !== "select" && !manager.getBranch().some(entry => entry.id === entryId))
		throw new SdkRevisionError("resource_gone");
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

	rememberBranch(manager);
	const leafToSelect = request.action === "select" ? selectionLeaf(manager, entryId) : undefined;
	if (leafToSelect && !answeredBranch(manager, entryId, leafToSelect)) throw new SdkRevisionError("invalid_input");
	let imageReservation: { images: ImageContent[]; release: () => void } | undefined;
	let imageRunId: string | undefined;
	let navigationStarted = false;
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
			if (request.action !== "select" && request.images) {
				if (session.settings.get("images.blockImages") || !session.model?.input.includes("image"))
					throw new SdkRevisionError("invalid_input");
				const imageModel = session.model;
				const autoResize = session.settings.get("images.autoResize");
				const store = new PromptImageUploadStore(() => sameIdentity(), session);
				try {
					imageReservation = await store.prepareCanonicalImages("sdk-revision", request.images, { autoResize });
				} finally {
					store.close();
				}
				if (
					!sameIdentity() ||
					session.sessionLifecycle.generation !== generation ||
					manager.getLeafId() !== previousLeaf ||
					!unchanged()
				)
					throw new SdkRevisionError("resource_gone");
				if (
					session.model !== imageModel ||
					session.settings.get("images.autoResize") !== autoResize ||
					session.settings.get("images.blockImages")
				)
					throw new SdkRevisionError("busy");
				idle(session);
			}
			navigationStarted = true;
			if (leafToSelect) {
				const navigation = await session.navigateTree(leafToSelect, { includeTarget: true, summarize: false });
				if (!sameIdentity()) throw new SdkRevisionError("resource_gone");
				if (navigation.cancelled) throw new SdkRevisionError("revision_cancelled");
				// Selecting the already active leaf is a native no-op (no generation commit).
				const expectedGeneration = generation + (previousLeaf === leafToSelect ? 0 : 1);
				if (
					session.sessionLifecycle.generation !== expectedGeneration ||
					session.sessionLifecycle.transitioning ||
					manager.getLeafId() !== leafToSelect ||
					!unchanged() ||
					!answeredBranch(manager, entryId, leafToSelect)
				)
					throw new SdkRevisionError("resource_gone");
				idle(session);
				return { selected: true, status: "selected", sessionId, entryId, leafEntryId: leafToSelect };
			}
			const navigation = await session.navigateTree(entryId, { summarize: false });
			if (!sameIdentity()) throw new SdkRevisionError("resource_gone");
			if (navigation.cancelled) throw new SdkRevisionError("revision_cancelled");
			current();
			idle(session);
			if (manager.getLeafId() !== target.parentId || !unchanged()) throw new SdkRevisionError("resource_gone");

			await session.prompt(request.body ?? "", {
				...(imageReservation ? { images: imageReservation.images } : {}),
				// An edit is user text, not permission to execute a slash command.
				expandPromptTemplates: false,
				...(runtime.sdkRunCapability !== undefined ? { sdkRunCapability: runtime.sdkRunCapability } : {}),
				onRunAccepted: handle => {
					acceptedScope = handle.scope;
					imageRunId = String(handle.logicalRunId);
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
				navigationStarted &&
				sameIdentity() &&
				session.sessionLifecycle.generation === generation + 1 &&
				!session.sessionLifecycle.transitioning &&
				!session.isRevisionControlBusy &&
				previousLeaf !== null &&
				manager.getLeafId() === (leafToSelect ?? target.parentId) &&
				unchanged()
			) {
				try {
					const restored = await session.navigateTree(previousLeaf, { summarize: false, includeTarget: true });
					if (!sameIdentity()) throw new SdkRevisionError("resource_gone");
					if (
						session.sessionLifecycle.generation !== generation + 2 ||
						session.sessionLifecycle.transitioning ||
						restored.cancelled ||
						manager.getLeafId() !== previousLeaf ||
						!unchanged()
					)
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
		if (imageReservation) {
			if (imageRunId)
				retirePromptImageReservation(
					imageRunId,
					id => agent.resourceLedger.waitForSettlement(id, { graceMs: null }),
					() => true,
					imageReservation.release,
				);
			else imageReservation.release();
		}
	}
}
