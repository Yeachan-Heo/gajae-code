import { canonicalSessionCwd, type SessionLocatorV2, sessionWorktreeRoot } from "./session-index";

export type ScopeNameV1 = "repo" | "pwd" | "global";

export type ScopeRequestV1 = {
	version: 1;
	requested: ScopeNameV1;
	requestAnchor: { cwd: string; worktreeRoot: string | null };
};

export type ResolvedScopeV1 = {
	version: 1;
	requested: ScopeNameV1;
	requestAnchor: { cwd: string; worktreeRoot: string | null };
	resolved:
		| { kind: "repo"; worktreeRoot: string }
		| { kind: "pwd"; cwd: string }
		| { kind: "global"; visibility: "current-broker" }
		| null;
	resolution: "resolved" | "not-in-git-worktree";
};

export type SdkSearchRowV1 = {
	id: string;
	locator: { cwd: string; worktreeRoot: string | null; stateRoot: string };
	live: boolean;
	probe?: "reachable" | "unreachable" | "stale";
};

export type SdkSearchResultV1 = {
	version: 1;
	scope: ResolvedScopeV1;
	status: "populated" | "empty" | "not-in-git-worktree" | "unavailable";
	observedAt: string;
	indexSeq?: number;
	rows: readonly SdkSearchRowV1[];
	cursor?: string;
	warnings: readonly string[];
	error?: { code: string; message: string };
};

export class ScopeRequestValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScopeRequestValidationError";
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Strictly validates the versioned request shape before canonical resolution. */
export function scopeRequestV1(value: unknown): ScopeRequestV1 | undefined {
	const request = record(value);
	const anchor = request === undefined ? undefined : record(request.requestAnchor);
	if (
		request?.version !== 1 ||
		(request.requested !== "repo" && request.requested !== "pwd" && request.requested !== "global") ||
		anchor === undefined ||
		typeof anchor.cwd !== "string" ||
		anchor.cwd.length === 0 ||
		(anchor.worktreeRoot !== null && (typeof anchor.worktreeRoot !== "string" || anchor.worktreeRoot.length === 0)) ||
		Object.keys(request).some(key => key !== "version" && key !== "requested" && key !== "requestAnchor") ||
		Object.keys(anchor).some(key => key !== "cwd" && key !== "worktreeRoot")
	)
		return undefined;
	return {
		version: 1,
		requested: request.requested,
		requestAnchor: { cwd: anchor.cwd, worktreeRoot: anchor.worktreeRoot },
	};
}

/** Strictly validates a resolved descriptor returned by Broker pages. */
export function resolvedScopeV1(value: unknown): ResolvedScopeV1 | undefined {
	const scope = record(value);
	if (!scope) return undefined;
	const request = scopeRequestV1({
		version: scope.version,
		requested: scope.requested,
		requestAnchor: scope.requestAnchor,
	});
	if (
		!request ||
		(scope.resolution !== "resolved" && scope.resolution !== "not-in-git-worktree") ||
		Object.keys(scope).some(
			key =>
				key !== "version" &&
				key !== "requested" &&
				key !== "requestAnchor" &&
				key !== "resolved" &&
				key !== "resolution",
		)
	)
		return undefined;
	const resolved = scope.resolved;
	if (resolved === null)
		return scope.resolution === "not-in-git-worktree" && request.requested === "repo"
			? { ...request, resolved: null, resolution: "not-in-git-worktree" }
			: undefined;
	const descriptor = record(resolved);
	if (!descriptor || scope.resolution !== "resolved") return undefined;
	if (
		request.requested === "repo" &&
		descriptor.kind === "repo" &&
		typeof descriptor.worktreeRoot === "string" &&
		Object.keys(descriptor).every(key => key === "kind" || key === "worktreeRoot")
	)
		return { ...request, resolved: { kind: "repo", worktreeRoot: descriptor.worktreeRoot }, resolution: "resolved" };
	if (
		request.requested === "pwd" &&
		descriptor.kind === "pwd" &&
		typeof descriptor.cwd === "string" &&
		Object.keys(descriptor).every(key => key === "kind" || key === "cwd")
	)
		return { ...request, resolved: { kind: "pwd", cwd: descriptor.cwd }, resolution: "resolved" };
	if (
		request.requested === "global" &&
		descriptor.kind === "global" &&
		descriptor.visibility === "current-broker" &&
		Object.keys(descriptor).every(key => key === "kind" || key === "visibility")
	)
		return { ...request, resolved: { kind: "global", visibility: "current-broker" }, resolution: "resolved" };
	return undefined;
}

/** Strictly validates a safe broker-search row. */
export function sdkSearchRowV1(value: unknown): SdkSearchRowV1 | undefined {
	const row = record(value);
	const locator = row === undefined ? undefined : record(row.locator);
	if (
		typeof row?.id !== "string" ||
		row.id.length === 0 ||
		(row.live !== true && row.live !== false) ||
		(row.probe !== undefined && row.probe !== "reachable" && row.probe !== "unreachable" && row.probe !== "stale") ||
		!locator ||
		typeof locator.cwd !== "string" ||
		(locator.worktreeRoot !== null && typeof locator.worktreeRoot !== "string") ||
		typeof locator.stateRoot !== "string" ||
		Object.keys(locator).some(key => key !== "cwd" && key !== "worktreeRoot" && key !== "stateRoot") ||
		Object.keys(row).some(key => key !== "id" && key !== "locator" && key !== "live" && key !== "probe")
	)
		return undefined;
	return {
		id: row.id,
		locator: { cwd: locator.cwd, worktreeRoot: locator.worktreeRoot, stateRoot: locator.stateRoot },
		live: row.live,
		...(row.probe === undefined ? {} : { probe: row.probe }),
	};
}

/** Strictly validates the aggregate credential-free search envelope. */
export function sdkSearchResultV1(value: unknown): SdkSearchResultV1 | undefined {
	const result = record(value);
	const scope = result === undefined ? undefined : resolvedScopeV1(result.scope);
	const cursor = typeof result?.cursor === "string" && result.cursor.length > 0 ? result.cursor : undefined;
	if (
		result?.version !== 1 ||
		!scope ||
		(result.status !== "populated" &&
			result.status !== "empty" &&
			result.status !== "not-in-git-worktree" &&
			result.status !== "unavailable") ||
		typeof result.observedAt !== "string" ||
		!Array.isArray(result.rows) ||
		!Array.isArray(result.warnings) ||
		result.rows.some(row => !sdkSearchRowV1(row)) ||
		(result.cursor !== undefined && cursor === undefined) ||
		result.warnings.some(warning => typeof warning !== "string") ||
		Object.keys(result).some(
			key =>
				key !== "version" &&
				key !== "scope" &&
				key !== "status" &&
				key !== "observedAt" &&
				key !== "indexSeq" &&
				key !== "rows" &&
				key !== "cursor" &&
				key !== "warnings" &&
				key !== "error",
		)
	)
		return undefined;
	if (result.status === "not-in-git-worktree" && (scope.resolved !== null || result.rows.length !== 0))
		return undefined;
	const error = record(result.error);
	if (
		result.status === "unavailable" &&
		(!error ||
			typeof error.code !== "string" ||
			typeof error.message !== "string" ||
			Object.keys(error).some(key => key !== "code" && key !== "message"))
	)
		return undefined;
	const indexSeq = typeof result.indexSeq === "number" ? result.indexSeq : undefined;
	if (result.indexSeq !== undefined && indexSeq === undefined) return undefined;
	if (indexSeq !== undefined && (!Number.isSafeInteger(indexSeq) || indexSeq < 0)) return undefined;
	return {
		version: 1,
		scope,
		status: result.status,
		observedAt: result.observedAt,
		...(indexSeq === undefined ? {} : { indexSeq }),
		rows: result.rows.map(row => sdkSearchRowV1(row)!),
		...(cursor === undefined ? {} : { cursor }),
		warnings: [...result.warnings],
		...(error === undefined ? {} : { error: { code: error.code as string, message: error.message as string } }),
	};
}

/** Resolves and validates an anchor against its canonical cwd worktree identity. */
export async function resolveScopeRequest(request: ScopeRequestV1): Promise<ResolvedScopeV1> {
	const cwd = await canonicalSessionCwd(request.requestAnchor.cwd);
	const worktreeRoot = await sessionWorktreeRoot(cwd);
	const suppliedWorktree =
		request.requestAnchor.worktreeRoot === null
			? null
			: await canonicalSessionCwd(request.requestAnchor.worktreeRoot);
	if (suppliedWorktree !== worktreeRoot)
		throw new ScopeRequestValidationError("scope request anchor does not match its canonical worktree identity");
	const requestAnchor = { cwd, worktreeRoot };
	if (request.requested === "global")
		return {
			version: 1,
			requested: request.requested,
			requestAnchor,
			resolved: { kind: "global", visibility: "current-broker" },
			resolution: "resolved",
		};
	if (request.requested === "pwd")
		return {
			version: 1,
			requested: request.requested,
			requestAnchor,
			resolved: { kind: "pwd", cwd },
			resolution: "resolved",
		};
	return worktreeRoot === null
		? { version: 1, requested: request.requested, requestAnchor, resolved: null, resolution: "not-in-git-worktree" }
		: {
				version: 1,
				requested: request.requested,
				requestAnchor,
				resolved: { kind: "repo", worktreeRoot },
				resolution: "resolved",
			};
}

export function scopeMatchesLocator(
	scope: ResolvedScopeV1,
	locator: Pick<SessionLocatorV2, "cwd" | "worktreeRoot">,
): boolean {
	if (scope.resolved === null) return false;
	if (scope.resolved.kind === "global") return true;
	if (scope.resolved.kind === "pwd") return locator.cwd === scope.resolved.cwd;
	return locator.worktreeRoot === scope.resolved.worktreeRoot;
}

export function searchRowV1(session: { sessionId: string; locator: SessionLocatorV2; live: boolean }): SdkSearchRowV1 {
	return {
		id: session.sessionId,
		locator: {
			cwd: session.locator.cwd,
			worktreeRoot: session.locator.worktreeRoot,
			stateRoot: session.locator.stateRoot,
		},
		live: session.live,
	};
}
