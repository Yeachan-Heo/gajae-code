import type { SessionContext, SessionEntry, SessionManager, SessionTreeNode } from "./session-manager";

/**
 * Opaque capability for zero-copy session snapshots. This module is deliberately
 * excluded from package exports; only trusted in-package readers may use it.
 */
export const sessionManagerReadCapability: unique symbol = Symbol("SessionManager internal read capability");

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
