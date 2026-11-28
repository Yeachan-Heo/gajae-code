import { afterAll, beforeAll } from "bun:test";
import { SessionOwnershipTestHooks } from "../../src/session/session-ownership";

/**
 * Run this file's cases in session ownership `observe`. They cover the shared-publication layer
 * that a root interactive session uses below `enforce`; under `enforce` a sole-owner root session
 * takes the legacy route instead (single-owner step 9), and step 10 retargets these cases.
 */
export function pinSharedPublicationMode(): void {
	beforeAll(() => {
		SessionOwnershipTestHooks.mode = "observe";
	});
	afterAll(() => {
		delete SessionOwnershipTestHooks.mode;
	});
}
