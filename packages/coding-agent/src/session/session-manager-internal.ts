import type { OwnerMembership } from "./owner-group";
import type { PendingResumeOp } from "./resume-operation";
import type {
	NativeForkAdmissionEvidence,
	SessionContext,
	SessionEntry,
	SessionManager,
	SessionTreeNode,
	StrictSessionOpenFailure,
} from "./session-manager";
import type { SessionNoReplacePublicationReceipt } from "./session-storage";

/**
 * Opaque capability for zero-copy session snapshots. This module is deliberately
 * excluded from package exports; only trusted in-package readers may use it.
 */
export const sessionManagerReadCapability: unique symbol = Symbol("SessionManager internal read capability");

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

export type NativeCapturedForkResult =
	| {
			kind: "native_forked";
			manager: SessionManager;
			membership: OwnerMembership;
			pending: PendingResumeOp;
			receipt: SessionNoReplacePublicationReceipt;
	  }
	| { kind: "native_fork_admission_retained"; evidence: NativeForkAdmissionEvidence }
	| {
			kind: "native_fork_retained";
			manager: SessionManager;
			membership: OwnerMembership;
			pending: PendingResumeOp;
			/** Historical no-replace receipt, not authority to continue or adopt the fork. */
			receipt?: SessionNoReplacePublicationReceipt;
			proven: boolean;
			error: Error;
	  }
	| StrictSessionOpenFailure;

type NativeBranchSuccessor = (
	manager: SessionManager,
	options: NativeBranchSuccessorOptions,
) => Promise<NativeCapturedForkResult>;

let prepareSuccessor: NativeBranchSuccessor | undefined;

/** Register the private producer without putting a callable capability on the manager's prototype. */
export function bindNativeBranchSuccessor(prepare: NativeBranchSuccessor): void {
	if (prepareSuccessor) throw new Error("Native branch successor preparation is already bound");
	prepareSuccessor = prepare;
}

export function prepareNativeBranchSuccessor(
	manager: SessionManager,
	options: NativeBranchSuccessorOptions,
): Promise<NativeCapturedForkResult> {
	if (!prepareSuccessor) throw new Error("Native branch successor preparation is unavailable");
	return prepareSuccessor(manager, options);
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
