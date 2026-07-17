import { afterEach, describe, expect, it, vi } from "bun:test";
import { kNoAuth, type ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

function completedSession(): AgentSession {
	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		setConfiguredModelChain: () => {},
		getConfiguredModelChain: () => undefined,
		seedDefaultFallbackResolution: () => {},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		prompt: async () => {},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as AgentSession;
}

describe("runSubprocess provider rate-limit scope", () => {
	afterEach(() => vi.restoreAllMocks());

	it("forwards exactly modelRegistry.authStorage as the child logical-stream scope", async () => {
		const authStorage = Object.freeze({});
		const modelRegistry = {
			authStorage,
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => kNoAuth,
		} as unknown as ModelRegistry;
		let capturedScope: object | undefined;
		let capturedAuthStorage: object | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected child session options");
			capturedScope = options.providerRateLimitScope;
			capturedAuthStorage = options.authStorage;
			return {
				session: completedSession(),
				extensionsResult: {} as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});
		const agent: AgentDefinition = {
			name: "task",
			description: "test",
			systemPrompt: "test",
			source: "bundled",
		};

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "test",
			index: 0,
			id: "scope-forwarding",
			settings: Settings.isolated(),
			modelRegistry,
			enableLsp: false,
		});

		expect(capturedAuthStorage).toBe(authStorage);
		expect(capturedScope).toBe(authStorage);
	});
});
