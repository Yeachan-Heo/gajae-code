/**
 * Shared helpers for internal-url protocol handlers that resolve session-scoped
 * artifact IDs.
 */
import * as path from "node:path";
import type { ResolveContext } from "./types";

function addDir(dirs: string[], dir: string | null | undefined): void {
	if (!dir) return;
	const normalized = path.resolve(dir);
	if (!dirs.includes(normalized)) dirs.push(normalized);
}

/**
 * Snapshot of artifacts dirs explicitly authorized for the calling session.
 *
 * Normal reads are scoped to the caller's artifacts directory. Parent/child
 * agent tree sharing is allowed only when the caller supplies explicit
 * authorized directories at the ResolveContext boundary. This intentionally
 * does not enumerate AgentRegistry.global(); live but unrelated sessions are
 * not an authorization source.
 */
export function authorizedArtifactsDirsFromContext(context?: ResolveContext): string[] {
	const dirs: string[] = [];
	addDir(dirs, context?.getArtifactsDir?.());
	for (const dir of context?.getAuthorizedArtifactsDirs?.() ?? []) addDir(dirs, dir);
	return dirs;
}
