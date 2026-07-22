import { describe, expect, test } from "bun:test";
import {
	defineCapability,
	initializeWithSettings,
	loadCapability,
	registerProvider,
} from "@gajae-code/coding-agent/capability";
import type { Settings } from "@gajae-code/coding-agent/config/settings";

const capability = defineCapability<{ name: string }>({
	id: "session-provider-policy-regression",
	displayName: "Session provider policy regression",
	description: "Verifies provider policy remains session-local",
	key: item => item.name,
});
registerProvider(capability.id, {
	id: "session-policy-a",
	displayName: "Session policy A",
	description: "Test provider A",
	priority: 1,
	load: async () => ({
		items: [{ name: "a", _source: { provider: "session-policy-a", path: "a", level: "native" } }],
	}),
});
registerProvider(capability.id, {
	id: "session-policy-b",
	displayName: "Session policy B",
	description: "Test provider B",
	priority: 1,
	load: async () => ({
		items: [{ name: "b", _source: { provider: "session-policy-b", path: "b", level: "native" } }],
	}),
});

describe("session-local disabled provider policy", () => {
	test("keeps concurrent session capability reloads isolated", async () => {
		const first = {
			get: (key: string) => (key === "disabledProviders" ? ["session-policy-a"] : []),
			getCwd: () => "/session-a",
		} as unknown as Settings;
		const second = {
			get: (key: string) => (key === "disabledProviders" ? ["session-policy-b"] : []),
			getCwd: () => "/session-b",
		} as unknown as Settings;
		initializeWithSettings(first);
		initializeWithSettings(second);

		const firstResult = await loadCapability<{ name: string }>(capability.id, { settings: first });
		const secondResult = await loadCapability<{ name: string }>(capability.id, { settings: second });

		expect(firstResult.items.map(item => item.name)).toEqual(["b"]);
		expect(secondResult.items.map(item => item.name)).toEqual(["a"]);
	});
});
