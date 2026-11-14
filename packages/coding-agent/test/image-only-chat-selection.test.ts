import { describe, expect, test } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { IMAGE_ONLY_CHAT_MESSAGE } from "@gajae-code/ai/core";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resolveCliModel, resolveRoleSelection } from "@gajae-code/coding-agent/config/model-resolver";
import { Settings } from "@gajae-code/coding-agent/config/settings";

function model(id: string, output?: Array<"text" | "image">): Model {
	return {
		provider: "openai",
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	} as Model;
}

const chat = model("gpt-4o");
const imageOnly = model("gpt-image-2.6-sunburst", ["image"]);

function registry(models: Model[]): ModelRegistry {
	return {
		getAll: () => models,
		getAvailable: () => models,
	} as unknown as ModelRegistry;
}

describe("image-only chat selection", () => {
	test("rejects CLI and default-role selection while keeping the image role", () => {
		const models = [chat, imageOnly];
		const cli = resolveCliModel({
			cliModel: "openai/gpt-image-2.6-sunburst",
			modelRegistry: registry(models),
		});
		expect(cli.model).toBeUndefined();
		expect(cli.error).toBe(IMAGE_ONLY_CHAT_MESSAGE);

		const settings = Settings.isolated({
			modelRoles: {
				default: "openai/gpt-image-2.6-sunburst",
				image: "openai/gpt-image-2.6-sunburst",
			},
		});
		expect(resolveRoleSelection(["default"], settings, models, registry(models))?.model?.id).toBeUndefined();
		expect(resolveRoleSelection(["image"], settings, models, registry(models))?.model?.id).toBe(
			"gpt-image-2.6-sunburst",
		);
	});
});
