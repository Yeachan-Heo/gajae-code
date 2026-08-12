import * as path from "node:path";
import { resolveEquivalentPath } from "@gajae-code/utils";
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
 * transcript component is canonicalized so a path alias — symlink, `..`
 * segment, or unresolved relative path — cannot register the manager under one
 * key at construction and look it up under another across a session-identity
 * transition, stranding ownership.
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
		? JSON.stringify(["async-job-endpoint", providerSessionId, resolveEquivalentPath(path.resolve(sessionFile))])
		: sessionId;
}
