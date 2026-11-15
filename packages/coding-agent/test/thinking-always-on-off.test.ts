import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core/thinking";
import { Effort, getBundledModel } from "@gajae-code/ai";
import {
	clampExplicitThinkingLevelForModel,
	modelSupportsThinkingOff,
	resolveThinkingLevelForModel,
	toReasoningEffort,
} from "../src/thinking";

function bundled(provider: "anthropic", id: string) {
	const model = getBundledModel(provider, id as never);
	if (!model) throw new Error(`Expected bundled ${provider}/${id}`);
	return model;
}

describe("Off on always-on Fable 5.2", () => {
	const fable52 = bundled("anthropic", "claude-fable-5-2");
	const fable51 = bundled("anthropic", "claude-fable-5-1");

	it("does not offer Off for Fable 5.2 but keeps it for models that honor it", () => {
		expect(modelSupportsThinkingOff(fable52)).toBe(false);
		expect(modelSupportsThinkingOff(fable51)).toBe(true);
		expect(modelSupportsThinkingOff(undefined)).toBe(true);
	});

	it("resolves Off (from /effort, --thinking, defaults or restored state) to the lowest real effort", () => {
		const resolved = resolveThinkingLevelForModel(fable52, ThinkingLevel.Off);
		expect(resolved).toBe(Effort.Minimal);
		expect(toReasoningEffort(resolved)).toBe(Effort.Minimal);
		expect(clampExplicitThinkingLevelForModel(fable52, ThinkingLevel.Off)).toBe(Effort.Minimal);
	});

	it("still preserves an explicit Off where the model can disable thinking", () => {
		expect(resolveThinkingLevelForModel(fable51, ThinkingLevel.Off)).toBe(ThinkingLevel.Off);
		expect(clampExplicitThinkingLevelForModel(fable51, ThinkingLevel.Off)).toBe(ThinkingLevel.Off);
		expect(resolveThinkingLevelForModel(undefined, ThinkingLevel.Off)).toBe(ThinkingLevel.Off);
	});
});
