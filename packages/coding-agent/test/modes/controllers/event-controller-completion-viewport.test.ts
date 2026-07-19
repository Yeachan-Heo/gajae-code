import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { StatusRowReserve } from "@gajae-code/coding-agent/modes/components/status-row-reserve";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import {
	associateSessionMessageViewportAnchorId,
	getSessionMessageViewportAnchorId,
} from "@gajae-code/coding-agent/session/session-manager";
import { Container, Loader, shouldUseViewportRepaintForHost, Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

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

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme();
});

afterAll(() => resetSettingsForTest());

describe("EventController completion viewport", () => {
	const envKeys = [
		"GJC_NOTIFY",
		"SSH_CONNECTION",
		"TERM",
		"COLORTERM",
		"WT_SESSION",
		"TERM_PROGRAM",
		"TMUX",
		"TMUX_PANE",
		"STY",
		"ZELLIJ",
		"GJC_TMUX_LAUNCHED",
		"TERMUX_VERSION",
		"PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER",
		"PI_CLEAR_ON_SHRINK",
		"PI_TUI_VIRTUAL_VIEWPORT",
	] as const;
	let previousEnv = new Map<string, string | undefined>();

	function restoreEnv(snapshot: Map<string, string | undefined>): void {
		for (const key of envKeys) {
			const value = snapshot.get(key);
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}

	afterEach(() => restoreEnv(previousEnv));

	it("preserves manual transcript rows through real completion lifecycle on supported terminal hosts", async () => {
		previousEnv = new Map(envKeys.map(key => [key, Bun.env[key]]));
		const cases: Array<{
			label: string;
			env: Partial<Record<(typeof envKeys)[number], string>>;
			resizeHeight?: number;
			nativeWindows?: boolean;
			isProcessTerminal?: boolean;
			initialLoaderMessage?: string;
			noInitialLoader?: boolean;
			initialSpinnerFrames?: string[];
			residualStatus?: boolean;
			expectEmptyLoader?: boolean;
			initialRetryLoader?: boolean;
			testActiveLoaderRetry?: boolean;
			width?: number;
		}> = [
			{ label: "plain-ssh", env: { SSH_CONNECTION: "client server", TERM: "xterm-256color" } },
			{ label: "tmux-default", env: { TMUX: "/tmp/tmux,1,0", TERM: "tmux-256color" } },
			{
				label: "tmux-legacy",
				env: { TMUX: "/tmp/tmux,1,0", TERM: "tmux-256color", PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER: "1" },
			},
			{ label: "termux-height", env: { TERMUX_VERSION: "0.118", TERM: "xterm-256color" }, resizeHeight: 14 },
			{
				label: "windows-markers",
				env: { WT_SESSION: "forwarded", TERM_PROGRAM: "Windows_Terminal", TERM: "xterm-256color" },
			},
			{ label: "native-windows-selector", env: { TERM: "xterm-256color" }, nativeWindows: true },
			{ label: "virtual-terminal", env: { TERM: "xterm-256color" }, isProcessTerminal: false },
			{
				label: "empty-loader",
				env: { TERM: "xterm-256color" },
				initialLoaderMessage: "",
				initialSpinnerFrames: [""],
				expectEmptyLoader: true,
			},
			{ label: "loader-unrelated-status", env: { TERM: "xterm-256color" }, residualStatus: true },
			{
				label: "active-loader-retry-unrelated-status",
				env: { TERM: "xterm-256color" },
				residualStatus: true,
				testActiveLoaderRetry: true,
			},
			{
				label: "virtual-loader-unrelated-status",
				env: { TERM: "xterm-256color" },
				isProcessTerminal: false,
				residualStatus: true,
			},
			{ label: "empty-status", env: { TERM: "xterm-256color" }, noInitialLoader: true },
			{
				label: "no-loader-unrelated-status",
				env: { TERM: "xterm-256color" },
				noInitialLoader: true,
				residualStatus: true,
			},
			{
				label: "retry-unrelated-status",
				env: { TERM: "xterm-256color" },
				noInitialLoader: true,
				residualStatus: true,
				initialRetryLoader: true,
			},
			{
				label: "narrow-tall-retry-short-replacement",
				env: { TERM: "xterm-256color" },
				residualStatus: true,
				testActiveLoaderRetry: true,
				width: 26,
			},
		];

		for (const testCase of cases) {
			for (const clearOnShrink of [false, true]) {
				const scenarioEnv = new Map(envKeys.map(key => [key, Bun.env[key]]));
				for (const key of envKeys) delete Bun.env[key];
				Object.assign(Bun.env, testCase.env);
				Bun.env.GJC_NOTIFY = "off";
				try {
					if (testCase.nativeWindows) {
						expect(shouldUseViewportRepaintForHost({}, "win32", { includeNativeWindows: true })).toBe(true);
					}

					const term = new VirtualTerminal(testCase.width ?? 40, 18, {
						isProcessTerminal: testCase.isProcessTerminal ?? true,
					});
					const ui = new TUI(term);
					ui.setClearOnShrink(clearOnShrink);
					const chatContainer = new Container();
					const startMessage = assistantMessage("streaming assistant response");
					const message = assistantMessage("final assistant response");
					const anchorId = `assistant:test:${testCase.label}:${clearOnShrink}`;
					associateSessionMessageViewportAnchorId(startMessage, anchorId);
					const streamingComponent = new AssistantMessageComponent(startMessage, false, undefined, anchorId);
					const split = new IrcSplitViewComponent(chatContainer, new IrcObservationLedger(), {
						fg: (_color: "dim" | "accent", text: string) => text,
						bold: (text: string) => text,
						boxSharp: { vertical: "│" },
					});
					const pendingMessagesContainer = new Container();
					const statusContainer = new Container();
					const loadingAnimation = testCase.noInitialLoader
						? undefined
						: new Loader(
								ui,
								value => value,
								value => value,
								testCase.initialLoaderMessage ?? "working",
								testCase.initialSpinnerFrames ?? ["|"],
							);
					if (loadingAnimation) statusContainer.addChild(loadingAnimation);
					const residualStatus = testCase.residualStatus ? new Text("independent status", 0, 0) : undefined;
					if (residualStatus) statusContainer.addChild(residualStatus);
					const retryLoader = testCase.initialRetryLoader
						? new Loader(
								ui,
								value => value,
								value => value,
								"retrying",
								["|"],
							)
						: undefined;
					if (retryLoader) statusContainer.addChild(retryLoader);
					const retainedStatus = [residualStatus, retryLoader].filter(
						(component): component is Text | Loader => component !== undefined,
					);
					const todoContainer = new Container();
					const btwContainer = new Container();
					const statusLine = new Text("status", 0, 0);
					const editor = new Text("editor", 0, 0);
					ui.addChild(split);
					ui.setViewportAnchorComponent(split);
					ui.addChild(pendingMessagesContainer);
					ui.addChild(statusContainer);
					ui.addChild(todoContainer);
					ui.addChild(btwContainer);
					ui.addChild(statusLine);
					ui.addChild(editor);
					ui.setBottomPinnedComponent(statusLine);
					const initialFootprint = loadingAnimation?.render(term.columns).map(() => "");
					let expectedFootprint = initialFootprint ?? retryLoader?.render(term.columns).map(() => "");
					if (testCase.expectEmptyLoader) expect(initialFootprint).toEqual([""]);
					let replacementLoader: Loader | undefined;
					let ctx: InteractiveModeContext;
					const ensureLoadingAnimation = (): void => {
						if (ctx.loadingAnimation) return;
						replacementLoader = new Loader(
							ui,
							value => value,
							value => value,
							"working",
							["|"],
						);
						ctx.loadingAnimation = replacementLoader;
						statusContainer.addChild(replacementLoader);
					};
					ctx = {
						isInitialized: true,
						ui,
						chatContainer,
						pendingMessagesContainer,
						statusContainer,
						todoContainer,
						btwContainer,
						statusLine,
						editor: { getText: () => "" },
						getUserMessageText: (userMessage: { content: string }) => userMessage.content,
						streamingComponent,
						streamingMessage: startMessage,
						loadingAnimation,
						ensureLoadingAnimation,
						retryLoader,
						pendingTools: new Map(),
						planModeController: { flushPendingModelSwitch: async () => {} },
						updateEditorTopBorder: () => {},
						updateEditorBorderColor: () => {},
						session: {
							isTtsrAbortPending: false,
							retryAttempt: 0,
							retryNow: () => {},
							abortRetry: () => {},
							isCompacting: true,
							getLastAssistantMessage: () => message,
						},
						sessionManager: { getSessionName: () => "", getCwd: () => process.cwd() },
						isBackgrounded: false,
					} as unknown as InteractiveModeContext;
					const uiHelpers = new UiHelpers(ctx);
					for (let index = 0; index < 30; index++) {
						uiHelpers.addMessageToChat({ role: "user", content: `history-${index}`, timestamp: index + 1 });
					}
					chatContainer.addChild(streamingComponent);
					const controller = new EventController(ctx);
					try {
						ui.start();
						await term.waitForRender();
						expect(ui.scrollViewportPages(-1), `${testCase.label} clear=${clearOnShrink}`).toBe(true);
						await term.flush();
						if (testCase.resizeHeight !== undefined) {
							term.resize(40, testCase.resizeHeight);
							await term.waitForRender();
						}
						const before = term.getViewport().map(line => line.trimEnd());
						const beforeHistory = before.flatMap((line, index) =>
							line.includes("history-") ? [{ index, line }] : [],
						);
						expect(beforeHistory.length, JSON.stringify(before)).toBeGreaterThanOrEqual(3);
						term.clearWriteLog();
						if (testCase.testActiveLoaderRetry) {
							if (!loadingAnimation || !residualStatus) {
								throw new Error("active retry case requires loading and residual status");
							}
							await controller.handleEvent({
								type: "auto_retry_start",
								attempt: 1,
								maxAttempts: 3,
								delayMs: 10_000,
								errorMessage: "retry",
							});
							await term.waitForRender();
							const activeRetryLoader = ctx.retryLoader;
							expect(activeRetryLoader).toBeDefined();
							if (!activeRetryLoader) throw new Error("retry start did not install a loader");
							expect(ctx.loadingAnimation).toBeUndefined();
							const activeReserve = statusContainer.children.find(child => child instanceof StatusRowReserve);
							expect(activeReserve).toBeDefined();
							if (!activeReserve) throw new Error("retry start did not install a status reserve");
							expect(statusContainer.children).toEqual([residualStatus, activeReserve, activeRetryLoader]);
							term.clearWriteLog();

							await controller.handleEvent({ type: "auto_retry_end", success: true, attempt: 1 });
							await term.waitForRender();
							expect(ctx.retryLoader).toBeUndefined();
							const retryFootprint = activeRetryLoader.render(term.columns).map(() => "");
							if (term.isProcessTerminal) {
								expectedFootprint = retryFootprint;
								expect(statusContainer.render(term.columns)).toEqual([
									...residualStatus.render(term.columns),
									...retryFootprint,
								]);
								const afterRetryEnd = term.getViewport().map(line => line.trimEnd());
								for (const entry of beforeHistory) expect(afterRetryEnd[entry.index]).toBe(entry.line);
								for (const entry of beforeHistory) {
									expect(term.getWriteLog().join("")).not.toContain(entry.line);
								}
								// Resumed turn after a successful retry: a fresh working
								// loader appears; the high-water reserve keeps the row
								// budget so neither the resume nor the completion after it
								// contracts the status area.
								ctx.ensureLoadingAnimation();
								await term.waitForRender();
								const resumedLoader = ctx.loadingAnimation;
								expect(resumedLoader).toBeDefined();
								if (!resumedLoader) throw new Error("resume did not install a loader");
								expect(statusContainer.children).toHaveLength(3);
							} else {
								expect(statusContainer.children).toEqual([residualStatus]);
							}
						}
						await controller.handleEvent({ type: "message_end", message });
						expect(getSessionMessageViewportAnchorId(message)).toBe(anchorId);
						await term.waitForRender();
						term.clearWriteLog();
						await controller.handleEvent({ type: "agent_end", messages: [message] });
						await term.waitForRender();
						expect(ctx.loadingAnimation, `${testCase.label} clear=${clearOnShrink}`).toBeUndefined();
						const reserve = statusContainer.children.find(child => child instanceof StatusRowReserve);
						if (term.isProcessTerminal && expectedFootprint) {
							expect(reserve, `${testCase.label} clear=${clearOnShrink}`).toBeDefined();
							expect(statusContainer.children, `${testCase.label} clear=${clearOnShrink}`).toHaveLength(
								residualStatus ? 2 : 1,
							);
							if (residualStatus) expect(statusContainer.children[0]).toBe(residualStatus);
							expect(statusContainer.render(term.columns), `${testCase.label} clear=${clearOnShrink}`).toEqual([
								...(residualStatus ? residualStatus.render(term.columns) : []),
								...expectedFootprint,
							]);
							const after = term.getViewport().map(line => line.trimEnd());
							for (const entry of beforeHistory) expect(after[entry.index]).toBe(entry.line);
							const writes = term.getWriteLog().join("");
							expect(writes).not.toContain("\x1b[2J\x1b[H");
							expect(writes).not.toContain("\x1b[3J");
							for (const entry of beforeHistory) {
								expect(writes, `${testCase.label} clear=${clearOnShrink}`).not.toContain(entry.line);
							}
							const visibleHistoryNumbers = beforeHistory.flatMap(entry => {
								const match = /history-(\d+)/.exec(entry.line);
								return match ? [Number(match[1])] : [];
							});
							const firstVisibleHistory = Math.min(...visibleHistoryNumbers);
							for (let index = 0; index < firstVisibleHistory; index++) {
								expect(writes).not.toMatch(new RegExp(`history-${index}(?!\\d)`));
							}
						} else {
							expect(reserve, `${testCase.label} clear=${clearOnShrink}`).toBeUndefined();
							expect(statusContainer.children, `${testCase.label} clear=${clearOnShrink}`).toEqual(
								retryLoader
									? [residualStatus].filter((component): component is Text => component !== undefined)
									: retainedStatus,
							);
							expect(statusContainer.render(term.columns), `${testCase.label} clear=${clearOnShrink}`).toEqual(
								(retryLoader ? [residualStatus] : retainedStatus)
									.filter((component): component is Text | Loader => component !== undefined)
									.flatMap(component => component.render(term.columns)),
							);
						}
						if (retryLoader) {
							await controller.handleEvent({ type: "agent_start" });
							await term.waitForRender();
							if (!residualStatus) throw new Error("retry ownership case requires residual status");
							await controller.handleEvent({
								type: "auto_retry_start",
								attempt: 1,
								maxAttempts: 3,
								delayMs: 10_000,
								errorMessage: "retry",
							});
							await term.waitForRender();
							const firstRetryLoader = ctx.retryLoader;
							expect(firstRetryLoader).toBeDefined();
							if (!firstRetryLoader) throw new Error("retry start did not install a loader");
							expect(statusContainer.children).toEqual([residualStatus, reserve, firstRetryLoader]);

							await controller.handleEvent({
								type: "auto_retry_start",
								attempt: 2,
								maxAttempts: 3,
								delayMs: 10_000,
								errorMessage: "retry",
							});
							await term.waitForRender();
							const secondRetryLoader = ctx.retryLoader;
							expect(secondRetryLoader).toBeDefined();
							if (!secondRetryLoader) throw new Error("repeated retry start did not replace the loader");
							expect(secondRetryLoader).not.toBe(firstRetryLoader);
							expect(statusContainer.children).toEqual([residualStatus, reserve, secondRetryLoader]);

							await controller.handleEvent({ type: "auto_retry_end", success: true, attempt: 2 });
							await term.waitForRender();
							expect(ctx.retryLoader).toBeUndefined();
							const retryFootprint = secondRetryLoader.render(term.columns).map(() => "");
							if (term.isProcessTerminal) {
								expectedFootprint = retryFootprint;
								expect(statusContainer.render(term.columns)).toEqual([
									...residualStatus.render(term.columns),
									...retryFootprint,
								]);
							} else {
								expect(statusContainer.children).toEqual([residualStatus]);
							}
						}

						if (term.isProcessTerminal && expectedFootprint) {
							const completionChildren = [...statusContainer.children];
							await controller.handleEvent({ type: "agent_end", messages: [message] });
							await term.waitForRender();
							expect(
								statusContainer.children,
								`${testCase.label} clear=${clearOnShrink} duplicate completion`,
							).toEqual(completionChildren);
						}
						term.clearWriteLog();
						await controller.handleEvent({ type: "agent_start" });
						await term.waitForRender();
						expect(replacementLoader, `${testCase.label} clear=${clearOnShrink}`).toBeDefined();
						if (!replacementLoader) throw new Error("agent start did not replace the completion footprint");
						expect(ctx.loadingAnimation, `${testCase.label} clear=${clearOnShrink}`).toBe(replacementLoader);
						if (retryLoader) expect(ctx.retryLoader).toBeUndefined();
						const startReserve = statusContainer.children.find(child => child instanceof StatusRowReserve);
						if (term.isProcessTerminal) {
							expect(startReserve, `${testCase.label} clear=${clearOnShrink} start reserve`).toBeDefined();
						} else {
							expect(startReserve, `${testCase.label} clear=${clearOnShrink} start reserve`).toBeUndefined();
						}
						expect(
							statusContainer.children.filter(child => !(child instanceof StatusRowReserve)),
							`${testCase.label} clear=${clearOnShrink}`,
						).toEqual([...(residualStatus ? [residualStatus] : []), replacementLoader]);
						if (term.isProcessTerminal) {
							// Starting a successor turn must not contract the status area
							// (the fresh short loader can replace a taller reserved
							// status) and must not repaint browsed transcript rows.
							const afterStart = term.getViewport().map(line => line.trimEnd());
							for (const entry of beforeHistory) expect(afterStart[entry.index]).toBe(entry.line);
							const startWrites = term.getWriteLog().join("");
							for (const entry of beforeHistory) {
								expect(startWrites, `${testCase.label} clear=${clearOnShrink} start`).not.toContain(entry.line);
							}
						}
						const rapidEnd = controller.handleEvent({ type: "agent_end", messages: [message] });
						const rapidStart = controller.handleEvent({ type: "agent_start" });
						await Promise.all([rapidEnd, rapidStart]);
						await term.waitForRender();
						expect(
							ctx.loadingAnimation,
							`${testCase.label} clear=${clearOnShrink} rapid lifecycle`,
						).toBeDefined();
						expect(
							statusContainer.children,
							`${testCase.label} clear=${clearOnShrink} rapid lifecycle`,
						).toHaveLength((term.isProcessTerminal ? 1 : 0) + (residualStatus ? 1 : 0) + 1);

						for (let cycle = 0; cycle < 3; cycle++) {
							await controller.handleEvent({ type: "agent_end", messages: [message] });
							await term.waitForRender();
							expect(
								statusContainer.children,
								`${testCase.label} clear=${clearOnShrink} cycle=${cycle} completion`,
							).toHaveLength((term.isProcessTerminal ? 1 : 0) + (residualStatus ? 1 : 0));

							await controller.handleEvent({ type: "agent_start" });
							await term.waitForRender();
							expect(
								ctx.loadingAnimation,
								`${testCase.label} clear=${clearOnShrink} cycle=${cycle} restart`,
							).toBeDefined();
							expect(
								statusContainer.children,
								`${testCase.label} clear=${clearOnShrink} cycle=${cycle} restart`,
							).toHaveLength((term.isProcessTerminal ? 1 : 0) + (residualStatus ? 1 : 0) + 1);
						}

						ctx.loadingAnimation?.stop();
						term.clearWriteLog();
						ui.requestRender();
						await term.waitForRender();
						expect(term.getWriteLog(), `${testCase.label} clear=${clearOnShrink} immediate no-op`).toEqual([]);
					} finally {
						ui.stop();
					}
				} finally {
					restoreEnv(scenarioEnv);
				}
			}
		}
	}, 30_000);
	it("serializes completion before a successor start and ignores duplicate completion effects", async () => {
		const term = new VirtualTerminal(40, 18, { isProcessTerminal: false });
		const ui = new TUI(term);
		const statusContainer = new Container();
		const loadingAnimation = new Loader(
			ui,
			value => value,
			value => value,
			"working",
			["|"],
		);
		statusContainer.addChild(loadingAnimation);
		const flushStarted = Promise.withResolvers<void>();
		const flushGate = Promise.withResolvers<void>();
		let flushes = 0;
		let ctx: InteractiveModeContext;
		const successorTool = new Text("successor tool", 0, 0);
		const ensureLoadingAnimation = (): void => {
			if (ctx.loadingAnimation) return;
			ctx.loadingAnimation = new Loader(
				ui,
				value => value,
				value => value,
				"successor working",
				["|"],
			);
			statusContainer.addChild(ctx.loadingAnimation);
			ctx.pendingTools.set("successor", successorTool as never);
		};
		ctx = {
			isInitialized: true,
			ui,
			chatContainer: new Container(),
			pendingMessagesContainer: new Container(),
			statusContainer,
			statusLine: { invalidate: () => {} },
			editor: { getText: () => "" },
			loadingAnimation,
			ensureLoadingAnimation,
			pendingTools: new Map([["predecessor", new Text("predecessor tool", 0, 0) as never]]),
			planModeController: {
				flushPendingModelSwitch: async () => {
					flushes++;
					flushStarted.resolve();
					await flushGate.promise;
				},
			},
			updateEditorTopBorder: () => {},
			updateEditorBorderColor: () => {},
			session: {
				isCompacting: true,
				getLastAssistantMessage: () => assistantMessage("completed"),
			},
			sessionManager: { getSessionName: () => "", getCwd: () => process.cwd() },
			isBackgrounded: false,
		} as unknown as InteractiveModeContext;

		const controller = new EventController(ctx);
		const ending = controller.handleEvent({ type: "agent_end", messages: [] });
		await flushStarted.promise;
		const starting = controller.handleEvent({ type: "agent_start" });
		await Promise.resolve();
		expect(ctx.loadingAnimation).toBeUndefined();

		flushGate.resolve();
		await Promise.all([ending, starting]);
		expect(ctx.loadingAnimation).toBeDefined();
		expect(ctx.pendingTools.has("predecessor")).toBe(false);
		expect(ctx.pendingTools.has("successor")).toBe(true);

		await controller.handleEvent({ type: "agent_end", messages: [] });
		expect(flushes).toBe(2);
		await controller.handleEvent({ type: "agent_end", messages: [] });
		expect(flushes).toBe(2);
		ctx.loadingAnimation?.stop();
	});
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
	it("does not starve live events while a tool handler awaits plan approval", async () => {
		const term = new VirtualTerminal(40, 12, { isProcessTerminal: false });
		const ui = new TUI(term);
		const approvalGate = Promise.withResolvers<void>();
		const ctx = {
			isInitialized: true,
			ui,
			chatContainer: new Container(),
			pendingMessagesContainer: new Container(),
			statusContainer: new Container(),
			statusLine: { invalidate: () => {} },
			editor: { getText: () => "" },
			ensureLoadingAnimation: () => {},
			pendingTools: new Map(),
			planModeController: {
				flushPendingModelSwitch: async () => {},
				handleApproval: async () => {
					await approvalGate.promise;
				},
			},
			updateEditorTopBorder: () => {},
			updateEditorBorderColor: () => {},
			toolOutputExpanded: false,
			session: {
				isCompacting: true,
				getToolByName: () => undefined,
				getLastAssistantMessage: () => assistantMessage("completed"),
			},
			sessionManager: { getSessionName: () => "", getCwd: () => process.cwd() },
			isBackgrounded: false,
		} as unknown as InteractiveModeContext;
		const controller = new EventController(ctx);

		const approval = controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "approval-1",
			toolName: "resolve",
			isError: false,
			result: {
				content: [],
				details: {
					sourceToolName: "plan_approval",
					action: "apply",
					sourceResultDetails: { planFilePath: "local://PLAN.md" },
				},
			},
		} as never);
		let approvalSettled = false;
		approval.then(() => {
			approvalSettled = true;
		});

		// While the approval handler is parked on user interaction, live events
		// and the lifecycle lane must still be processed to completion.
		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "other",
			partialResult: { content: [] },
		} as never);
		await controller.handleEvent({ type: "agent_start" } as never);
		await controller.handleEvent({ type: "agent_end", messages: [] } as never);
		expect(approvalSettled).toBe(false);

		approvalGate.resolve();
		await approval;
	});
	it("ignores a stale completion that arrives after a successor turn starts", async () => {
		const term = new VirtualTerminal(40, 12, { isProcessTerminal: true });
		const ui = new TUI(term);
		const statusContainer = new Container();
		const sessionState = { isStreaming: false };
		let ctx: InteractiveModeContext;
		const ensureLoadingAnimation = (): void => {
			if (ctx.loadingAnimation) return;
			ctx.loadingAnimation = new Loader(
				ui,
				value => value,
				value => value,
				"working",
				["|"],
			);
			statusContainer.addChild(ctx.loadingAnimation);
		};
		ctx = {
			isInitialized: true,
			ui,
			chatContainer: new Container(),
			pendingMessagesContainer: new Container(),
			statusContainer,
			statusLine: { invalidate: () => {} },
			editor: { getText: () => "" },
			ensureLoadingAnimation,
			pendingTools: new Map(),
			planModeController: { flushPendingModelSwitch: async () => {} },
			updateEditorTopBorder: () => {},
			updateEditorBorderColor: () => {},
			session: {
				isCompacting: true,
				get isStreaming() {
					return sessionState.isStreaming;
				},
				getLastAssistantMessage: () => assistantMessage("completed"),
			},
			sessionManager: { getSessionName: () => "", getCwd: () => process.cwd() },
			isBackgrounded: false,
		} as unknown as InteractiveModeContext;
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "agent_end", messages: [] });
		await controller.handleEvent({ type: "agent_start" });
		const successorLoader = ctx.loadingAnimation;
		expect(successorLoader).toBeDefined();
		const successorTool = new Text("successor tool", 0, 0);
		ctx.pendingTools.set("successor", successorTool as never);

		// A duplicate of the previous turn's completion arrives after the
		// successor already started and is actively streaming.
		sessionState.isStreaming = true;
		await controller.handleEvent({ type: "agent_end", messages: [] });
		expect(ctx.loadingAnimation, "stale end must not stop the successor loader").toBe(successorLoader);
		expect(ctx.pendingTools.has("successor")).toBe(true);

		// The successor's own completion still lands normally.
		sessionState.isStreaming = false;
		await controller.handleEvent({ type: "agent_end", messages: [] });
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(ctx.pendingTools.has("successor")).toBe(false);
		successorLoader?.stop();
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
});
