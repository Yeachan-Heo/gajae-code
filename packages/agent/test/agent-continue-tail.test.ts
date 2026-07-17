import { describe, expect, it } from "bun:test";
import { Agent, canContinuePersistedHistory } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createAssistantMessage } from "./helpers";

function userMessage() {
	return { role: "user" as const, content: "resume", timestamp: 1 };
}

function toolResultMessage() {
	return {
		role: "toolResult" as const,
		toolCallId: "call_1",
		toolName: "tool",
		content: [{ type: "text" as const, text: "result" }],
		isError: false,
		timestamp: 1,
	};
}

function assistantMessage() {
	return createAssistantMessage([]);
}

describe("persisted continuation tail", () => {
	it("accepts user and tool-result tails but rejects empty and assistant tails", () => {
		expect(canContinuePersistedHistory([])).toBe(false);
		expect(canContinuePersistedHistory([userMessage()])).toBe(true);
		expect(canContinuePersistedHistory([toolResultMessage()])).toBe(true);
		expect(canContinuePersistedHistory([assistantMessage()])).toBe(false);
	});

	it("keeps assistant-tail queue handling separate from persisted-tail eligibility", async () => {
		const withoutQueue = new Agent();
		withoutQueue.replaceMessages([assistantMessage()]);
		await expect(withoutQueue.continue()).rejects.toThrow("Cannot continue from message role: assistant");

		const steeringMock = createMockModel({ responses: [{ content: ["steered"] }] });
		const withSteering = new Agent({ streamFn: steeringMock.stream });
		withSteering.replaceMessages([assistantMessage()]);
		withSteering.steer(userMessage());
		await expect(withSteering.continue()).resolves.toBeUndefined();
		expect(withSteering.hasQueuedSteering()).toBe(false);

		const followUpMock = createMockModel({ responses: [{ content: ["followed up"] }] });
		const withFollowUp = new Agent({ streamFn: followUpMock.stream });
		withFollowUp.replaceMessages([assistantMessage()]);
		withFollowUp.followUp(userMessage());
		await expect(withFollowUp.continue()).resolves.toBeUndefined();
		expect(withFollowUp.hasQueuedMessages()).toBe(false);
	});
});
