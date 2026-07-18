import { describe, expect, it } from "bun:test";
import { Container, Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class AnchoredTranscript extends Container {
	append(id: string, text = id): Text {
		const row = new Text(text, 0, 0);
		this.addChild(row);
		this.setViewportAnchorSource(row, { id });
		return row;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

describe("G001 WS0 red-team: revealViewportAnchor", () => {
	it("fails safely for zero-sized terminals and an empty frame", () => {
		const term = new VirtualTerminal(1, 1);
		const tui = new TUI(term);
		Object.defineProperties(term, {
			columns: { value: 0, configurable: true },
			rows: { value: 0, configurable: true },
		});
		expect(tui.revealViewportAnchor("missing", "top")).toBe(false);
		Object.defineProperties(term, {
			columns: { value: 1 },
			rows: { value: 1 },
		});
		expect(tui.revealViewportAnchor("missing", "center")).toBe(false);
	});

	it("clamps extreme alignment for short content and repeated reveals are idempotent", async () => {
		const term = new VirtualTerminal(30, 7);
		const tui = new TUI(term);
		const transcript = new AnchoredTranscript();
		transcript.append("first");
		transcript.append("target");
		transcript.append("last");
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			for (const alignment of ["top", "center", "bottom"] as const) {
				expect(tui.revealViewportAnchor("target", alignment)).toBe(true);
				await settle(term);
				expect(visible(term)).toContain("target");
			}
			const before = visible(term);
			expect(tui.revealViewportAnchor("target", "center")).toBe(true);
			await settle(term);
			expect(visible(term)).toEqual(before);
		} finally {
			tui.stop();
		}
	});

	it("cannot reveal an anchor after it is evicted and never changes rendered width", async () => {
		const term = new VirtualTerminal(18, 5);
		const tui = new TUI(term);
		const transcript = new AnchoredTranscript();
		const rows: Text[] = [];
		for (let index = 0; index < 12; index++)
			rows.push(transcript.append(`entry-${index}`, `entry-${index} has width-sensitive content`));
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			const beforeLines = transcript.renderWithViewportAnchors(term.columns).lines;
			expect(tui.revealViewportAnchor("entry-8", "center")).toBe(true);
			await settle(term);
			const afterLines = transcript.renderWithViewportAnchors(term.columns).lines;
			expect(afterLines).toEqual(beforeLines);
			const removed = rows[8];
			expect(removed).toBeDefined();
			transcript.removeChild(removed!);
			tui.requestRender();
			await settle(term);
			const beforeFailedReveal = visible(term);
			expect(tui.revealViewportAnchor("entry-8", "bottom")).toBe(false);
			await settle(term);
			expect(visible(term)).toEqual(beforeFailedReveal);
		} finally {
			tui.stop();
		}
	});
});
