import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@gajae-code/ai";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { generateCommitMessage } from "../src/utils/commit-message-generator";
import { generateSessionTitle } from "../src/utils/title-generator";

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
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("role thinking helper propagation", () => {
	it("passes default-role thinking to commit message generation", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:minimal`,
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix scope handling" }],
		} as never);

		const message = await generateCommitMessage(`diff --git a/x b/x\n+change\n`, registry as never, settings);
		expect(message).toBe("fix scope handling");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			reasoning: Effort.Minimal,
			maxTokens: 1024,
		});
	});

	it("disables reasoning for title generation even when the default role has thinking", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:low`,
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "Investigate resolver" },
				},
			],
		} as never);

		const title = await generateSessionTitle("Investigate resolver", registry as never, settings);
		expect(title).toBe("Investigate resolver");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ disableReasoning: true });
	});
});
