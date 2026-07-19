import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { StatusArea } from "@gajae-code/coding-agent/modes/status-area";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { Container, Loader, Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { assistantMessage } from "./completion-fixtures";

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme();
});

afterAll(() => resetSettingsForTest());

describe("EventController status teardown ownership", () => {
	it("uses the active retry loader for direct completion cleanup and footprint", async () => {
		const term = new VirtualTerminal(20, 8, { isProcessTerminal: true });
		const ui = new TUI(term);
		const statusContainer = new Container();
		const residualStatus = new Text("independent status", 0, 0);
		const loadingAnimation = new Loader(
			ui,
			value => value,
			value => value,
			"working",
			["|"],
		);
		statusContainer.addChild(loadingAnimation);
		statusContainer.addChild(residualStatus);
		const originalEscape = (): void => {};
		const ctx = {
			isInitialized: true,
			ui,
			chatContainer: new Container(),
			pendingMessagesContainer: new Container(),
			statusContainer,
			statusLine: { invalidate: () => {} },
			editor: { getText: () => "", onEscape: originalEscape },
			loadingAnimation,
			ensureLoadingAnimation: () => {},
			pendingTools: new Map(),
			planModeController: { flushPendingModelSwitch: async () => {} },
			updateEditorTopBorder: () => {},
			updateEditorBorderColor: () => {},
			session: {
				isCompacting: true,
				retryNow: () => {},
				abortRetry: () => {},
				getLastAssistantMessage: () => assistantMessage("completed"),
			},
			sessionManager: { getSessionName: () => "", getCwd: () => process.cwd() },
			isBackgrounded: false,
		} as unknown as InteractiveModeContext;

		const controller = new EventController(ctx);
		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 10_000,
			errorMessage: "retry",
		});
		const retryLoader = ctx.retryLoader;
		expect(retryLoader).toBeDefined();
		if (!retryLoader) throw new Error("retry start did not install a loader");
		const retryFootprint = retryLoader.render(term.columns).map(() => "");
		expect(ctx.retryCountdownTimer).toBeDefined();
		expect(ctx.editor.onEscape).not.toBe(originalEscape);

		await controller.handleEvent({ type: "agent_end", messages: [] });

		expect(ctx.retryLoader).toBeUndefined();
		expect(ctx.retryCountdownTimer).toBeUndefined();
		expect(ctx.editor.onEscape).toBe(originalEscape);
		expect(statusContainer.render(term.columns)).toEqual([...residualStatus.render(term.columns), ...retryFootprint]);
	});
	it("auto compaction preserves independent status and the reserved row budget", async () => {
		const term = new VirtualTerminal(40, 12, { isProcessTerminal: true });
		const ui = new TUI(term);
		const statusContainer = new Container();
		const residualStatus = new Text("independent status", 0, 0);
		const loadingAnimation = new Loader(
			ui,
			value => value,
			value => value,
			"working",
			["|"],
		);
		statusContainer.addChild(loadingAnimation);
		statusContainer.addChild(residualStatus);
		const ctx = {
			isInitialized: true,
			ui,
			chatContainer: new Container(),
			pendingMessagesContainer: new Container(),
			statusContainer,
			statusLine: { invalidate: () => {} },
			editor: { getText: () => "", onEscape: undefined },
			loadingAnimation,
			ensureLoadingAnimation: () => {},
			pendingTools: new Map(),
			planModeController: { flushPendingModelSwitch: async () => {} },
			updateEditorTopBorder: () => {},
			updateEditorBorderColor: () => {},
			showStatus: () => {},
			showWarning: () => {},
			flushCompactionQueue: async () => {},
			session: {
				isCompacting: true,
				abortCompaction: () => {},
				getLastAssistantMessage: () => assistantMessage("completed"),
			},
			sessionManager: { getSessionName: () => "", getCwd: () => process.cwd() },
			isBackgrounded: false,
		} as unknown as InteractiveModeContext;
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_start",
			reason: "overflow",
			action: "compact",
		} as never);
		expect(ctx.autoCompactionLoader).toBeDefined();
		expect(statusContainer.children).toContain(loadingAnimation);
		expect(statusContainer.children).toContain(residualStatus);
		const peakRows = statusContainer.render(term.columns).length;

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "compact",
			aborted: true,
		} as never);
		expect(ctx.autoCompactionLoader).toBeUndefined();
		expect(statusContainer.children).toContain(loadingAnimation);
		expect(statusContainer.children).toContain(residualStatus);
		// The reserve keeps the compaction loader's rows as blanks: the status
		// area must not contract below its peak height.
		expect(statusContainer.render(term.columns).length).toBeGreaterThanOrEqual(peakRows);
		loadingAnimation.stop();
	});
	it("keeps browsed scrollback stable through an error or cancel loader teardown", async () => {
		const previousTerm = Bun.env.TERM;
		const previousNotify = Bun.env.GJC_NOTIFY;
		Bun.env.TERM = "xterm-256color";
		Bun.env.GJC_NOTIFY = "off";
		const term = new VirtualTerminal(40, 18, { isProcessTerminal: true });
		const ui = new TUI(term);
		const chatContainer = new Container();
		const split = new IrcSplitViewComponent(chatContainer, new IrcObservationLedger(), {
			fg: (_color: "dim" | "accent", text: string) => text,
			bold: (text: string) => text,
			boxSharp: { vertical: "│" },
		});
		const statusContainer = new Container();
		const statusArea = new StatusArea({ ui, statusContainer });
		const residualStatus = new Text("independent status", 0, 0);
		statusContainer.addChild(residualStatus);
		const loader = new Loader(
			ui,
			value => value,
			value => value,
			"working on a long wrapped status message",
			["|"],
		);
		statusArea.addLoader(loader);
		const statusLine = new Text("status", 0, 0);
		const editor = new Text("editor", 0, 0);
		ui.addChild(split);
		ui.setViewportAnchorComponent(split);
		ui.addChild(statusContainer);
		ui.addChild(statusLine);
		ui.addChild(editor);
		ui.setBottomPinnedComponent(statusLine);
		const ctx = {
			ui,
			chatContainer,
			pendingMessagesContainer: new Container(),
			statusContainer,
			getUserMessageText: (userMessage: { content: string }) => userMessage.content,
			sessionManager: { getSessionName: () => "", getCwd: () => process.cwd() },
		} as unknown as InteractiveModeContext;
		const uiHelpers = new UiHelpers(ctx);
		for (let index = 0; index < 30; index++) {
			uiHelpers.addMessageToChat({ role: "user", content: `history-${index}`, timestamp: index + 1 });
		}
		try {
			ui.start();
			await term.waitForRender();
			expect(ui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			const before = term.getViewport().map(line => line.trimEnd());
			const beforeHistory = before.flatMap((line, index) => (line.includes("history-") ? [{ index, line }] : []));
			expect(beforeHistory.length, JSON.stringify(before)).toBeGreaterThanOrEqual(3);
			const rowsBefore = statusContainer.render(term.columns).length;
			term.clearWriteLog();

			// The exact teardown showError / cancelPendingSubmission /
			// finishPendingSubmission perform on the shared status area.
			statusArea.removeLoader(loader);
			ui.requestRender();
			await term.waitForRender();

			expect(statusContainer.children).toContain(residualStatus);
			// Non-contracting: the reserve keeps the removed loader's rows.
			expect(statusContainer.render(term.columns).length).toBeGreaterThanOrEqual(rowsBefore);
			const after = term.getViewport().map(line => line.trimEnd());
			for (const entry of beforeHistory) expect(after[entry.index]).toBe(entry.line);
			const writes = term.getWriteLog().join("");
			for (const entry of beforeHistory) expect(writes).not.toContain(entry.line);
		} finally {
			ui.stop();
			if (previousTerm === undefined) delete Bun.env.TERM;
			else Bun.env.TERM = previousTerm;
			if (previousNotify === undefined) delete Bun.env.GJC_NOTIFY;
			else Bun.env.GJC_NOTIFY = previousNotify;
		}
	});
});
