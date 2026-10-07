import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { LoadedCustomCommand } from "@gajae-code/coding-agent/extensibility/custom-commands";
import type { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

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

function titleResponse(title: string) {
	return {
		stopReason: "stop",
		content: [{ type: "toolCall", id: "title-call", name: "set_title", arguments: { title } }],
	} as unknown as Awaited<ReturnType<typeof ai.completeSimple>>;
}

function userMessage(content: string): AgentMessage {
	return { role: "user", content, timestamp: 0 } as AgentMessage;
}

type StubEditor = {
	setText: (text: string) => void;
	getText: () => string;
	addToHistory: ReturnType<typeof vi.fn>;
	onSubmit?: (text: string) => Promise<void>;
};

function createContext(opts: {
	isStreaming: boolean;
	messages: AgentMessage[];
	isCompacting?: boolean;
	isBashRunning?: boolean;
	handledCommands?: readonly string[];
}) {
	let editorText = "";
	let sessionName: string | undefined;
	let sessionId = "session-1";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
	};
	const setSessionName = vi.fn(async (name: string, _source: "auto" | "user") => {
		sessionName = name;
		return true;
	});
	const prompt = vi.fn(async (_text: string, _options?: unknown) => {});
	const followUp = vi.fn(async (_text: string, _images?: unknown, _options?: unknown) => {});
	const queueCompactionMessage = vi.fn();
	const onInputCallback = vi.fn();
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		skillCommands: new Map(),
		session: {
			sessionId: "stub-session",
			isStreaming: opts.isStreaming,
			isCompacting: opts.isCompacting ?? false,
			isBashRunning: opts.isBashRunning ?? false,
			isEvalRunning: false,
			extensionRunner: undefined,
			messages: opts.messages,
			model,
			modelRegistry: { getAvailable: () => [model], getApiKey: async () => "test-key" },
			credentialSessionId: "credential-session",
			agent: { metadataForProvider: () => undefined },
			prompt,
			followUp,
			isLocallyHandledSlashCommand: (text: string) =>
				(opts.handledCommands ?? []).some(name => text === `/${name}` || text.startsWith(`/${name} `)),
		},
		queueCompactionMessage,
		settings: {
			get: (key: string) => (key === "busyPromptMode" ? "steer" : undefined),
			getModelRole: (role: string) => (role === "default" ? `${model.provider}/${model.id}` : undefined),
			getStorage: () => undefined,
		},
		sessionManager: {
			getCwd: () => process.cwd(),
			getSessionName: () => sessionName,
			getSessionId: () => sessionId,
			setSessionName,
		},
		showError: vi.fn(),
		showStatus: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		startPendingSubmission: (submission: unknown) => submission,
		onInputCallback,
		isBashMode: false,
		isPythonMode: false,
		pendingImages: [],
		isBackgrounded: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		hasActiveBtw: () => false,
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	const submit = async (text: string) => {
		editor.setText(text);
		await editor.onSubmit?.(text);
	};
	const queueSubmit = async (text: string) => {
		editor.setText(text);
		await controller.handleQueueSubmit();
	};
	// New Session / switch / resume commits a successor into the same manager.
	const replaceSession = (nextId: string) => {
		sessionId = nextId;
		sessionName = undefined;
	};
	return {
		submit,
		queueSubmit,
		setSessionName,
		prompt,
		followUp,
		queueCompactionMessage,
		onInputCallback,
		replaceSession,
	};
}

describe("InputController automatic session title", () => {
	// Other suites in the same process may run CLI paths that export the
	// --no-title opt-out into the environment; these cases need it unset.
	const savedNoTitle = { GJC_NO_TITLE: Bun.env.GJC_NO_TITLE, PI_NO_TITLE: Bun.env.PI_NO_TITLE };

	beforeEach(() => {
		delete Bun.env.GJC_NO_TITLE;
		delete Bun.env.PI_NO_TITLE;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const [key, value] of Object.entries(savedNoTitle)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	it("titles the session from the first user message typed while a skill-started turn streams", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse("Hash Map Basics"));
		const skillOnly = [{ role: "custom", customType: "skill-prompt", content: "skill", timestamp: 0 }];
		const { submit, setSessionName, prompt } = createContext({
			isStreaming: true,
			messages: skillOnly as unknown as AgentMessage[],
		});

		await submit("Explain what a hash map is");
		await Bun.sleep(0);

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		const request = completeSimple.mock.calls[0]?.[1];
		expect(JSON.stringify(request?.messages)).toContain("Explain what a hash map is");
		expect(setSessionName).toHaveBeenCalledWith("Hash Map Basics", "auto");
	});

	it("titles the session from the first message sent with the queue shortcut during a streaming turn", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse("Queued Title"));
		const { queueSubmit, setSessionName, prompt } = createContext({ isStreaming: true, messages: [] });

		await queueSubmit("queued first question");
		await Bun.sleep(0);

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(setSessionName).toHaveBeenCalledWith("Queued Title", "auto");
	});

	it("requests one title when several messages arrive before the first title lands", async () => {
		const release = Promise.withResolvers<void>();
		const completeSimple = vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			await release.promise;
			return titleResponse("First Steer");
		});
		const { submit, setSessionName, prompt } = createContext({ isStreaming: true, messages: [] });

		await submit("first steer");
		await submit("second steer");
		release.resolve();
		await Bun.sleep(0);

		expect(prompt).toHaveBeenCalledTimes(2);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(setSessionName).toHaveBeenCalledTimes(1);
		expect(setSessionName).toHaveBeenCalledWith("First Steer", "auto");
	});

	it("does not title a streaming steer once the session already has a user message", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse("Unused"));
		const { submit, setSessionName, prompt } = createContext({
			isStreaming: true,
			messages: [userMessage("earlier question")],
		});

		await submit("follow-up steer");
		await Bun.sleep(0);

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(completeSimple).not.toHaveBeenCalled();
		expect(setSessionName).not.toHaveBeenCalled();
	});

	it("discards a pending title when the session is replaced before it lands", async () => {
		const release = Promise.withResolvers<void>();
		const completeSimple = vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			await release.promise;
			return titleResponse("Predecessor Title");
		});
		const { submit, setSessionName, replaceSession } = createContext({ isStreaming: true, messages: [] });

		await submit("predecessor question");
		replaceSession("session-2");
		release.resolve();
		await Bun.sleep(0);

		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(setSessionName).not.toHaveBeenCalled();
	});

	it("titles a replacement session while the predecessor's title is still pending", async () => {
		const releaseFirst = Promise.withResolvers<void>();
		const completeSimple = vi
			.spyOn(ai, "completeSimple")
			.mockImplementationOnce(async () => {
				await releaseFirst.promise;
				return titleResponse("Predecessor Title");
			})
			.mockResolvedValueOnce(titleResponse("Successor Title"));
		const { submit, setSessionName, replaceSession } = createContext({ isStreaming: true, messages: [] });

		await submit("predecessor question");
		replaceSession("session-2");
		await submit("successor question");
		await Bun.sleep(0);
		releaseFirst.resolve();
		await Bun.sleep(0);

		expect(completeSimple).toHaveBeenCalledTimes(2);
		expect(setSessionName).toHaveBeenCalledTimes(1);
		expect(setSessionName).toHaveBeenCalledWith("Successor Title", "auto");
	});

	it("still titles the first idle message", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse("Idle Title"));
		const { submit, setSessionName, onInputCallback } = createContext({ isStreaming: false, messages: [] });

		await submit("idle question");
		await Bun.sleep(0);

		expect(onInputCallback).toHaveBeenCalledTimes(1);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(setSessionName).toHaveBeenCalledWith("Idle Title", "auto");
	});

	it("titles text accepted into the compaction queue by Enter and by the queue shortcut", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse("Compaction Title"));
		const steer = createContext({ isStreaming: false, isCompacting: true, messages: [] });
		await steer.submit("question during compaction");
		await Bun.sleep(0);
		expect(steer.queueCompactionMessage).toHaveBeenCalledTimes(1);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(steer.setSessionName).toHaveBeenCalledWith("Compaction Title", "auto");

		completeSimple.mockClear();
		const followUp = createContext({ isStreaming: false, isCompacting: true, messages: [] });
		await followUp.queueSubmit("queued during compaction");
		await Bun.sleep(0);
		expect(followUp.queueCompactionMessage).toHaveBeenCalledTimes(1);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(followUp.setSessionName).toHaveBeenCalledWith("Compaction Title", "auto");
	});

	it("titles a follow-up accepted while foreground bash runs", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse("Bash Title"));
		const { queueSubmit, followUp, setSessionName } = createContext({
			isStreaming: false,
			isBashRunning: true,
			messages: [],
		});

		await queueSubmit("question while bash runs");
		await Bun.sleep(0);

		expect(followUp).toHaveBeenCalledTimes(1);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(setSessionName).toHaveBeenCalledWith("Bash Title", "auto");
	});

	it("does not send locally handled slash commands to the title model, then titles the first ordinary prompt", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse("Real Title"));
		const { submit, queueSubmit, setSessionName } = createContext({
			isStreaming: true,
			messages: [],
			handledCommands: ["ext-cmd"],
		});

		await submit("/ext-cmd token=secret");
		await queueSubmit("/ext-cmd another=secret");
		await Bun.sleep(0);
		expect(completeSimple).not.toHaveBeenCalled();
		expect(setSessionName).not.toHaveBeenCalled();

		await submit("an ordinary first prompt");
		await Bun.sleep(0);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(completeSimple.mock.calls[0]?.[1]?.messages)).toContain("an ordinary first prompt");
		expect(JSON.stringify(completeSimple.mock.calls[0]?.[1]?.messages)).not.toContain("secret");
		expect(setSessionName).toHaveBeenCalledWith("Real Title", "auto");
	});
});

describe("AgentSession locally handled slash command classification", () => {
	it("matches extension, custom, and MCP command names exactly", async () => {
		const command = (name: string) => ({ command: { name } }) as unknown as LoadedCustomCommand;
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			extensionRunner: {
				getCommand: (name: string) => (name === "ext" ? {} : undefined),
			} as unknown as ExtensionRunner,
			customCommands: [command("custom")],
		});
		try {
			session.setMCPPromptCommands([command("mcp")]);

			for (const text of ["/ext", "/ext token=secret", "/custom", "/custom value", "/mcp", "/mcp value"]) {
				expect(session.isLocallyHandledSlashCommand(text)).toBe(true);
			}
			for (const text of ["/unknown value", "/skill:custom value", "ordinary custom", " /custom value"]) {
				expect(session.isLocallyHandledSlashCommand(text)).toBe(false);
			}
		} finally {
			await session.dispose();
		}
	});
});
