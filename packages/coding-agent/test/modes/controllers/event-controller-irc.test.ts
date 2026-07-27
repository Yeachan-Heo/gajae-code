import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext, IrcArrivalSnapshot } from "@gajae-code/coding-agent/modes/types";
import { parseIrcMessage } from "@gajae-code/coding-agent/modes/utils/irc-message";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import type { CustomMessage } from "@gajae-code/coding-agent/session/messages";
import { Container, Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

beforeAll(() => initTheme());

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function message(observationId: string, timestamp: number, text = "hello"): CustomMessage {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: text,
		display: true,
		details: { observationId, from: "peer", message: text },
		attribution: "agent",
		timestamp,
	};
}

function makeContext(arrival: IrcArrivalSnapshot) {
	const chatContainer = new Container();
	const requestRender = vi.fn();
	const recordVisibleTranscriptMutation = vi.fn();
	const captureIrcArrivalSnapshot = vi.fn(() => arrival);
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender, terminal: { columns: 80 } },
		chatContainer,
		ircLedger: new IrcObservationLedger(),
		session: {},
		captureIrcArrivalSnapshot,
		recordVisibleTranscriptMutation,
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	ctx.removeRenderedIrcInlineComponents = observationId => helpers.removeRenderedIrcInlineComponents(observationId);
	ctx.resetRenderedIrcInlineComponents = () => helpers.resetRenderedIrcInlineComponents();
	const addLiveIrcObservationToChat = vi.fn(
		(item: Parameters<InteractiveModeContext["addLiveIrcObservationToChat"]>[0], snapshot: IrcArrivalSnapshot) =>
			helpers.addLiveIrcObservationToChat(item, snapshot),
	);
	ctx.addLiveIrcObservationToChat = addLiveIrcObservationToChat;
	return {
		ctx,
		chatContainer,
		requestRender,
		recordVisibleTranscriptMutation,
		addLiveIrcObservationToChat,
		captureIrcArrivalSnapshot,
	};
}
function integratedSidebarStage(historyRows: number) {
	const columns = 100;
	const rows = 24;
	const ledger = new IrcObservationLedger();
	const transcript = new Container();
	for (let index = 0; index < historyRows; index++) {
		const row = new Text(`history row ${index}`, 0, 0);
		transcript.addChild(row);
		transcript.setViewportAnchorSource(row, { id: `row-${index}` });
	}
	const split = new IrcSplitViewComponent(transcript, ledger, {
		fg: (_color, text) => text,
		bold: text => text,
		boxSharp: { vertical: "|" },
	});
	split.setVisible(true);
	const status = new Text("status: pinned", 0, 0);
	const editor = new Text("> editor: pinned", 0, 0);
	const terminal = new VirtualTerminal(columns, rows, { isProcessTerminal: true });
	const tui = new TUI(terminal);
	tui.addChild(split);
	tui.setViewportAnchorComponent(split);
	tui.addChild(status);
	tui.addChild(editor);
	tui.setBottomPinnedComponent(status);

	let revision = 0n;
	const recordVisibleTranscriptMutation = vi.fn(() => {
		revision += 1n;
		tui.setViewportOutputSource({ identity: "session:integrated", revision });
	});

	const arrival: IrcArrivalSnapshot = {
		panelVisible: true,
		panelRequestedVisible: true,
		sidebarAvailable: true,
		resolvedToggleKey: "Ctrl+I",
	};
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: tui,
		chatContainer: transcript,
		ircLedger: ledger,
		session: {},
		captureIrcArrivalSnapshot: vi.fn(() => arrival),
		recordVisibleTranscriptMutation,
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	ctx.addLiveIrcObservationToChat = vi.fn((item, snapshot) => helpers.addLiveIrcObservationToChat(item, snapshot));
	ctx.removeRenderedIrcInlineComponents = observationId => helpers.removeRenderedIrcInlineComponents(observationId);
	ctx.resetRenderedIrcInlineComponents = () => helpers.resetRenderedIrcInlineComponents();
	const controller = new EventController(ctx);
	return {
		controller,
		tui,
		terminal,
		split,
		recordVisibleTranscriptMutation,
		getRevision: () => revision,
	};
}

describe("EventController IRC observations", () => {
	it("renders same-timestamp distinct observations and deduplicates persisted delivery", async () => {
		const { ctx, chatContainer, addLiveIrcObservationToChat, captureIrcArrivalSnapshot } = makeContext({
			panelVisible: false,
			panelRequestedVisible: false,
			sidebarAvailable: true,
			resolvedToggleKey: "Ctrl+I",
		});
		const controller = new EventController(ctx);
		const first = message("one", 1, "first");
		const second = message("two", 1, "second");

		await controller.handleEvent({ type: "irc_message", message: first });
		await controller.handleEvent({ type: "irc_message", message: second });
		await controller.handleEvent({ type: "message_start", message: first });

		expect(addLiveIrcObservationToChat).toHaveBeenCalledTimes(2);
		expect(captureIrcArrivalSnapshot).toHaveBeenCalledTimes(3);
		expect(chatContainer.children).toHaveLength(4);
	});

	it("advances the transcript revision exactly once when an ephemeral inline observation expires", async () => {
		vi.useFakeTimers({ now: 0 });
		const { ctx, chatContainer, recordVisibleTranscriptMutation } = makeContext({
			panelVisible: true,
			panelRequestedVisible: true,
			sidebarAvailable: true,
			resolvedToggleKey: "Ctrl+I",
		});
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "irc_message", message: message("ephemeral", 0) });
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(9_999);
		expect(chatContainer.children).toHaveLength(2);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(chatContainer.children).toHaveLength(0);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(10_000);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(2);
	});

	it("does not advance the transcript revision when a canceled expiry removes nothing", async () => {
		vi.useFakeTimers({ now: 0 });
		const { ctx, recordVisibleTranscriptMutation } = makeContext({
			panelVisible: true,
			panelRequestedVisible: true,
			sidebarAvailable: true,
			resolvedToggleKey: "Ctrl+I",
		});
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "irc_message", message: message("canceled-expiry", 0) });
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);

		controller.resetIrcObservations();
		vi.advanceTimersByTime(10_000);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
	});

	it("treats a requested sidebar that cannot render at narrow width as a persistent arrival", async () => {
		vi.useFakeTimers({ now: 0 });
		const { ctx, chatContainer } = makeContext({
			panelVisible: false,
			panelRequestedVisible: false,
			sidebarAvailable: true,
			resolvedToggleKey: "Ctrl+I",
		});
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "irc_message", message: message("narrow", 0) });

		vi.advanceTimersByTime(10_000);
		expect(chatContainer.children).toHaveLength(2);
	});

	it("uses a closed arrival snapshot for persistent rendering even after a later toggle", async () => {
		vi.useFakeTimers({ now: 0 });
		let arrival: IrcArrivalSnapshot = {
			panelVisible: false,
			panelRequestedVisible: false,
			sidebarAvailable: true,
			resolvedToggleKey: "Ctrl+I",
		};
		const { ctx, chatContainer } = makeContext(arrival);
		ctx.captureIrcArrivalSnapshot = vi.fn(() => arrival);
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "irc_message", message: message("persistent", 0) });

		arrival = { ...arrival, panelVisible: true };
		vi.advanceTimersByTime(10_000);
		expect(chatContainer.children).toHaveLength(2);
	});

	it("coalesces sidebar semantic changes and inline mutations into one visible mutation", async () => {
		const arrival: IrcArrivalSnapshot = {
			panelVisible: true,
			panelRequestedVisible: true,
			sidebarAvailable: true,
			resolvedToggleKey: "Ctrl+I",
		};
		const { ctx, recordVisibleTranscriptMutation } = makeContext(arrival);
		ctx.addLiveIrcObservationToChat = vi.fn(() => []);
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "irc_message", message: message("sidebar-only", 1) });
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		await controller.handleEvent({ type: "irc_message", message: message("sidebar-only", 1) });
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);

		const { ctx: inlineContext, recordVisibleTranscriptMutation: inlineMutation } = makeContext(arrival);
		inlineContext.addLiveIrcObservationToChat = vi.fn(() => [new Container()]);
		const inlineController = new EventController(inlineContext);
		try {
			await inlineController.handleEvent({ type: "irc_message", message: message("inline", 2) });
			expect(inlineMutation).toHaveBeenCalledTimes(1);
		} finally {
			inlineController.clearIrcExpiryTimers();
		}

		const { ctx: evictionContext, recordVisibleTranscriptMutation: evictionMutation } = makeContext(arrival);
		evictionContext.addLiveIrcObservationToChat = vi.fn(() => []);
		for (let index = 0; index < 10_000; index++) {
			evictionContext.ircLedger.observe(
				{
					observationId: `retained-${index}`,
					kind: "incoming",
					from: "peer",
					to: "you",
					text: `retained ${index}`,
					timestamp: index,
				},
				false,
			);
		}
		await new EventController(evictionContext).handleEvent({
			type: "irc_message",
			message: message("evicts-oldest", 3),
		});
		expect(evictionMutation).toHaveBeenCalledTimes(1);
	});

	it("does not report a sidebar-only mutation while the sidebar is hidden or narrow", async () => {
		for (const arrival of [
			{ panelVisible: false, panelRequestedVisible: false, sidebarAvailable: true, resolvedToggleKey: "Ctrl+I" },
			{ panelVisible: false, panelRequestedVisible: true, sidebarAvailable: true, resolvedToggleKey: "Ctrl+I" },
		] satisfies IrcArrivalSnapshot[]) {
			const { ctx, recordVisibleTranscriptMutation } = makeContext(arrival);
			ctx.ui.terminal = { columns: 64 } as typeof ctx.ui.terminal;
			ctx.addLiveIrcObservationToChat = vi.fn(() => []);
			await new EventController(ctx).handleEvent({
				type: "irc_message",
				message: message(`hidden-${arrival.panelRequestedVisible}`, 1),
			});
			expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
		}
	});
});
describe("EventController live IRC integrated TUI regression", () => {
	it("preserves a manual sticky viewport and pinned rails through the production IRC pipeline", async () => {
		const { controller, tui, terminal, split, recordVisibleTranscriptMutation, getRevision } =
			integratedSidebarStage(36);
		try {
			tui.setViewportOutputSource({ identity: "session:integrated", revision: 0n });
			tui.start();
			await terminal.waitForRender();

			// Enter a known non-edge manual stable viewport (in history, not the live edge).
			expect(tui.scrollViewportBy(-6, { pin: "stable" })).toBe(true);
			await terminal.waitForRender();

			const beforeFrame = terminal.getViewport();
			const manualTopRow = beforeFrame[0];
			expect(manualTopRow).toContain("history row 8");
			expect(beforeFrame.join("\n")).not.toContain("New output — type to follow");
			expect(split.renderWithViewportAnchors(terminal.columns).lines.join("\n")).not.toContain("live sidebar only");

			// Deliver through production EventController and UiHelpers; the visible sidebar and
			// ephemeral inline rows share one coalesced semantic revision.
			const observation = message("live-sidebar", 1, "live sidebar only");
			await controller.handleEvent({ type: "irc_message", message: observation });
			await terminal.waitForRender();

			// Callback wiring and TUI semantic revision advance exactly once.
			expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
			expect(getRevision()).toBe(1n);

			// A duplicate delivery records zero additional mutations.
			await controller.handleEvent({ type: "irc_message", message: observation });
			await terminal.waitForRender();
			expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
			expect(getRevision()).toBe(1n);

			const afterFrame = terminal.getViewport();
			// Left historical top/sentinel remains stable despite the notice-capacity change.
			expect(afterFrame[0]).toBe(manualTopRow);
			// The exact manual-output notice appears at the transcript/suffix boundary.
			expect(afterFrame[21]).toContain("New output — type to follow");
			// Pinned rails remain visible.
			expect(afterFrame[22]).toContain("status: pinned");
			expect(afterFrame[23]).toContain("> editor: pinned");
			// The right sidebar and production inline projection both include the live output.
			expect(split.renderWithViewportAnchors(terminal.columns).lines.join("\n")).toContain("live sidebar only");
			// No follow-live/jump: a row only visible at the live-edge bottom is absent.
			expect(afterFrame.join("\n")).not.toContain("history row 35");
		} finally {
			controller.clearIrcExpiryTimers();
			tui.stop();
		}
	});
});

describe("parseIrcMessage UI sanitization", () => {
	it("strips terminal controls from fields while preserving tabs and newlines", () => {
		const parsed = parseIrcMessage({
			role: "custom",
			customType: "irc:relay",
			content: "",
			display: true,
			attribution: "agent",
			timestamp: 1,
			details: {
				from: "peer\x1b]8;;https://example.test\x1b\\name\x1b]8;;\x1b\\",
				to: "you\x1bPqpayload\x1b\\",
				body: "first\tline\nsecond\x1b[31m line",
			},
		} as CustomMessage);

		expect(parsed).toMatchObject({ from: "peername", to: "you", text: "first\tline\nsecond line" });
	});

	it("uses the current time when an IRC timestamp is malformed", () => {
		const now = 1_234_567_890;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const parsed = parseIrcMessage({
			role: "custom",
			customType: "irc:incoming",
			content: "",
			display: true,
			attribution: "agent",
			timestamp: Number.NaN,
			details: { from: "peer", message: "hello" },
		} as CustomMessage);

		expect(parsed?.timestamp).toBe(now);
	});
});
