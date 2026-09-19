import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { buildConversationTitleInput } from "../src/utils/title-generator";

function user(content: unknown): AgentMessage {
	return { role: "user", content, timestamp: 0 } as AgentMessage;
}

function assistant(text = "assistant response"): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

describe("buildConversationTitleInput", () => {
	it("returns undefined without non-empty user text", () => {
		expect(buildConversationTitleInput([])).toBeUndefined();
		expect(buildConversationTitleInput([assistant()])).toBeUndefined();
		expect(
			buildConversationTitleInput([
				user("  \n\t"),
				user([
					{ type: "text", text: " \n " },
					{ type: "image", data: "ignored", mimeType: "image/png" },
				]),
			]),
		).toBeUndefined();
	});

	it("extracts string and text-block content while ignoring non-text blocks", () => {
		expect(
			buildConversationTitleInput([
				user("  string content  "),
				user([
					{ type: "text", text: "first block" },
					{ type: "image", data: "ignored", mimeType: "image/png" },
					{ type: "text", text: "second block" },
				]),
			]),
		).toBe("string content\nfirst block\nsecond block");
	});

	it("keeps the first and five most recent qualifying user messages", () => {
		const messages = Array.from({ length: 9 }, (_, index) => user(`Message ${index + 1}`));
		expect(buildConversationTitleInput(messages)).toBe(
			"Message 1\nMessage 5\nMessage 6\nMessage 7\nMessage 8\nMessage 9",
		);
	});

	it("truncates messages longer than 400 characters only", () => {
		expect(buildConversationTitleInput([user("x".repeat(900))])).toBe(`${"x".repeat(400)}…`);
		expect(buildConversationTitleInput([user("y".repeat(400))])).toBe("y".repeat(400));
	});

	it("keeps user-message ordering when assistant messages are interleaved", () => {
		expect(
			buildConversationTitleInput([user("first"), assistant(), user("second"), assistant(), user("third")]),
		).toBe("first\nsecond\nthird");
	});
});
