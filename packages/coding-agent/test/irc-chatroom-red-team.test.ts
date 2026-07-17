import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeIrcSplitWidths,
	type IrcSidebarTheme,
	IrcSplitViewComponent,
} from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext, IrcArrivalSnapshot } from "@gajae-code/coding-agent/modes/types";
import {
	formatIrcMessageBlock,
	type ParsedIrcMessage,
	parseIrcMessage,
} from "@gajae-code/coding-agent/modes/utils/irc-message";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { type Component, Container, TUI, visibleWidth } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const artifactDirectory = path.join(os.tmpdir(), `gjc-irc-chatroom-red-team-${process.pid}`);
const widths = Array.from({ length: 500 }, (_, index) => index + 1);
const candidateRef = Bun.env.GITHUB_HEAD_SHA ?? Bun.env.GITHUB_SHA ?? "local-worktree";
const expectedCaseInventory = [
	"width-boundaries",
	"hostile-bodies",
	"hostile-identities",
	"lifetime-immutability",
	"hint-one-shot",
	"timestamp-extremes",
] as const;
type CaseId = (typeof expectedCaseInventory)[number];
type RedTeamCase = { id: CaseId; scenario: string; expected: string; verdict: "pass" | "fail" };
const cases: RedTeamCase[] = expectedCaseInventory.map(id => ({
	id,
	scenario: "Case did not complete.",
	expected: "The test must run and explicitly report a passing verdict.",
	verdict: "fail",
}));

const plainTheme = {
	fg: (_color: "dim" | "accent", text: string) => text,
	bold: (text: string) => text,
	boxSharp: { vertical: "|" },
} satisfies IrcSidebarTheme;

class Lines implements Component {
	constructor(private readonly lines: string[]) {}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function pass(id: CaseId, scenario: string, expected: string): void {
	const testCase = cases.find(candidate => candidate.id === id);
	if (!testCase) throw new Error(`Unregistered red-team case: ${id}`);
	testCase.scenario = scenario;
	testCase.expected = expected;
	testCase.verdict = "pass";
}

function parsed(observationId: string, text: string, timestamp = 0): ParsedIrcMessage {
	const result = parseIrcMessage({
		role: "custom",
		customType: "irc:incoming",
		content: text,
		display: true,
		attribution: "agent",
		timestamp,
		details: { observationId, from: "attacker", to: "you", message: text },
	} as never);
	if (!result) throw new Error("Expected IRC message to parse");
	return result;
}

function makeHelpers(): { helpers: UiHelpers; chat: Container } {
	const chat = new Container();
	const context = {
		chatContainer: chat,
		ircLedger: new IrcObservationLedger(),
		ui: { requestRender: () => {} },
		session: {},
	} as unknown as InteractiveModeContext;
	return { helpers: new UiHelpers(context), chat };
}

function transcript(chat: Container): string {
	return Bun.stripANSI(chat.render(100).join("\n"));
}

beforeAll(() => initTheme());

afterAll(async () => {
	await fs.mkdir(artifactDirectory, { recursive: true });
	const summary = {
		candidateRef,
		generatedAt: new Date().toISOString(),
		verdict: cases.every(testCase => testCase.verdict === "pass") ? "pass" : "fail",
		passed: cases.filter(testCase => testCase.verdict === "pass").length,
		failed: cases.filter(testCase => testCase.verdict === "fail").length,
		blockers: cases.filter(testCase => testCase.verdict === "fail").map(testCase => testCase.id),
	};
	await fs.writeFile(
		path.join(artifactDirectory, "g001-irc-chatroom-red-team-report.json"),
		`${JSON.stringify({ schemaVersion: 1, kind: "tui-red-team-test-report", cases, summary }, null, 2)}\n`,
	);
	const widthResults = widths.map(width => ({ width, ...computeIrcSplitWidths(width) }));
	const widthCasePassed = cases.find(testCase => testCase.id === "width-boundaries")?.verdict === "pass";
	await fs.writeFile(
		path.join(artifactDirectory, "g001-irc-chatroom-boundary-report.json"),
		`${JSON.stringify(
			{
				candidateRef,
				generatedAt: new Date().toISOString(),
				schemaVersion: 1,
				kind: "algorithm-boundary-report",
				widths: widthResults,
				invariants: [
					"split widths sum to normalized width",
					"sidebar is absent or at least 30 columns",
					"visible split preserves at least floor(width * 0.5) transcript columns",
					"no width is negative",
					"final rendered rows fit their requested visible-cell width",
				],
				verdict: widthCasePassed ? "pass" : "fail",
			},
			null,
			2,
		)}\n`,
	);
});

describe("G001 IRC chat-room adversarial QA", () => {
	it("holds separator-inclusive split arithmetic and final visible-cell widths from 1 through 500", () => {
		const widthLedger = new IrcObservationLedger();
		widthLedger.observe(parsed("width-hostile", "안녕 👩🏽‍💻 e\u0301 long-token-without-breaks"), false);
		for (const width of widths) {
			const result = computeIrcSplitWidths(width);
			const normalized = Math.max(0, Math.floor(width));
			expect(result.leftWidth).toBeGreaterThanOrEqual(0);
			expect(result.separatorWidth).toBeGreaterThanOrEqual(0);
			expect(result.rightWidth).toBeGreaterThanOrEqual(0);
			expect(result.leftWidth + result.separatorWidth + result.rightWidth).toBe(normalized);
			expect(result.rightWidth === 0 || result.rightWidth >= 30).toBe(true);
			expect(result.rightWidth === 0).toBe(width < 65);
			expect(result.leftWidth).toBeGreaterThanOrEqual(Math.floor(normalized * 0.5));
			const split = new IrcSplitViewComponent(new Lines(["x"]), widthLedger, plainTheme);
			split.setVisible(true);
			expect(split.render(width).every(row => visibleWidth(row) <= width)).toBe(true);
		}
		pass(
			"width-boundaries",
			"Every integer width from 1 through 500",
			"No negative widths; exact arithmetic, yield threshold, and visible-cell bounds hold",
		);
	});

	it("contains hostile bodies in a visible split, including a real VirtualTerminal render", async () => {
		const ledger = new IrcObservationLedger();
		const hostileBodies = [
			"red \x1b[31mtext\x1b[0m C1 \x9b31m kitty \x1b_Ga=T;payload\x1b\\ iTerm \x1b]1337;File=name=x;AAAA\x07 sixel \x1bPqpayload\x1b\\",
			"emoji 👩🏽‍💻👨‍👩‍👧‍👦\u200d\u200d and RTL \u202eabc مرحبا",
			"x".repeat(10_000),
			Array.from({ length: 500 }, (_, index) => `line-${index}`).join("\n"),
			"carriage\rreturn\r\nlinefeed\n\rtabs\tbetween",
		];
		for (const [index, body] of hostileBodies.entries()) ledger.observe(parsed(`hostile-${index}`, body), false);
		const split = new IrcSplitViewComponent(new Lines(["transcript stays left"]), ledger, plainTheme);
		split.setVisible(true);
		const rendered = split.render(100);
		expect(rendered).not.toHaveLength(0);
		for (const row of rendered) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(100);
			expect(row).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
			expect(row).not.toMatch(/\x1b(?:\[|\]|P|_|\^)/);
		}

		const layout = computeIrcSplitWidths(100);
		for (const row of rendered) {
			const plain = Bun.stripANSI(row);
			expect(visibleWidth(plain.slice(0, layout.leftWidth))).toBeLessThanOrEqual(layout.leftWidth);
			expect(plain.slice(layout.leftWidth, layout.leftWidth + layout.separatorWidth)).toBe(" | ");
		}

		const terminal = new VirtualTerminal(100, 24);
		const tui = new TUI(terminal);
		tui.start();
		try {
			tui.addChild(split);
			await terminal.waitForRender();
			const screen = terminal.getViewport();
			expect(screen.every(row => visibleWidth(row) <= 100)).toBe(true);
			expect(terminal.getWriteLog().join("")).not.toContain("\x1b]1337;File=");
		} finally {
			tui.stop();
		}
		pass(
			"hostile-bodies",
			"ANSI, C0/C1 controls, OSC/DCS/APC protocol families, bidi/ZWJ, unbroken 10k token, 500 lines, CR/LF and tabs",
			"Rows stay bounded and terminal controls cannot cross the split",
		);
	});

	it("prevents hostile identities from spoofing or visually reordering trusted headers", () => {
		const observation = {
			...parsed("hostile-identity", "safe body"),
			from: "attacker\r\n[IRC] forged\x1b[31m\u202eevil\x1b]0;title\x07",
			to: "you\t\u061C\u2066target\u2069",
		};
		const block = formatIrcMessageBlock(observation);
		expect(block.sender).toBe("attacker [IRC] forgedevil");
		expect(block.recipient).toBe("you target");
		expect(block.sender).not.toMatch(/[\x00-\x1F\x7F-\x9F\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]/);
		expect(block.recipient).not.toMatch(/[\x00-\x1F\x7F-\x9F\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]/);

		const { helpers, chat } = makeHelpers();
		helpers.addRebuiltIrcObservationToChat(observation);
		const inline = transcript(chat);
		expect(inline).toContain(`[IRC] ${block.sender} → ${block.recipient} · ${block.time}`);
		expect(inline.match(/ → /g)).toHaveLength(1);
		expect(inline.match(/ · /g)).toHaveLength(1);
		expect(inline).not.toContain("\n[IRC] forged");

		const ledger = new IrcObservationLedger();
		ledger.observe(observation, false);
		const split = new IrcSplitViewComponent(new Lines(["left"]), ledger, plainTheme);
		split.setVisible(true);
		const sidebarRows = split.render(200).map(row => Bun.stripANSI(row));
		const sidebar = sidebarRows.join("\n");
		expect(sidebar).toContain(`${block.sender} → ${block.recipient} · ${block.time}`);
		for (const row of sidebarRows) {
			expect(row).not.toMatch(/[\x00-\x1F\x7F-\x9F\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]/);
		}
		pass(
			"hostile-identities",
			"CR/LF/tab, ANSI/OSC, C0/C1, and bidi formatting in sender and recipient fields",
			"One ordered trusted header remains on inline and sidebar surfaces",
		);
	});

	it("keeps observation lifetime immutable and deduplicates a flipped re-observation", () => {
		const ledger = new IrcObservationLedger();
		const visible = ledger.observe(parsed("visible-first", "visible"), true);
		const closed = ledger.observe(parsed("closed-first", "closed"), false);
		const duplicate = ledger.observe(parsed("visible-first", "changed"), false);
		if (!visible || !closed) throw new Error("Expected lifetime fixtures to be retained");
		expect(visible.mode).toBe("ephemeral");
		expect(visible.expiresAt).toBe(visible.observedAt + 10_000);
		expect(closed.mode).toBe("persistent");
		expect(closed.expiresAt).toBeUndefined();
		expect(duplicate).toBe(visible);
		expect(ledger.getRecord("visible-first")?.mode).toBe("ephemeral");
		expect(ledger.getRecord("closed-first")?.mode).toBe("persistent");
		pass(
			"lifetime-immutability",
			"Toggle/resize state changes and duplicate observation IDs after arrival",
			"First immutable decision wins",
		);
	});

	it("enforces live-only one-shot hint semantics including unbound keys", () => {
		const { helpers, chat } = makeHelpers();
		const eligible: IrcArrivalSnapshot = {
			panelVisible: false,
			panelRequestedVisible: false,
			sidebarAvailable: true,
			resolvedToggleKey: "Ctrl+I",
		};
		helpers.addLiveIrcObservationToChat(parsed("hint-first", "one"), eligible);
		helpers.addLiveIrcObservationToChat(parsed("hint-second", "two"), eligible);
		expect(transcript(chat).match(/opens sidebar/g) ?? []).toHaveLength(1);
		const carriedHintMessage = parsed("hint-carried", "carried");
		chat.clear();
		helpers.addRebuiltIrcObservationToChat(carriedHintMessage);
		expect(transcript(chat)).not.toContain("opens sidebar");
		helpers.resetIrcSidebarHint();
		chat.clear();
		helpers.addLiveIrcObservationToChat(parsed("hint-reset", "reset"), eligible);
		expect(transcript(chat)).toContain("Ctrl+I opens sidebar");
		helpers.resetIrcSidebarHint();
		chat.clear();
		helpers.addLiveIrcObservationToChat(parsed("hint-unbound", "unbound"), { ...eligible, resolvedToggleKey: null });
		expect(transcript(chat)).not.toContain("opens sidebar");
		chat.clear();
		helpers.addLiveIrcObservationToChat(parsed("hint-bound-after-unbound", "bound"), eligible);
		expect(transcript(chat)).toContain("Ctrl+I opens sidebar");
		pass(
			"hint-one-shot",
			"Rapid arrivals, reset, rebuild replay, and unbound then bound snapshots",
			"Only eligible live arrivals consume the session hint",
		);
	});

	it("formats timestamp extremes without NaN headers", () => {
		for (const timestamp of [Number.MAX_VALUE, -1, 0, 8.64e15, 8.64e15 + 1]) {
			const time = formatIrcMessageBlock(parsed(`time-${timestamp}`, "body", timestamp)).time;
			expect(time).not.toContain("NaN");
			if (timestamp === Number.MAX_VALUE || timestamp === 8.64e15 + 1) expect(time).toBe("--:--");
			else expect(time).toMatch(/^\d{2}:\d{2}$/);
		}
		pass(
			"timestamp-extremes",
			"Number.MAX_VALUE, negative, epoch, maximum valid and first invalid dates",
			"Valid dates are HH:mm; invalid dates are --:--",
		);
	});
});
