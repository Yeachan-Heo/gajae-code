import { stablePathKey } from "@gajae-code/utils";
import type { Settings } from "../config/settings";

export function isBackgroundJobSupportEnabled(settings: Pick<Settings, "get">): boolean {
	void settings;
	return true;
}

/**
 * Single source of truth for the AsyncJobManager endpoint key.
 *
 * A session with an explicit provider session id is keyed by (provider id,
 * transcript path); everything else is keyed by its logical session id. The
 * transcript component uses a stable path key so a path
 * alias — symlink, casing difference on a case-insensitive Windows directory,
 * or `..` segment — cannot register the manager under one key at construction
 * and look it up under another across a session-identity transition,
 * stranding ownership. The key remains stable when a transcript is created or
 * atomically replaced, and case-sensitive Windows paths remain distinct.
 *
 * Both the SDK constructor and AgentSession's transition rekeying must derive
 * the key here; duplicating the shape lets the two drift apart silently.
 */
export function asyncJobEndpointId(
	providerSessionId: string | undefined,
	sessionId: string,
	sessionFile: string | undefined,
): string {
	return providerSessionId !== undefined && sessionFile !== undefined
		? JSON.stringify(["async-job-endpoint", providerSessionId, stablePathKey(sessionFile)])
		: sessionId;
}
