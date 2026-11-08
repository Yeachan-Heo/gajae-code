import { beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { CustomEditor } from "@gajae-code/coding-agent/modes/components/custom-editor";
import { BtwController } from "@gajae-code/coding-agent/modes/controllers/btw-controller";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import { getEditorTheme, initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { Container, type TUI } from "@gajae-code/tui";
import { setKittyProtocolActive } from "@gajae-code/tui/keys";

beforeAll(async () => {
	await initTheme();
});

const ESC = "\x1b";

interface FakeScope {
	messages: unknown[];
	systemPrompt: string[];
}

interface Harness {
	editor: CustomEditor;
	btw: BtwController;
	btwContainer: Container;
	scope: FakeScope;
	releaseBtwConversationScope: Mock<(scope: FakeScope) => void>;
}

function makeHarness(runEphemeralTurn: () => Promise<unknown>): Harness {
	const editor = new CustomEditor(getEditorTheme());
	const btwContainer = new Container();
	const ui = { requestRender: vi.fn(), followLiveViewport: vi.fn(), onDebug: undefined } as unknown as TUI;
	const scope: FakeScope = { messages: ["visible text"], systemPrompt: ["instruction"] };
	// The real session splices the scope arrays and drops its provider-prefix state.
	const releaseBtwConversationScope = vi.fn((released: FakeScope) => {
		released.messages.splice(0);
		released.systemPrompt.splice(0);
	});
	const session = {
		model: { provider: "anthropic", id: "test" },
		runEphemeralTurn,
		createBtwConversationScope: vi.fn(() => scope),
		releaseBtwConversationScope,
		isStreaming: false,
		isBashRunning: false,
		isEvalRunning: false,
		isCompacting: false,
		isGeneratingHandoff: false,
		hasQueuedSteering: false,
	} as unknown as InteractiveModeContext["session"];

	const btw = new BtwController({
		ui,
		btwContainer,
		session,
		showStatus: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext);

	const keymap: Record<string, string[]> = { "app.interrupt": ["escape"] };
	const ctx = {
		ui,
		editor,
		keybindings: { getKeys: (action: string) => keymap[action] ?? [] },
		session,
		hasActiveBtw: () => btw.hasActiveRequest(),
		handleBtwEscape: () => btw.handleEscape(),
		cancelPendingSubmission: vi.fn(() => false),
		restoreQueuedMessagesToEditor: vi.fn(),
	} as unknown as InteractiveModeContext;

	new InputController(ctx).setupKeyHandlers();
	return { editor, btw, btwContainer, scope, releaseBtwConversationScope };
}

const pending = () => new Promise<never>(() => {});

async function drain(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("btw panel Esc dismissal (issue #455)", () => {
	it("dismisses a running btw panel on Esc", async () => {
		const { editor, btw, btwContainer, scope, releaseBtwConversationScope } = makeHarness(() => pending());
		await btw.start("Why?");
		expect(btw.hasActiveRequest()).toBe(true);
		expect(releaseBtwConversationScope).not.toHaveBeenCalled();

		editor.handleInput(ESC);

		expect(btw.hasActiveRequest()).toBe(false);
		expect(btwContainer.children).toHaveLength(0);
		expect(releaseBtwConversationScope).toHaveBeenCalledTimes(1);
		expect(releaseBtwConversationScope.mock.calls[0]?.[0]).toBe(scope);
		expect(scope.messages).toEqual([]);
		expect(scope.systemPrompt).toEqual([]);
	});

	it("dismisses a completed btw panel on Esc", async () => {
		const { editor, btw, btwContainer, scope, releaseBtwConversationScope } = makeHarness(async () => ({
			replyText: "Answer",
			assistantMessage: {},
		}));
		await btw.start("Why?");
		await drain();
		expect(btw.hasActiveRequest()).toBe(true);
		// A settled turn keeps the scope for follow-ups; only closing the panel releases it.
		expect(releaseBtwConversationScope).not.toHaveBeenCalled();

		editor.handleInput(ESC);

		expect(btw.hasActiveRequest()).toBe(false);
		expect(btwContainer.children).toHaveLength(0);
		expect(releaseBtwConversationScope).toHaveBeenCalledTimes(1);
		expect(releaseBtwConversationScope.mock.calls[0]?.[0]).toBe(scope);
	});

	it("dismisses an errored btw panel on Esc", async () => {
		const { editor, btw, btwContainer } = makeHarness(async () => {
			throw new Error("boom");
		});
		await btw.start("Why?");
		await drain();
		expect(btw.hasActiveRequest()).toBe(true);

		editor.handleInput(ESC);

		expect(btw.hasActiveRequest()).toBe(false);
		expect(btwContainer.children).toHaveLength(0);
	});

	it("dismisses retained completed and errored panels on Esc", async () => {
		const completed = makeHarness(async () => ({
			replyText: "Answer",
			assistantMessage: {},
		}));
		await completed.btw.start("Why?");
		await drain();
		expect(completed.btw.hasOpenPanel()).toBe(true);
		completed.editor.handleInput(ESC);
		expect(completed.btw.hasOpenPanel()).toBe(false);
		expect(completed.btwContainer.children).toHaveLength(0);

		const errored = makeHarness(async () => {
			throw new Error("boom");
		});
		await errored.btw.start("Why?");
		await drain();
		expect(errored.btw.hasOpenPanel()).toBe(true);
		errored.editor.handleInput(ESC);
		expect(errored.btw.hasOpenPanel()).toBe(false);
		expect(errored.releaseBtwConversationScope).toHaveBeenCalledTimes(1);
		expect(errored.releaseBtwConversationScope.mock.calls[0]?.[0]).toBe(errored.scope);
		expect(errored.btwContainer.children).toHaveLength(0);
	});
	it("dismisses under the kitty keyboard protocol encoding of Esc", async () => {
		setKittyProtocolActive(true);
		try {
			const { editor, btw, btwContainer } = makeHarness(() => pending());
			await btw.start("Why?");

			editor.handleInput("\x1b[27u");

			expect(btw.hasActiveRequest()).toBe(false);
			expect(btwContainer.children).toHaveLength(0);
		} finally {
			setKittyProtocolActive(false);
		}
	});

	// Regression: previously the btw dismiss was wired only through the
	// input-controller's onEscape handler. Whenever another controller
	// (auto-compaction, auto-retry, manual compaction, handoff, branch summary,
	// MCP connect, debug) temporarily replaced editor.onEscape, the btw panel
	// could no longer be dismissed with Esc.
	it("stays dismissable while a transient onEscape handler is installed", async () => {
		const { editor, btw, btwContainer } = makeHarness(() => pending());
		await btw.start("Why?");
		expect(btw.hasActiveRequest()).toBe(true);

		// Mimic event-controller/command-controller hijacking onEscape (e.g. an
		// auto-compaction or auto-retry that begins while the panel is open).
		let transientHandlerFired = false;
		editor.onEscape = () => {
			transientHandlerFired = true;
		};

		editor.handleInput(ESC);

		expect(btw.hasActiveRequest()).toBe(false);
		expect(btwContainer.children).toHaveLength(0);
		expect(transientHandlerFired).toBe(false);
	});

	it("does not consume Esc when no btw panel is active", async () => {
		const { editor, btw } = makeHarness(() => pending());
		expect(btw.hasActiveRequest()).toBe(false);

		let transientHandlerFired = false;
		editor.onEscape = () => {
			transientHandlerFired = true;
		};

		editor.handleInput(ESC);

		expect(transientHandlerFired).toBe(true);
	});
});

describe("queued /btw handoff on Esc queue restore", () => {
	it("restores the main queue and draft to the editor without reopening the handed-off side chat", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const btwContainer = new Container();
		const ui = { requestRender: vi.fn(), followLiveViewport: vi.fn(), onDebug: undefined } as unknown as TUI;
		let onQueuedPromoted: ((promotion: { removed?: boolean }) => void) | undefined;
		const session = {
			model: { provider: "anthropic", id: "test" },
			runEphemeralTurn: async () => ({ replyText: "SIDE_ANSWER", assistantMessage: {} }),
			createBtwConversationScope: vi.fn(() => ({ messages: [], systemPrompt: [] })),
			isStreaming: true,
			isCompacting: false,
			enqueueCustomMessageDisplay: vi.fn(() => "tag"),
			promptCustomMessage: vi.fn(
				async (_message: unknown, options: { onQueuedPromoted?: typeof onQueuedPromoted }) => {
					onQueuedPromoted = options.onQueuedPromoted;
				},
			),
			// Mirrors AgentSession.clearQueue: removal hooks fire while the queue is cleared.
			clearQueue: vi.fn(() => {
				onQueuedPromoted?.({ removed: true });
				return { steering: [], followUp: ["main queued", "/btw-handoff"] };
			}),
		} as unknown as InteractiveModeContext["session"];
		const showStatus = vi.fn();
		const ctx = {
			ui,
			editor,
			btwContainer,
			session,
			sessionManager: { getSessionId: () => "session" },
			pendingImages: [],
			compactionQueuedMessages: [],
			locallySubmittedUserSignatures: new Set<string>(),
			showStatus,
			showError: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
		} as unknown as InteractiveModeContext;
		const btw = new BtwController(ctx);
		const input = new InputController(ctx);

		await btw.start("Side question?");
		await drain();
		await btw.handoff();
		editor.setText("main draft");

		input.restoreQueuedMessagesToEditor();

		expect(btw.hasOpenPanel()).toBe(false);
		expect(btwContainer.children).toHaveLength(0);
		expect(editor.getText()).toBe("main queued\n\n/btw-handoff\n\nmain draft");
		expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining("Use /btw to reopen that side chat"));

		await btw.start("");
		expect(btw.hasOpenPanel()).toBe(true);
		expect(Bun.stripANSI(btwContainer.render(120).join("\n"))).toContain("SIDE_ANSWER");
	});
});
