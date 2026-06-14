// MUST be first: pins terminal-capability env before @gajae-code/tui evaluates.
import "./render-goldens-env";
import { describe, expect, it } from "bun:test";
import { Editor, Text, TUI } from "@gajae-code/tui";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

const nextTick = (): Promise<void> => new Promise<void>(r => process.nextTick(r));
const macro0 = (): Promise<void> => new Promise<void>(r => setTimeout(r, 0));

interface Harness {
	term: VirtualTerminal;
	tui: TUI;
	editor: Editor;
}

function setup(cols = 100, rows = 24, transcriptLines = 48): Harness {
	const term = new VirtualTerminal(cols, rows);
	const tui = new TUI(term);
	tui.start();
	for (let i = 0; i < transcriptLines; i++) {
		tui.addChild(new Text(`redteam transcript line ${String(i).padStart(2, "0")} :: streaming content`, 1, 0));
	}
	const editor = new Editor(defaultEditorTheme);
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.requestRender(false, "init");
	return { term, tui, editor };
}

async function hotRender(h: Harness): Promise<void> {
	h.tui.requestRender(false, "stream.hot");
	await macro0();
	await h.term.flush();
}

async function expectTextAndViewport(h: Harness, expected: string): Promise<void> {
	expect(h.editor.getText()).toBe(expected);
	const viewport = (await h.term.flushAndGetViewport()).join("\n");
	const visibleNeedle = expected.length > 80 ? expected.slice(-60) : expected;
	expect(viewport).toContain(visibleNeedle);
}

describe("keyboard input priority scheduler red-team", () => {
	it("does not lose keys during a 200-key burst interleaved with streaming renders", async () => {
		const h = setup();
		try {
			await h.term.waitForRender();
			const typed = Array.from({ length: 200 }, (_, i) => String.fromCharCode(33 + (i % 60))).join("");
			let expected = "";

			for (const ch of typed) {
				h.tui.requestRender(false, "stream.chunk");
				h.term.sendInput(ch);
				expected += ch;
				await nextTick();
			}

			await h.term.waitForRender();
			await expectTextAndViewport(h, expected);
		} finally {
			h.tui.stop();
		}
	}, 30000);

	it("echoes input by nextTick when a streaming render is pending and by next frame for first input without streaming", async () => {
		const hot = setup();
		try {
			await hot.term.waitForRender();
			await hotRender(hot);

			hot.tui.requestRender(false, "stream.pending");
			hot.term.sendInput("HOT-ECHO");
			await nextTick();
			await hot.term.flush();

			expect(hot.editor.getText()).toBe("HOT-ECHO");
			expect(hot.term.getViewport().join("\n")).toContain("HOT-ECHO");
		} finally {
			hot.tui.stop();
		}

		const cold = setup();
		try {
			await cold.term.waitForRender();
			cold.term.sendInput("COLD-ECHO");
			await cold.term.waitForRender();
			await expectTextAndViewport(cold, "COLD-ECHO");
		} finally {
			cold.tui.stop();
		}
	}, 30000);

	it("forced render immediately after input preserves the keystroke and leaves no stale viewport", async () => {
		const h = setup();
		try {
			await h.term.waitForRender();
			h.tui.requestRender(false, "stream.pending");
			h.term.sendInput("FORCED-KEEP");
			h.tui.requestRender(true, "redteam.force.after-input");

			await nextTick();
			await h.term.waitForRender();
			await expectTextAndViewport(h, "FORCED-KEEP");

			h.term.resize(104, 24);
			await h.term.waitForRender();
			await expectTextAndViewport(h, "FORCED-KEEP");
		} finally {
			h.tui.stop();
		}
	}, 30000);

	it("bracketed paste while streaming echoes pasted text within a frame without loss", async () => {
		const h = setup();
		try {
			await h.term.waitForRender();
			await hotRender(h);

			h.tui.requestRender(false, "stream.pending");
			h.term.sendInput("\x1b[200~PASTED-TEXT\x1b[201~");
			await nextTick();
			await h.term.flush();

			expect(h.editor.getText()).toBe("PASTED-TEXT");
			expect(h.term.getViewport().join("\n")).toContain("PASTED-TEXT");
			await h.term.waitForRender();
			await expectTextAndViewport(h, "PASTED-TEXT");
		} finally {
			h.tui.stop();
		}
	}, 30000);

	it("keeps repaint write growth structurally bounded after an input burst", async () => {
		const h = setup();
		try {
			await h.term.waitForRender();
			h.term.clearWriteLog();
			const typed = Array.from({ length: 120 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
			let expected = "";

			for (const ch of typed) {
				h.tui.requestRender(false, "stream.chunk");
				h.term.sendInput(ch);
				expected += ch;
				await nextTick();
			}
			await h.term.waitForRender();

			await expectTextAndViewport(h, expected);
			const writes = h.term.getWriteLog();
			const bytes = writes.join("").length;
			// Loose structural sanity: expedited/coalesced renders may write per keystroke, but must not
			// balloon quadratically with burst length or transcript size.
			expect(writes.length).toBeLessThanOrEqual(typed.length * 12 + 80);
			expect(bytes).toBeLessThan(typed.length * 600);
		} finally {
			h.tui.stop();
		}
	}, 30000);
});
