import type { Settings } from "../config/settings";

export function resolveStreamFirstEventTimeoutMs(settings: Settings): number | undefined {
	return settings.has("retry.streamFirstEventTimeoutMs") ? settings.get("retry.streamFirstEventTimeoutMs") : undefined;
}
