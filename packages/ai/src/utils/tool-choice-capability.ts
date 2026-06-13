import { extractHttpStatusFromError } from "@gajae-code/utils/fetch-retry";
import * as logger from "@gajae-code/utils/logger";
import type { Api, Model, ToolChoice, ToolChoiceCompat, ToolChoiceSupport, ToolChoiceSupportSource } from "../types";

const supportRank: Record<ToolChoiceSupport, number> = {
	none: 0,
	auto: 1,
	required: 2,
	named: 3,
};

const registry = new Map<string, ToolChoiceSupport>();
const loggedRegistryKeys = new Set<string>();

/**
 * Claude Mythos accepts tools but rejects forced tool use (Anthropic 400:
 * "tool_choice forces tool use is not compatible with this model"). Catalog
 * generation and dynamic discovery use this to default `toolChoiceSupport`.
 */
export function isClaudeForcedToolChoiceIncapableModelId(modelId: string): boolean {
	return /(?:^|[/.])claude-mythos(?:-|$)/i.test(modelId);
}

/** Derives the effective static tool-choice support from compatibility flags. */
export function deriveToolChoiceSupport(compat: ToolChoiceCompat | undefined): {
	support: ToolChoiceSupport;
	source: "static" | "derived";
} {
	if (compat?.toolChoiceSupport) {
		return { support: compat.toolChoiceSupport, source: "static" };
	}
	if (compat?.supportsToolChoice === false) {
		return { support: "none", source: "derived" };
	}
	if (compat?.supportsForcedToolChoice === false) {
		return { support: "auto", source: "derived" };
	}
	return { support: "named", source: "derived" };
}

/** Returns the registry key used for runtime tool-choice capability overrides. */
export function toolChoiceRegistryKey(model: Model<Api>): string {
	return [model.api, model.provider, model.baseUrl, model.wireModelId ?? model.id].join("|");
}

/** Returns the current runtime tool-choice capability override for a model. */
export function getToolChoiceCapabilityOverride(model: Model<Api>): ToolChoiceSupport | undefined {
	return registry.get(toolChoiceRegistryKey(model));
}

/** Clears runtime tool-choice capability overrides for tests. */
export function clearToolChoiceIncapabilityRegistryForTests(): void {
	registry.clear();
	loggedRegistryKeys.clear();
}

/** Records a discovered maximum supported tool-choice level for a model. */
export function markToolChoiceIncapability(model: Model<Api>, maxSupport: ToolChoiceSupport, reason?: string): void {
	const key = toolChoiceRegistryKey(model);
	const existing = registry.get(key);
	const next = existing && supportRank[existing] < supportRank[maxSupport] ? existing : maxSupport;
	registry.set(key, next);

	if (!loggedRegistryKeys.has(key)) {
		loggedRegistryKeys.add(key);
		logger.debug("Discovered tool_choice incapability", {
			api: model.api,
			provider: model.provider,
			baseUrlHost: safeHostname(model.baseUrl),
			model: model.wireModelId ?? model.id,
			maxSupport,
			reason,
		});
	}
}

/**
 * Resolves a requested tool_choice against static and runtime capability limits.
 * `compat` overrides `model.compat` for transports that layer URL/provider
 * detection on top of explicit model overrides (e.g. resolveOpenAICompat).
 */
export function resolveToolChoice(
	model: Model<Api>,
	requested: ToolChoice | undefined,
	compat?: ToolChoiceCompat,
): ResolveToolChoiceResult {
	const derived = deriveToolChoiceSupport(compat ?? model.compat);
	const runtime = registry.get(toolChoiceRegistryKey(model));
	const support = runtime && supportRank[runtime] < supportRank[derived.support] ? runtime : derived.support;
	const supportSource: ToolChoiceSupportSource = support === derived.support ? derived.source : "runtime";
	const requestedInfo = requestedToolChoiceLevel(requested);
	const clampLevel = requestedInfo.requestedLevel === "none" ? "auto" : requestedInfo.requestedLevel;
	const registryKey = toolChoiceRegistryKey(model);

	if (requested === undefined) {
		return {
			requestedChoice: requested,
			requestedLevel: requestedInfo.requestedLevel,
			resolvedChoice: undefined,
			resolvedLevel: "auto",
			support,
			supportSource,
			degraded: false,
			registryKey,
		};
	}

	if (support === "none") {
		return {
			requestedChoice: requested,
			requestedLevel: requestedInfo.requestedLevel,
			resolvedChoice: undefined,
			resolvedLevel: "none",
			support,
			supportSource,
			degraded: requestedInfo.requestedLevel !== "none",
			reason: "tool_choice is not supported by this model",
			registryKey,
			targetToolName: requestedInfo.targetToolName,
		};
	}

	if (supportRank[support] >= supportRank[clampLevel]) {
		return {
			requestedChoice: requested,
			requestedLevel: requestedInfo.requestedLevel,
			resolvedChoice: requested,
			resolvedLevel: requestedInfo.requestedLevel,
			support,
			supportSource,
			degraded: false,
			registryKey,
			targetToolName: requestedInfo.targetToolName,
		};
	}

	if (requestedInfo.requestedLevel === "named" && support === "required") {
		return {
			requestedChoice: requested,
			requestedLevel: "named",
			resolvedChoice: "required",
			resolvedLevel: "required",
			support,
			supportSource,
			degraded: true,
			reason: "named tool_choice degraded to required",
			registryKey,
			targetToolName: requestedInfo.targetToolName,
		};
	}

	return {
		requestedChoice: requested,
		requestedLevel: requestedInfo.requestedLevel,
		resolvedChoice: undefined,
		resolvedLevel: support === "auto" ? "auto" : "none",
		support,
		supportSource,
		degraded: true,
		reason: "forced tool_choice is not supported by this model",
		registryKey,
		targetToolName: requestedInfo.targetToolName,
	};
}

/** Detects provider errors indicating forced tool_choice is unsupported. */
export function isForcedToolChoiceUnsupportedError(error: unknown, sentForcedToolChoice: boolean): boolean {
	if (!sentForcedToolChoice || extractHttpStatusFromError(error) !== 400) return false;
	const message = errorMessage(error);
	return (
		// `by <something>` continuations ("not supported by billing") describe a
		// different subject than the model's tool_choice capability — reject them
		// unless the continuation names the model itself.
		/tool[_\s-]?choices?\b.*?(not\s+compatible|incompatible|not\s+supported)(?!\s+by\s+(?!(?:this|the)\s+model\b|model\b))/is.test(
			message,
		) ||
		/forces?\s+tool\s+use.*?(not\s+compatible|incompatible|not\s+supported)/is.test(message) ||
		/does\s+not\s+support\s+forced\s+tool[_\s-]?choices?/is.test(message)
	);
}

export type { ToolChoiceCompat, ToolChoiceSupport, ToolChoiceSupportSource } from "../types";

export interface ResolveToolChoiceResult {
	requestedChoice: ToolChoice | undefined;
	requestedLevel: ToolChoiceSupport;
	resolvedChoice: ToolChoice | undefined;
	resolvedLevel: ToolChoiceSupport;
	support: ToolChoiceSupport;
	supportSource: ToolChoiceSupportSource;
	degraded: boolean;
	reason?: string;
	registryKey: string;
	targetToolName?: string;
}

function requestedToolChoiceLevel(requested: ToolChoice | undefined): {
	requestedLevel: ToolChoiceSupport;
	targetToolName?: string;
} {
	if (requested === undefined || requested === "auto") return { requestedLevel: "auto" };
	if (requested === "none") return { requestedLevel: "none" };
	if (requested === "any" || requested === "required") return { requestedLevel: "required" };
	if ("name" in requested) return { requestedLevel: "named", targetToolName: requested.name };
	return { requestedLevel: "named", targetToolName: requested.function.name };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String(error);
}

function safeHostname(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}
}
