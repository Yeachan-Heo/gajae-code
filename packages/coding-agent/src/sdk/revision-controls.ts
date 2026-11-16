import { type AttemptScope, attemptScopesEqual } from "@gajae-code/agent-core/attempt-scope";
import type { ImageContent } from "@gajae-code/ai/core";
import {
	type AgentSession,
	ExecutionSelectionError,
	type ExecutionSelectionPublication,
	type PromptOptions,
} from "../session/agent-session";
import { resumeDigest } from "../session/native-resume";
import { OWNER_ENROLL_CUSTOM_TYPE, RESUME_CURSOR_CUSTOM_TYPE } from "../session/resume-cursor";
import { getSessionMessageEntryId, type PendingResumeOp, type SessionManager } from "../session/session-manager";
import { PromptImageUploadStore, retirePromptImageReservation } from "./host/prompt-image-upload";
import { normalizeSdkRevisionInput, type SdkRevisionResult, validRevisionEntryId } from "./protocol/revision-contracts";

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
	onRunAccepted?: PromptOptions["onRunAccepted"];
	onPreflightAcceptCommit?: PromptOptions["onPreflightAcceptCommit"];
}

// Retain admission across navigation, normal prompt execution, and persistence.
// A replacement Host control object must not admit a second revision of this session.
const revisions = new WeakSet<AgentSession>();

/** Presentation metadata only; never authority to discover or open a transcript. */
export interface SdkSessionView {
	sessionId: string;
	leafEntryId: string | null;
}

function validSessionView(value: unknown): value is SdkSessionView {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const fields = Reflect.ownKeys(value);
	if (
		fields.length !== 2 ||
		!fields.includes("sessionId") ||
		!fields.includes("leafEntryId") ||
		!Object.hasOwn(Object.getOwnPropertyDescriptor(value, "sessionId") ?? {}, "value") ||
		!Object.hasOwn(Object.getOwnPropertyDescriptor(value, "leafEntryId") ?? {}, "value")
	)
		return false;
	const view = value as Record<string, unknown>;
	return (
		validRevisionEntryId(view.sessionId) &&
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(view.sessionId) &&
		(view.leafEntryId === null || validRevisionEntryId(view.leafEntryId))
	);
}

/** Capture only an idle, live cursor. Hosts persist this DTO, not inferred chronology. */
export function captureSessionView(session: AgentSession): SdkSessionView {
	if (revisions.has(session)) throw new SdkRevisionError("busy");
	idle(session);
	const manager = session.sessionManager;
	const view = { sessionId: session.sessionId, leafEntryId: manager.getLeafId() };
	if (!validSessionView(view) || (view.leafEntryId !== null && !manager.getEntry(view.leafEntryId)))
		throw new SdkRevisionError("resource_gone");
	return view;
}

/** Restore only within the supplied live session; never open, fork, append, or select a fallback. */
export async function restoreSessionView(session: AgentSession, view: SdkSessionView): Promise<SdkSessionView> {
	if (!validSessionView(view)) throw new SdkRevisionError("invalid_input");
	const { sessionId, leafEntryId } = view;
	if (session.sessionId !== sessionId) throw new SdkRevisionError("resource_gone");
	if (revisions.has(session)) throw new SdkRevisionError("busy");
	idle(session);
	const manager = session.sessionManager;
	const agent = session.agent;
	const file = manager.getSessionFile();
	const identity = manager.getSessionIdentityGeneration();
	const generation = session.sessionLifecycle.generation;
	const previousLeaf = manager.getLeafId();
	const managerId = manager.getSessionId();
	const before = manager.revisionSnapshot();
	if (leafEntryId !== null && !manager.getEntry(leafEntryId)) throw new SdkRevisionError("resource_gone");
	const changes = previousLeaf === leafEntryId ? 0 : 1;
	revisions.add(session);
	try {
		await session.restoreTreeLeaf(leafEntryId);
		const after = manager.revisionSnapshot();
		if (
			session.sessionLifecycle.disposed ||
			session.sessionManager !== manager ||
			session.agent !== agent ||
			session.sessionId !== sessionId ||
			manager.getSessionId() !== managerId ||
			manager.getSessionFile() !== file ||
			manager.getSessionIdentityGeneration() !== identity ||
			session.sessionLifecycle.generation !== generation + changes ||
			session.sessionLifecycle.transitioning ||
			manager.getLeafId() !== leafEntryId ||
			(leafEntryId !== null && !manager.getEntry(leafEntryId)) ||
			after.entry !== before.entry ||
			after.leaf !== before.leaf + changes ||
			after.headerExport !== before.headerExport ||
			after.label !== before.label ||
			after.replayMetadata !== before.replayMetadata
		)
			throw new SdkRevisionError("resource_gone");
		idle(session);
		return { sessionId, leafEntryId };
	} catch (error) {
		const rollbackFailed =
			!!error && typeof error === "object" && "rollbackFailed" in error && error.rollbackFailed === true;
		throw new SdkRevisionError(failure(error).code, rollbackFailed);
	} finally {
		revisions.delete(session);
	}
}

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
	const previousMessages = agent.state.messages.slice();
	const beforeRevision = manager.revisionSnapshot();
	const before = new Map(manager.getEntries().map(entry => [entry.id, JSON.stringify(entry)]));
	// One immutable identity per selected operation, including all cursor chunks.
	const selectionOp = crypto.randomUUID();
	const ownedSelectionEntries = new Map<string, string>();
	let selectionStaged = false;
	let selectionCommitted = false;
	let executionLeaf = target.parentId;
	const accountSelectionManifest = (pending: PendingResumeOp, selectedTarget: string | null) => {
		const plannedIds = [...(pending.plan.enroll === null ? [] : [pending.plan.enroll]), ...pending.plan.cursorIds];
		const additions = manager.getEntries().slice(before.size);
		if (
			selectionStaged ||
			pending.plan.target !== selectedTarget ||
			!pending.plan.selectionRequested ||
			pending.plan.dependentIds.length !== 0 ||
			pending.g0.entryRevision0 !== beforeRevision.entry ||
			pending.CB !== (pending.plan.cursorIds.at(-1) ?? selectedTarget) ||
			pending.manifest.length !== plannedIds.length ||
			additions.length !== plannedIds.length
		)
			throw new SdkRevisionError("resource_gone");
		const selectedEntries = new Map<string, string>();
		for (const [index, item] of pending.manifest.entries()) {
			const entry = additions[index];
			const enroll = item.id === pending.plan.enroll;
			const cursorIndex = index - (pending.plan.enroll === null ? 0 : 1);
			if (
				!entry ||
				item.id !== plannedIds[index] ||
				item.order !== index ||
				item.id !== entry.id ||
				item.parentId !== entry.parentId ||
				item.payloadDigest !== resumeDigest(JSON.stringify(entry)) ||
				before.has(item.id) ||
				selectedEntries.has(item.id) ||
				entry.type !== "custom" ||
				item.kind !== (enroll ? "enroll" : "cursor") ||
				entry.customType !== (enroll ? OWNER_ENROLL_CUSTOM_TYPE : RESUME_CURSOR_CUSTOM_TYPE) ||
				(!enroll &&
					item.parentId !== (cursorIndex === 0 ? selectedTarget : pending.plan.cursorIds[cursorIndex - 1]))
			)
				throw new SdkRevisionError("resource_gone");
			selectedEntries.set(item.id, JSON.stringify(entry));
		}
		for (const [id, entry] of selectedEntries) ownedSelectionEntries.set(id, entry);
		selectionStaged = true;
		return pending.CB;
	};
	const accountSelection = (publication: ExecutionSelectionPublication | undefined, selectedTarget: string | null) => {
		if (!publication) return selectedTarget;
		const { pending, result } = publication;
		if (
			result.receipt.op !== pending.op ||
			!result.receipt.commitment.operationComplete ||
			!result.receipt.commitment.continueEligible
		)
			throw new SdkRevisionError("resource_gone");
		const leaf = accountSelectionManifest(pending, selectedTarget);
		selectionCommitted = true;
		return leaf;
	};
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
		const revision = manager.revisionSnapshot();
		return (
			entries.length === before.size + ownedSelectionEntries.size &&
			entries.every(
				entry => (before.get(entry.id) ?? ownedSelectionEntries.get(entry.id)) === JSON.stringify(entry),
			) &&
			revision.entry === beforeRevision.entry + ownedSelectionEntries.size &&
			revision.headerExport === beforeRevision.headerExport &&
			revision.label === beforeRevision.label &&
			revision.replayMetadata === beforeRevision.replayMetadata
		);
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
			const assertNavigationCurrent = () => {
				if (
					!sameIdentity() ||
					session.sessionLifecycle.generation !== generation ||
					manager.getLeafId() !== previousLeaf ||
					manager.revisionSnapshot().leaf !== beforeRevision.leaf ||
					!unchanged()
				)
					throw new SdkRevisionError("resource_gone");
			};
			navigationStarted = true;
			if (leafToSelect) {
				const navigation = await session.navigateTree(leafToSelect, {
					includeTarget: true,
					summarize: false,
					beforeExecutionCommit: assertNavigationCurrent,
				});
				if (!sameIdentity()) throw new SdkRevisionError("resource_gone");
				if (navigation.cancelled) throw new SdkRevisionError("revision_cancelled");
				const selectedLeaf = accountSelection(navigation.executionSelection, leafToSelect);
				if (selectedLeaf === null) throw new SdkRevisionError("resource_gone");
				// Selecting the already active leaf is a native no-op (no generation commit).
				const expectedGeneration = generation + (previousLeaf === leafToSelect ? 0 : 1);
				if (
					session.sessionLifecycle.generation !== expectedGeneration ||
					session.sessionLifecycle.transitioning ||
					manager.getLeafId() !== selectedLeaf ||
					manager.revisionSnapshot().leaf !== beforeRevision.leaf + (previousLeaf === leafToSelect ? 0 : 1) ||
					!unchanged() ||
					!answeredBranch(manager, entryId, selectedLeaf)
				)
					throw new SdkRevisionError("resource_gone");
				idle(session);
				return { selected: true, status: "selected", sessionId, entryId, leafEntryId: selectedLeaf };
			}
			const navigation = await session.prepareTreeEdit(entryId, { beforeExecutionCommit: assertNavigationCurrent });
			if (!sameIdentity()) throw new SdkRevisionError("resource_gone");
			if (navigation.cancelled) throw new SdkRevisionError("revision_cancelled");
			current();
			idle(session);
			if (
				manager.getLeafId() !== target.parentId ||
				manager.revisionSnapshot().leaf !== beforeRevision.leaf + 1 ||
				!unchanged()
			)
				throw new SdkRevisionError("resource_gone");

			const assertPreflightCurrent = () => {
				current();
				if (
					manager.getLeafId() !== executionLeaf ||
					manager.revisionSnapshot().leaf !== beforeRevision.leaf + 1 + (selectionCommitted ? 1 : 0) ||
					!unchanged()
				)
					throw new SdkRevisionError("resource_gone");
			};
			const onPreflightAcceptCommit = runtime.onPreflightAcceptCommit;
			await session.prompt(request.body ?? "", {
				...(imageReservation ? { images: imageReservation.images } : {}),
				// An edit is user text, not permission to execute a slash command.
				expandPromptTemplates: false,
				...(runtime.sdkRunCapability !== undefined ? { sdkRunCapability: runtime.sdkRunCapability } : {}),
				onPreflightAcceptCommit: async () => {
					assertPreflightCurrent();
					await onPreflightAcceptCommit?.();
					assertPreflightCurrent();
					const publication = await session.selectExecutionBranchDurably(
						target.parentId,
						selectionOp,
						assertPreflightCurrent,
					);
					if (!sameIdentity() || (publication && publication.pending.op !== selectionOp))
						throw new SdkRevisionError("resource_gone");
					executionLeaf = accountSelection(publication, target.parentId);
					assertPreflightCurrent();
				},
				onRunAccepted: handle => {
					acceptedScope = handle.scope;
					imageRunId = String(handle.logicalRunId);
					terminal = undefined;
					terminalLeaf = undefined;
					providerFailed = false;
					return runtime.onRunAccepted?.(handle);
				},
				onPreflightAccepted: assertPreflightCurrent,
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
			// A refused selection retains its immutable operation. Account only that exact
			// manifest so presentation rollback cannot mistake a competing append for ours.
			let rollbackLeafChanges = 1;
			if (error instanceof ExecutionSelectionError && error.pending.op === selectionOp) {
				if (!sameIdentity()) throw new SdkRevisionError("resource_gone");
				accountSelectionManifest(error.pending, target.parentId);
				// Edit preparation, staged selection, then presentation-only refusal restore.
				rollbackLeafChanges = 3;
				if (
					session.sessionLifecycle.generation !== generation + 1 ||
					session.sessionLifecycle.transitioning ||
					manager.getLeafId() !== target.parentId ||
					manager.revisionSnapshot().leaf !== beforeRevision.leaf + rollbackLeafChanges ||
					!unchanged()
				)
					throw new SdkRevisionError("resource_gone");
			}
			// Never erase appended work, move a competing branch, or touch a successor.
			// Exact restoration includes a user leaf or empty root without running tree hooks.
			if (
				navigationStarted &&
				!selectionCommitted &&
				sameIdentity() &&
				session.sessionLifecycle.generation === generation + 1 &&
				!session.sessionLifecycle.transitioning &&
				!session.isRevisionControlBusy &&
				manager.getLeafId() === (leafToSelect ?? target.parentId) &&
				manager.revisionSnapshot().leaf === beforeRevision.leaf + rollbackLeafChanges &&
				unchanged()
			) {
				try {
					await session.restoreTreeLeaf(previousLeaf, { messages: previousMessages });
					if (!sameIdentity()) throw new SdkRevisionError("resource_gone");
					if (
						session.sessionLifecycle.generation !== generation + 2 ||
						session.sessionLifecycle.transitioning ||
						manager.getLeafId() !== previousLeaf ||
						manager.revisionSnapshot().leaf !== beforeRevision.leaf + rollbackLeafChanges + 1 ||
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
