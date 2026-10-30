import {
	type ResolvedScopeV1,
	resolveScopeRequest,
	type ScopeNameV1,
	type ScopeRequestV1,
	type SdkSearchResultV1,
	type SdkSearchRowV1,
	sdkSearchResultV1,
} from "../sdk/broker/session-scope";
import type { SessionLifecycleActor, SessionListOutcome, SessionListRequest } from "../sdk/lifecycle/service";

export type MasterPeerSnapshot = {
	readonly status: SdkSearchResultV1["status"];
	readonly scope: ResolvedScopeV1;
	readonly observedAt: string;
	readonly indexSeq?: number;
	readonly rows: readonly SdkSearchRowV1[];
	readonly truncated?: boolean;
};

const MASTER_PEER_SNAPSHOT_MAX_ROWS = 256;
const MASTER_PEER_SNAPSHOT_MAX_BYTES = 64 * 1024;

/** The scoped Broker surface needed for the one-time master peer snapshot. */
export interface MasterPeerSnapshotLifecycle {
	list(request: Omit<SessionListRequest, "operation">): Promise<SessionListOutcome>;
}

export interface CollectMasterPeerSnapshotInput {
	readonly lifecycle: MasterPeerSnapshotLifecycle;
	readonly actor: SessionLifecycleActor;
	readonly ownerSessionId: string;
	readonly currentSessionId?: string;
	readonly scope: ScopeNameV1;
	readonly requestAnchor: ScopeRequestV1["requestAnchor"];
	readonly timeoutMs?: number;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Orders by session ID, then the complete canonical locator as a deterministic
 * tie-breaker. The Broker's `live` value is index evidence, not a fresh probe.
 */
function compareRows(left: SdkSearchRowV1, right: SdkSearchRowV1): number {
	const id = compareText(left.id, right.id);
	if (id !== 0) return id;
	const cwd = compareText(left.locator.cwd, right.locator.cwd);
	if (cwd !== 0) return cwd;
	const worktreeRoot = compareText(left.locator.worktreeRoot ?? "", right.locator.worktreeRoot ?? "");
	if (worktreeRoot !== 0) return worktreeRoot;
	return compareText(left.locator.stateRoot, right.locator.stateRoot);
}

function unavailableSnapshot(scope: ResolvedScopeV1): MasterPeerSnapshot {
	return {
		status: "unavailable",
		scope,
		observedAt: new Date().toISOString(),
		rows: [],
	};
}

function matchesResolvedScope(left: ResolvedScopeV1, right: ResolvedScopeV1): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Retains a row prefix only when its final escaped prompt block fits the budget. */
function boundSnapshotRows(
	snapshot: Omit<MasterPeerSnapshot, "rows" | "truncated">,
	rows: readonly SdkSearchRowV1[],
): {
	rows: readonly SdkSearchRowV1[];
	truncated: boolean;
} {
	const retained: SdkSearchRowV1[] = [];
	for (const [index, row] of rows.entries()) {
		if (retained.length >= MASTER_PEER_SNAPSHOT_MAX_ROWS) return { rows: retained, truncated: true };

		retained.push(row);
		const willTruncate = index < rows.length - 1;
		const candidate: MasterPeerSnapshot = {
			...snapshot,
			rows: retained,
			...(willTruncate ? { truncated: true } : {}),
		};
		if (Buffer.byteLength(renderMasterPeerSnapshot(candidate), "utf8") > MASTER_PEER_SNAPSHOT_MAX_BYTES) {
			retained.pop();
			return { rows: retained, truncated: true };
		}
		if (willTruncate && retained.length === MASTER_PEER_SNAPSHOT_MAX_ROWS) return { rows: retained, truncated: true };
	}
	return { rows: retained, truncated: false };
}

/**
 * Collects the first-request peer snapshot through scoped Broker session.list.
 * It deliberately has no Router or endpoint-probe dependency.
 */
export async function collectMasterPeerSnapshot(input: CollectMasterPeerSnapshotInput): Promise<MasterPeerSnapshot> {
	const request: ScopeRequestV1 = {
		version: 1,
		requested: input.scope,
		requestAnchor: input.requestAnchor,
	};
	const resolvedScope = await resolveScopeRequest(request);
	const outcome = await input.lifecycle.list({
		actor: input.actor,
		capability: "session.list",
		target: { scope: request },
		...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
	});
	const result = sdkSearchResultV1(outcome.result);
	if (!result || !matchesResolvedScope(result.scope, resolvedScope)) return unavailableSnapshot(resolvedScope);
	const snapshot: Omit<MasterPeerSnapshot, "rows" | "truncated"> = {
		status: result.status,
		scope: result.scope,
		observedAt: result.observedAt,
		...(result.indexSeq === undefined ? {} : { indexSeq: result.indexSeq }),
	};
	const rows = result.rows
		.filter(row => row.id !== (input.currentSessionId ?? input.ownerSessionId))
		.sort(compareRows);
	const bounded = boundSnapshotRows(snapshot, rows);
	return {
		...snapshot,
		rows: bounded.rows,
		...(bounded.truncated ? { truncated: true } : {}),
	};
}

/** Escapes untrusted metadata before it is placed in fixed prompt framing. */
export function escapeMasterPeerSnapshotText(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (code === 38 || code === 60 || code === 62 || code === 96) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const character = input[index];
		if (character === "&") output += "&amp;";
		else if (character === "<") output += "&lt;";
		else if (character === ">") output += "&gt;";
		else if (character === "`") output += "&#96;";
		else output += character;
	}
	return output;
}

function escapeOptionalText(input: string | null): string | null {
	return input === null ? null : escapeMasterPeerSnapshotText(input);
}

function renderedScope(scope: ResolvedScopeV1): ResolvedScopeV1 {
	const resolved =
		scope.resolved === null
			? null
			: scope.resolved.kind === "repo"
				? { kind: "repo" as const, worktreeRoot: escapeMasterPeerSnapshotText(scope.resolved.worktreeRoot) }
				: scope.resolved.kind === "pwd"
					? { kind: "pwd" as const, cwd: escapeMasterPeerSnapshotText(scope.resolved.cwd) }
					: { kind: "global" as const, visibility: scope.resolved.visibility };
	return {
		version: scope.version,
		requested: escapeMasterPeerSnapshotText(scope.requested) as ScopeNameV1,
		requestAnchor: {
			cwd: escapeMasterPeerSnapshotText(scope.requestAnchor.cwd),
			worktreeRoot: escapeOptionalText(scope.requestAnchor.worktreeRoot),
		},
		resolved,
		resolution: escapeMasterPeerSnapshotText(scope.resolution) as ResolvedScopeV1["resolution"],
	};
}

function renderedRows(rows: readonly SdkSearchRowV1[]): readonly SdkSearchRowV1[] {
	return rows.map(row => ({
		id: escapeMasterPeerSnapshotText(row.id),
		locator: {
			cwd: escapeMasterPeerSnapshotText(row.locator.cwd),
			worktreeRoot: escapeOptionalText(row.locator.worktreeRoot),
			stateRoot: escapeMasterPeerSnapshotText(row.locator.stateRoot),
		},
		live: row.live,
	}));
}

/** Renders the fixed, escaped prompt block for one master peer observation. */
export function renderMasterPeerSnapshot(snapshot: MasterPeerSnapshot): string {
	const content = {
		scope: renderedScope(snapshot.scope),
		observedAt: escapeMasterPeerSnapshotText(snapshot.observedAt),
		...(snapshot.indexSeq === undefined ? {} : { indexSeq: snapshot.indexSeq }),
		...(snapshot.truncated === undefined ? {} : { truncated: snapshot.truncated }),
		rows: renderedRows(snapshot.rows),
	};
	return `<gjc-master-peer-snapshot>\nstatus: ${escapeMasterPeerSnapshotText(snapshot.status)}\n${JSON.stringify(content)}\n</gjc-master-peer-snapshot>`;
}
