import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import { visibleWidth } from "@gajae-code/tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(1);
	await term.flush();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function countMatches(lines: string[], pattern: RegExp): number {
	let count = 0;
	for (const line of lines) {
		if (pattern.test(line)) count += 1;
	}
	return count;
}

describe("TUI terminal-state regressions", () => {
	let monotonicNow = 0;
	let previousTmux: string | undefined;
	let previousSty: string | undefined;
	let previousZellij: string | undefined;
	let previousLegacyFullRender: string | undefined;
	// Keep TUI's 16ms render throttle deterministic without sleeping a real frame per render.

	beforeEach(() => {
		previousTmux = Bun.env.TMUX;
		previousSty = Bun.env.STY;
		previousZellij = Bun.env.ZELLIJ;
		previousLegacyFullRender = Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		delete Bun.env.TMUX;
		delete Bun.env.STY;
		delete Bun.env.ZELLIJ;
		delete Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousTmux === undefined) {
			delete Bun.env.TMUX;
		} else {
			Bun.env.TMUX = previousTmux;
		}
		if (previousSty === undefined) {
			delete Bun.env.STY;
		} else {
			Bun.env.STY = previousSty;
		}
		if (previousZellij === undefined) {
			delete Bun.env.ZELLIJ;
		} else {
			Bun.env.ZELLIJ = previousZellij;
		}
		if (previousLegacyFullRender === undefined) {
			delete Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
		} else {
			Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER = previousLegacyFullRender;
		}
	});

	describe("cursor + differential stability", () => {
		it("keeps stable output across repeated no-op renders", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["hello", "world", "stable"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const before = visible(term);

				for (let i = 0; i < 8; i++) {
					tui.requestRender();
					await settle(term);
				}

				expect(visible(term)).toEqual(before);
			} finally {
				tui.stop();
			}
		});

		it("updates only changed middle line without corrupting neighbors", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["AAA", "BBB", "CCC", "DDD", "EEE"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const before = visible(term);

				component.setLines(["AAA", "BBB", "XXX", "DDD", "EEE"]);
				tui.requestRender();
				await settle(term);

				const after = visible(term);
				expect(after[0]).toBe(before[0]);
				expect(after[1]).toBe(before[1]);
				expect(after[2]?.trim()).toBe("XXX");
				expect(after[3]).toBe(before[3]);
				expect(after[4]).toBe(before[4]);
			} finally {
				tui.stop();
			}
		});

		it("clears removed tail lines after shrink", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["A", "B", "C", "D", "E"]);
			tui.setClearOnShrink(true);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(["A", "B"]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe("A");
				expect(viewport[1]?.trim()).toBe("B");
				expect(viewport[2]?.trim()).toBe("");
				expect(viewport[3]?.trim()).toBe("");
				expect(viewport[4]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("clears row 0 when content shrinks to empty without clearOnShrink", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["A"]);
			tui.setClearOnShrink(false);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines([]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});
	});
	describe("render line cache bounds", () => {
		it("keeps normalization and truncation caches bounded for streaming unique lines", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 10_000; i++) component.setLines([`stream-${i}-${"x".repeat(80)}`]);
				tui.requestRender();
				await settle(term);

				const stats = tui.getLineRenderCacheStats();
				expect(stats.normalizationSize).toBeLessThanOrEqual(stats.normalizationLimit);
				expect(stats.truncationSize).toBeLessThanOrEqual(stats.truncationLimit);
				expect(stats.normalizationLimit).toBe(2);
				expect(stats.truncationLimit).toBe(2);
			} finally {
				tui.stop();
			}
		});
	});

	describe("resize + viewport behavior", () => {
		it("clears preexisting shell rows on startup and resize redraw", async () => {
			const term = new VirtualTerminal(50, 5);
			term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
			await settle(term);

			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("ui-", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(49, 5);
				await settle(term);

				const buffer = term.getScrollBuffer().join("\n");
				expect(buffer.includes("shell-")).toBeFalsy();
			} finally {
				tui.stop();
			}
		});

		it("resizing width truncates visible lines without ghost wrap rows", async () => {
			const term = new VirtualTerminal(30, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([
				"012345678901234567890123456789012345",
				"ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
			]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(16, 6);
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]!.length).toBeLessThanOrEqual(16);
				expect(viewport[1]!.length).toBeLessThanOrEqual(16);
				expect(viewport[2]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});
		it("truncates compatibility jamo before the terminal can auto-wrap them", async () => {
			const term = new VirtualTerminal(10, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["ㅁ".repeat(20)]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]).toBe("ㅁ".repeat(5));
				expect(visibleWidth(viewport[0]!)).toBe(10);
				expect(viewport[1]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("normalizes decomposed Korean jamo before terminal emission", async () => {
			const term = new VirtualTerminal(20, 6);
			const tui = new TUI(term);
			const decomposed = "한글 출력";
			const component = new MutableLinesComponent([decomposed]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]).toBe("한글 출력");
				expect(viewport.join("\n")).not.toContain("ᄒ");
				expect(viewport.join("\n")).not.toContain("\\u");
			} finally {
				tui.stop();
			}
		});

		it("maintains exact viewport rows across repeated width reflow on sparse mixed content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);
				expect(visible(term)).toEqual(expectedViewport(80, 18));

				const widths = [72, 64, 56, 68, 52, 80];
				for (const width of widths) {
					term.resize(width, 18);
					await settle(term);
					expect(visible(term)).toEqual(expectedViewport(width, 18));
				}
			} finally {
				tui.stop();
			}
		});
		it("aggressive resize storm does not duplicate viewport content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				const sizes: Array<[number, number]> = [];
				for (let i = 0; i < 240; i++) {
					sizes.push([i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18]);
				}

				for (const [w, h] of sizes) {
					term.resize(w, h);
				}
				await settle(term);

				const [finalWidth, finalHeight] = sizes[sizes.length - 1]!;
				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		});
		it("height-only resize recovers from cursor drift without duplicate rows", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				// Simulate terminal-managed cursor relocation during aggressive UI changes/resizes.
				// TUI's internal cursor row bookkeeping does not observe this external movement.
				term.write("\x1b[18;1H");
				await settle(term);

				term.resize(80, 17);
				await settle(term);

				expect(visible(term)).toEqual(expectedViewport(80, 17));
			} finally {
				tui.stop();
			}
		});
		it("streaming content under aggressive resize keeps a single consistent viewport", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const source = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
				"        ├─────────┬─────────┬────────┬──────┬──────────────┬──────────────┐",
				"        │         │         │        │      │              │              │",
				"        ▼         │         ▼        │      ▼              ▼              ▼",
				"┌──────────────┐  │  ┌────────────┐  │  ┌───────┐     ┌─────────┐     ┌───────┐",
				"│    agent     │  │  │    tui     │  │  │ utils │     │ natives │     │ stats │",
				"└───────┬──────┘  │  └──────┬─────┘  │  └───────┘     └────┬────┘     └───────┘",
				"        ├─────────┘         └────────┘                     │",
				"        ▼                                                  │",
				"┌──────────────┐     ┌────────────┐                        │",
				"│      ai      │     │ pi-natives │◄───────────────────────┘",
				"└──────────────┘     └────────────┘",
			];
			const working: string[] = [];
			const component = new MutableLinesComponent(working);
			tui.addChild(component);

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = working.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				let nextLine = 0;
				let finalWidth = term.columns;
				let finalHeight = term.rows;
				for (let i = 0; i < 180; i++) {
					if (i % 3 === 0 && nextLine < source.length) {
						working.push(source[nextLine++]!);
						component.setLines(working);
					}

					finalWidth = i % 2 === 0 ? 79 : 80;
					finalHeight = i % 4 < 2 ? 17 : 18;
					term.resize(finalWidth, finalHeight);
					tui.requestRender();
					await settle(term);
				}

				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		});
		it("forced renders during resize storm stay stable under cursor relocation", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = Array.from({ length: 40 }, (_v, i) => `row-${i}`);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				let finalWidth = term.columns;
				let finalHeight = term.rows;
				for (let i = 0; i < 80; i++) {
					finalWidth = i % 2 === 0 ? 79 : 80;
					finalHeight = i % 3 === 0 ? 17 : 18;
					term.resize(finalWidth, finalHeight);
					term.write("\x1b[18;1H");
					tui.requestRender(true);
					await settle(term);
				}

				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		});
		it("shrink then grow keeps tail anchored to latest rows", async () => {
			const term = new VirtualTerminal(24, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("row-", 30));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(rows("row-", 16));
				tui.requestRender();
				await settle(term);

				component.setLines(rows("row-", 24));
				tui.requestRender();
				await settle(term);

				const viewport = visible(term).filter(line => line.trim().length > 0);
				expect(viewport).toHaveLength(6);
				expect(viewport[0]?.trim()).toBe("row-18");
				expect(viewport[5]?.trim()).toBe("row-23");
			} finally {
				tui.stop();
			}
		});
		it("mixed width/height resize storm keeps scrollback bounded for static content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
				"        ├─────────┬─────────┬────────┬──────┬──────────────┬──────────────┐",
				"        │         │         │        │      │              │              │",
				"        ▼         │         ▼        │      ▼              ▼              ▼",
				"┌──────────────┐  │  ┌────────────┐  │  ┌───────┐     ┌─────────┐     ┌───────┐",
				"│    agent     │  │  │    tui     │  │  │ utils │     │ natives │     │ stats │",
				"└───────┬──────┘  │  └──────┬─────┘  │  └───────┘     └────┬────┘     └───────┘",
				"        ├─────────┘         └────────┘                     │",
				"        ▼                                                  │",
				"┌──────────────┐     ┌────────────┐                        │",
				"│      ai      │     │ pi-natives │◄───────────────────────┘",
				"└──────────────┘     └────────────┘",
			];
			tui.addChild(new MutableLinesComponent(lines));

			try {
				tui.start();
				await settle(term);
				const before = term.getScrollBuffer().length;

				for (let i = 0; i < 220; i++) {
					term.resize(i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18);
					await settle(term);
				}

				const after = term.getScrollBuffer().length;
				expect(after - before).toBeLessThan(120);
			} finally {
				tui.stop();
			}
		}, 15_000);
	});

	describe("scrollback integrity", () => {
		it("repaints only the visible viewport for offscreen changes in tmux", async () => {
			Bun.env.TMUX = "1";
			delete Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;

			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const lines = rows("line-", 80);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const before = visible(term);

				term.clearWriteLog();
				const nextLines = [...lines];
				nextLines[0] = "updated-offscreen-header";
				component.setLines(nextLines);
				tui.requestRender();
				await settle(term);

				expect(visible(term)).toEqual(before);
				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\x1b[3J");
				expect(writes).not.toContain("\x1b[2J");
				expect(writes).not.toContain("updated-offscreen-header");
				expect(writes).toContain("line-79");
			} finally {
				tui.stop();
			}
		});

		it("keeps a legacy full-render kill switch for multiplexer viewport repaint", async () => {
			Bun.env.TMUX = "1";
			Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER = "1";

			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const lines = rows("line-", 80);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.clearWriteLog();
				const nextLines = [...lines];
				nextLines[0] = "updated-offscreen-header";
				component.setLines(nextLines);
				tui.requestRender();
				await settle(term);

				const writes = term.getWriteLog().join("");
				expect(writes).toContain("\x1b[2J\x1b[H");
				expect(writes).not.toContain("\x1b[3J");
				expect(writes).toContain("updated-offscreen-header");
			} finally {
				tui.stop();
			}
		});

		it("refreshes newly visible rows after a tmux height increase", async () => {
			Bun.env.TMUX = "1";
			delete Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;

			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const lines = rows("line-", 80);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const nextLines = [...lines];
				nextLines[70] = "UPDATED-70";
				component.setLines(nextLines);
				tui.requestRender();
				await settle(term);
				expect(visible(term).join("\n")).not.toContain("UPDATED-70");

				term.clearWriteLog();
				term.resize(32, 12);
				await settle(term);

				const viewport = visible(term).join("\n");
				expect(viewport).toContain("UPDATED-70");
				expect(viewport).not.toContain("line-70");
				const writes = term.getWriteLog().join("");
				expect(writes).not.toContain("\x1b[3J");
				expect(writes).not.toContain("\x1b[2J");
				expect(writes).not.toContain("line-0");
				expect(writes).toContain("UPDATED-70");
			} finally {
				tui.stop();
			}
		});

		it("overflow content appears once across buffer without duplicate row IDs", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 10));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const all = term.getScrollBuffer();
				for (let i = 0; i < 10; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(countMatches(all, pattern), `line-${i} should appear exactly once`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});

		it("appending lines during aggressive resize does not duplicate history rows", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines: string[] = [];
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 140; i++) {
					lines.push(`line-${i}`);
					component.setLines(lines);
					term.resize(i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18);
					tui.requestRender();
					await settle(term);
				}

				const scrollback = term.getScrollBuffer();
				const duplicated: number[] = [];
				let presentCount = 0;
				for (let i = 0; i < 140; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					const count = countMatches(scrollback, pattern);
					if (count > 0) presentCount += 1;
					if (count > 1) duplicated.push(i);
				}
				expect(presentCount).toBeGreaterThan(30);
				expect(duplicated).toEqual([]);
			} finally {
				tui.stop();
			}
		});

		it("retains append history when offscreen header changes during overflow growth", async () => {
			const term = new VirtualTerminal(32, 6);
			const tui = new TUI(term);
			const logLines = rows("line-", 6);
			let tick = 0;
			const component = new MutableLinesComponent([`status-${tick}`, ...logLines]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 6; i < 70; i++) {
					tick += 1;
					logLines.push(`line-${i}`);
					component.setLines([`status-${tick}`, ...logLines]);
					tui.requestRender();
					await settle(term);
				}

				const scrollback = term.getScrollBuffer();
				for (let i = 0; i < 70; i++) {
					expect(countMatches(scrollback, new RegExp(`\\bline-${i}\\b`))).toBe(1);
				}
				for (let i = 0; i <= tick; i++) {
					expect(countMatches(scrollback, new RegExp(`\\bstatus-${i}\\b`))).toBeLessThanOrEqual(1);
				}

				const viewport = visible(term).map(line => line.trim());
				expect(viewport.at(-1)).toBe("line-69");
				for (let i = 1; i < viewport.length; i++) {
					const prev = Number.parseInt(viewport[i - 1]!.slice(5), 10);
					const next = Number.parseInt(viewport[i]!.slice(5), 10);
					expect(next - prev).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("updates visible tail line when appending during overflow", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const lines = [...rows("line-", 7), "tail-0"];
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let tick = 1; tick <= 30; tick++) {
					lines[lines.length - 1] = `tail-${tick}`;
					lines.push(`new-${tick}`);
					component.setLines(lines);
					tui.requestRender();
					await settle(term);

					const viewport = visible(term).map(line => line.trim());
					const expectedViewport = lines.slice(Math.max(0, lines.length - term.rows)).map(line => line.trim());
					expect(viewport).toEqual(expectedViewport);
				}
			} finally {
				tui.stop();
			}
		});
		it("forced full redraws do not duplicate persistent content", async () => {
			const term = new VirtualTerminal(40, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["alpha", "beta", "gamma"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 5; i++) {
					tui.requestRender(true);
					await settle(term);
				}

				const allText = term.getScrollBuffer().join("\n");
				expect((allText.match(/alpha/g) ?? []).length).toBe(1);
				expect((allText.match(/beta/g) ?? []).length).toBe(1);
				expect((allText.match(/gamma/g) ?? []).length).toBe(1);
			} finally {
				tui.stop();
			}
		});
	});

	describe("overlay compositing", () => {
		it("overlay show/hide restores underlying content", async () => {
			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term);
			const base = new MutableLinesComponent(rows("base-", 8));
			tui.addChild(base);

			try {
				tui.start();
				await settle(term);

				const handle = tui.showOverlay(new MutableLinesComponent(["OVERLAY-0", "OVERLAY-1"]), {
					anchor: "top-left",
					row: 2,
					col: 4,
				});
				await settle(term);

				expect(visible(term)[2]?.includes("OVERLAY-0")).toBeTruthy();
				expect(visible(term)[3]?.includes("OVERLAY-1")).toBeTruthy();

				handle.hide();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[2]?.trim()).toBe("base-2");
				expect(viewport[3]?.trim()).toBe("base-3");
			} finally {
				tui.stop();
			}
		});
	});

	describe("stress scenarios", () => {
		it("rapid content mutations converge to final expected screen", async () => {
			const term = new VirtualTerminal(30, 8);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["init"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 80; i++) {
					const n = (i % 7) + 1;
					component.setLines(Array.from({ length: n }, (_v, j) => `iter-${i}-line-${j}`));
					tui.requestRender();
					await settle(term);
				}

				const expected = Array.from({ length: 3 }, (_v, j) => `iter-79-line-${j}`);
				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe(expected[0]);
				expect(viewport[1]?.trim()).toBe(expected[1]);
				expect(viewport[2]?.trim()).toBe(expected[2]);
				expect(viewport[3]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});
	});
	describe("cursor escape sequences stay inside synchronized output blocks", () => {
		// Cursor placement sequences that must not leak outside \x1b[?2026h…\x1b[?2026l
		const CURSOR_SEQ = /\x1b\[\?(?:25[hl]|\d+[A-G])/g;
		const BSU = "\x1b[?2026h";
		const ESU = "\x1b[?2026l";

		function getWrites(term: VirtualTerminal): string[] {
			const writes: string[] = [];
			const originalWrite = term.write.bind(term);
			const spy = vi.spyOn(term, "write");
			spy.mockImplementation((data: string) => {
				writes.push(data);
				originalWrite(data);
			});
			return writes;
		}

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("all cursor sequences fall inside BSU/ESU brackets on full render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const writes = getWrites(term);

			const component = new MutableLinesComponent(["hello", "world"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on differential render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);

			const component = new MutableLinesComponent(["AAA", "BBB", "CCC"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				component.setLines(["AAA", "XXX", "CCC"]);
				tui.requestRender();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on deleted-lines render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			tui.setClearOnShrink(true);

			const component = new MutableLinesComponent(["A", "B", "C", "D"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				component.setLines(["A", "B"]);
				tui.requestRender();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on repeated no-op renders", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);

			const component = new MutableLinesComponent(["hello", "world", "stable"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				for (let i = 0; i < 4; i++) {
					tui.requestRender();
					await settle(term);
				}
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		/**
		 * Assert that every cursor escape sequence in every write call appears
		 * strictly between a matched BSU/ESU pair, or is the sole payload of a
		 * standalone hideCursor call (from a no-change path).
		 */
		function assertCursorSequencesInsideSyncBlocks(writes: string[]): void {
			for (const write of writes) {
				if (write === "\x1b[?25l") {
					// Standalone hideCursor — allowed (no-change path)
					continue;
				}
				// Walk through the write, tracking BSU/ESU nesting
				let depth = 0;
				let idx = 0;
				while (idx < write.length) {
					CURSOR_SEQ.lastIndex = idx;
					const match = CURSOR_SEQ.exec(write);
					if (!match) break;

					const matchIdx = match.index;
					// Count BSU/ESU depth up to the match position
					let scanIdx = idx;
					while (scanIdx < matchIdx) {
						if (write.startsWith(BSU, scanIdx)) {
							depth++;
							scanIdx += BSU.length;
						} else if (write.startsWith(ESU, scanIdx)) {
							depth--;
							scanIdx += ESU.length;
						} else {
							scanIdx++;
						}
					}

					expect(depth).toBeGreaterThan(0);

					idx = matchIdx + match[0].length;
				}
			}
		}
	});
});
