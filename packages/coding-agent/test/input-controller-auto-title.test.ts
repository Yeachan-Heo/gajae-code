import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

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

function createContext(opts: { isStreaming: boolean; messages: AgentMessage[] }) {
	let editorText = "";
	let sessionName: string | undefined;
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
	const onInputCallback = vi.fn();
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		skillCommands: new Map(),
		session: {
			sessionId: "stub-session",
			isStreaming: opts.isStreaming,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			messages: opts.messages,
			model,
			modelRegistry: { getAvailable: () => [model], getApiKey: async () => "test-key" },
			credentialSessionId: "credential-session",
			agent: { metadataForProvider: () => undefined },
			prompt,
		},
		settings: {
			get: (key: string) => (key === "busyPromptMode" ? "steer" : undefined),
			getModelRole: (role: string) => (role === "default" ? `${model.provider}/${model.id}` : undefined),
			getStorage: () => undefined,
		},
		sessionManager: {
			getCwd: () => process.cwd(),
			getSessionName: () => sessionName,
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
	return { submit, queueSubmit, setSessionName, prompt, onInputCallback };
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

	it("still titles the first idle message", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleResponse("Idle Title"));
		const { submit, setSessionName, onInputCallback } = createContext({ isStreaming: false, messages: [] });

		await submit("idle question");
		await Bun.sleep(0);

		expect(onInputCallback).toHaveBeenCalledTimes(1);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(setSessionName).toHaveBeenCalledWith("Idle Title", "auto");
	});
});
