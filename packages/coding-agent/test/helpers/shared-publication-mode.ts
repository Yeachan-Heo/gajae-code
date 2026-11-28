import { vi } from "bun:test";
import type { SessionManager } from "../../src/session/session-manager";

/**
 * Route `manager`'s AgentSession through the shared-publication layer for every session it holds,
 * as the removed root-TUI flag did: the funnel's one remaining entry, a session that already
 * requires shared admission, reports true. Since single-owner step 10a no production writer enters
 * the layer (every session, root TUI included, writes on the legacy route), so the suites that call
 * this cover the layer's internals only until steps 10b-10e delete it, and go with it. The caller's
 * `vi.restoreAllMocks()` ends it.
 */
export function routeThroughSharedPublication(manager: SessionManager): void {
	vi.spyOn(manager, "requiresSharedMutationAdmission").mockReturnValue(true);
}
