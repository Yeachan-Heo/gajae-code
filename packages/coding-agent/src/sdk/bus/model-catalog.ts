import type { Api, Model, ThinkingConfig } from "@gajae-code/ai";

type ThinkingLevel = ThinkingConfig["minLevel"];

export interface SdkModelThinkingCapability {
	minLevel: ThinkingLevel;
	maxLevel: ThinkingLevel;
	levels?: ThinkingLevel[];
	defaultLevel?: ThinkingLevel;
	mode: ThinkingConfig["mode"];
}

export interface SdkModelCatalogEntry {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	thinking?: SdkModelThinkingCapability;
}

export function toSdkModelCatalogEntry(model: Model<Api>): SdkModelCatalogEntry {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		...(model.thinking
			? {
					thinking: {
						minLevel: model.thinking.minLevel,
						maxLevel: model.thinking.maxLevel,
						...(model.thinking.levels ? { levels: [...model.thinking.levels] } : {}),
						...(model.thinking.defaultLevel ? { defaultLevel: model.thinking.defaultLevel } : {}),
						mode: model.thinking.mode,
					},
				}
			: {}),
	};
}
