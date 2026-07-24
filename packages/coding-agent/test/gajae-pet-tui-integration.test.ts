import { afterEach, describe, expect, it } from "bun:test";
import { Container, TUI, type Component } from "@gajae-code/tui";
import type { TuiTransactionObservation } from "@gajae-code/tui";
import type { Terminal, TerminalAppearance } from "@gajae-code/tui/terminal";
import type { CustomEditor } from "../src/modes/components/custom-editor";
import { GajaePetWidget } from "../src/modes/components/gajae-pet-widget";

class RecordingTerminal implements Terminal {
	readonly writes: string[] = [];
	readonly writeAttempts: string[] = [];
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _available = true;
	private failNextWriteCount = 0;
	private failurePredicate?: (data: string) => boolean;

	constructor(
		private readonly _columns = 80,
		private readonly _rows = 30,
	) {}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writeAttempts.push(data);
		if (!this._available) throw new Error("recording terminal unavailable");
		if (this.failNextWriteCount > 0) {
			this.failNextWriteCount -= 1;
			throw new Error("injected recording terminal failure");
		}
		if (this.failurePredicate?.(data)) {
			this.failurePredicate = undefined;
			throw new Error("injected recording terminal failure");
		}
		this.writes.push(data);
	}

	failNextWrite(): void {
		this.failNextWriteCount += 1;
	}

	failNextWriteMatching(predicate: (data: string) => boolean): void {
		this.failurePredicate = predicate;
	}

	setAvailable(available: boolean): void {
		this._available = available;
	}

	get available(): boolean {
		return this._available;
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		if (lines < 0) this.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		this.write("\x1b[H\x1b[0J");
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		this.write(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07");
	}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	setMouseEnabled(_enabled: boolean): void {}

	/** Keep this helper local to the recording terminal so tests do not need a real clock. */
	async settle(): Promise<void> {
		await new Promise<void>(resolve => process.nextTick(resolve));
		await new Promise<void>(resolve => setTimeout(resolve, 25));
	}
}

class FixedEditor implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		return [`editor:${width}`];
	}
}

class MutableLines implements Component {
	constructor(private lines: string[]) {}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.lines;
	}
}

function makeHarness(options: {
	protocol?: "sixel" | "kitty";
	rows?: number;
	lines?: string[];
} = {}) {
	const terminal = new RecordingTerminal(80, options.rows ?? 30);
	const ui = new TUI(terminal, false);
	const transactions: TuiTransactionObservation[] = [];
	ui.setTransactionObserver(observation => transactions.push(observation));
	const editor = new FixedEditor() as unknown as CustomEditor;
	const editorContainer = new Container();
	const floorContainer = new Container();
	const transcript = new MutableLines(options.lines ?? ["shared-head"]);
	editorContainer.addChild(editor);
	ui.addChild(transcript);
	ui.addChild(editorContainer);
	ui.addChild(new FixedLines(["shared-tail"]));
	const widget = new GajaePetWidget({
		ui,
		editor,
		editorContainer,
		floorContainer,
		isWorking: () => false,
		getComposerBottomOffset: () => floorContainer.render(terminal.columns).length,
		forcePixelProtocol: options.protocol ?? "sixel",
		autoFlexGapMs: null,
	});
	return { terminal, ui, widget, transcript, transactions };
}

class FixedLines implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.lines;
	}
}

const harnesses: Array<ReturnType<typeof makeHarness>> = [];

afterEach(() => {
	for (const { widget, ui } of harnesses.splice(0)) {
		widget.dispose();
		ui.dispose();
	}
});

describe("GajaePetWidget with the real TUI renderer", () => {
	it("uses both forced pixel protocols and records shared/overlay attempts and successes", async () => {
		for (const protocol of ["sixel", "kitty"] as const) {
			const harness = makeHarness({ protocol });
			harnesses.push(harness);
			harness.ui.start();
			await harness.terminal.settle();
			harness.terminal.writes.length = 0;
			harness.terminal.writeAttempts.length = 0;
			harness.transactions.length = 0;

			harness.widget.setMode("red");
			await harness.terminal.settle();

			const marker = protocol === "sixel" ? "\x1bP0;1;0q" : "\x1b_G";
			const sharedAttempt = harness.terminal.writeAttempts.findIndex(write => write.includes("shared-head"));
			const overlayAttempt = harness.terminal.writeAttempts.findIndex(write => write.includes(marker));
			expect(sharedAttempt).toBeGreaterThanOrEqual(0);
			expect(overlayAttempt).toBeGreaterThan(sharedAttempt);
			expect(harness.terminal.writes.some(write => write.includes(marker))).toBe(true);
			expect(
				harness.transactions.some(
					observation =>
						observation.classification === "shared" &&
						observation.outcome === "accepted" &&
						observation.operation === "primary",
				),
			).toBe(true);
			expect(
				harness.transactions.some(
					observation => observation.classification === "exempt" && observation.outcome === "accepted",
				),
			).toBe(true);
		}
	});

	it("does not attempt the overlay after a failed shared write, then recovers on ui.start()", async () => {
		for (const protocol of ["sixel", "kitty"] as const) {
			const harness = makeHarness({ protocol });
			harnesses.push(harness);
			harness.ui.start();
			await harness.terminal.settle();
			harness.terminal.writes.length = 0;
			harness.terminal.writeAttempts.length = 0;
			harness.transactions.length = 0;

			harness.terminal.failNextWrite();
			harness.widget.setMode("red");
			await harness.terminal.settle();

			const marker = protocol === "sixel" ? "\x1bP0;1;0q" : "\x1b_G";
			expect(harness.terminal.writeAttempts.some(write => write.includes("shared-head"))).toBe(true);
			expect(harness.terminal.writeAttempts.some(write => write.includes(marker))).toBe(false);
			expect(
				harness.transactions.some(
					observation => observation.classification === "shared" && observation.outcome === "failed",
				),
			).toBe(true);
			expect(
				harness.transactions.some(
					observation => observation.classification === "exempt" && observation.outcome === "failed",
				),
			).toBe(false);

			harness.ui.start();
			await harness.terminal.settle();
			expect(
				harness.transactions.some(
					observation =>
						observation.classification === "shared" &&
						observation.outcome === "accepted" &&
						observation.operation === "primary",
				),
			).toBe(true);
			expect(
				harness.transactions.some(
					observation => observation.classification === "exempt" && observation.outcome === "accepted",
				),
			).toBe(true);
		}
	});

	it("logs an overlay failure separately from its committed shared frame", async () => {
		for (const protocol of ["sixel", "kitty"] as const) {
			const harness = makeHarness({ protocol });
			harnesses.push(harness);
			harness.ui.start();
			await harness.terminal.settle();
			harness.terminal.writes.length = 0;
			harness.terminal.writeAttempts.length = 0;
			harness.transactions.length = 0;

			const marker = protocol === "sixel" ? "\x1bP0;1;0q" : "\x1b_G";
			harness.terminal.failNextWriteMatching(write => write.includes(marker));
			harness.widget.setMode("red");
			await harness.terminal.settle();

			expect(harness.terminal.writes.some(write => write.includes("shared-head"))).toBe(true);
			expect(harness.terminal.writes.some(write => write.includes(marker))).toBe(false);
			expect(
				harness.transactions.some(
					observation =>
						observation.classification === "shared" &&
						observation.outcome === "accepted" &&
						observation.operation === "primary",
				),
			).toBe(true);
			expect(
				harness.transactions.some(
					observation => observation.classification === "exempt" && observation.outcome === "failed",
				),
			).toBe(true);

			harness.ui.start();
			await harness.terminal.settle();
			expect(harness.terminal.writes.some(write => write.includes(marker))).toBe(true);
			expect(
				harness.transactions.some(
					observation => observation.classification === "exempt" && observation.outcome === "accepted",
				),
			).toBe(true);
		}
	});

	it("keeps page, follow, and status transitions in the real renderer transaction log", async () => {
		const initialLines = [...Array.from({ length: 12 }, (_, index) => `transcript-${index}`), "status:idle"];
		const harness = makeHarness({ rows: 4, lines: initialLines });
		harnesses.push(harness);
		harness.ui.start();
		await harness.terminal.settle();
		harness.widget.setMode("red");
		await harness.terminal.settle();
		harness.terminal.writes.length = 0;
		harness.transactions.length = 0;

		expect(harness.ui.scrollViewportPages(1)).toBe(true);
		expect(
			harness.transactions.some(
				observation =>
					observation.classification === "shared" &&
					observation.operation === "page" &&
					observation.outcome === "accepted",
			),
		).toBe(true);
		expect(
			harness.transactions.some(
				observation => observation.classification === "exempt" && observation.outcome === "accepted",
			),
		).toBe(true);

		expect(harness.ui.followLiveViewport()).toBe(true);
		expect(
			harness.transactions.some(
				observation =>
					observation.classification === "shared" &&
					observation.operation === "follow" &&
					observation.outcome === "accepted",
			),
		).toBe(true);

		harness.transcript.setLines([...initialLines.slice(0, -1), "status:working"]);
		harness.ui.requestRender(true);
		await harness.terminal.settle();
		expect(harness.terminal.writes.some(write => write.includes("status:working"))).toBe(true);
		expect(
			harness.transactions.some(
				observation =>
					observation.classification === "shared" &&
					observation.operation === "primary" &&
					observation.outcome === "accepted",
			),
		).toBe(true);
	});

	it("retries queued Pet cleanup when ui.start() follows terminal recovery", async () => {
		const harness = makeHarness();
		harnesses.push(harness);
		harness.ui.start();
		await harness.terminal.settle();
		harness.terminal.writes.length = 0;

		harness.widget.setMode("red");
		await harness.terminal.settle();
		harness.terminal.writes.length = 0;
		harness.terminal.setAvailable(false);
		harness.widget.dispose();

		expect(harness.terminal.writes).toHaveLength(0);

		harness.terminal.setAvailable(true);
		harness.ui.start();
		await harness.terminal.settle();
		expect(harness.terminal.writes.some(write => write.includes("\x1b[28;76H\x1b[4X"))).toBe(true);
	});
	it("commits shared renderer bytes before the real Pet overlay frame", async () => {
		const harness = makeHarness();
		harnesses.push(harness);
		harness.ui.start();
		await harness.terminal.settle();
		harness.terminal.writes.length = 0;

		harness.widget.setMode("red");
		await harness.terminal.settle();

		const sharedIndex = harness.terminal.writes.findIndex(
			write => write.includes("shared-head") && write.includes("shared-tail"),
		);
		const overlayIndex = harness.terminal.writes.findIndex(write => write.includes("\x1bP0;1;0q"));
		expect(sharedIndex).toBeGreaterThanOrEqual(0);
		expect(overlayIndex).toBeGreaterThan(sharedIndex);
		expect(harness.terminal.writes[overlayIndex]).toContain("\x1b[?2026h\x1b7");
	});

	it("emits a deterministic Pet frame and clears its delivered Sixel footprint on disable", async () => {
		const harness = makeHarness();
		harnesses.push(harness);
		harness.ui.start();
		await harness.terminal.settle();
		harness.terminal.writes.length = 0;

		harness.widget.setMode("red");
		await harness.terminal.settle();
		const frame = harness.terminal.writes.find(write => write.includes("\x1bP0;1;0q"));
		expect(frame).toBeDefined();
		expect(frame).toContain("\x1b[28;76H");

		harness.terminal.writes.length = 0;
		harness.widget.setMode("off");
		expect(harness.terminal.writes).toHaveLength(1);
		expect(harness.terminal.writes[0]).toContain("\x1b[28;76H\x1b[4X");

		await harness.terminal.settle();
		expect(harness.terminal.writes.filter(write => write.includes("\x1bP0;1;0q"))).toHaveLength(0);
	});
});
