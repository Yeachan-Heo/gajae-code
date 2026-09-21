import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { CommandController } from "../src/modes/controllers/command-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import type { AgentSession } from "../src/session/agent-session";
import type { SessionManager } from "../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

const model = {
	provider: "test-provider",
	id: "test-title-model",
	name: "test-title-model",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	contextWindow: 128_000,
	maxTokens: 4096,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	headers: {},
	compat: {},
} as unknown as Model<Api>;

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: 0 } as AgentMessage;
}

function createTitleSession(messages: AgentMessage[]): AgentSession {
	const settings = {
		getModelRole(role: string) {
			return role === "default" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	};
	return {
		messages,
		model,
		modelRegistry: {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
		},
		settings,
		credentialSessionId: "credential-session",
		agent: { metadataForProvider: () => undefined },
	} as unknown as AgentSession;
}

function titleResponse(title: string): unknown {
	return {
		stopReason: "stop",
		content: [{ type: "toolCall", id: "title-call", name: "set_title", arguments: { title } }],
	};
}

function createManager(): SessionManager & {
	_sessionName: string | undefined;
	setSessionName: (name: string, source: string) => Promise<boolean>;
} {
	const manager = {
		_sessionName: "Original",
		getCwd: () => "/tmp/project",
		getSessionName() {
			return this._sessionName;
		},
		async setSessionName(name: string) {
			this._sessionName = name;
			return true;
		},
	};
	return manager as unknown as SessionManager & {
		_sessionName: string | undefined;
		setSessionName: (name: string, source: string) => Promise<boolean>;
	};
}

function createTuiContext(session: AgentSession, sessionManager: SessionManager, showStatus: ReturnType<typeof vi.fn>) {
	const ctx = {
		session,
		sessionManager,
		settings: session.settings,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		showStatus,
	} as unknown as InteractiveModeContext;
	return ctx;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("session title regeneration ordering", () => {
	it("drops a stale TUI regeneration silently after an explicit rename", async () => {
		const completion = Promise.withResolvers<unknown>();
		const completeSimpleCalled = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			completeSimpleCalled.resolve();
			return completion.promise as never;
		});

		const messages = [user("Investigate the original task")];
		const session = createTitleSession(messages);
		const manager = createManager();
		const showStatus = vi.fn();
		const controller = new CommandController(createTuiContext(session, manager, showStatus));

		const staleRegeneration = controller.handleRenameCommand();
		await completeSimpleCalled.promise;
		await controller.handleRenameCommand("Manual");

		completion.resolve(titleResponse("Stale Generated Title"));
		await staleRegeneration;

		expect(manager._sessionName).toBe("Manual");
		expect(showStatus).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith('Session renamed to "Manual".');
	});

	it("drops a stale ACP regeneration silently after an explicit rename", async () => {
		const completion = Promise.withResolvers<unknown>();
		const completeSimpleCalled = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			completeSimpleCalled.resolve();
			return completion.promise as never;
		});

		const messages = [user("Investigate the original task")];
		const session = createTitleSession(messages);
		const manager = createManager();
		const output: string[] = [];
		const runtime = {
			session,
			sessionManager: manager,
			settings: session.settings,
			cwd: "/tmp/project",
			output: (text: string) => output.push(text),
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;

		const staleRegeneration = executeAcpBuiltinSlashCommand("/rename", runtime);
		await completeSimpleCalled.promise;
		await executeAcpBuiltinSlashCommand("/rename Manual", runtime);

		completion.resolve(titleResponse("Stale Generated Title"));
		expect(await staleRegeneration).toEqual({ consumed: true });

		expect(manager._sessionName).toBe("Manual");
		expect(output).toEqual(["Session renamed to Manual."]);
	});
});
