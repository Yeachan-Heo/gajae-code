import { afterEach, describe, expect, it } from "bun:test";
import { type Component, Container, CURSOR_MARKER, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

const VIEWPORT_NORMALIZE_OVERSCAN = 8;

class CountingTranscript extends Container {
	renderCount = 0;

	override renderWithViewportAnchors(width: number) {
		this.renderCount += 1;
		return super.renderWithViewportAnchors(width);
	}
}

class Line implements Component {
	constructor(private text: string) {}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(): string[] {
		return [this.text];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const tick = Promise.withResolvers<void>();
	process.nextTick(tick.resolve);
	await tick.promise;
	await Bun.sleep(20);
	await term.flush();
}

describe("layout tick row walk", () => {
	const previousViewport = Bun.env.PI_TUI_VIRTUAL_VIEWPORT;

	afterEach(() => {
		if (previousViewport === undefined) delete Bun.env.PI_TUI_VIRTUAL_VIEWPORT;
		else Bun.env.PI_TUI_VIRTUAL_VIEWPORT = previousViewport;
	});

	it("reuses the cached transcript prefix and normalizes only the viewport window", async () => {
		delete Bun.env.PI_TUI_VIRTUAL_VIEWPORT;
		const height = 12;
		const transcriptRows = 200;
		const term = new VirtualTerminal(80, height);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		const transcript = new CountingTranscript();
		const loader = new Line(`load-0${CURSOR_MARKER}`);
		const pinned = new Line("pin");
		for (let index = 0; index < transcriptRows; index++) transcript.addChild(new Line(`line-${index}`));
		tui.addChild(transcript);
		tui.addChild(loader);
		tui.addChild(pinned);
		tui.setViewportAnchorComponent(transcript);
		tui.setBottomPinnedComponent(pinned);
		tui.setViewportOutputSource({ identity: "session:layout-walk", revision: 0n });

		try {
			tui.start();
			await settle(term);
			expect(transcript.renderCount).toBe(1);
			TUI.resetRenderCountersForTest();

			const frameRows = transcriptRows + 2;
			const offscreenPrefix = Math.max(0, frameRows - height - VIEWPORT_NORMALIZE_OVERSCAN);
			loader.setText(`load-1${CURSOR_MARKER}`);
			tui.requestLayoutRender("layout-row-walk");
			await settle(term);

			const first = TUI.getRenderCountersForTest();
			const firstViewport = term.getViewport().join("\n");
			expect(transcript.renderCount).toBe(1);
			expect(firstViewport).toContain("load-1");
			expect(firstViewport).toContain("pin");
			expect(firstViewport).toContain("line-199");
			expect(firstViewport).not.toContain("pi:c");
			expect(tui.getRenderedLineForTest(0)).toContain("line-0");
			expect(tui.getRenderedLineForTest(offscreenPrefix - 1)).toContain(`line-${offscreenPrefix - 1}`);
			expect(first.layoutAssemblyRows).toBe(2);
			expect(first.layoutOffscreenPrefixCompares).toBe(offscreenPrefix);
			expect(first.layoutPrefixLineCopies).toBe(offscreenPrefix);
			expect(first.layoutAssemblyRows).toBeLessThan(height);

			TUI.resetRenderCountersForTest();
			loader.setText(`load-2${CURSOR_MARKER}`);
			tui.requestLayoutRender("layout-row-walk-again");
			await settle(term);

			const second = TUI.getRenderCountersForTest();
			const secondViewport = term.getViewport().join("\n");
			expect(transcript.renderCount).toBe(1);
			expect(secondViewport).toContain("load-2");
			expect(secondViewport).toContain("line-199");
			expect(secondViewport).not.toContain("load-1");
			expect(tui.getRenderedLineForTest(0)).toContain("line-0");
			expect(second.layoutAssemblyRows).toBe(2);
			expect(second.layoutOffscreenPrefixCompares).toBe(offscreenPrefix);
			expect(second.layoutPrefixLineCopies).toBe(0);

			transcript.addChild(new Line("line-extra"));
			TUI.resetRenderCountersForTest();
			tui.requestLayoutRender("layout-row-walk-invalidated");
			await settle(term);

			const invalidated = TUI.getRenderCountersForTest();
			expect(transcript.renderCount).toBe(2);
			expect(term.getViewport().join("\n")).toContain("line-extra");
			expect(invalidated.layoutAssemblyRows).toBe(frameRows + 1);
		} finally {
			tui.stop();
		}
	});

	it("emits the same bytes as a full render", async () => {
		delete Bun.env.PI_TUI_VIRTUAL_VIEWPORT;
		const ticks = 4;
		const scenarios = [
			{ transcriptRows: 200, height: 12, cursor: "loader" as const },
			{ transcriptRows: 200, height: 12, cursor: "transcript-visible" as const },
			{ transcriptRows: 200, height: 12, cursor: "transcript-prefix" as const },
			{ transcriptRows: 15, height: 8, cursor: "loader" as const },
			{ transcriptRows: 5, height: 12, cursor: "loader" as const },
		];

		for (const scenario of scenarios) {
			const layout = await captureFrame({
				...scenario,
				ticks,
				mode: "layout",
			});
			const full = await captureFrame({
				...scenario,
				ticks,
				mode: "full",
			});
			expect(layout.writes).toBe(full.writes);
			expect(layout.viewport).toBe(full.viewport);

			const frameRows = scenario.transcriptRows + 2;
			const offscreenPrefix = Math.max(0, frameRows - scenario.height - VIEWPORT_NORMALIZE_OVERSCAN);
			const stitchBlocked = scenario.height > 0 && frameRows < scenario.height;
			if (stitchBlocked) {
				expect(layout.copies).toBe(0);
			} else {
				expect(layout.copies).toBe(offscreenPrefix);
				expect(layout.assembly).toBe(2 * ticks);
			}
		}
	});
});

async function captureFrame(input: {
	transcriptRows: number;
	height: number;
	cursor: "loader" | "transcript-visible" | "transcript-prefix";
	ticks: number;
	mode: "layout" | "full";
}): Promise<{ writes: string; viewport: string; copies: number; assembly: number }> {
	const term = new VirtualTerminal(80, input.height);
	const tui = new TUI(term, undefined, { widthSettleMs: 0 });
	const transcript = new CountingTranscript();
	const cursorRow =
		input.cursor === "transcript-prefix"
			? 0
			: input.cursor === "transcript-visible"
				? Math.max(0, input.transcriptRows - 2)
				: -1;
	for (let index = 0; index < input.transcriptRows; index++) {
		const marker = index === cursorRow ? CURSOR_MARKER : "";
		transcript.addChild(new Line(`line-${index}${marker}`));
	}
	const loader = new Line(input.cursor === "loader" ? `load-0${CURSOR_MARKER}` : "load-0");
	const pinned = new Line("pin");
	tui.addChild(transcript);
	tui.addChild(loader);
	tui.addChild(pinned);
	tui.setViewportAnchorComponent(transcript);
	tui.setBottomPinnedComponent(pinned);
	tui.setViewportOutputSource({ identity: "session:layout-walk", revision: 0n });

	try {
		tui.start();
		await settle(term);
		TUI.resetRenderCountersForTest();
		for (let tick = 1; tick <= input.ticks; tick++) {
			loader.setText(input.cursor === "loader" ? `load-${tick}${CURSOR_MARKER}` : `load-${tick}`);
			if (input.mode === "layout") tui.requestLayoutRender("layout-byte-parity");
			else tui.requestRender(false, "layout-byte-parity");
			await settle(term);
		}
		const counters = TUI.getRenderCountersForTest();
		return {
			writes: term.getWriteLog().join(""),
			viewport: term.getViewport().join("\n"),
			copies: counters.layoutPrefixLineCopies,
			assembly: counters.layoutAssemblyRows,
		};
	} finally {
		tui.stop();
	}
}
