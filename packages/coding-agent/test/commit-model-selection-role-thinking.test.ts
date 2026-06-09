import { describe, expect, it } from "bun:test";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { resolvePrimaryModel, resolveSecondaryCommitModel } from "../src/commit/model-selection";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(modelRoles: Record<string, string>) {
	return {
		getModelRole(role: string) {
			return modelRoles[role];
		},
		getStorage() {
			return undefined;
		},
		setModelRole(role: string, value: string) {
			modelRoles[role] = value;
		},
		get(path: string) {
			if (path === "modelRoles") return modelRoles;
			return undefined;
		},
	} as never;
}

describe("commit model selection", () => {
	it("uses the default role (with explicit thinking) for primary and secondary commit models", async () => {
		const defaultModel = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${defaultModel.provider}/${defaultModel.id}:low`,
		});
		const registry = {
			getAvailable: () => [defaultModel],
			getApiKey: async () => "test-key",
		};

		const primary = await resolvePrimaryModel(undefined, settings, registry);
		expect(primary.model.id).toBe(defaultModel.id);
		expect(primary.thinkingLevel).toBe(Effort.Low);

		const secondary = await resolveSecondaryCommitModel(settings, registry, defaultModel, "fallback-key");
		expect(secondary.model.id).toBe(defaultModel.id);
		expect(secondary.thinkingLevel).toBe(Effort.Low);
	});
});
