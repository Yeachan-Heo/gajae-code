import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import { type ModelLookupRegistry, resolveModelRoleValue, resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";

export interface ResolvedCommitModel {
	model: Model<Api>;
	apiKey: string;
	thinkingLevel?: ThinkingLevel;
}

type CommitModelRegistry = ModelLookupRegistry & {
	getApiKey: (model: Model<Api>) => Promise<string | undefined>;
};

export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: CommitModelRegistry,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	const resolved = override
		? resolveModelRoleValue(override, available, { settings, matchPreferences, modelRegistry })
		: resolveRoleSelection(["default"], settings, available, modelRegistry);
	const model = resolved?.model;
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	return { model, apiKey, thinkingLevel: resolved?.thinkingLevel };
}

export async function resolveSecondaryCommitModel(
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	fallbackModel: Model<Api>,
	fallbackApiKey: string,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const resolved = resolveRoleSelection(["default"], settings, available, modelRegistry);
	if (resolved?.model) {
		const apiKey = await modelRegistry.getApiKey(resolved.model);
		if (apiKey) return { model: resolved.model, apiKey, thinkingLevel: resolved.thinkingLevel };
	}

	return { model: fallbackModel, apiKey: fallbackApiKey };
}
