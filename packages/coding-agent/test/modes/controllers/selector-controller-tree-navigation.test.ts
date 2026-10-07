import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import { TreeSelectorComponent } from "@gajae-code/coding-agent/modes/components/tree-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Container, Text } from "@gajae-code/tui";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

let tempDirectory: string | undefined;
let sessionManager: SessionManager | undefined;

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme();
});

afterEach(async () => {
	if (sessionManager) {
		await sessionManager.close();
		sessionManager = undefined;
	}
	if (tempDirectory) {
		await fs.rm(tempDirectory, { recursive: true, force: true });
		tempDirectory = undefined;
	}
});

describe("SelectorController tree navigation", () => {
	it("retires a streaming response from the abandoned branch after navigation commits", async () => {
		tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-selector-tree-navigation-"));
		sessionManager = SessionManager.create(tempDirectory, tempDirectory);
		sessionManager.appendMessage({ role: "user", content: "selected branch prompt", timestamp: 1 });
		sessionManager.appendMessage(assistantMessage("selected branch answer"));
		const selectedContext = sessionManager.buildSessionContext();
		const firstEntry = sessionManager.getEntries()[0];
		if (!firstEntry) throw new Error("Expected a prior session entry to navigate to");

		const navigationFinished = Promise.withResolvers<void>();
		const navigateTree = vi.fn(async () => ({
			cancelled: false,
			aborted: false,
			sessionContext: selectedContext,
		}));
		const chatContainer = new Container();
		const abandonedPartial = assistantMessage("abandoned branch partial answer");
		const streamingComponent = new AssistantMessageComponent(abandonedPartial);
		chatContainer.addChild(streamingComponent);
		const pendingMessagesContainer = new Container();
		pendingMessagesContainer.addChild(new Text("predecessor pending output"));
		const pendingTools = new Map<string, unknown>([["predecessor-tool", {}]]);
		const rebuiltTranscript = new Text("selected branch transcript");
		const rebuildInitialMessages = vi.fn(() => {
			chatContainer.clear();
			chatContainer.addChild(rebuiltTranscript);
		});
		const ctx = {
			session: { navigateTree },
			sessionManager,
			ui: { requestRender: vi.fn(), terminal: { rows: 40 } },
			editor: { onEscape: undefined, getText: () => "", setText: vi.fn() },
			chatContainer,
			pendingMessagesContainer,
			compactionQueuedMessages: [{ text: "predecessor queued message" }],
			streamingComponent,
			streamingMessage: abandonedPartial,
			pendingTools,
			statusContainer: new Container(),
			stopLoadingAnimation: vi.fn(),
			resetAssistantTextPresentation: vi.fn(),
			rebuildInitialMessages,
			reloadTodos: vi.fn(async () => {}),
			showHookSelector: vi.fn(async () => "No summary"),
			showStatus: vi.fn((message: string) => {
				if (message === "Navigated to selected point") navigationFinished.resolve();
			}),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);
		let treeSelector: TreeSelectorComponent | undefined;
		controller.showSelector = create => {
			const selection = create(() => {});
			if (!(selection.component instanceof TreeSelectorComponent)) {
				throw new Error("Expected the tree selector component");
			}
			treeSelector = selection.component;
		};

		controller.showTreeSelector();
		if (!treeSelector) throw new Error("Expected the tree selector to open");
		treeSelector.handleInput("\x1b[A");
		treeSelector.handleInput("\n");
		await navigationFinished.promise;

		expect(navigateTree).toHaveBeenCalledWith(firstEntry.id, {
			summarize: false,
			customInstructions: undefined,
		});
		expect(rebuildInitialMessages).toHaveBeenCalledWith("reconcile-same-transcript", selectedContext);
		expect(chatContainer.children).toEqual([rebuiltTranscript]);
		expect(chatContainer.render(80).join("\n")).toContain("selected branch transcript");
		expect(chatContainer.render(80).join("\n")).not.toContain("abandoned branch partial answer");
		expect(ctx.streamingComponent).toBeUndefined();
		expect(ctx.streamingMessage).toBeUndefined();
		expect(pendingTools.size).toBe(0);
		expect(pendingMessagesContainer.children).toHaveLength(0);
		expect(ctx.compactionQueuedMessages).toEqual([]);
	});
});
