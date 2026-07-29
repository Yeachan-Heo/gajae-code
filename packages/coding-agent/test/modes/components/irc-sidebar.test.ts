import { afterEach, describe, expect, it } from "bun:test";
import {
	computeIrcSplitWidths,
	computeIrcWorkLaneWidths,
	getIrcSidebarSemanticToken,
	IRC_SIDEBAR_MAX_RENDER_ROWS,
	IrcLeftLaneComponent,
	type IrcSidebarTheme,
	IrcSplitViewComponent,
} from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import {
	IRC_OBSERVATION_LEDGER_MAX_RETAINED_UTF8_BYTES,
	IrcObservationLedger,
} from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import {
	type Component,
	Container,
	Image,
	ImageProtocol,
	isTerminalGraphicsFallbackActive,
	TERMINAL,
	Text,
	TUI,
	visibleWidth,
} from "@gajae-code/tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

const sidebarTheme = {
	fg: (_color: "dim" | "accent", text: string) => text,
	bold: (text: string) => text,
	boxSharp: { vertical: "|" },
} satisfies IrcSidebarTheme;

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const mutableTerminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
const originalProtocol = TERMINAL.imageProtocol;

afterEach(() => {
	mutableTerminal.imageProtocol = originalProtocol;
});

function localTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

class TestPane implements Component {
	widths: number[] = [];
	constructor(private readonly lines: string | string[]) {}

	render(width: number): string[] {
		this.widths.push(width);
		return typeof this.lines === "string" ? [this.lines] : this.lines;
	}
	invalidate(): void {}
}

function addRecord(ledger: IrcObservationLedger, text: string, observationId = text): void {
	ledger.observe(
		{
			observationId,
			kind: "incoming",
			from: "alice",
			to: "bob",
			text,
			timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
		},
		false,
	);
}

function image(): Image {
	return new Image(
		BASE64_ONE_PIXEL_PNG,
		"image/png",
		{ fallbackColor: text => text },
		{ maxWidthCells: 10, maxHeightCells: 2, refetch: () => BASE64_ONE_PIXEL_PNG },
		{ widthPx: 100, heightPx: 100 },
	);
}

describe("IrcObservationLedger sidebar contracts", () => {
	it("does not consume an identity when its payload is rejected", () => {
		const ledger = new IrcObservationLedger();
		const observationId = "rejected-then-accepted";
		expect(
			ledger.observe(
				{
					observationId,
					kind: "incoming",
					from: "alice",
					to: "bob",
					text: "x".repeat(IRC_OBSERVATION_LEDGER_MAX_RETAINED_UTF8_BYTES),
					timestamp: 1,
				},
				false,
			),
		).toBeUndefined();
		expect(
			ledger.observe(
				{ observationId, kind: "incoming", from: "alice", to: "bob", text: "accepted", timestamp: 2 },
				false,
			),
		).toBeDefined();
	});

	it("reset releases deduplication state without changing an empty projection epoch", () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "first", "reset-identity");
		ledger.reset();
		const emptyEpoch = ledger.mutationEpoch;
		ledger.reset();
		expect(ledger.mutationEpoch).toBe(emptyEpoch);
		expect(
			ledger.observe(
				{
					observationId: "reset-identity",
					kind: "incoming",
					from: "alice",
					to: "bob",
					text: "second",
					timestamp: 2,
				},
				false,
			),
		).toBeDefined();
	});
});
describe("computeIrcSplitWidths", () => {
	it("keeps exact split invariants for every width from 1 through 500", () => {
		for (let width = 1; width <= 500; width++) {
			const result = computeIrcSplitWidths(width);
			expect(result.leftWidth).toBeGreaterThanOrEqual(0);
			expect(result.separatorWidth).toBeGreaterThanOrEqual(0);
			expect(result.rightWidth).toBeGreaterThanOrEqual(0);
			expect(result.leftWidth + result.separatorWidth + result.rightWidth).toBe(width);
			expect(result.rightWidth === 0 || result.rightWidth >= 30).toBe(true);
			expect(result.rightWidth === 0).toBe(width < 65);
			expect(result.leftWidth).toBeGreaterThanOrEqual(Math.floor(width * 0.5));
		}
	});
});
describe("shared work lane", () => {
	it("keeps dependent pre-boundary content in the transcript lane only while IRC is effective", () => {
		const todo = new TestPane("todo content");
		const lane = new IrcLeftLaneComponent(todo, width => width >= 65);

		expect(computeIrcWorkLaneWidths(64, true)).toEqual({ leftWidth: 64, separatorWidth: 0, rightWidth: 0 });
		expect(computeIrcWorkLaneWidths(65, true)).toEqual({ leftWidth: 32, separatorWidth: 3, rightWidth: 30 });
		expect(lane.render(64)).toEqual(["todo content"]);
		expect(lane.render(80)).toEqual(["todo content"]);
		expect(todo.widths).toEqual([64, computeIrcSplitWidths(80).leftWidth]);
	});
});

describe("IrcSplitViewComponent", () => {
	it("delegates hidden rendering at full width", () => {
		const pane = new TestPane("transcript");
		const split = new IrcSplitViewComponent(pane, new IrcObservationLedger(), sidebarTheme);

		expect(split.render(80)).toEqual(["transcript"]);
		expect(pane.widths).toEqual([80]);
	});

	it("keeps the left pane full width when the sidebar cannot meet its minimum", () => {
		const pane = new TestPane("transcript");
		const split = new IrcSplitViewComponent(pane, new IrcObservationLedger(), sidebarTheme);
		split.setVisible(true);

		expect(split.render(64)).toEqual(["transcript"]);
		expect(pane.widths).toEqual([64]);
	});

	it("reports requested visibility as ineffective below the sidebar minimum width", () => {
		const split = new IrcSplitViewComponent(new TestPane("transcript"), new IrcObservationLedger(), sidebarTheme);
		split.setVisible(true);

		expect(split.effectiveSidebarVisible(64)).toBe(false);
		expect(split.effectiveSidebarVisible(65)).toBe(true);
	});

	it("preserves transcript metadata while excluding inline and right-only IRC rows", () => {
		const left = new Container();
		const semantic = new Text("semantic transcript row", 0, 0);
		const inlineIrc = new Text("inline IRC row", 0, 0);
		left.addChild(semantic);
		left.setViewportAnchorSource(semantic, { id: "message-1" });
		left.addChild(inlineIrc);
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "right one\nright two\nright three\nright four");
		const split = new IrcSplitViewComponent(left, ledger, sidebarTheme);

		const hidden = split.renderWithViewportAnchors(80);
		const hiddenPlain = hidden.lines.map(line => Bun.stripANSI(line));
		const hiddenSemantic = hiddenPlain.findIndex(line => line.includes("semantic transcript row"));
		const hiddenInline = hiddenPlain.findIndex(line => line.includes("inline IRC row"));
		expect(hidden.anchors[hiddenSemantic]?.id).toBe("message-1");
		expect(hidden.anchors[hiddenInline]).toBeNull();

		split.setVisible(true);
		const visible = split.renderWithViewportAnchors(80);
		const visiblePlain = visible.lines.map(line => Bun.stripANSI(line));
		const visibleSemantic = visiblePlain.findIndex(line => line.includes("semantic transcript row"));
		const visibleInline = visiblePlain.findIndex(line => line.includes("inline IRC row"));
		expect(visible.anchors[visibleSemantic]?.id).toBe("message-1");
		expect(visible.anchors[visibleInline]).toBeNull();
		const rightOnlyRows = visiblePlain.flatMap((line, index) =>
			line.includes("right ") && !line.includes("semantic transcript row") && !line.includes("inline IRC row")
				? [index]
				: [],
		);
		expect(rightOnlyRows.length).toBeGreaterThan(0);
		for (const row of rightOnlyRows) expect(visible.anchors[row]).toBeNull();

		split.setVisible(false);
		expect(split.renderWithViewportAnchors(80).anchors.some(anchor => anchor?.id === "message-1")).toBe(true);
	});

	it("renders Discord-style blocks with indented bodies, blank separators, and tail alignment", () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "first line\nsecond line", "first");
		addRecord(ledger, "latest IRC line", "latest");
		const split = new IrcSplitViewComponent(new TestPane(["older", "newer", "live tail"]), ledger, sidebarTheme);
		split.setVisible(true);

		const lines = split.render(80).map(line => Bun.stripANSI(line));
		const sidebarRows = lines.map(line => line.slice(computeIrcSplitWidths(80).leftWidth + 3));
		expect(sidebarRows).toContain(`alice → bob · ${localTime(Date.parse("2026-01-02T03:04:05.000Z"))}`);
		expect(sidebarRows).toContain("  first line");
		expect(sidebarRows).toContain("  second line");
		const firstBody = sidebarRows.indexOf("  second line");
		expect(sidebarRows[firstBody + 1]).toBe("");
		expect(lines.at(-1)).toContain("latest IRC line");
	});

	it("renders uncapped CJK and emoji bodies within the sidebar width", () => {
		const ledger = new IrcObservationLedger();
		const body = "안녕하세요 👩🏽‍💻 e\u0301 ".repeat(20);
		addRecord(ledger, body);
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);

		const widths = computeIrcSplitWidths(80);
		const rendered = split.render(80);
		expect(rendered.every(line => visibleWidth(line) <= 80)).toBe(true);
		const bodyRows = rendered.map(line => Bun.stripANSI(line).slice(widths.leftWidth + widths.separatorWidth));
		expect(bodyRows.filter(line => line.startsWith("  ")).length).toBeGreaterThan(1);
		expect(bodyRows.every(line => visibleWidth(line) <= widths.rightWidth)).toBe(true);
	});

	it("preserves grapheme boundaries and composes text deterministically in a process-style virtual terminal", async () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "👩🏽‍💻👨‍👩‍👧‍👦 e\u0301 ".repeat(12));
		const split = new IrcSplitViewComponent(new TestPane("left transcript"), ledger, sidebarTheme);
		split.setVisible(true);
		const layout = computeIrcSplitWidths(80);
		const sidebarRows = split
			.render(80)
			.map(line => Bun.stripANSI(line).slice(layout.leftWidth + layout.separatorWidth))
			.filter(line => line.startsWith("  "));
		expect(sidebarRows.length).toBeGreaterThan(1);
		for (const row of sidebarRows) {
			expect(row).not.toMatch(/^\s*\u200d|\u200d\s*$/);
			expect(visibleWidth(row)).toBeLessThanOrEqual(layout.rightWidth);
		}

		const terminal = new VirtualTerminal(80, 24, { isProcessTerminal: true });
		const tui = new TUI(terminal);
		tui.start();
		try {
			tui.addChild(split);
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			expect(viewport.some(line => line.includes("left transcript"))).toBe(true);
			expect(viewport.some(line => line.includes("👩🏽‍💻"))).toBe(true);
			expect(viewport.every(line => visibleWidth(line) <= 80)).toBe(true);
			expect(terminal.getWriteLog()).toContain("\x1b[?25l");
		} finally {
			tui.stop();
		}
	});

	it("renders ordinary complete bodies below the fixed render budget", () => {
		const ledger = new IrcObservationLedger();
		const body = Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n");
		addRecord(ledger, body);
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);

		const rendered = Bun.stripANSI(split.render(80).join("\n"));
		expect(rendered).toContain("  line 0");
		expect(rendered).toContain("  line 79");
	});

	it("caps materialized rows for a near-budget retained body and marks the elision", () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "x".repeat(15 * 1_024 * 1_024), "near-budget");
		expect(ledger.getSidebarRecords()).toHaveLength(1);
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);

		const rendered = split.render(80);
		expect(rendered.length).toBeLessThanOrEqual(IRC_SIDEBAR_MAX_RENDER_ROWS);
		expect(Bun.stripANSI(rendered.join("\n"))).toContain("… message elided …");
	});

	it.each(["from", "to"] as const)("bounds a near-budget %s identity before sidebar formatting", field => {
		const ledger = new IrcObservationLedger();
		ledger.observe(
			{
				observationId: `large-${field}`,
				kind: "incoming",
				from: field === "from" ? "a".repeat(15 * 1_024 * 1_024) : "alice",
				to: field === "to" ? "b".repeat(15 * 1_024 * 1_024) : "bob",
				text: "",
				timestamp: 1,
			},
			false,
		);
		expect(ledger.getSidebarRecords()).toHaveLength(1);
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);

		const rendered = split.render(80);
		expect(rendered.length).toBeLessThanOrEqual(IRC_SIDEBAR_MAX_RENDER_ROWS);
		expect(Bun.stripANSI(rendered.join("\n"))).toContain("…");
	});

	it("clips the UTF-8 source projection only at complete grapheme boundaries", () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "e\u0301👩🏽‍💻界".repeat(20_000), "unicode-near-budget");
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);

		const plainLines = split.render(80).map(line => Bun.stripANSI(line));
		expect(plainLines.join("\n")).toContain("… message elided …");
		expect(plainLines.join("\n")).not.toContain("�");
		for (const line of plainLines) {
			expect(line).not.toMatch(/^\s*[\u0300-\u036f\u200d]/u);
			expect(line).not.toMatch(/[\u200d]$/u);
		}
	});

	it("renders a deterministic newest-record tail at the retained record-count boundary", () => {
		const ledger = new IrcObservationLedger();
		for (let index = 0; index < 10_000; index++) addRecord(ledger, `message-${index}`, `record-${index}`);
		expect(ledger.getSidebarRecords()).toHaveLength(10_000);
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);

		const rendered = split.render(80);
		const plain = Bun.stripANSI(rendered.join("\n"));
		expect(rendered.length).toBeLessThanOrEqual(IRC_SIDEBAR_MAX_RENDER_ROWS);
		expect(plain).toContain("… older IRC messages elided …");
		expect(plain).toContain("message-9999");
		expect(plain).not.toContain("message-0\n");
	});

	it("shows records captured before opening the sidebar", () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "backfill");
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);

		split.setVisible(true);
		expect(Bun.stripANSI(split.render(80).join("\n"))).toContain("backfill");
	});

	it("suppresses terminal graphics only while visible and restores full width when hidden", () => {
		const pane: Component = {
			render: () => [isTerminalGraphicsFallbackActive() ? "[image hidden]" : "\x1bPqSIXEL\x1b\\"],
			invalidate: () => {},
		};
		const split = new IrcSplitViewComponent(pane, new IrcObservationLedger(), sidebarTheme);

		expect(split.render(80).join("\n")).toContain("\x1bPqSIXEL\x1b\\");
		split.setVisible(true);
		expect(split.render(80).join("\n")).not.toContain("\x1bPqSIXEL\x1b\\");
		split.setVisible(false);
		expect(split.render(80).join("\n")).toContain("\x1bPqSIXEL\x1b\\");
	});

	it("recomputes both panes on resize", () => {
		const pane = new TestPane("left");
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "right");
		const split = new IrcSplitViewComponent(pane, ledger, sidebarTheme);
		split.setVisible(true);

		const wide = split.render(80);
		const narrow = split.render(40);
		expect(pane.widths).toEqual([47, 40]);
		expect(wide.every(line => visibleWidth(line) <= 80)).toBe(true);
		expect(narrow.every(line => visibleWidth(line) <= 40)).toBe(true);
	});

	it("replaces tabs in IRC labels and text before wrapping", () => {
		const ledger = new IrcObservationLedger();
		ledger.observe(
			{
				observationId: "tabs",
				kind: "incoming",
				from: "ali\tce",
				to: "bo\tb",
				text: "message\twith tabs",
				timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
			},
			false,
		);
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);

		const lines = split.render(80).map(line => Bun.stripANSI(line));
		expect(lines.every(line => visibleWidth(line) <= 80)).toBe(true);
		expect(lines.join("\n")).not.toContain("\t");
	});

	it("renders kitty images in the left pane while the sidebar is visible", () => {
		mutableTerminal.imageProtocol = ImageProtocol.Kitty;
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "peer message");
		const split = new IrcSplitViewComponent(image(), ledger, sidebarTheme);

		split.setVisible(true);
		const visible = split.render(80).join("\n");
		expect(visible).toContain("\x1b_G");
		expect(Bun.stripANSI(visible)).toContain("peer message");

		split.setVisible(false);
		expect(split.render(80).join("\n")).toContain("\x1b_G");
	});

	it("suppresses iTerm2 images in the visible split and restores them when hidden", () => {
		mutableTerminal.imageProtocol = ImageProtocol.Iterm2;
		const split = new IrcSplitViewComponent(image(), new IrcObservationLedger(), sidebarTheme);

		split.setVisible(true);
		const visible = split.render(80);
		expect(visible.join("\n")).not.toContain("\x1b]1337;File=");
		expect(Bun.stripANSI(visible.join("\n"))).toContain("[image/png");
		expect(visible.every(line => visibleWidth(line) <= 80)).toBe(true);

		split.setVisible(false);
		expect(split.render(80).join("\n")).toContain("\x1b]1337;File=");
	});

	it("keeps sixel suppressed in the visible split even with kitty permission active", () => {
		mutableTerminal.imageProtocol = ImageProtocol.Sixel;
		const split = new IrcSplitViewComponent(image(), new IrcObservationLedger(), sidebarTheme);

		split.setVisible(true);
		const visible = split.render(80).join("\n");
		expect(visible).not.toContain("\x1bP");
		expect(Bun.stripANSI(visible)).toContain("[image/png");
	});

	it("resolves injected theme accessors and message styles on every render", () => {
		let currentTheme: IrcSidebarTheme = {
			fg: (_color, text) => `\x1b[31m${text}\x1b[0m`,
			bold: text => `\x1b[1m${text}\x1b[22m`,
			boxSharp: { vertical: "│" },
		};
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "message");
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, () => currentTheme);
		split.setVisible(true);

		const first = split.render(80).join("\n");
		expect(first).toContain("\x1b[31m\x1b[1malice\x1b[22m\x1b[0m");
		currentTheme = {
			fg: (_color, text) => `\x1b[32m${text}\x1b[0m`,
			bold: text => `\x1b[4m${text}\x1b[24m`,
			boxSharp: { vertical: "║" },
		};
		const second = split.render(80).join("\n");
		expect(second).toContain("\x1b[32m\x1b[4malice\x1b[24m\x1b[0m");
	});

	it("renders ledger mutations without retaining stale sidebar output", () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "first entry", "first");
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);

		expect(Bun.stripANSI(split.render(80).join("\n"))).toContain("first entry");
		addRecord(ledger, "second entry", "second");
		const rendered = Bun.stripANSI(split.render(80).join("\n"));
		expect(rendered).toContain("first entry");
		expect(rendered).toContain("second entry");
	});

	it("clears sidebar output after a ledger reset", () => {
		const ledger = new IrcObservationLedger();
		addRecord(ledger, "reset entry", "reset");
		const split = new IrcSplitViewComponent(new TestPane("left"), ledger, sidebarTheme);
		split.setVisible(true);
		expect(Bun.stripANSI(split.render(80).join("\n"))).toContain("reset entry");

		ledger.reset();
		expect(Bun.stripANSI(split.render(80).join("\n"))).not.toContain("reset entry");
	});

	it("hashes semantic tokens compactly while preserving and changing them with projected semantics", () => {
		const ledger = new IrcObservationLedger();
		const width = computeIrcSplitWidths(80).rightWidth;
		addRecord(ledger, "visible token", "visible");
		const initial = getIrcSidebarSemanticToken(ledger, width);
		expect(initial).toMatch(/^[a-f0-9]{64}$/);

		addRecord(ledger, "ignored duplicate", "visible");
		expect(getIrcSidebarSemanticToken(ledger, width)).toBe(initial);
		addRecord(ledger, "changed token", "changed");
		expect(getIrcSidebarSemanticToken(ledger, width)).not.toBe(initial);
	});
});

it("keeps a short anchored transcript visible after manual sidebar-history navigation in a pinned TUI frame", async () => {
	const transcript = new Container();
	const transcriptRow = new Text("short transcript remains visible", 0, 0);
	transcript.addChild(transcriptRow);
	transcript.setViewportAnchorSource(transcriptRow, { id: "short-transcript" });
	const ledger = new IrcObservationLedger();
	for (let index = 0; index < 40; index++) addRecord(ledger, `long sidebar history ${index}`, `history-${index}`);
	const split = new IrcSplitViewComponent(transcript, ledger, sidebarTheme);
	split.setVisible(true);
	const status = new Text("status: pinned", 0, 0);
	const editor = new Text("> editor: pinned", 0, 0);
	const terminal = new VirtualTerminal(80, 10, { isProcessTerminal: true });
	const tui = new TUI(terminal);
	try {
		tui.addChild(split);
		tui.setViewportAnchorComponent(split);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setBottomPinnedComponent(status);
		tui.setViewportOutputSource({ identity: "irc-subagent-view", revision: 0n });
		tui.start();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("short transcript remains visible");

		expect(tui.scrollViewportBy(-3, { pin: "stable" })).toBe(true);
		expect(tui.scrollViewportPages(-1)).toBe(true);
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("status: pinned");
		expect(terminal.getViewport().join("\n")).toContain("> editor: pinned");

		tui.scrollViewportBy(10_000, { pin: "edge" });
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("short transcript remains visible");
	} finally {
		tui.stop();
	}
});
