import type { PendingResumeOp } from "./resume-operation";
import type { SessionContext, SessionEntry, SessionManager, SessionTreeNode } from "./session-manager";

/**
 * Opaque capability for zero-copy session snapshots. This module is deliberately
 * excluded from package exports; only trusted in-package readers may use it.
 */
export const sessionManagerReadCapability: unique symbol = Symbol("SessionManager internal read capability");

/** Internal producer only: possession of the reservation does not grant ownership. */
export const nativeBranchSuccessorCapability: unique symbol = Symbol("SessionManager internal native branch successor");

export interface NativeBranchSuccessorOptions {
	readonly sourceOp: PendingResumeOp;
	readonly selectedEntryId: string;
	readonly reserve: (identity: {
		readonly role: "successor";
		readonly sessionId: string;
		readonly file: string;
	}) => Promise<void>;
	readonly signal?: AbortSignal;
}

export function prepareNativeBranchSuccessor(manager: SessionManager, options: NativeBranchSuccessorOptions) {
	return manager[nativeBranchSuccessorCapability](options);
}

export interface SessionManagerReadAccess {
	getEntries(): readonly SessionEntry[];
	getSessionContext(): Readonly<SessionContext>;
	getTree(): SessionTreeNode[];
}

type InternalReadSessionManager = SessionManager & {
	[sessionManagerReadCapability](): SessionManagerReadAccess;
};

function access(manager: SessionManager): SessionManagerReadAccess {
	return (manager as InternalReadSessionManager)[sessionManagerReadCapability]();
}

export function getEntriesForInternalRead(manager: SessionManager): readonly SessionEntry[] {
	return access(manager).getEntries();
}

export function getSessionContextForInternalRead(manager: SessionManager): Readonly<SessionContext> {
	return access(manager).getSessionContext();
}

export function getTreeForInternalRead(manager: SessionManager): SessionTreeNode[] {
	return access(manager).getTree();
}
