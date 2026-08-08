import { logger } from "@gajae-code/utils";
import type { Settings } from "../config/settings";
import { createLazyService, type LazyService } from "./lazy-service";

type FetchWithPreconnect = typeof fetch & { preconnect?: (url: string) => void };

/** Runtime network prewarm and first-request latency diagnostics. */
export interface NetworkPrewarmRuntime {
	enabled: boolean;
	preconnect(baseUrl: string | undefined): void;
	recordFirstRequestLatency(latencyMs: number): void;
	getFirstRequestLatencyDeltaMs(): number | undefined;
}

/**
 * Keep network preconnect behind a lifecycle-owned LazyService. The service is
 * cheap to initialize even when disabled, so the disabled path can still
 * record the first-request latency delta without touching fetch.preconnect.
 */
export function createNetworkPrewarmService(settings: Settings): LazyService<NetworkPrewarmRuntime> {
	return createLazyService({
		id: "startup.networkPrewarm",
		initialize: async () => {
			const enabled = settings.get("startup.networkPrewarm");
			let firstRequestLatencyDeltaMs: number | undefined;
			return {
				value: {
					enabled,
					preconnect(baseUrl) {
						if (!enabled || !baseUrl) return;
						const preconnect = (globalThis.fetch as FetchWithPreconnect).preconnect;
						if (typeof preconnect !== "function") return;
						try {
							preconnect(baseUrl);
						} catch (error) {
							// Preserve the legacy best-effort optimization contract while keeping
							// the diagnostic visible to debug logging.
							logger.debug("Model-host preconnect failed", {
								baseUrl,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					},
					recordFirstRequestLatency(latencyMs) {
						if (enabled || firstRequestLatencyDeltaMs !== undefined) return;
						firstRequestLatencyDeltaMs = Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : 0;
						logger.info("Model first-request latency delta", {
							networkPrewarm: false,
							firstRequestLatencyDeltaMs,
						});
					},
					getFirstRequestLatencyDeltaMs() {
						return firstRequestLatencyDeltaMs;
					},
				},
			};
		},
	});
}
