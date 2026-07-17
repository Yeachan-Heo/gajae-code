import { getAgentDir, getSessionsDir } from "@gajae-code/utils";
import {
	listManagedCandidates,
	type ManagedCandidate,
	type ManagedCandidateListing,
	type ManagedScope,
	type ManagedScopeResolution,
	resolveManagedScope,
} from "../session/internal/managed-session-scope";
import type { ResumeSessionIdentity } from "../session/session-manager";

/** Version of the supported readonly managed-session directory API. */
/** Broker-owned policy for managed-session migration decisions after scope validation. */
export type DirectoryMigrationPolicy = "copy-retain" | "disabled";
export const SESSION_DIRECTORY_API_VERSION = 1 as const;

/** A collision-resistant v2 managed-session scope for one canonical workspace identity. */
export interface ManagedSessionScope {
	readonly apiVersion: 1;
	readonly layoutVersion: 2;
	readonly identityVersion: 1;
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly canonicalCwd: string;
	readonly legacyLexicalCwd: string;
	readonly directoryName: string;
	readonly directoryPath: string;
}

export type ResolveManagedSessionScopeResult =
	| { kind: "resolved"; scope: ManagedSessionScope }
	| {
			kind: "error";
			code:
				| "cwd_missing"
				| "cwd_not_directory"
				| "identity_unavailable"
				| "network_unsupported"
				| "sessions_root_unavailable"
				| "binding_conflict"
				| "binding_invalid";
			message: string;
	  };

export interface LogicalSessionCandidate {
	readonly sessionId: string;
	readonly path: string;
	readonly cwd: string;
	readonly provenance: "v2" | "legacy";
	readonly identity: Readonly<ResumeSessionIdentity>;
	readonly migrationState: "native_v2" | "legacy_unmigrated" | "migrated_v2";
}

export type ListManagedSessionCandidatesResult =
	| {
			kind: "complete";
			scope: ManagedSessionScope;
			owned: readonly LogicalSessionCandidate[];
			foreignCount: number;
			invalid: readonly { code: string }[];
	  }
	| { kind: "error"; code: "scan_failed" | "unsafe_root" | "invalid_candidate"; message: string };

function toPublicScope(scope: ManagedScope): ManagedSessionScope {
	return {
		apiVersion: scope.apiVersion,
		layoutVersion: scope.layoutVersion,
		identityVersion: scope.identityVersion,
		agentDir: scope.agentDir,
		sessionsRoot: scope.sessionsRoot,
		canonicalCwd: scope.canonicalCwd,
		legacyLexicalCwd: scope.legacyLexicalCwd,
		directoryName: scope.directoryName,
		directoryPath: scope.directoryPath,
	};
}

function toPublicCandidate(candidate: ManagedCandidate): LogicalSessionCandidate {
	return {
		sessionId: candidate.sessionId,
		path: candidate.path,
		cwd: candidate.cwd,
		provenance: candidate.provenance,
		identity: { ...candidate.identity },
		migrationState: candidate.migrationState,
	};
}

function validatedPrivateScope(scope: ManagedSessionScope): ManagedScope | undefined {
	const resolved = resolveManagedScope({
		cwd: scope.legacyLexicalCwd,
		agentDir: scope.agentDir,
		sessionsRoot: scope.sessionsRoot,
	});
	if (resolved.kind !== "resolved") return undefined;
	const expected = toPublicScope(resolved.scope);
	return Object.entries(expected).every(([key, value]) => scope[key as keyof ManagedSessionScope] === value)
		? resolved.scope
		: undefined;
}

function toResolveResult(result: ManagedScopeResolution): ResolveManagedSessionScopeResult {
	return result.kind === "resolved" ? { kind: "resolved", scope: toPublicScope(result.scope) } : result;
}

function toListingResult(result: ManagedCandidateListing): ListManagedSessionCandidatesResult {
	if (result.kind === "error") return result;
	return {
		kind: "complete",
		scope: toPublicScope(result.scope),
		owned: result.owned.map(toPublicCandidate),
		foreignCount: result.foreignCount,
		invalid: result.invalid,
	};
}

/** Resolve a v2 scope without creating, migrating, or deleting session data. */
export async function resolveManagedSessionScope(input: {
	cwd: string;
	agentDir?: string;
	sessionsRoot?: string;
}): Promise<ResolveManagedSessionScopeResult> {
	const agentDir = input.agentDir ?? getAgentDir();
	return toResolveResult(
		resolveManagedScope({
			cwd: input.cwd,
			agentDir,
			sessionsRoot: input.sessionsRoot ?? getSessionsDir(agentDir),
		}),
	);
}

/** List readonly v2 and validated legacy candidates for an already resolved scope. */
export async function listManagedSessionCandidates(input: {
	scope: ManagedSessionScope;
}): Promise<ListManagedSessionCandidatesResult> {
	const scope = validatedPrivateScope(input.scope);
	if (!scope)
		return { kind: "error", code: "invalid_candidate", message: "The managed session scope is no longer valid." };
	return toListingResult(listManagedCandidates(scope));
}
