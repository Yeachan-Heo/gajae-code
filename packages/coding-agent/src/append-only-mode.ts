/**
 * Single source of truth for append-only context-mode resolution and manager
 * construction. Both the initial session build (`sdk/session.ts`) and the runtime
 * model/setting-change path (`agent-session.ts`), plus the status UI, resolve
 * through here so the auto allowlist and prefix-reset diagnostics never drift.
 */

import { AppendOnlyContextManager } from "@gajae-code/agent-core";
import { logger } from "@gajae-code/utils";

/**
 * Providers for which append-only context auto-enables. Exact provider-string
 * match only: `anthropic` reached via a gateway/aggregator provider string
 * (e.g. `openrouter`, a custom gateway) does NOT match and stays opt-in via
 * `provider.appendOnlyContext: "on"`, because those transports can rewrite or
 * renormalize the request in ways that have not been validated for append-only
 * prefix stability.
 */
export function providerSupportsAppendOnlyAuto(provider: string): boolean {
	return provider === "deepseek" || provider === "anthropic";
}

/**
 * Resolve whether to enable append-only context mode based on the setting and provider.
 *
 * - `"on"` → always enable
 * - `"off"` → never enable
 * - `"auto"` → enable for providers with strong prompt-prefix caching that this
 *   harness has validated (see {@link providerSupportsAppendOnlyAuto})
 */
export function resolveAppendOnlyMode(setting: "auto" | "on" | "off" | undefined, provider: string): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default:
			return providerSupportsAppendOnlyAuto(provider);
	}
}

/**
 * Construct an {@link AppendOnlyContextManager} wired to emit per-session
 * stable-prefix reset diagnostics. Use this at every creation site so the
 * telemetry is uniform.
 */
export function createAppendOnlyContextManager(provider: string | undefined): AppendOnlyContextManager {
	return new AppendOnlyContextManager({
		onPrefixChange: info =>
			logger.debug("append-only stable prefix changed (cache prefix reset)", {
				provider,
				from: info.from,
				to: info.to,
				version: info.version,
				reason: info.from === "<unbuilt>" ? "initial-build" : "prefix-mutation",
			}),
	});
}
