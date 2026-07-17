import { describe, expect, test } from "bun:test";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const alpha = {
	provider: "test",
	id: "alpha",
	api: "openai-responses",
	name: "alpha",
	thinking: { defaultLevel: ThinkingLevel.Low },
} as Model;
const beta = { provider: "test", id: "beta", api: "openai-responses", name: "beta" } as Model;
const gamma = { provider: "test", id: "gamma", api: "openai-responses", name: "gamma" } as Model;

function createSession(): AgentSession {
	return new AgentSession({
		agent: new Agent({ initialState: { model: alpha, systemPrompt: [], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: { getAvailable: () => [alpha, beta, gamma], getApiKey: async () => "key" } as never,
	});
}

describe("/model configured fallback-chain rebasing", () => {
	test("preserves the selected suffix for an exact configured entry", async () => {
		const session = createSession();
		session.setConfiguredModelChain("default", ["test/alpha:low", "test/beta", "test/gamma"], "test");

		await session.setModel(beta, "default", { selector: "test/beta" });

		expect(session.getConfiguredModelChain("default")).toEqual(["test/beta", "test/gamma"]);
	});

	test("uses the picked thinking selector as the head when it matches a concrete configured model", async () => {
		const session = createSession();
		session.setConfiguredModelChain("default", ["test/alpha:low", "test/beta", "test/gamma"], "test");

		await session.setModel(alpha, "default", { selector: "test/alpha", thinkingLevel: ThinkingLevel.High });

		expect(session.getConfiguredModelChain("default")).toEqual(["test/alpha:high", "test/beta", "test/gamma"]);
	});

	test("turns an outside selection into a one-entry configured chain", async () => {
		const session = createSession();
		session.setConfiguredModelChain("default", ["test/alpha", "test/beta"], "test");

		await session.setModel(gamma, "default", { selector: "test/gamma" });

		expect(session.getConfiguredModelChain("default")).toEqual(["test/gamma"]);
	});

	test("repeated active selection reruns rebasing and persists configured intent without transient state", async () => {
		const session = createSession();
		session.setConfiguredModelChain("default", ["test/alpha", "test/beta", "test/gamma"], "test");
		session.seedDefaultFallbackResolution(2, [{ selector: "test/beta", reason: "unavailable" }]);

		await session.setModel(beta, "default", { selector: "test/beta" });
		await session.setModel(beta, "default", { selector: "test/beta" });

		expect(session.getConfiguredModelChain("default")).toEqual(["test/beta", "test/gamma"]);
		expect(session.sessionManager.buildSessionContext().configuredModelChains.default).toMatchObject({
			entries: ["test/beta", "test/gamma"],
			role: "default",
		});
		expect(JSON.stringify(session.sessionManager.getBranch())).not.toContain("activeIndex");
	});
});
