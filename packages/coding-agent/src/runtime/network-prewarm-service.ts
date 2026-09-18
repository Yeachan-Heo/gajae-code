import { logger } from "@gajae-code/utils";
import type { Settings } from "../config/settings";
import { createLazyService, type LazyService } from "./lazy-service";

type FetchWithPreconnect = typeof fetch & { preconnect?: (url: string) => void };

/** Runtime network prewarm and first-request latency diagnostics. */
export interface NetworkPrewarmRuntime {
	/**
	 * Whether preconnect is still believed to work. Starts from the setting and
	 * flips to `false` for the lifetime of this runtime service once the runtime
	 * proves the capability unusable, so it reports what actually happens rather
	 * than what was configured.
	 */
	readonly enabled: boolean;
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
			let enabled = settings.get("startup.networkPrewarm");
			let firstRequestLatencyDeltaMs: number | undefined;
			/**
			 * Retire the capability for this runtime service and say so once.
			 *
			 * A preconnect that throws for a well-formed model-host URL is a runtime
			 * limitation, not a per-URL accident: Bun 1.4.0 rejects every URL on a
			 * scheme's default port with `Invalid port`, which is every provider
			 * endpoint. Retrying per host only repeats the same throw once per host
			 * per session, and recording it at `debug` left a permanently dead
			 * optimization reporting itself as enabled.
			 */
			const retire = (baseUrl: string, reason: string): void => {
				if (!enabled) return;
				enabled = false;
				logger.warn("Model-host preconnect unavailable; disabling network prewarm for this runtime service", {
					baseUrl,
					reason,
				});
			};
			return {
				value: {
					get enabled() {
						return enabled;
					},
					preconnect(baseUrl) {
						if (!enabled || !baseUrl) return;
						const preconnect = (globalThis.fetch as FetchWithPreconnect).preconnect;
						if (typeof preconnect !== "function") {
							retire(baseUrl, "fetch.preconnect is not a function on this runtime");
							return;
						}
						// The first real model-host preconnect doubles as the capability probe:
						// when it works it is the prewarm this service exists to perform, and
						// when it throws it proves the capability instead of costing an extra
						// synthetic connection.
						try {
							preconnect(baseUrl);
						} catch (error) {
							retire(baseUrl, error instanceof Error ? error.message : String(error));
						}
					},
					recordFirstRequestLatency(latencyMs) {
						// Reading `enabled` after a possible retirement is the point: a process
						// whose prewarm turned out to be dead still records its unprewarmed
						// first-request baseline instead of measuring nothing.
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
