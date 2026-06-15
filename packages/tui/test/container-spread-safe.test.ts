import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, Container, renderMetrics, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

/** Minimal component that returns a fixed line array regardless of width. */
class FixedLines implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	setLines(lines: string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.#lines;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(1);
	await term.flush();
}

describe("Container spread-safe composition (W1a / F2)", () => {
	it("composes a >500k-line child without RangeError and preserves order", () => {
		// The previous `lines.push(...child.render(width))` spread threw
		// `RangeError: Maximum call stack size exceeded` past ~490k elements.
		const bigCount = 600_000;
		const big = Array.from({ length: bigCount }, (_v, i) => `row${i}`);
		const container = new Container();
		container.addChild(new FixedLines(big));
		container.addChild(new FixedLines(["tail-a", "tail-b"]));

		const out = container.render(80);

		expect(out.length).toBe(bigCount + 2);
		expect(out[0]).toBe("row0");
		expect(out[bigCount - 1]).toBe(`row${bigCount - 1}`);
		expect(out[bigCount]).toBe("tail-a");
		expect(out[bigCount + 1]).toBe("tail-b");
	});

	it("produces output identical to manual child concatenation", () => {
		const children = [
			new FixedLines(["a", "b"]),
			new FixedLines(["c"]),
			new FixedLines([]),
			new FixedLines(["d", "e"]),
		];
		const container = new Container();
		for (const child of children) container.addChild(child);

		const out = container.render(80);
		const expected = children.flatMap(child => child.render(80));

		expect(out).toEqual(expected);
	});
});

describe("render line-count metrics (W1a foundation for F1)", () => {
	let wasEnabled = false;
	let previousTmux: string | undefined;
	let previousSty: string | undefined;
	let previousZellij: string | undefined;
	let monotonicNow = 0;

	beforeEach(() => {
		previousTmux = Bun.env.TMUX;
		previousSty = Bun.env.STY;
		previousZellij = Bun.env.ZELLIJ;
		delete Bun.env.TMUX;
		delete Bun.env.STY;
		delete Bun.env.ZELLIJ;
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
		wasEnabled = renderMetrics.enabled;
		renderMetrics.reset();
		renderMetrics.enable();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		renderMetrics.reset();
		if (!wasEnabled) renderMetrics.disable();
		if (previousTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = previousTmux;
		if (previousSty === undefined) delete Bun.env.STY;
		else Bun.env.STY = previousSty;
		if (previousZellij === undefined) delete Bun.env.ZELLIJ;
		else Bun.env.ZELLIJ = previousZellij;
	});

	it("populates rendered/measured/normalized gauges and diffed on a differential pass", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term);
		const component = new FixedLines(["alpha", "beta", "gamma"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term); // first render (full)

			// Second render exercises the differential diff path, recording "diffed".
			component.setLines(["alpha", "BETA", "gamma"]);
			tui.requestRender();
			await settle(term);
		} finally {
			tui.stop();
		}

		const { lineCounts } = renderMetrics.snapshot();
		expect(lineCounts.rendered?.last).toBeGreaterThan(0);
		expect(lineCounts.measured?.last).toBeGreaterThan(0);
		expect(lineCounts.normalized?.last).toBeGreaterThan(0);
		expect(lineCounts.diffed?.last).toBeGreaterThan(0);
	});
});
