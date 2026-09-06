import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

type TestContext = InteractiveModeContext & {
	editorContainer: {
		children: unknown[];
		clear: () => void;
		detachChild: (child: unknown) => void;
		addChild: (child: unknown) => void;
	};
};

function createContext(options: {
	sessionModel: Model | undefined;
	settings: Settings;
	setModel: (model: Model) => Promise<void>;
}): { ctx: TestContext; setModel: typeof options.setModel } {
	const editorContainer = {
		children: [] as unknown[],
		clear() {
			this.children = [];
		},
		detachChild(child: unknown) {
			this.children = this.children.filter(entry => entry !== child);
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	const ctx = {
		editorContainer,
		editor: {},
		settings: options.settings,
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			terminal: { columns: 120 },
		},
		session: {
			model: options.sessionModel,
			switchSession: vi.fn(async () => true),
			resolveConfiguredDefaultModel: vi.fn(() => getBundledModel("anthropic", "claude-opus-4-8")),
			setModel: options.setModel,
		},
		resetIrcSidebarSession: vi.fn(),
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionDir: () => "/tmp/project/sessions",
			getSessionFile: () => "/tmp/project/sessions/active.jsonl",
			getSessionId: () => "session-id",
			isManagedDestination: () => false,
		},
		statusContainer: { clear: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn() },
		compactionQueuedMessages: [] as unknown[],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: { clear: vi.fn() },
		resetAssistantTextPresentation: vi.fn(),
		loadingAnimation: undefined,
		stopLoadingAnimation: vi.fn(),
		syncActivityIndicator: vi.fn(),
		statusLine: { invalidate: vi.fn(), setSessionStartTime: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		renderInitialMessages: vi.fn(),
		rebuildInitialMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		chatContainer: { clear: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		shutdown: vi.fn(async () => undefined),
	} as unknown as TestContext;

	return { ctx, setModel: options.setModel };
}

beforeAll(() => {
	initTheme();
});

describe("SelectorController resume model choice", () => {
	beforeEach(() => {
		vi.spyOn(SessionManager, "list").mockResolvedValue([]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not prompt when resumeModelBehavior is the default (keepSessionModel)", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const setModel = vi.fn(async () => {});
		const settings = Settings.isolated();
		const { ctx } = createContext({ sessionModel: sonnet, settings, setModel });
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/project/sessions/active.jsonl");

		// Only the (no-op) editor restore path runs — no confirm dialog mounted.
		expect(ctx.editorContainer.children).toHaveLength(0);
		expect(setModel).not.toHaveBeenCalled();
		expect(ctx.stopLoadingAnimation).toHaveBeenCalledWith({
			foregroundSettled: true,
			restoreBackground: false,
		});
		expect(ctx.syncActivityIndicator).toHaveBeenCalledTimes(1);
		expect(ctx.resetAssistantTextPresentation).toHaveBeenCalledTimes(1);
	});

	it("prompts and switches when resumeModelBehavior is ask and models differ", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-8")!;
		const setModel = vi.fn(async () => {});
		const settings = Settings.isolated({ "session.resumeModelBehavior": "ask" });
		const { ctx } = createContext({ sessionModel: sonnet, settings, setModel });
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/project/sessions/active.jsonl");

		expect(ctx.editorContainer.children).toHaveLength(1);

		const selector = ctx.editorContainer.children[0] as { handleInput: (key: string) => void };
		// Second option ("Use claude-opus-4-8") — navigate down then confirm.
		selector.handleInput("\u001b[B");
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(setModel).toHaveBeenCalledWith(opus);
	});

	it("does not prompt when the session model already matches the current default", async () => {
		const opus = getBundledModel("anthropic", "claude-opus-4-8")!;
		const setModel = vi.fn(async () => {});
		const settings = Settings.isolated({ "session.resumeModelBehavior": "ask" });
		const { ctx } = createContext({ sessionModel: opus, settings, setModel });
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/project/sessions/active.jsonl");

		expect(ctx.editorContainer.children).toHaveLength(0);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("preserves retry UI when a pre-mutation switch hook cancels", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const { ctx } = createContext({
			sessionModel: sonnet,
			settings: Settings.isolated(),
			setModel: vi.fn(async () => {}),
		});
		(ctx.session.switchSession as unknown as { mockResolvedValue(value: boolean): void }).mockResolvedValue(false);
		const retryLoader = { stop: vi.fn() };
		const typedRetryLoader = retryLoader as unknown as TestContext["retryLoader"];
		ctx.retryLoader = typedRetryLoader;
		const retryTimer = setInterval(() => {}, 60_000);
		ctx.retryCountdownTimer = retryTimer;
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/project/sessions/active.jsonl");

		expect(ctx.retryLoader).toBe(typedRetryLoader);
		expect(ctx.retryCountdownTimer).toBe(retryTimer);
		expect(retryLoader.stop).not.toHaveBeenCalled();
		expect(ctx.resetAssistantTextPresentation).not.toHaveBeenCalled();
		clearInterval(retryTimer);
	});

	it("clears retry UI when switch rollback follows mutation start", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const { ctx } = createContext({
			sessionModel: sonnet,
			settings: Settings.isolated(),
			setModel: vi.fn(async () => {}),
		});
		const switchSession = ctx.session.switchSession as unknown as {
			mockImplementation(
				implementation: (path: string, options?: { onTransitionMutationStarted?: () => void }) => Promise<boolean>,
			): void;
		};
		switchSession.mockImplementation(async (_path, options) => {
			options?.onTransitionMutationStarted?.();
			return false;
		});
		const retryLoader = { stop: vi.fn() };
		ctx.retryLoader = retryLoader as unknown as TestContext["retryLoader"];
		ctx.retryCountdownTimer = setInterval(() => {}, 60_000);
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/project/sessions/active.jsonl");

		expect(retryLoader.stop).toHaveBeenCalledTimes(1);
		expect(ctx.retryLoader).toBeUndefined();
		expect(ctx.retryCountdownTimer).toBeUndefined();
	});

	it("clears retry UI after a committed session switch", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const { ctx } = createContext({
			sessionModel: sonnet,
			settings: Settings.isolated(),
			setModel: vi.fn(async () => {}),
		});
		const retryLoader = { stop: vi.fn() };
		ctx.retryLoader = retryLoader as unknown as TestContext["retryLoader"];
		ctx.retryCountdownTimer = setInterval(() => {}, 60_000);
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/project/sessions/active.jsonl");

		expect(retryLoader.stop).toHaveBeenCalledTimes(1);
		expect(ctx.retryLoader).toBeUndefined();
		expect(ctx.retryCountdownTimer).toBeUndefined();
	});
});
