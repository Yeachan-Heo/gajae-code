import { afterAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Component, renderMetrics, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

const FLAG = "PI_TUI_VIRTUAL_VIEWPORT";
const ROWS = 12;
const OVERSCAN = 8;

type CaseResult = {
	name: string;
	status: "passed" | "failed";
	checks: string[];
	metrics?: Record<string, unknown>;
	error?: string;
};

type Capture = { viewport: string[]; scrollback: string[]; writeLog: string };
type Step = (ctx: ScenarioContext) => void;
type ScenarioContext = { tui: TUI; term: VirtualTerminal; component: MutableLines };

const cases: CaseResult[] = [];
let previousFlag: string | undefined;
let previousTmux: string | undefined;
let previousSty: string | undefined;
let previousZellij: string | undefined;
let previousMetrics = false;
let monotonicNow = 0;

class MutableLines implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines.slice();
	}
	setLines(lines: string[]): void {
		this.#lines = lines.slice();
	}
	setLine(index: number, value: string): void {
		const next = this.#lines.slice();
		next[index] = value;
		this.#lines = next;
	}
	append(value: string): void {
		this.#lines = [...this.#lines, value];
	}
	clearTo(lines: string[]): void {
		this.#lines = lines.slice();
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.#lines;
	}
}

function makeRows(count: number, prefix = "line"): string[] {
	return Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(1);
	await term.flush();
}

function capture(term: VirtualTerminal): Capture {
	return {
		viewport: term.getViewport(),
		scrollback: term.getScrollBuffer(),
		writeLog: term.getWriteLog().join(""),
	};
}

function expectSameCapture(on: Capture[], off: Capture[]): void {
	expect(on.map(c => c.viewport)).toEqual(off.map(c => c.viewport));
	expect(on.map(c => c.scrollback)).toEqual(off.map(c => c.scrollback));
	expect(on.map(c => c.writeLog)).toEqual(off.map(c => c.writeLog));
}

async function runScenario(
	initialLines: string[],
	steps: Step[],
	flagOn: boolean,
	width = 40,
	height = ROWS,
): Promise<Capture[]> {
	Bun.env[FLAG] = flagOn ? "1" : "0";
	delete Bun.env.TMUX;
	delete Bun.env.STY;
	delete Bun.env.ZELLIJ;
	const term = new VirtualTerminal(width, height);
	const tui = new TUI(term);
	const component = new MutableLines(initialLines);
	const snapshots: Capture[] = [];
	tui.addChild(component);
	try {
		tui.start();
		await settle(term);
		snapshots.push(capture(term));
		for (const step of steps) {
			step({ tui, term, component });
			tui.requestRender();
			await settle(term);
			snapshots.push(capture(term));
		}
	} finally {
		tui.stop();
	}
	return snapshots;
}

async function parityCase(
	name: string,
	initialLines: string[],
	steps: Step[],
	width?: number,
	height?: number,
): Promise<void> {
	try {
		const off = await runScenario(initialLines, steps, false, width, height);
		const on = await runScenario(initialLines, steps, true, width, height);
		expectSameCapture(on, off);
		cases.push({
			name,
			status: "passed",
			checks: ["viewport byte-equal", "scrollback byte-equal", "write sequence byte-equal"],
		});
	} catch (error) {
		cases.push({
			name,
			status: "failed",
			checks: [],
			error: error instanceof Error ? (error.stack ?? error.message) : String(error),
		});
		throw error;
	}
}

describe("G003 virtual viewport adversarial parity QA", () => {
	beforeEach(() => {
		previousFlag = Bun.env[FLAG];
		previousTmux = Bun.env.TMUX;
		previousSty = Bun.env.STY;
		previousZellij = Bun.env.ZELLIJ;
		previousMetrics = renderMetrics.enabled;
		renderMetrics.reset();
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterAll(() => {
		vi.restoreAllMocks();
		if (previousFlag === undefined) delete Bun.env[FLAG];
		else Bun.env[FLAG] = previousFlag;
		if (previousTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = previousTmux;
		if (previousSty === undefined) delete Bun.env.STY;
		else Bun.env.STY = previousSty;
		if (previousZellij === undefined) delete Bun.env.ZELLIJ;
		else Bun.env.ZELLIJ = previousZellij;
		renderMetrics.reset();
		if (previousMetrics) renderMetrics.enable();
		else renderMetrics.disable();

		const passed = cases.filter(c => c.status === "passed").length;
		const failed = cases.filter(c => c.status === "failed").length;
		mkdirSync("artifacts", { recursive: true });
		writeFileSync(
			join("artifacts", "g003-qa-report.json"),
			`${JSON.stringify({ schemaVersion: 1, kind: "tui-parity-test-report", cases, summary: { total: cases.length, passed, failed } }, null, 2)}\n`,
		);
	});

	it("OFFSCREEN-MUTATION", async () => {
		await parityCase("OFFSCREEN-MUTATION", makeRows(80), [
			ctx => ctx.component.setLine(0, "line-0-mutated-above-window"),
			ctx => ctx.component.setLine(3, "line-3-mutated-above-window"),
		]);
	});

	it("PREFIX-COLLISION", async () => {
		const lines = [`prefix-wrap ${"abcdefghij ".repeat(8)}`, "prefix-tab\tcontent\tend", ...makeRows(70, "tail")];
		await parityCase(
			"PREFIX-COLLISION",
			lines,
			[
				ctx => ctx.term.resize(22, ROWS),
				ctx => ctx.term.resize(40, ROWS),
				ctx => ctx.component.setLine(0, `prefix-wrap ${"abcdefghij ".repeat(8)}`),
			],
			40,
		);
	});

	it("SCROLLBACK-INTEGRITY", async () => {
		await parityCase("SCROLLBACK-INTEGRITY", makeRows(140), [
			ctx => {
				for (let i = 0; i < 40; i++) ctx.component.append(`append-${i}`);
			},
			ctx => {
				expect(ctx.tui.scrollViewportPages(-1)).toBe(true);
			},
			ctx => {
				expect(ctx.tui.scrollViewportPages(-1)).toBe(true);
			},
			ctx => ctx.tui.scrollViewportPages(1),
		]);
	});

	it("RESIZE-STORM", async () => {
		await parityCase(
			"RESIZE-STORM",
			makeRows(60),
			Array.from({ length: 16 }, (_v, i) => ctx => {
				ctx.component.append(`storm-append-${i}-${"x".repeat(30)}`);
				ctx.term.resize(i % 2 === 0 ? 24 : 52, ROWS);
			}),
		);
	});

	it("OVERLAY", async () => {
		await parityCase("OVERLAY", makeRows(90), [
			ctx => ctx.tui.showOverlay(new MutableLines(["overlay-A", "overlay-B"]), { anchor: "center" }),
			ctx => ctx.component.setLine(2, "mutated-beneath-overlay-above-window"),
			ctx => ctx.tui.hideOverlay(),
		]);
	});

	it("SHRINK", async () => {
		await parityCase("SHRINK", makeRows(88), [
			ctx => ctx.component.clearTo(["after-clear-0", "after-clear-1"]),
			ctx => ctx.component.clearTo([]),
			ctx => ctx.component.append("after-empty"),
		]);
	});

	it("ALTERNATING on/off/on", async () => {
		const steps: Step[] = [
			ctx => ctx.component.append("alternate-append"),
			ctx => ctx.component.setLine(1, "alternate-offscreen-edit"),
			ctx => ctx.term.resize(34, ROWS),
		];
		try {
			const off = await runScenario(makeRows(70), steps, false);
			const onA = await runScenario(makeRows(70), steps, true);
			const onB = await runScenario(makeRows(70), steps, true);
			expectSameCapture(onA, off);
			expectSameCapture(onB, off);
			cases.push({
				name: "ALTERNATING on/off/on",
				status: "passed",
				checks: ["first on run byte-equal", "off run byte-equal", "second on run byte-equal"],
			});
		} catch (error) {
			cases.push({
				name: "ALTERNATING on/off/on",
				status: "failed",
				checks: [],
				error: error instanceof Error ? (error.stack ?? error.message) : String(error),
			});
			throw error;
		}
	});

	it("BOUNDED-WORK", async () => {
		try {
			Bun.env[FLAG] = "1";
			renderMetrics.reset();
			renderMetrics.enable();
			const term = new VirtualTerminal(40, ROWS);
			const tui = new TUI(term);
			const component = new MutableLines(makeRows(50_000, "huge"));
			tui.addChild(component);
			try {
				tui.start();
				await settle(term);
				component.append("huge-bottom-append");
				tui.requestRender();
				await settle(term);
				const lc = renderMetrics.snapshot().lineCounts;
				const limit = ROWS + OVERSCAN;
				expect(lc.normalized?.last ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(limit);
				expect(lc.diffed?.last ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(limit);
				cases.push({
					name: "BOUNDED-WORK",
					status: "passed",
					checks: [`normalized <= ${limit}`, `diffed <= ${limit}`],
					metrics: { normalized: lc.normalized, diffed: lc.diffed, offscreenScan: lc.offscreenScan },
				});
			} finally {
				tui.stop();
			}
		} catch (error) {
			cases.push({
				name: "BOUNDED-WORK",
				status: "failed",
				checks: [],
				error: error instanceof Error ? (error.stack ?? error.message) : String(error),
			});
			throw error;
		}
	});
});
