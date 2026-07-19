import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { Container, Loader, Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { assistantMessage } from "./completion-fixtures";

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme();
});

afterAll(() => resetSettingsForTest());

describe("EventController lifecycle ordering", () => {
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
});
