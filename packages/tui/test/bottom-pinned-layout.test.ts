import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, Container, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class LinesComponent implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.lines;
	}
}

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.#lines;
	}
}

describe("TUI bottom-pinned layout", () => {
	const terminalEnvironmentKeys = ["TMUX", "TMUX_PANE", "STY", "ZELLIJ", "GJC_TMUX_LAUNCHED", "TERM"] as const;
	let previousTerminalEnvironment = new Map<string, string | undefined>();
	beforeEach(() => {
		previousTerminalEnvironment = new Map(terminalEnvironmentKeys.map(key => [key, process.env[key]]));
		for (const key of terminalEnvironmentKeys) delete process.env[key];
		process.env.TERM = "xterm-256color";
	});
	afterEach(() => {
		for (const key of terminalEnvironmentKeys) {
			const value = previousTerminalEnvironment.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("pads short content so the pinned component reaches the bottom row", async () => {
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		const header = new LinesComponent(["forge"]);
		const pinned = new LinesComponent(["status", "composer"]);

		tui.addChild(header);
		tui.addChild(pinned);
		tui.setBottomPinnedComponent(pinned);

		try {
			tui.start();
			await term.waitForRender();

			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport[0]).toBe("forge");
			expect(viewport.slice(1, 6)).toEqual(["", "", "", "", ""]);
			expect(viewport[6]).toBe("status");
			expect(viewport[7]).toBe("composer");
		} finally {
			tui.stop();
		}
	});

	it("does not insert spacer rows when content already exceeds the viewport", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		const header = new LinesComponent(["line-0", "line-1", "line-2"]);
		const pinned = new LinesComponent(["status", "composer"]);

		tui.addChild(header);
		tui.addChild(pinned);
		tui.setBottomPinnedComponent(pinned);

		try {
			tui.start();
			await term.waitForRender();

			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport).toEqual(["line-1", "line-2", "status", "composer"]);
		} finally {
			tui.stop();
		}
	});

	for (const isProcessTerminal of [false, true]) {
		it(`keeps contracted output below committed scrollback (${isProcessTerminal ? "process" : "virtual"} terminal)`, async () => {
			const term = new VirtualTerminal(40, 6, { isProcessTerminal });
			const tui = new TUI(term);
			const transcript = new MutableLinesComponent(["transcript-0", "transcript-1", "transcript-2"]);
			const working = new MutableLinesComponent(["working"]);
			const status = new LinesComponent(["status"]);

			tui.addChild(transcript);
			tui.addChild(working);
			tui.addChild(status);
			tui.setBottomPinnedComponent(status);

			try {
				tui.start();
				await term.waitForRender();

				transcript.setLines(Array.from({ length: 14 }, (_value, index) => `transcript-${index}`));
				tui.requestRender();
				await term.waitForRender();

				working.setLines([]);
				tui.requestRender();
				await term.waitForRender();

				const scrollBuffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(scrollBuffer.filter(line => line.startsWith("transcript-"))).toEqual(
					Array.from({ length: 14 }, (_value, index) => `transcript-${index}`),
				);
				const contractedViewport = term.getViewport().map(line => line.trimEnd());
				expect(contractedViewport.filter(line => line.startsWith("transcript-"))).toEqual(
					Array.from({ length: 4 }, (_value, index) => `transcript-${index + 10}`),
				);
				expect(contractedViewport.slice(-2)).toEqual(["", "status"]);

				term.resize(40, 8);
				await term.waitForRender();

				const resizedScrollBuffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(resizedScrollBuffer.filter(line => line.startsWith("transcript-"))).toEqual(
					Array.from({ length: 14 }, (_value, index) => `transcript-${index}`),
				);
				const resizedViewport = term.getViewport().map(line => line.trimEnd());
				if (isProcessTerminal) {
					expect(resizedViewport.filter(line => line.startsWith("transcript-"))).toEqual(
						Array.from({ length: 4 }, (_value, index) => `transcript-${index + 10}`),
					);
				} else {
					expect(resizedViewport.filter(line => line.startsWith("transcript-"))).toEqual(
						Array.from({ length: 7 }, (_value, index) => `transcript-${index + 7}`),
					);
				}
				expect(resizedViewport.at(-1)).toBe("status");

				transcript.setLines(Array.from({ length: 15 }, (_value, index) => `transcript-${index}`));
				tui.requestRender();
				await term.waitForRender();

				const grownScrollBuffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(grownScrollBuffer.filter(line => line.startsWith("transcript-"))).toEqual(
					Array.from({ length: 15 }, (_value, index) => `transcript-${index}`),
				);
				const grownViewport = term.getViewport().map(line => line.trimEnd());
				expect(grownViewport).toContain("transcript-14");
				expect(grownViewport.at(-1)).toBe("status");
			} finally {
				tui.stop();
			}
		});
	}

	for (const isProcessTerminal of [false, true]) {
		describe(`frontier preservation with ${isProcessTerminal ? "process" : "virtual"} terminal`, () => {
			it("preserves the committed frontier when following live after manual-history output", async () => {
				const term = new VirtualTerminal(40, 6, { isProcessTerminal });
				const tui = new TUI(term);
				const transcript = new MutableLinesComponent(["transcript-0", "transcript-1", "transcript-2"]);
				const working = new MutableLinesComponent(Array.from({ length: 5 }, (_value, index) => `working-${index}`));
				const status = new LinesComponent(["status"]);
				tui.addChild(transcript);
				tui.addChild(working);
				tui.addChild(status);
				tui.setBottomPinnedComponent(status);

				try {
					tui.start();
					await term.waitForRender();
					transcript.setLines(Array.from({ length: 14 }, (_value, index) => `transcript-${index}`));
					tui.requestRender();
					await term.waitForRender();

					working.setLines([]);
					tui.requestRender();
					await term.waitForRender();
					const committedRows = Array.from({ length: 14 }, (_value, index) => `transcript-${index}`);
					expect(
						term
							.getScrollBuffer()
							.map(line => line.trimEnd())
							.filter(line => line.startsWith("transcript-")),
					).toEqual(committedRows);

					expect(tui.scrollViewportPages(-1)).toBe(true);
					await term.flush();
					working.setLines(["later-0"]);
					tui.requestRender();
					await term.waitForRender();

					expect(tui.followLiveViewport()).toBe(true);
					await term.flush();
					const followedViewport = term.getViewport().map(line => line.trimEnd());
					if (isProcessTerminal) {
						expect(followedViewport).toEqual(["later-0", "", "", "", "", "status"]);
					} else {
						expect(followedViewport.at(-1)).toBe("status");
						expect(followedViewport.filter(line => line === "later-0")).toHaveLength(1);
					}

					working.setLines(["later-0", "later-1"]);
					tui.requestRender();
					await term.waitForRender();
					expect(
						term
							.getScrollBuffer()
							.map(line => line.trimEnd())
							.filter(line => line.startsWith("transcript-")),
					).toEqual(committedRows);
					const appendedViewport = term.getViewport().map(line => line.trimEnd());
					if (isProcessTerminal) {
						expect(appendedViewport).toEqual(["later-0", "later-1", "", "", "", "status"]);
					} else {
						expect(appendedViewport.at(-1)).toBe("status");
						expect(appendedViewport.filter(line => line === "later-0")).toHaveLength(1);
						expect(appendedViewport.filter(line => line === "later-1")).toHaveLength(1);
					}
				} finally {
					tui.stop();
				}
			});

			it("retains the manual resume frontier across temporary suspend and start", async () => {
				const term = new VirtualTerminal(40, 6, { isProcessTerminal });
				const tui = new TUI(term);
				const transcript = new MutableLinesComponent(["transcript-0", "transcript-1", "transcript-2"]);
				const working = new MutableLinesComponent(Array.from({ length: 5 }, (_value, index) => `working-${index}`));
				const status = new LinesComponent(["status"]);
				tui.addChild(transcript);
				tui.addChild(working);
				tui.addChild(status);
				tui.setBottomPinnedComponent(status);

				try {
					tui.start();
					await term.waitForRender();
					transcript.setLines(Array.from({ length: 14 }, (_value, index) => `transcript-${index}`));
					tui.requestRender();
					await term.waitForRender();
					working.setLines([]);
					tui.requestRender();
					await term.waitForRender();
					const committedRows = Array.from({ length: 14 }, (_value, index) => `transcript-${index}`);
					expect(
						term
							.getScrollBuffer()
							.map(line => line.trimEnd())
							.filter(line => line.startsWith("transcript-")),
					).toEqual(committedRows);

					expect(tui.scrollViewportPages(-1)).toBe(true);
					await term.flush();
					working.setLines(["later-0"]);
					tui.requestRender();
					await term.waitForRender();
					const manualRowsBeforeStop = term
						.getScrollBuffer()
						.map(line => line.trimEnd())
						.filter(line => line.startsWith("transcript-"));
					const manualViewportBeforeStop = term.getViewport().map(line => line.trimEnd());
					tui.suspend();
					await term.flush();
					expect(
						term
							.getScrollBuffer()
							.map(line => line.trimEnd())
							.filter(line => line.startsWith("transcript-")),
					).toEqual(manualRowsBeforeStop);
					expect(term.getViewport().at(-1)?.trimEnd()).toBe("");
					working.setLines(["later-0", "later-1"]);
					tui.start();
					await term.waitForRender();
					expect(term.getViewport().map(line => line.trimEnd())).toEqual(manualViewportBeforeStop);

					expect(tui.followLiveViewport()).toBe(true);
					await term.flush();
					expect(
						term
							.getScrollBuffer()
							.map(line => line.trimEnd())
							.filter(line => line.startsWith("transcript-")),
					).toEqual(committedRows);
					const followedViewport = term.getViewport().map(line => line.trimEnd());
					if (isProcessTerminal) {
						expect(followedViewport).toEqual(["later-0", "later-1", "", "", "", "status"]);
					} else {
						expect(followedViewport.at(-1)).toBe("status");
						expect(followedViewport.filter(line => line === "later-0")).toHaveLength(1);
						expect(followedViewport.filter(line => line === "later-1")).toHaveLength(1);
					}

					expect(
						term
							.getScrollBuffer()
							.map(line => line.trimEnd())
							.filter(line => line.startsWith("transcript-")),
					).toEqual(committedRows);
					expect(term.getViewport().at(-1)?.trimEnd()).toBe("status");
				} finally {
					tui.stop();
				}
			});

			it("recomputes frontier spacer geometry after layout growth", async () => {
				const term = new VirtualTerminal(40, 6, { isProcessTerminal });
				const tui = new TUI(term, undefined, { widthSettleMs: 0 });
				const transcript = new Container();
				transcript.replaceChildren(
					Array.from({ length: 3 }, (_value, index) => new MutableLinesComponent([`transcript-${index}`])),
				);
				const working = new MutableLinesComponent(Array.from({ length: 5 }, (_value, index) => `working-${index}`));
				const status = new LinesComponent(["status"]);
				tui.addChild(transcript);
				tui.addChild(working);
				tui.addChild(status);
				tui.setViewportAnchorComponent(transcript);
				tui.setBottomPinnedComponent(status);
				tui.setViewportOutputSource({ identity: "session:frontier-spacer-layout", revision: 0n });

				try {
					tui.start();
					await term.waitForRender();
					transcript.replaceChildren(
						Array.from({ length: 14 }, (_value, index) => new MutableLinesComponent([`transcript-${index}`])),
					);
					tui.setViewportOutputSource({ identity: "session:frontier-spacer-layout", revision: 1n });
					tui.requestRender();
					await term.waitForRender();

					working.setLines([]);
					tui.requestRender();
					await term.waitForRender();
					working.setLines(Array.from({ length: 5 }, (_value, index) => `working-${index}`));
					tui.requestLayoutRender("frontier-spacer-layout-growth");
					await term.waitForRender();

					expect(tui.scrollViewportPages(-1)).toBe(true);
					await term.flush();
					const viewport = term.getViewport().map(line => line.trimEnd());
					expect(viewport.at(-1)).toBe("status");
					expect(viewport.some(line => line.startsWith("transcript-"))).toBe(true);
				} finally {
					tui.stop();
				}
			});

			it("shows a short replacement transcript instead of the old session frontier", async () => {
				const term = new VirtualTerminal(40, 6, { isProcessTerminal });
				const tui = new TUI(term);
				const transcript = new MutableLinesComponent(Array.from({ length: 18 }, (_value, index) => `old-${index}`));
				const status = new LinesComponent(["status"]);
				tui.addChild(transcript);
				tui.addChild(status);
				tui.setBottomPinnedComponent(status);

				try {
					tui.start();
					await term.waitForRender();
					tui.resetViewportAnchorIntent();
					transcript.setLines(["replacement-0", "replacement-1"]);
					tui.requestRender();
					await term.waitForRender();

					const viewport = term.getViewport().map(line => line.trimEnd());
					expect(viewport).toContain("replacement-0");
					expect(viewport).toContain("replacement-1");
					expect(viewport.some(line => line.startsWith("old-"))).toBe(false);
					expect(viewport.at(-1)).toBe("status");
				} finally {
					tui.stop();
				}
			});

			it("shows a rebuilt summary instead of preserving a stale live frontier", async () => {
				const term = new VirtualTerminal(40, 6, { isProcessTerminal });
				const tui = new TUI(term);
				const transcript = new MutableLinesComponent(
					Array.from({ length: 18 }, (_value, index) => `history-${index}`),
				);
				const status = new LinesComponent(["status"]);
				tui.addChild(transcript);
				tui.addChild(status);
				tui.setBottomPinnedComponent(status);

				try {
					tui.start();
					await term.waitForRender();
					tui.prepareViewportAnchorForTranscriptRebuild();
					transcript.setLines(["summary-0", "summary-1", "summary-2"]);
					tui.requestRender();
					await term.waitForRender();

					const viewport = term.getViewport().map(line => line.trimEnd());
					expect(viewport).toContain("summary-0");
					expect(viewport).toContain("summary-2");
					expect(viewport.at(-1)).toBe("status");
				} finally {
					tui.stop();
				}
			});

			it("preserves the live frontier during a same-width forced redraw", async () => {
				const term = new VirtualTerminal(40, 6, { isProcessTerminal });
				const tui = new TUI(term);
				const transcript = new MutableLinesComponent(["transcript-0", "transcript-1", "transcript-2"]);
				const working = new MutableLinesComponent(["working"]);
				const status = new LinesComponent(["status"]);
				tui.addChild(transcript);
				tui.addChild(working);
				tui.addChild(status);
				tui.setBottomPinnedComponent(status);

				try {
					tui.start();
					await term.waitForRender();
					transcript.setLines(Array.from({ length: 14 }, (_value, index) => `transcript-${index}`));
					tui.requestRender();
					await term.waitForRender();
					working.setLines([]);
					tui.requestRender(true, "test.forced-contraction");
					await term.waitForRender();

					const scrollRows = term
						.getScrollBuffer()
						.map(line => line.trimEnd())
						.filter(line => line.startsWith("transcript-"));
					expect(scrollRows).toEqual(Array.from({ length: 14 }, (_value, index) => `transcript-${index}`));
					const viewport = term.getViewport().map(line => line.trimEnd());
					if (isProcessTerminal) {
						expect(viewport.filter(line => line.startsWith("transcript-"))).toEqual(
							Array.from({ length: 4 }, (_value, index) => `transcript-${index + 10}`),
						);
					}
					expect(viewport.at(-1)).toBe("status");
				} finally {
					tui.stop();
				}
			});

			it("keeps manual transcript capacity separate from frontier spacers", async () => {
				const term = new VirtualTerminal(40, 6, { isProcessTerminal });
				const tui = new TUI(term);
				const transcript = new MutableLinesComponent(
					Array.from({ length: 6 }, (_value, index) => `transcript-${index}`),
				);
				const working = new MutableLinesComponent(
					Array.from({ length: 20 }, (_value, index) => `working-${index}`),
				);
				const status = new LinesComponent(["status"]);
				tui.addChild(transcript);
				tui.addChild(working);
				tui.addChild(status);
				tui.setBottomPinnedComponent(status);

				try {
					tui.start();
					await term.waitForRender();
					working.setLines([]);
					tui.requestRender();
					await term.waitForRender();

					expect(tui.scrollViewportPages(-1)).toBe(true);
					await term.flush();
					const viewport = term.getViewport().map(line => line.trimEnd());
					expect(viewport.filter(line => line.startsWith("transcript-"))).not.toHaveLength(0);
					expect(viewport.at(-1)).toBe("status");
				} finally {
					tui.stop();
				}
			});
		});
	}

	it("leaves a blank handoff row after manual history on permanent stop", async () => {
		const term = new VirtualTerminal(40, 6, { isProcessTerminal: true });
		const tui = new TUI(term);
		tui.addChild(new MutableLinesComponent(Array.from({ length: 14 }, (_value, index) => `transcript-${index}`)));
		const status = new LinesComponent(["status"]);
		tui.addChild(status);
		tui.setBottomPinnedComponent(status);

		try {
			tui.start();
			await term.waitForRender();
			expect(tui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			const transcriptRowsBeforeStop = term
				.getScrollBuffer()
				.map(line => line.trimEnd())
				.filter(line => line.startsWith("transcript-"));
			tui.stop();
			await term.flush();
			expect(
				term
					.getScrollBuffer()
					.map(line => line.trimEnd())
					.filter(line => line.startsWith("transcript-")),
			).toEqual(transcriptRowsBeforeStop);
			expect(term.getViewport().at(-1)?.trimEnd()).toBe("");
		} finally {
			tui.stop();
		}
	});

	describe("with the GJC psmux launch marker", () => {
		let origTmux: string | undefined;
		let origTmuxPane: string | undefined;
		let origLaunched: string | undefined;

		beforeEach(() => {
			origTmux = process.env.TMUX;
			origTmuxPane = process.env.TMUX_PANE;
			origLaunched = process.env.GJC_TMUX_LAUNCHED;
			delete process.env.TMUX;
			delete process.env.TMUX_PANE;
			process.env.GJC_TMUX_LAUNCHED = "1";
		});

		afterEach(() => {
			if (origTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = origTmux;
			if (origTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = origTmuxPane;
			if (origLaunched === undefined) delete process.env.GJC_TMUX_LAUNCHED;
			else process.env.GJC_TMUX_LAUNCHED = origLaunched;
		});

		it("keeps the pinned group on the last row after a viewport resize", async () => {
			const term = new VirtualTerminal(40, 6, { isProcessTerminal: true });
			const tui = new TUI(term);
			const header = new LinesComponent(["forge"]);
			const pinned = new LinesComponent(["status", "composer"]);

			tui.addChild(header);
			tui.addChild(pinned);
			tui.setBottomPinnedComponent(pinned);

			try {
				tui.start();
				await term.waitForRender();

				term.clearWriteLog();
				term.resize(40, 9);
				await term.waitForRender();

				const viewport = term.getViewport().map(line => line.trimEnd());
				expect(viewport[0]).toBe("forge");
				expect(viewport.slice(1, 7)).toEqual(["", "", "", "", "", ""]);
				expect(viewport[7]).toBe("status");
				expect(viewport[8]).toBe("composer");
				expect(term.getWriteLog().join("")).not.toContain("\x1b[3J");
			} finally {
				tui.stop();
			}
		});
	});
});
