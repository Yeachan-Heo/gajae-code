import type { Settings } from "../config/settings";
import { createLazyService, type LazyService } from "../runtime/lazy-service";
import { offBackend } from "./off-backend";
import { resolveMemoryBackendId } from "./resolve";
import type { MemoryBackend } from "./types";

/**
 * Return a refusal reason when a cwd rescope would leave the resident memory
 * service or its backend state bound to the launch scope.
 *
 * The lazy service captures its original Settings instance, while Hindsight
 * state captures both its resolved config and bank scope. Compare those values
 * before publication instead of allowing a move to report success with stale
 * memory authority. A `undefined` result means the move is memory-safe.
 */
export async function getMemoryBackendRescopeError(
	settings: Settings,
	targetSettings: Settings,
): Promise<Error | undefined> {
	const sourceId = resolveMemoryBackendId(settings);
	const targetId = resolveMemoryBackendId(targetSettings);
	if (sourceId !== targetId) {
		return new Error(
			`Refusing to rescope before publication: memory backend would change from "${sourceId}" to "${targetId}"; restart the session at the target cwd to apply the target policy.`,
		);
	}

	switch (sourceId) {
		case "off":
			return undefined;
		case "local": {
			const sourcePolicy = JSON.stringify(settings.getGroup("memories"));
			const targetPolicy = JSON.stringify(targetSettings.getGroup("memories"));
			if (sourcePolicy === targetPolicy) return undefined;
			return new Error(
				`Refusing to rescope before publication: local memory policy is launch-bound and differs at target cwd; restart the session at the target cwd to apply the target policy.`,
			);
		}
		case "hindsight":
			// Hindsight state owns a client, resolved config, bank scope, and a
			// retain queue. Rebinding those pieces before publication would require
			// draining and recreating state with no safe ownership handoff, so fail
			// closed for every Hindsight move rather than mislabeling queued facts.
			return new Error(
				`Refusing to rescope before publication: Hindsight bank scope and queued retains are launch-bound and cannot be rebound safely; restart the session at the target cwd.`,
			);
	}
}

/**
 * Build the lazy runtime service for the selected memory backend.
 *
 * The identity resolver is deliberately config-only. Backend implementations
 * enter the module graph only when this service is first activated, and the
 * resident no-op backend keeps `memory.backend=off` import-free.
 */
export function createMemoryBackendService(settings: Settings): LazyService<MemoryBackend> {
	return createLazyService({
		id: "memory.backend",
		enabled: () => true,
		initialize: async () => {
			switch (resolveMemoryBackendId(settings)) {
				case "off":
					return { value: offBackend };
				case "local": {
					const { localBackend } = await import("./local-backend");
					return { value: localBackend };
				}
				case "hindsight": {
					const { hindsightBackend } = await import("../hindsight");
					return { value: hindsightBackend };
				}
			}
		},
	});
}
