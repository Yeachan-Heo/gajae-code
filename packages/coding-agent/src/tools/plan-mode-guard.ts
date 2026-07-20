import * as path from "node:path";
import { resolveLocalUrlToPath } from "../internal-urls";
import type { ToolSession } from ".";
import { normalizeLocalScheme, resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const LOCAL_SCHEME_PREFIX = "local:";

function resolveRawPath(session: ToolSession, targetPath: string): string {
	const normalized = normalizeLocalScheme(targetPath);
	if (normalized.startsWith(LOCAL_SCHEME_PREFIX)) {
		return resolveLocalUrlToPath(normalized, {
			getArtifactsDir: session.getArtifactsDir,
			isManagedDestination: session.isManagedSessionDestination,
			getSessionId: session.getSessionId,
		});
	}

	return resolveToCwd(normalized, session.cwd);
}

/**
 * Resolve a write/edit target to its absolute filesystem path.
 *
 * In plan mode, transparently redirects targets whose basename matches the
 * plan file's basename (e.g. a bare `PLAN.md` or `./PLAN.md`) to the canonical
 * plan file location at `state.planFilePath`. This lets `write` and `edit`
 * accept the unqualified plan filename and have the change land at the
 * session-scoped `local://PLAN.md` artifact instead of a stray cwd-relative
 * file the plan-mode guard would otherwise reject.
 *
 * Outside plan mode (or when the basename does not match) this is a no-op.
 */
export function resolvePlanPath(session: ToolSession, targetPath: string): string {
	const resolved = resolveRawPath(session, targetPath);

	const state = session.getPlanModeState?.();
	if (!state?.enabled) return resolved;

	const planResolved = resolveRawPath(session, state.planFilePath);
	if (resolved === planResolved) return resolved;
	if (path.basename(resolved) !== path.basename(planResolved)) return resolved;

	return planResolved;
}

export function enforcePlanModeWrite(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	const state = session.getPlanModeState?.();
	if (!state?.enabled) return;

	const resolvedTarget = resolvePlanPath(session, targetPath);
	const resolvedPlan = resolvePlanPath(session, state.planFilePath);

	if (options?.move) {
		throw new ToolError("Plan mode: renaming files is not allowed.");
	}

	if (options?.op === "delete") {
		throw new ToolError("Plan mode: deleting files is not allowed.");
	}

	if (resolvedTarget !== resolvedPlan) {
		throw new ToolError(`Plan mode: only the plan file may be modified (${state.planFilePath}).`);
	}
}
