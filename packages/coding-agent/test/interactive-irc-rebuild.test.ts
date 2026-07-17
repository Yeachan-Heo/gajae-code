import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@gajae-code/coding-agent/session/session-manager";
import { Container } from "@gajae-code/tui";

beforeAll(() => initTheme());
afterEach(() => vi.useRealTimers());

function makeContext() {
	const chatContainer = new Container();
	const ledger = new IrcObservationLedger();
	const ctx = {
		chatContainer,
		pendingTools: new Map(),
		ircLedger: ledger,
		ui: { requestRender: vi.fn() },
		session: {},
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	ctx.removeRenderedIrcInlineComponents = observationId => helpers.removeRenderedIrcInlineComponents(observationId);
	ctx.resetRenderedIrcInlineComponents = () => helpers.resetRenderedIrcInlineComponents();
	ctx.addMessageToChat = message => helpers.addMessageToChat(message);
	ctx.getUserMessageText = message => helpers.getUserMessageText(message);
	return { ctx, ledger, helpers, chatContainer };
}

const emptyContext = { messages: [] } as unknown as SessionContext;

const incoming = {
	observationId: "inline",
	kind: "incoming" as const,
	from: "peer",
	to: "you",
	text: "first line\nsecond line",
	timestamp: 0,
};

const eligibleArrival = {
	panelVisible: false,
	panelRequestedVisible: false,
	sidebarAvailable: true,
	resolvedToggleKey: "Ctrl+I",
};

it("renders rebuilt IRC observations as one header and one multiline body without consuming the live hint", () => {
	const { helpers, chatContainer } = makeContext();
	const rebuilt = vi.spyOn(helpers, "addRebuiltIrcObservationToChat");
	const live = vi.spyOn(helpers, "addLiveIrcObservationToChat");

	const rebuiltComponents = helpers.addRebuiltIrcObservationToChat(incoming);
	expect(rebuiltComponents).toHaveLength(2);
	expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).not.toContain("opens sidebar");

	chatContainer.clear();
	const liveComponents = helpers.addLiveIrcObservationToChat(incoming, eligibleArrival);
	expect(liveComponents).toHaveLength(2);
	expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("Ctrl+I opens sidebar");
	expect(rebuilt).toHaveBeenCalledTimes(1);
	expect(live).toHaveBeenCalledTimes(1);
});

it("does not consume the hint for visible or unavailable live arrivals", () => {
	const { helpers, chatContainer } = makeContext();
	helpers.addLiveIrcObservationToChat(incoming, { ...eligibleArrival, panelVisible: true });
	helpers.addLiveIrcObservationToChat(
		{ ...incoming, observationId: "unavailable" },
		{
			...eligibleArrival,
			sidebarAvailable: false,
		},
	);
	chatContainer.clear();

	helpers.addLiveIrcObservationToChat({ ...incoming, observationId: "eligible" }, eligibleArrival);
	expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("Ctrl+I opens sidebar");
});

it("suppresses the sidebar hint for an unbound toggle without consuming a later eligible hint", () => {
	const { helpers, chatContainer } = makeContext();
	helpers.addLiveIrcObservationToChat(incoming, { ...eligibleArrival, resolvedToggleKey: null });
	expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).not.toContain("opens sidebar");

	chatContainer.clear();
	helpers.addLiveIrcObservationToChat(
		{ ...incoming, observationId: "empty" },
		{ ...eligibleArrival, resolvedToggleKey: "" },
	);
	expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).not.toContain("opens sidebar");

	chatContainer.clear();
	helpers.addLiveIrcObservationToChat({ ...incoming, observationId: "bound" }, eligibleArrival);
	expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("Ctrl+I opens sidebar");
});

it("uses the rebuild-only API for ledger projection", () => {
	const { ledger, helpers } = makeContext();
	ledger.observe(incoming, false);
	const rebuilt = vi.spyOn(helpers, "addRebuiltIrcObservationToChat");
	const live = vi.spyOn(helpers, "addLiveIrcObservationToChat");

	helpers.renderSessionContext(emptyContext);

	expect(rebuilt).toHaveBeenCalledWith(expect.objectContaining({ observationId: "inline" }));
	expect(live).not.toHaveBeenCalled();
});

describe("IRC rebuild projection", () => {
	it("keeps the remaining absolute TTL when a rebuild reconciles its timer", () => {
		vi.useFakeTimers({ now: 0 });
		const { ctx, ledger, helpers, chatContainer } = makeContext();
		ledger.observe(
			{ observationId: "ephemeral", kind: "incoming", from: "peer", to: "you", text: "hello", timestamp: 0 },
			true,
		);
		vi.advanceTimersByTime(4_000);
		helpers.renderSessionContext(emptyContext);
		new EventController(ctx).reconcileIrcExpiryTimers(helpers.getRenderedIrcInlineComponents());

		vi.advanceTimersByTime(5_999);
		expect(chatContainer.children).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(chatContainer.children).toHaveLength(0);
	});

	it("omits expired ephemeral records and retains persistent relays through rebuild", () => {
		vi.useFakeTimers({ now: 0 });
		const { ledger, helpers, chatContainer } = makeContext();
		ledger.observe(
			{ observationId: "expired", kind: "incoming", from: "peer", to: "you", text: "old", timestamp: 0 },
			true,
		);
		ledger.observe(
			{ observationId: "relay", kind: "relay", from: "one", to: "two", text: "visible", timestamp: 0 },
			false,
		);
		vi.advanceTimersByTime(10_000);
		helpers.renderSessionContext({
			messages: [
				{
					role: "custom",
					customType: "irc:incoming",
					content: "old",
					display: true,
					attribution: "agent",
					timestamp: 0,
					details: { observationId: "expired", from: "peer", message: "old" },
				},
			],
		} as unknown as SessionContext);

		expect(helpers.getRenderedIrcInlineComponents().has("expired")).toBe(false);
		expect(helpers.getRenderedIrcInlineComponents().has("relay")).toBe(true);
		expect(chatContainer.children).toHaveLength(2);
	});

	it("removes inline components that expire between rendering and reconciliation", () => {
		vi.useFakeTimers({ now: 0 });
		const { ctx, ledger, helpers, chatContainer } = makeContext();
		ledger.observe(
			{
				observationId: "expired-during-rebuild",
				kind: "incoming",
				from: "peer",
				to: "you",
				text: "hello",
				timestamp: 0,
			},
			true,
		);
		helpers.renderSessionContext(emptyContext);
		expect(chatContainer.children).toHaveLength(2);

		vi.advanceTimersByTime(10_000);
		new EventController(ctx).reconcileIrcExpiryTimers(helpers.getRenderedIrcInlineComponents());

		expect(chatContainer.children).toHaveLength(0);
		expect(helpers.getRenderedIrcInlineComponents().has("expired-during-rebuild")).toBe(false);
	});

	it("removes inline components that cross their deadline between projection and timer scheduling", () => {
		vi.useFakeTimers({ now: 0 });
		const { ctx, ledger, helpers, chatContainer } = makeContext();
		ledger.observe(
			{
				observationId: "expires-mid-reconcile",
				kind: "incoming",
				from: "peer",
				to: "you",
				text: "hello",
				timestamp: 0,
			},
			true,
		);
		helpers.renderSessionContext(emptyContext);
		expect(chatContainer.children).toHaveLength(2);

		// The projection snapshot (single clock read #1) sees the record alive
		// at 9_999; the scheduler's own single clock read (#2) crosses the
		// deadline at 10_001 — the previously missed scheduling boundary now
		// owned by #scheduleIrcExpiry's cleanup path.
		const realNow = Date.now;
		let calls = 0;
		Date.now = () => (++calls === 1 ? 9_999 : 10_001);
		try {
			new EventController(ctx).reconcileIrcExpiryTimers(helpers.getRenderedIrcInlineComponents());
		} finally {
			Date.now = realNow;
		}

		expect(chatContainer.children).toHaveLength(0);
		expect(helpers.getRenderedIrcInlineComponents().has("expires-mid-reconcile")).toBe(false);
	});

	it("arms an expiry timer even when a legacy recheck window would have crossed the deadline", () => {
		// Root-cause regression for the split-clock-read defect: reads are
		// 9_999 (projection), 9_999 (what the removed reconcile-loop recheck
		// would have seen), 10_001 (what the old scheduler's separate read saw,
		// making it silently skip timer creation). The fixed implementation
		// performs only two reads and arms a timer from the second (alive)
		// read, so advancing fake time must remove the row.
		vi.useFakeTimers({ now: 0 });
		const { ctx, ledger, helpers, chatContainer } = makeContext();
		ledger.observe(
			{
				observationId: "legacy-recheck-window",
				kind: "incoming",
				from: "peer",
				to: "you",
				text: "hello",
				timestamp: 0,
			},
			true,
		);
		helpers.renderSessionContext(emptyContext);
		expect(chatContainer.children).toHaveLength(2);

		const realNow = Date.now;
		let calls = 0;
		Date.now = () => (++calls <= 2 ? 9_999 : 10_001);
		try {
			new EventController(ctx).reconcileIrcExpiryTimers(helpers.getRenderedIrcInlineComponents());
		} finally {
			Date.now = realNow;
		}

		// The row must not be stuck: either it was removed synchronously or a
		// timer was armed. With the fixed two-read implementation a 1ms timer
		// exists; fire it and assert removal.
		vi.advanceTimersByTime(2);
		expect(chatContainer.children).toHaveLength(0);
	});

	it("keeps persisted IRC observations between surrounding messages across rebuilds", () => {
		const { ledger, helpers, chatContainer } = makeContext();
		ledger.observe(
			{ observationId: "persisted", kind: "incoming", from: "peer", to: "you", text: "middle", timestamp: 0 },
			false,
		);
		const context = {
			messages: [
				{ role: "user", content: "before", timestamp: 0 },
				{
					role: "custom",
					customType: "irc:incoming",
					content: "middle",
					display: true,
					attribution: "agent",
					timestamp: 0,
					details: { observationId: "persisted", from: "peer", message: "middle" },
				},
				{ role: "user", content: "after", timestamp: 1 },
			],
		} as unknown as SessionContext;

		for (let rebuild = 0; rebuild < 2; rebuild++) {
			chatContainer.clear();
			helpers.renderSessionContext(context);
			const transcript = Bun.stripANSI(chatContainer.render(100).join("\n"));
			expect(transcript.indexOf("before")).toBeLessThan(transcript.indexOf("[IRC]"));
			expect(transcript.indexOf("[IRC]")).toBeLessThan(transcript.indexOf("after"));
			expect(helpers.getRenderedIrcInlineComponents().size).toBe(1);
			expect(chatContainer.children).toHaveLength(4);
		}
	});
});
