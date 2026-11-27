import { canonicalSessionCwd, sessionWorktreeRoot } from "../sdk/broker/session-index";
import type { MasterScope } from "./context";
import { collectMasterPeerSnapshot, type MasterPeerSnapshotLifecycle, renderMasterPeerSnapshot } from "./snapshot";

export const MASTER_PEER_SNAPSHOT_CUSTOM_TYPE = "master-peer-snapshot";

export interface OwnerEndpointGenerationTracker {
	/** Host broker-registration callback; registrations of other sessions (after a switch) are ignored. */
	readonly record: (sessionId: string, endpointGeneration: number) => void;
	/** The owner's latest registered generation, else the startup (lifecycle rollback) one. */
	readonly get: () => number | undefined;
}

/**
 * Tracks the endpoint generation this process last registered for the master's
 * lineage owner session, so the peer snapshot can tell its own stale owner row
 * from another process that resumed the owner (#7459). The Broker issues each
 * registration of a session a fresh, higher generation
 * (`allocateSessionEventGeneration`), so a different generation is a different
 * host. The runtime reports every session it hosts across switches; only the
 * owner's registrations count.
 */
export function createOwnerEndpointGenerationTracker(
	ownerSessionId: string,
	getStartupGeneration: () => number | null | undefined,
): OwnerEndpointGenerationTracker {
	let latest: number | undefined;
	return {
		record: (sessionId, endpointGeneration) => {
			if (sessionId === ownerSessionId) latest = endpointGeneration;
		},
		get: () => latest ?? getStartupGeneration() ?? undefined,
	};
}

/** The injected message shape consumed by the agent-session contributor seam. */
export interface MasterPeerSnapshotMessage {
	customType: string;
	content: string;
	display: false;
	attribution: "agent";
}

export interface MasterPeerSnapshotContributorInput {
	readonly lifecycle: MasterPeerSnapshotLifecycle;
	readonly ownerSessionId: string;
	/** Current transcript/session identity; differs from ownerSessionId after a branch or switch. */
	readonly getSessionId?: () => string;
	/**
	 * Lazy accessor for the owner session's endpoint generation. Called at snapshot time,
	 * after the broker registration has recorded it. Used to distinguish between stale index
	 * data and a different process incarnation.
	 */
	readonly getOwnerEndpointGeneration?: () => number | undefined;
	readonly scope: MasterScope;
	/** Live cwd accessor; resolved at injection time, not at registration. */
	readonly getCwd: () => string;
	/**
	 * Whether a prior injection was persisted to the session branch. A persisted
	 * block proves a first request was accepted, so later turns never duplicate
	 * it; a pre-accept cancellation persists nothing and the next attempt
	 * re-collects a fresh snapshot.
	 */
	readonly hasPersistedInjection: () => boolean;
	readonly onError?: (error: unknown) => void;
}

/**
 * Builds the one-shot before-agent-start contributor that injects the scoped,
 * no-probe master peer snapshot immediately before the first accepted provider
 * request. Idle masters never collect: the snapshot is gathered only when a
 * prompt actually starts.
 */
export function createMasterPeerSnapshotContributor(
	input: MasterPeerSnapshotContributorInput,
): () => Promise<MasterPeerSnapshotMessage | undefined> {
	return async () => {
		try {
			if (input.hasPersistedInjection()) return undefined;
			const anchorCwd = await canonicalSessionCwd(input.getCwd());
			const snapshot = await collectMasterPeerSnapshot({
				lifecycle: input.lifecycle,
				actor: { id: input.ownerSessionId, namespace: "sdk:master-snapshot" },
				ownerSessionId: input.ownerSessionId,
				...(input.getSessionId === undefined ? {} : { currentSessionId: input.getSessionId() }),
				...(input.getOwnerEndpointGeneration === undefined
					? {}
					: { ownerEndpointGeneration: input.getOwnerEndpointGeneration() }),
				scope: input.scope,
				requestAnchor: { cwd: anchorCwd, worktreeRoot: await sessionWorktreeRoot(anchorCwd) },
			});
			return {
				customType: MASTER_PEER_SNAPSHOT_CUSTOM_TYPE,
				content: renderMasterPeerSnapshot(snapshot),
				display: false,
				attribution: "agent",
			};
		} catch (error) {
			input.onError?.(error);
			return undefined;
		}
	};
}
