import { describe, expect, it } from "bun:test";
import { Container, Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class AnchoredTranscript extends Container {
	append(id: string, text = id): void {
		const row = new Text(text, 0, 0);
		this.addChild(row);
		this.setViewportAnchorSource(row, { id });
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function createTranscript(count = 30): AnchoredTranscript {
	const transcript = new AnchoredTranscript();
	for (let index = 0; index < count; index++) transcript.append(`entry-${index}`);
	return transcript;
}

describe("TUI viewport anchor reveal", () => {
	it("reveals anchors at the requested top, center, and bottom alignment", async () => {
		const term = new VirtualTerminal(30, 7);
		const tui = new TUI(term);
		const transcript = createTranscript();
		const status = new Text("status", 0, 0);
		const editor = new Text("editor", 0, 0);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setViewportAnchorComponent(transcript);
		tui.setBottomPinnedComponent(status);
		try {
			tui.start();
			await settle(term);

			expect(tui.revealViewportAnchor("entry-10", "top")).toBe(true);
			await settle(term);
			expect(visible(term)).toEqual([
				"entry-10",
				"entry-11",
				"entry-12",
				"entry-13",
				"entry-14",
				"status",
				"editor",
			]);

			expect(tui.revealViewportAnchor("entry-15", "center")).toBe(true);
			await settle(term);
			expect(visible(term)).toEqual([
				"entry-13",
				"entry-14",
				"entry-15",
				"entry-16",
				"entry-17",
				"status",
				"editor",
			]);

			expect(tui.revealViewportAnchor("entry-20", "bottom")).toBe(true);
			await settle(term);
			expect(visible(term)).toEqual([
				"entry-16",
				"entry-17",
				"entry-18",
				"entry-19",
				"entry-20",
				"status",
				"editor",
			]);
		} finally {
			tui.stop();
		}
	});

	it("returns false when pinned chrome leaves no transcript lane", async () => {
		const term = new VirtualTerminal(30, 2);
		const tui = new TUI(term);
		const transcript = createTranscript();
		const status = new Text("status", 0, 0);
		const editor = new Text("editor", 0, 0);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editor);
		tui.setViewportAnchorComponent(transcript);
		tui.setBottomPinnedComponent(status);
		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(["status", "editor"]);
			expect(tui.revealViewportAnchor("entry-10", "center")).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("returns false for an unresolvable anchor without changing the viewport", async () => {
		const term = new VirtualTerminal(30, 7);
		const tui = new TUI(term);
		const transcript = createTranscript();
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			expect(tui.revealViewportAnchor("missing", "top")).toBe(false);
			tui.start();
			await settle(term);
			const before = visible(term);
			expect(tui.revealViewportAnchor("missing", "center")).toBe(false);
			await settle(term);
			expect(visible(term)).toEqual(before);
		} finally {
			tui.stop();
		}
	});

	it("reveals an anchor after paging away from live output", async () => {
		const term = new VirtualTerminal(30, 7);
		const tui = new TUI(term);
		const transcript = createTranscript();
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			expect(tui.revealViewportAnchor("entry-6", "center")).toBe(true);
			await settle(term);
			expect(visible(term)[Math.floor(term.rows / 2)]).toBe("entry-6");
		} finally {
			tui.stop();
		}
	});

	it("reveals an anchor added after the initial render", async () => {
		const term = new VirtualTerminal(30, 7);
		const tui = new TUI(term);
		const transcript = createTranscript(12);
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			transcript.append("appended-target");
			tui.requestRender();
			await settle(term);
			expect(tui.revealViewportAnchor("appended-target", "bottom")).toBe(true);
			await settle(term);
			expect(visible(term)[term.rows - 1]).toBe("appended-target");
		} finally {
			tui.stop();
		}
	});

	it("does not reflow content while revealing an anchor", async () => {
		const term = new VirtualTerminal(18, 7);
		const tui = new TUI(term);
		const transcript = new AnchoredTranscript();
		for (let index = 0; index < 20; index++) {
			transcript.append(`entry-${index}`, `entry-${index} keeps its rendered line content`);
		}
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		try {
			tui.start();
			await settle(term);
			const before = transcript.renderWithViewportAnchors(term.columns).lines;
			expect(tui.revealViewportAnchor("entry-8", "center")).toBe(true);
			await settle(term);
			const after = transcript.renderWithViewportAnchors(term.columns).lines;
			expect(after).toEqual(before);
			expect(visible(term)[Math.floor(term.rows / 2)]).toContain("entry-8");
		} finally {
			tui.stop();
		}
	});
});
