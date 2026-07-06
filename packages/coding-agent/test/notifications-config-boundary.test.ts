import { describe, expect, test } from "bun:test";
import {
	buildRedactedAction,
	isGloballyConfigured,
	maskToken,
	type NotificationConfig,
	type RedactableAction,
} from "../src/notifications/config";

const BASE_CFG: NotificationConfig = {
	enabled: true,
	botToken: undefined,
	chatId: undefined,
	discord: {
		botToken: undefined,
		channelId: undefined,
	},
	slack: {
		botToken: undefined,
		channelId: undefined,
	},
	redact: false,
	verbosity: "lean",
	idleTimeoutMs: 60000,
};

describe("notification config privacy boundaries", () => {
	test("does not treat whitespace-only adapter credentials as configured", () => {
		expect(isGloballyConfigured({ ...BASE_CFG, botToken: "   ", chatId: "chat-1" })).toBe(false);
		expect(isGloballyConfigured({ ...BASE_CFG, botToken: "token-1", chatId: "   " })).toBe(false);
		expect(
			isGloballyConfigured({
				...BASE_CFG,
				discord: { botToken: "   ", channelId: "discord-channel" },
			}),
		).toBe(false);
		expect(
			isGloballyConfigured({
				...BASE_CFG,
				slack: { botToken: "slack-token", channelId: "   " },
			}),
		).toBe(false);
	});

	test("maskToken does not reveal short tokens in full", () => {
		expect(maskToken("abc")).toBe("•••…(len 3)");
		expect(maskToken("abc")).not.toContain("abc");
		expect(maskToken("abcd")).toBe("••••…(len 4)");
		expect(maskToken("abcd")).not.toContain("abcd");
	});

	test("redacted non-ask actions drop option text", () => {
		const action: RedactableAction = {
			id: "i1",
			kind: "idle",
			sessionId: "session-abcdef",
			question: "Sensitive question",
			options: ["secret option"],
			summary: "Sensitive idle summary",
		};

		expect(buildRedactedAction(action, { redact: true, sessionTag: "abcdef" })).toEqual({
			id: "i1",
			kind: "idle",
			sessionId: "session-abcdef",
		});
	});
});
