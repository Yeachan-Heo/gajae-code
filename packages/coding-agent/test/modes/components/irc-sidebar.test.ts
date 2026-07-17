import { afterEach, describe, expect, it } from "bun:test";
import {
	computeIrcSplitWidths,
	IRC_SIDEBAR_MAX_RENDER_ROWS,
	type IrcSidebarTheme,
	IrcSplitViewComponent,
} from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
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
});
