import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";

import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { getWelcomeTranscriptReservedRows } from "@gajae-code/coding-agent/modes/interactive-mode";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { getThemeByName, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { Container, Text } from "@gajae-code/tui";

function createForkContext(fork: () => Promise<boolean>) {
	const chatContainer = new Container();
	const ledger = new IrcObservationLedger();
	let sidebarRequestedVisible = true;
	const panelVisible = true;

	const ctx = {
		session: {
			isStreaming: false,
			fork,
			sessionFile: "/tmp/sessions/fork.jsonl",
		},
		isInitialized: true,
		loadingAnimation: undefined,
		statusContainer: { clear: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		chatContainer,
		pendingTools: new Map<string, never>(),

		ircLedger: ledger,
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
		showWarning: vi.fn(),
		captureIrcArrivalSnapshot: () => ({
			panelVisible,

			panelRequestedVisible: sidebarRequestedVisible,
			sidebarAvailable: true,
			resolvedToggleKey: "Ctrl+I",
		}),
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	ctx.addLiveIrcObservationToChat = (message, arrival) => helpers.addLiveIrcObservationToChat(message, arrival);
	ctx.removeRenderedIrcInlineComponents = observationId => helpers.removeRenderedIrcInlineComponents(observationId);
	ctx.resetRenderedIrcInlineComponents = () => helpers.resetRenderedIrcInlineComponents();
	let controller: EventController;
	ctx.resetIrcSidebarSession = () => {
		ledger.reset();
		controller.resetIrcObservations();
		sidebarRequestedVisible = false;
		helpers.resetIrcSidebarHint();
	};
	controller = new EventController(ctx);
	return {
		ctx,
		helpers,
		chatContainer,
		ledger,
		controller,
		isSidebarRequestedVisible: () => sidebarRequestedVisible,
	};
}

afterEach(() => vi.useRealTimers());

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

describe("bounded IRC inline projection", () => {
	it.each([false, true])("bounds near-budget live and rebuilt bodies when panelVisible=%s", panelVisible => {
		const chatContainer = new Container();
		const helpers = new UiHelpers({ chatContainer } as InteractiveModeContext);
		const message = {
			observationId: `inline-budget-${panelVisible}`,
			kind: "incoming" as const,
			from: "peer",
			to: "you",
			text: "x".repeat(15 * 1_024 * 1_024),
			timestamp: 1,
		};
		helpers.addLiveIrcObservationToChat(message, {
			panelVisible,
			panelRequestedVisible: panelVisible,
			sidebarAvailable: true,
			resolvedToggleKey: null,
		});
		const live = chatContainer.render(80);
		expect(live.length).toBeLessThanOrEqual(2_050);
		expect(Bun.stripANSI(live.join("\n"))).toContain("… message elided …");

		chatContainer.clear();
		helpers.addRebuiltIrcObservationToChat(message);
		const rebuilt = chatContainer.render(80);
		expect(rebuilt.length).toBeLessThanOrEqual(2_050);
		expect(Bun.stripANSI(rebuilt.join("\n"))).toContain("… message elided …");
	});
});

const incoming = {
	observationId: "hint",
	kind: "incoming" as const,
	from: "peer",
	to: "you",
	text: "hello",
	timestamp: 0,
};
const eligibleArrival = {
	panelVisible: false,
	panelRequestedVisible: false,
	sidebarAvailable: true,
	resolvedToggleKey: "Ctrl+I",
};

function transcriptIncludesHint(chatContainer: Container): boolean {
	return Bun.stripANSI(chatContainer.render(100).join("\n")).includes("opens sidebar");
}

describe("IRC lifecycle resets", () => {
	it("releases real IRC owners after a successful fork and rejects its delayed replay", async () => {
		vi.useFakeTimers({ now: 0 });
		const fixture = createForkContext(async () => true);
		const message = {
			role: "custom" as const,
			customType: "irc:incoming" as const,
			content: "before fork",
			display: true,
			attribution: "agent" as const,
			timestamp: 0,
			details: { observationId: "before-fork", from: "peer", to: "you", message: "before fork" },
		};

		await fixture.controller.handleEvent({ type: "irc_message", message });
		expect(fixture.ledger.getSidebarRecords()).toHaveLength(1);
		expect(fixture.chatContainer.children).toHaveLength(2);
		fixture.chatContainer.clear();
		fixture.helpers.renderSessionContext({ messages: [] } as never);
		fixture.controller.reconcileIrcExpiryTimers(fixture.helpers.getRenderedIrcInlineComponents());
		expect(fixture.helpers.getRenderedIrcInlineComponents().has("before-fork")).toBe(true);

		await new CommandController(fixture.ctx).handleForkCommand();
		expect(fixture.ledger.getSidebarRecords()).toEqual([]);
		expect(Bun.stripANSI(fixture.chatContainer.render(100).join("\n"))).not.toContain("before fork");
		expect(fixture.helpers.getRenderedIrcInlineComponents()).toEqual(new Map());
		expect(fixture.isSidebarRequestedVisible()).toBe(false);
		const postForkChildCount = fixture.chatContainer.children.length;

		await fixture.controller.handleEvent({ type: "irc_message", message });
		expect(fixture.ledger.getSidebarRecords()).toEqual([]);
		expect(fixture.chatContainer.children).toHaveLength(postForkChildCount);
		expect(Bun.stripANSI(fixture.chatContainer.render(100).join("\n"))).not.toContain("before fork");
	});

	it("preserves real IRC ownership when a fork is cancelled or fails", async () => {
		const message = {
			role: "custom" as const,
			customType: "irc:incoming" as const,
			content: "still here",
			display: true,
			attribution: "agent" as const,
			timestamp: 0,
			details: { observationId: "still-here", from: "peer", to: "you", message: "still here" },
		};
		const cancelled = createForkContext(async () => false);
		await cancelled.controller.handleEvent({ type: "irc_message", message });
		await new CommandController(cancelled.ctx).handleForkCommand();
		expect(cancelled.ledger.getSidebarRecords()).toHaveLength(1);
		expect(cancelled.chatContainer.children).toHaveLength(2);
		expect(cancelled.isSidebarRequestedVisible()).toBe(true);

		const failed = createForkContext(async () => Promise.reject(new Error("disk failure")));
		await failed.controller.handleEvent({
			type: "irc_message",
			message: { ...message, details: { ...message.details, observationId: "failed" } },
		});
		await expect(new CommandController(failed.ctx).handleForkCommand()).rejects.toThrow("disk failure");
		expect(failed.ledger.getSidebarRecords()).toHaveLength(1);
		expect(failed.chatContainer.children).toHaveLength(2);
		expect(failed.isSidebarRequestedVisible()).toBe(true);
	});

	it("expires only ephemeral inline owners while retaining the sidebar observation and dedup identity", async () => {
		vi.useFakeTimers({ now: 0 });
		const fixture = createForkContext(async () => true);
		const message = {
			role: "custom" as const,
			customType: "irc:incoming" as const,
			content: "visible arrival",
			display: true,
			attribution: "agent" as const,
			timestamp: 0,
			details: { observationId: "expires-inline-only", from: "peer", to: "you", message: "visible arrival" },
		};
		await fixture.controller.handleEvent({ type: "irc_message", message });
		fixture.chatContainer.clear();
		fixture.helpers.renderSessionContext({ messages: [] } as never);
		fixture.controller.reconcileIrcExpiryTimers(fixture.helpers.getRenderedIrcInlineComponents());

		vi.advanceTimersByTime(10_000);
		expect(fixture.ledger.getSidebarRecords().map(record => record.observationId)).toEqual(["expires-inline-only"]);
		expect(fixture.helpers.getRenderedIrcInlineComponents().has("expires-inline-only")).toBe(false);
		expect(fixture.chatContainer.children).toHaveLength(0);

		await fixture.controller.handleEvent({ type: "irc_message", message });
		expect(fixture.chatContainer.children).toHaveLength(0);
		expect(fixture.ledger.getSidebarRecords()).toHaveLength(1);
	});

	it("bounds the ledger by count with deterministic oldest-first eviction and insertion order", () => {
		const ledger = new IrcObservationLedger();
		for (let index = 0; index <= 10_000; index++) {
			ledger.observe(
				{ observationId: `count-${index}`, kind: "incoming", from: "peer", to: "you", text: "x", timestamp: index },
				false,
			);
		}

		const records = ledger.getSidebarRecords();
		expect(records).toHaveLength(10_000);
		expect(records[0]?.observationId).toBe("count-1");
		expect(records.at(-1)?.observationId).toBe("count-10000");
		expect(ledger.drainEvictedObservationIds()).toEqual(["count-0"]);
	});

	it("never resurrects an evicted identity after more than the retained-count window", () => {
		const ledger = new IrcObservationLedger();
		for (let index = 0; index <= 20_000; index++) {
			ledger.observe(
				{
					observationId: `replay-${index}`,
					kind: "incoming",
					from: "peer",
					to: "you",
					text: "x",
					timestamp: index,
				},
				false,
			);
		}

		expect(ledger.getRecord("replay-0")).toBeUndefined();
		expect(
			ledger.observe(
				{
					observationId: "replay-0",
					kind: "incoming",
					from: "peer",
					to: "you",
					text: "resurrected",
					timestamp: 30_000,
				},
				false,
			),
		).toBeUndefined();
		expect(ledger.getSidebarRecords().some(record => record.text === "resurrected")).toBe(false);
	});

	it("keeps distinct lone-surrogate observation IDs distinct in replay suppression", () => {
		const ledger = new IrcObservationLedger();
		const first = ledger.observe(
			{ observationId: "\uD800", kind: "incoming", from: "peer", to: "you", text: "first", timestamp: 1 },
			false,
		);
		const second = ledger.observe(
			{ observationId: "\uD801", kind: "incoming", from: "peer", to: "you", text: "second", timestamp: 2 },
			false,
		);

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(ledger.getSidebarRecords().map(record => record.text)).toEqual(["first", "second"]);
	});

	it("fails closed after the bounded unique-identity capacity is exhausted", () => {
		const ledger = new IrcObservationLedger();
		for (let index = 0; index < 100_000; index++) {
			ledger.observe(
				{
					observationId: `capacity-${index}`,
					kind: "incoming",
					from: "peer",
					to: "you",
					text: "x",
					timestamp: index,
				},
				false,
			);
		}

		expect(
			ledger.observe(
				{
					observationId: "capacity-overflow",
					kind: "incoming",
					from: "peer",
					to: "you",
					text: "new",
					timestamp: 100_000,
				},
				false,
			),
		).toBeUndefined();
		expect(ledger.getSidebarRecords().at(-1)?.observationId).toBe("capacity-99999");
	});

	it("bounds the ledger by retained UTF-8 payload bytes with deterministic eviction", () => {
		const ledger = new IrcObservationLedger();
		const payload = "b".repeat(9 * 1024 * 1024);
		ledger.observe(
			{ observationId: "bytes-first", kind: "incoming", from: "peer", to: "you", text: payload, timestamp: 0 },
			false,
		);
		ledger.observe(
			{ observationId: "bytes-second", kind: "incoming", from: "peer", to: "you", text: payload, timestamp: 1 },
			false,
		);

		expect(ledger.getSidebarRecords().map(record => record.observationId)).toEqual(["bytes-second"]);
		expect(ledger.drainEvictedObservationIds()).toEqual(["bytes-first"]);
	});

	it("rejects oversized payloads without retaining their bytes and preserves first-arrival duplicates", () => {
		const ledger = new IrcObservationLedger();
		const oversizedText = "oversized-original-payload".repeat(1024 * 1024);
		expect(
			ledger.observe(
				{
					observationId: "oversized",
					kind: "incoming",
					from: "peer",
					to: "you",
					text: oversizedText,
					timestamp: 0,
				},
				false,
			),
		).toBeUndefined();
		expect(ledger.getSidebarRecords()).toEqual([]);
		expect(JSON.stringify(ledger.getSidebarRecords())).not.toContain("oversized-original-payload");

		const first = ledger.observe(
			{ observationId: "duplicate", kind: "incoming", from: "first", to: "you", text: "first", timestamp: 1 },
			false,
		);
		const duplicate = ledger.observe(
			{ observationId: "duplicate", kind: "incoming", from: "second", to: "you", text: "second", timestamp: 2 },
			true,
		);
		expect(duplicate).toBe(first);
		expect(ledger.getSidebarRecords().map(record => [record.observationId, record.from, record.text])).toEqual([
			["duplicate", "first", "first"],
		]);
	});

	it("re-arms the live-only sidebar hint after a successful fork reset", async () => {
		const { ctx, helpers, chatContainer } = createForkContext(async () => true);
		helpers.addLiveIrcObservationToChat(incoming, eligibleArrival);
		expect(transcriptIncludesHint(chatContainer)).toBe(true);

		await new CommandController(ctx).handleForkCommand();
		chatContainer.clear();
		helpers.addLiveIrcObservationToChat({ ...incoming, observationId: "hint-after-fork" }, eligibleArrival);
		expect(transcriptIncludesHint(chatContainer)).toBe(true);
	});

	it("reserves welcome rows from the transcript instead of the rendered IRC split", () => {
		const transcript = new Container();
		transcript.addChild(new Text("transcript\nrow"));
		const transcriptReservation = getWelcomeTranscriptReservedRows(transcript, 80);
		const ledger = new IrcObservationLedger();
		for (let index = 0; index < 50; index++) {
			ledger.observe(
				{
					observationId: `backlog-${index}`,
					kind: "incoming",
					from: "peer",
					to: "you",
					text: "one\ntwo",
					timestamp: index,
				},
				false,
			);
		}
		const split = new IrcSplitViewComponent(transcript, ledger, () => theme);
		split.setVisible(true);

		expect(split.render(80).length).toBeGreaterThan(transcriptReservation);
		expect(getWelcomeTranscriptReservedRows(transcript, 80)).toBe(transcriptReservation);
	});
});
