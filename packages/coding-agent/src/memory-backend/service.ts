import type { Settings } from "../config/settings";
import { createLazyService, type LazyService } from "../runtime/lazy-service";
import { offBackend } from "./off-backend";
import { resolveMemoryBackendId } from "./resolve";
import type { MemoryBackend } from "./types";

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
