import type { ModelRefreshStrategy } from "@gajae-code/ai";

export function resolveListModelsRefreshStrategy(): ModelRefreshStrategy {
	return "online-if-uncached";
}
