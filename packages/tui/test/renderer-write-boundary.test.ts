import { afterEach, describe, expect, it, vi } from "bun:test";
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

describe("renderer transaction write boundary", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits an accepted shared transaction before the exempt post-render overlay", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term);
		const observations: TuiTransactionObservation[] = [];
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			originalWrite(data);
		});
		tui.addChild(new FixedLines(["shared-frame"]));
		tui.setTransactionObserver(observation => observations.push(observation));
		tui.setPostRenderEmitter(() => "POST-RENDER-OVERLAY");

		try {
			tui.start();
			await settle(term);

			expect(observations).toHaveLength(2);
			expect(observations[0]).toMatchObject({
				classification: "shared",
				operation: "primary",
				outcome: "accepted",
			});
			expect(observations[0]?.bytes).toContain("shared-frame");
			expect(observations[1]).toMatchObject({
				classification: "exempt",
				outcome: "accepted",
			});
			expect(observations[1]?.bytes).toBe("\x1b[?2026h\x1b7POST-RENDER-OVERLAY\x1b8\x1b[?2026l");

			const sharedWrite = writes.findIndex(data => data.includes("shared-frame"));
			const overlayWrite = writes.findIndex(data => data.includes("POST-RENDER-OVERLAY"));
			expect(sharedWrite).toBeGreaterThanOrEqual(0);
			expect(overlayWrite).toBeGreaterThan(sharedWrite);
		} finally {
			tui.stop();
		}
	});

	it("reports a failed shared write and does not invoke the post-render overlay", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term);
		const observations: TuiTransactionObservation[] = [];
		let overlayCalls = 0;
		const originalWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			if (data.includes("SHARED-WRITE-FAILURE")) throw new Error("shared write failed");
			originalWrite(data);
		});
		tui.addChild(new FixedLines(["SHARED-WRITE-FAILURE"]));
		tui.setTransactionObserver(observation => observations.push(observation));
		tui.setPostRenderEmitter(() => {
			overlayCalls += 1;
			return "SHOULD-NOT-RENDER";
		});

		try {
			tui.start();
			await settle(term);

			expect(observations).toHaveLength(1);
			expect(observations[0]).toMatchObject({
				classification: "shared",
				operation: "primary",
				outcome: "failed",
			});
			expect(observations[0]?.bytes).toContain("SHARED-WRITE-FAILURE");
			expect(overlayCalls).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("keeps the accepted shared transaction when the exempt overlay write fails", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term);
		const observations: TuiTransactionObservation[] = [];
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			if (data.includes("OVERLAY-WRITE-FAILURE")) throw new Error("overlay write failed");
			originalWrite(data);
		});
		tui.addChild(new FixedLines(["shared-before-overlay-failure"]));
		tui.setTransactionObserver(observation => observations.push(observation));
		tui.setPostRenderEmitter(() => "OVERLAY-WRITE-FAILURE");

		try {
			tui.start();
			await settle(term);

			expect(observations).toHaveLength(2);
			expect(observations[0]).toMatchObject({
				classification: "shared",
				operation: "primary",
				outcome: "accepted",
			});
			expect(observations[1]).toMatchObject({
				classification: "exempt",
				outcome: "failed",
			});
			expect(observations[1]?.bytes).toContain("OVERLAY-WRITE-FAILURE");
			expect(writes.findIndex(data => data.includes("OVERLAY-WRITE-FAILURE"))).toBeGreaterThan(
				writes.findIndex(data => data.includes("shared-before-overlay-failure")),
			);
		} finally {
			tui.stop();
		}
	});
});
