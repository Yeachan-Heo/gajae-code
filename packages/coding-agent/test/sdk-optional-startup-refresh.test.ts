import { describe, expect, test } from "bun:test";
import type { ModelRefreshStrategy } from "@gajae-code/ai/core";
import { startOptionalModelRefresh } from "@gajae-code/coding-agent/sdk/session";

describe("optional model refresh startup gate", () => {
	test("does not start unrelated provider discovery for lifecycle startup", () => {
		const calls: Array<{ strategy: ModelRefreshStrategy | undefined; sessionId: string | undefined }> = [];
		const registry = {
			refreshInBackground(strategy?: ModelRefreshStrategy, sessionId?: string) {
				calls.push({ strategy, sessionId });
			},
		};

		expect(startOptionalModelRefresh(registry, "session-1", true)).toBe(false);
		expect(calls).toEqual([]);
	});

	test("keeps optional discovery for ordinary interactive startup", () => {
		const calls: Array<{ strategy: ModelRefreshStrategy | undefined; sessionId: string | undefined }> = [];
		const registry = {
			refreshInBackground(strategy?: ModelRefreshStrategy, sessionId?: string) {
				calls.push({ strategy, sessionId });
			},
		};

		expect(startOptionalModelRefresh(registry, "session-2", false)).toBe(true);
		expect(calls).toEqual([{ strategy: "online-if-uncached", sessionId: "session-2" }]);
	});
});
