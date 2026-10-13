import { describe, expect, it } from "bun:test";
import { shouldSendServiceTier } from "../src/types";

describe("openai-codex ultrafast service tier", () => {
	describe("shouldSendServiceTier", () => {
		it("sends ultrafast for openai-codex", () => {
			expect(shouldSendServiceTier("ultrafast", "openai-codex")).toBe(true);
		});

		it("does not send ultrafast for other providers", () => {
			expect(shouldSendServiceTier("ultrafast", "openai")).toBe(false);
			expect(shouldSendServiceTier("ultrafast", "anthropic")).toBe(false);
			expect(shouldSendServiceTier("ultrafast", "deepinfra")).toBe(false);
			expect(shouldSendServiceTier("ultrafast", "bedrock")).toBe(false);
		});

		it("sends other tiers for openai-codex", () => {
			expect(shouldSendServiceTier("flex", "openai-codex")).toBe(true);
			expect(shouldSendServiceTier("scale", "openai-codex")).toBe(true);
			expect(shouldSendServiceTier("priority", "openai-codex")).toBe(true);
		});

		it("does not send default/auto tiers", () => {
			expect(shouldSendServiceTier("default", "openai-codex")).toBe(false);
			expect(shouldSendServiceTier("auto", "openai-codex")).toBe(false);
		});

		it("handles undefined/null tiers", () => {
			expect(shouldSendServiceTier(undefined, "openai-codex")).toBe(false);
			expect(shouldSendServiceTier(null, "openai-codex")).toBe(false);
		});
	});
});
