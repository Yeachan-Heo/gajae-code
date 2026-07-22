import { beforeAll, describe, expect, it, vi } from "bun:test";
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

interface Harness {
	editor: CustomEditor;
	btw: BtwController;
	btwContainer: Container;
}

function makeHarness(runEphemeralTurn: () => Promise<unknown>): Harness {
	const editor = new CustomEditor(getEditorTheme());
	const btwContainer = new Container();
	const ui = { requestRender: vi.fn(), followLiveViewport: vi.fn(), onDebug: undefined } as unknown as TUI;
	const session = {
		model: { provider: "anthropic", id: "test" },
		runEphemeralTurn,
		createBtwConversationScope: vi.fn(() => ({ messages: [], systemPrompt: [] })),
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
	return { editor, btw, btwContainer };
}

const pending = () => new Promise<never>(() => {});

async function drain(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("btw panel Esc dismissal (issue #455)", () => {
	it("dismisses a running btw panel on Esc", async () => {
		const { editor, btw, btwContainer } = makeHarness(() => pending());
		await btw.start("Why?");
		expect(btw.hasActiveRequest()).toBe(true);

		editor.handleInput(ESC);

		expect(btw.hasActiveRequest()).toBe(false);
		expect(btwContainer.children).toHaveLength(0);
	});

	it("dismisses a completed btw panel on Esc", async () => {
		const { editor, btw, btwContainer } = makeHarness(async () => ({
			replyText: "Answer",
			assistantMessage: {},
		}));
		await btw.start("Why?");
		await drain();
		expect(btw.hasActiveRequest()).toBe(true);

		editor.handleInput(ESC);

		expect(btw.hasActiveRequest()).toBe(false);
		expect(btwContainer.children).toHaveLength(0);
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
