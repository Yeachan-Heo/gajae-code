import { describe, expect, test } from "bun:test";
import { resolveServiceTier, shouldSendServiceTier } from "../src/types";

describe("ultrafast service tier", () => {
	test("resolveServiceTier resolves ultrafast to ultrafast", () => {
		expect(resolveServiceTier("ultrafast", "openai")).toBe("ultrafast");
		expect(resolveServiceTier("ultrafast", "openai-codex")).toBe("ultrafast");
		expect(resolveServiceTier("ultrafast", undefined)).toBe("ultrafast");
	});

	test("shouldSendServiceTier sends ultrafast to OpenAI", () => {
		expect(shouldSendServiceTier("ultrafast", "openai")).toBe(true);
		expect(shouldSendServiceTier("ultrafast", "openai-codex")).toBe(true);
	});

	test("shouldSendServiceTier sends ultrafast when provider supports it", () => {
		expect(shouldSendServiceTier("ultrafast", "custom-provider", true)).toBe(true);
	});

	test("shouldSendServiceTier does not send ultrafast to providers that do not support it", () => {
		expect(shouldSendServiceTier("ultrafast", "anthropic")).toBe(false);
		expect(shouldSendServiceTier("ultrafast", "custom-provider", false)).toBe(false);
	});

	test("ultrafast works alongside existing tiers", () => {
		expect(resolveServiceTier("flex", "openai")).toBe("flex");
		expect(resolveServiceTier("priority", "openai")).toBe("priority");
		expect(shouldSendServiceTier("flex", "openai")).toBe(true);
		expect(shouldSendServiceTier("priority", "openai")).toBe(true);
	});
});
