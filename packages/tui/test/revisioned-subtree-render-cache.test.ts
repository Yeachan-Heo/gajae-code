import { describe, expect, it } from "bun:test";
import { type Component, Container, TUI } from "@gajae-code/tui";
import { settle, VirtualTerminal } from "./virtual-terminal";

class CountingTranscript extends Container {
	renderCount = 0;

	override renderWithViewportAnchors(width: number) {
		this.renderCount += 1;
		return super.renderWithViewportAnchors(width);
	}
}

class MutableComponent implements Component {
	#text: string;

	constructor(text: string) {
		this.#text = text;
	}

	setText(text: string): void {
		this.#text = text;
	}

	invalidate(): void {}

	render(): string[] {
		return [this.#text];
	}
}

describe("revisioned subtree render cache", () => {
	it("reuses an unchanged transcript while a local suffix changes", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		const transcript = new CountingTranscript();
		const suffix = new MutableComponent("status-0");
		for (let index = 0; index < 2_000; index++) transcript.addChild(new MutableComponent(`line-${index}`));
		tui.addChild(transcript);
		tui.addChild(suffix);
		tui.setViewportAnchorComponent(transcript);
		tui.setViewportOutputSource({ identity: "session:test", revision: 0n });

		try {
			tui.start();
			await settle(term, 20);
			expect(transcript.renderCount).toBe(1);

			for (let index = 1; index <= 5; index++) {
				suffix.setText(`status-${index}`);
				tui.requestLayoutRender("revision-cache-test");
				await settle(term, 20);
			}

			expect(transcript.renderCount).toBe(1);
			expect(term.getViewport().join("\n")).toContain("status-5");
		} finally {
			tui.stop();
		}
	});

	it("rerenders when the transcript revision or width changes", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		const transcript = new CountingTranscript();
		transcript.addChild(new MutableComponent("transcript"));
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		tui.setViewportOutputSource({ identity: "session:test", revision: 0n });

		try {
			tui.start();
			await settle(term, 20);
			expect(transcript.renderCount).toBe(1);

			tui.setViewportOutputSource({ identity: "session:test", revision: 1n });
			await settle(term, 20);
			expect(transcript.renderCount).toBe(2);

			term.resize(100, 12);
			await settle(term, 20);
			expect(transcript.renderCount).toBe(3);
		} finally {
			tui.stop();
		}
	});

	it("rerenders when a transcript subtree replaces direct children", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		const transcript = new CountingTranscript();
		transcript.addChild(new MutableComponent("before"));
		tui.addChild(transcript);
		tui.addChild(new MutableComponent("suffix"));
		tui.setViewportAnchorComponent(transcript);
		tui.setViewportOutputSource({ identity: "session:test", revision: 0n });

		try {
			tui.start();
			await settle(term, 20);
			transcript.replaceChildren([new MutableComponent("after")]);
			tui.requestLayoutRender("transcript-replacement");
			await settle(term, 20);

			expect(transcript.renderCount).toBe(2);
			expect(term.getViewport().join("\n")).toContain("after");
		} finally {
			tui.stop();
		}
	});

	it("renders conservatively for ordinary requests even when the semantic revision is unchanged", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		const transcript = new CountingTranscript();
		const line = new MutableComponent("before");
		transcript.addChild(line);
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		tui.setViewportOutputSource({ identity: "session:test", revision: 0n });

		try {
			tui.start();
			await settle(term, 20);
			line.setText("after");
			tui.requestRender(true, "ordinary-mutation");
			await settle(term, 20);

			expect(transcript.renderCount).toBe(2);
			expect(term.getViewport().join("\n")).toContain("after");
		} finally {
			tui.stop();
		}
	});

	it("lets a coalesced ordinary request override a pending layout-only request", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, undefined, { widthSettleMs: 0 });
		const transcript = new CountingTranscript();
		const line = new MutableComponent("before");
		transcript.addChild(line);
		tui.addChild(transcript);
		tui.setViewportAnchorComponent(transcript);
		tui.setViewportOutputSource({ identity: "session:test", revision: 0n });

		try {
			tui.start();
			await settle(term, 20);
			line.setText("after");
			tui.requestLayoutRender("pending-layout");
			tui.requestRender(false, "ordinary-mutation");
			await settle(term, 20);

			expect(transcript.renderCount).toBe(2);
			expect(term.getViewport().join("\n")).toContain("after");
		} finally {
			tui.stop();
		}
	});
});
