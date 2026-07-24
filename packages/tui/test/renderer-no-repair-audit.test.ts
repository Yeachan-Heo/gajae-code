import { describe, expect, it } from "bun:test";
import { type Component, type TuiTransactionObservation, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class FixedLines implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.lines;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(1);
	await term.flush();
}

describe("renderer shared-write no-repair guard", () => {
	it("rejects erase CSI and incomplete CSI component bytes before terminal delivery", async () => {
		const unsafePayloads = [
			"\x1b[J",
			"\x1b[0J",
			"\x1b[?2J",
			"\x1b[1;2K",
			"\x9bJ",
			"\x9b?2K",
			"\x1b",
			"\x1b[",
			"\x1b[?2",
			"\x9b",
			"\x9b?2",
		];

		for (const payload of unsafePayloads) {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const observations: TuiTransactionObservation[] = [];
			tui.addChild(new FixedLines([`unsafe-shared${payload}`]));
			tui.setTransactionObserver(observation => observations.push(observation));

			try {
				tui.start();
				await settle(term);

				expect(term.getWriteLog().some(write => write.includes("unsafe-shared"))).toBe(false);
				expect(observations).toContainEqual(
					expect.objectContaining({ classification: "shared", outcome: "failed" }),
				);
			} finally {
				tui.stop();
			}
		}
	});

	it("keeps renderer-owned shared frames free of terminal erase CSI", async () => {
		const cases = [
			{ term: new VirtualTerminal(40, 10), lines: ["full-render-frame"] },
			{
				term: new VirtualTerminal(40, 10, { isProcessTerminal: true }),
				lines: ["viewport-render-frame"],
			},
		];

		for (const { term, lines } of cases) {
			const tui = new TUI(term);
			const observations: TuiTransactionObservation[] = [];
			tui.addChild(new FixedLines(lines));
			tui.setTransactionObserver(observation => observations.push(observation));

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();
				term.resize(41, 10);
				await settle(term);

				const eraseCsi = /\x1b\[(?:2K|2J|3J)/u;
				expect(term.getWriteLog().join("")).not.toMatch(eraseCsi);
				expect(
					observations
						.filter(observation => observation.classification === "shared")
						.every(observation => !eraseCsi.test(observation.bytes)),
				).toBe(true);
			} finally {
				tui.stop();
			}
		}
	});
	it("keeps Pet overlay bytes exempt from the shared guard", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term);
		const observations: TuiTransactionObservation[] = [];
		tui.addChild(new FixedLines(["safe-shared"]));
		tui.setTransactionObserver(observation => observations.push(observation));
		tui.setPostRenderEmitter(() => "\x1b[2JPET-OVERLAY");

		try {
			tui.start();
			await settle(term);

			expect(term.getWriteLog().some(write => write.includes("safe-shared"))).toBe(true);
			expect(term.getWriteLog().some(write => write.includes("PET-OVERLAY"))).toBe(true);
			expect(observations).toContainEqual(
				expect.objectContaining({ classification: "shared", outcome: "accepted" }),
			);
			expect(observations).toContainEqual(
				expect.objectContaining({
					classification: "exempt",
					outcome: "accepted",
					bytes: expect.stringContaining("\x1b[2J"),
				}),
			);
		} finally {
			tui.stop();
		}
	});
});
