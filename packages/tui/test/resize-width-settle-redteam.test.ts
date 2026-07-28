import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Text } from "../src/components/text";
import { TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

// Adversarial companion to resize-width-settle.test.ts. The split is by evidence,
// not by topic: that file pins the redraw-count contract with the cheapest possible
// setup, while every case here asserts against real captured terminal output —
// escape sequences, viewport rows, and scroll buffers compared to an independently
// rendered clean target-width reference.
//
// Cases live here only when they need that captured-output evidence or a host this
// harness must fake (tmux/process-terminal). Anything a count assertion can pin
// belongs in the base file; a case duplicated across both files is dead weight, so
// stop/restart cancellation lives only there, where restarting before the deadline
// gives it a real failure mode.

const START_WIDTH = 44;
const SETTLED_WIDTH = 22;
const ROWS = 12;
const SETTLE_MS = 1000;
const FAKE_TMUX = "/tmp/fake-tmux,4242,0";

type Capture = {
	viewport: string[];
	scrollback: string[];
	writeLog: string;
};

let originalTmux: string | undefined;
let originalTmuxPane: string | undefined;
let originalSty: string | undefined;
let originalZellij: string | undefined;
let originalTmuxLaunched: string | undefined;
let originalVirtualViewport: string | undefined;
let originalLegacyMultiplexer: string | undefined;

function transcriptTexts(count = 32): string[] {
	return Array.from(
		{ length: count },
		(_value, index) => `R${index}-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-TAIL${index}`,
	);
}

function trimTerminalLines(lines: string[]): string[] {
	return lines.map(line => line.replace(/[ ]+$/u, ""));
}

function capture(term: VirtualTerminal): Capture {
	return {
		viewport: trimTerminalLines(term.getViewport()),
		scrollback: trimTerminalLines(term.getScrollBuffer()),
		writeLog: term.getWriteLog().join(""),
	};
}

function nonEmpty(lines: string[]): string[] {
	return lines.filter(line => line.length > 0);
}

function trimTrailingBlank(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1].length === 0) end--;
	return lines.slice(0, end);
}

function countSequence(haystack: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const index = haystack.indexOf(needle, offset);
		if (index < 0) return count;
		count += 1;
		offset = index + needle.length;
	}
}

function writeExcerpt(writeLog: string, maxLength = 5000): string {
	return writeLog.length <= maxLength ? writeLog : writeLog.slice(-maxLength);
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

async function addTranscript(tui: TUI, term: VirtualTerminal, texts = transcriptTexts()): Promise<void> {
	for (const text of texts) tui.addChild(new Text(text, 0, 0));
	tui.requestRender(false, "redteam.setup");
	await settle(term);
}

async function renderReference(
	width: number,
	rows: number,
	texts: string[],
	isProcessTerminal: boolean,
	underTmux: boolean,
): Promise<Capture> {
	if (underTmux) process.env.TMUX = FAKE_TMUX;
	else delete process.env.TMUX;
	const term = new VirtualTerminal(width, rows, { isProcessTerminal });
	const tui = new TUI(term);
	try {
		tui.start();
		await settle(term);
		for (const text of texts) tui.addChild(new Text(text, 0, 0));
		tui.requestRender(false, "redteam.reference");
		await settle(term);
		return capture(term);
	} finally {
		tui.stop();
	}
}

// Each case asserts a named set of checks. `expected` documents the contract the
// case pins; `evidence` is attached to the failure message so a red-team failure
// reports the captured terminal state instead of a bare boolean.
function finishCase(
	id: string,
	expected: string,
	checks: Record<string, boolean>,
	evidence: Record<string, unknown>,
): void {
	const failedChecks = Object.entries(checks)
		.filter(([, passed]) => !passed)
		.map(([name]) => name);
	const detail = `${id} failed [${failedChecks.join(", ")}]\nexpected: ${expected}\nevidence: ${JSON.stringify(evidence, null, 2)}`;
	expect(failedChecks, detail).toEqual([]);
}

class LegacyHeightResizeTUI extends TUI {
	override requestResizeRender(): void {
		this.requestRender(true, "resize");
	}
}

async function runHeightScenario(legacy: boolean): Promise<{
	immediate: Capture;
	delayedWriteLog: string;
	redrawsBefore: number;
	redrawsAfterImmediate: number;
	redrawsAfterDelay: number;
}> {
	delete process.env.TMUX;
	const term = new VirtualTerminal(START_WIDTH, ROWS, { isProcessTerminal: false });
	const tui = legacy ? new LegacyHeightResizeTUI(term) : new TUI(term);
	try {
		tui.start();
		await settle(term);
		await addTranscript(tui, term, transcriptTexts(18));
		term.clearWriteLog();
		const redrawsBefore = tui.fullRedraws;
		for (const height of [8, 10, 6, 9, 7]) {
			term.resize(START_WIDTH, height);
			await settle(term);
		}
		const immediate = capture(term);
		const redrawsAfterImmediate = tui.fullRedraws;
		term.clearWriteLog();
		await Bun.sleep(SETTLE_MS + 150);
		await term.flush();
		const delayedWriteLog = term.getWriteLog().join("");
		const redrawsAfterDelay = tui.fullRedraws;
		return { immediate, delayedWriteLog, redrawsBefore, redrawsAfterImmediate, redrawsAfterDelay };
	} finally {
		tui.stop();
	}
}

beforeEach(() => {
	originalTmux = process.env.TMUX;
	originalTmuxPane = process.env.TMUX_PANE;
	originalSty = process.env.STY;
	originalZellij = process.env.ZELLIJ;
	originalTmuxLaunched = process.env.GJC_TMUX_LAUNCHED;
	originalVirtualViewport = process.env.PI_TUI_VIRTUAL_VIEWPORT;
	originalLegacyMultiplexer = process.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	delete process.env.STY;
	delete process.env.ZELLIJ;
	delete process.env.GJC_TMUX_LAUNCHED;
	delete process.env.PI_TUI_VIRTUAL_VIEWPORT;
	delete process.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER;
});

afterEach(() => {
	const restore = (name: string, value: string | undefined): void => {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};
	restore("TMUX", originalTmux);
	restore("TMUX_PANE", originalTmuxPane);
	restore("STY", originalSty);
	restore("ZELLIJ", originalZellij);
	restore("GJC_TMUX_LAUNCHED", originalTmuxLaunched);
	restore("PI_TUI_VIRTUAL_VIEWPORT", originalVirtualViewport);
	restore("PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER", originalLegacyMultiplexer);
});

async function runWidthRepair(underTmux: boolean): Promise<{
	before: Capture;
	interim: Capture;
	post: Capture;
	reference: Capture;
	redrawsBeforeSettle: number;
	redrawsAfterSettle: number;
	texts: string[];
}> {
	if (underTmux) process.env.TMUX = FAKE_TMUX;
	else delete process.env.TMUX;
	const texts = transcriptTexts();
	const term = new VirtualTerminal(START_WIDTH, ROWS, { isProcessTerminal: underTmux });
	const tui = new TUI(term);
	try {
		tui.start();
		await settle(term);
		await addTranscript(tui, term, texts);
		term.clearWriteLog();
		const before = capture(term);
		term.resize(SETTLED_WIDTH, ROWS);
		await settle(term);
		const interim = capture(term);
		const redrawsBeforeSettle = tui.fullRedraws;
		await Bun.sleep(SETTLE_MS + 150);
		await term.flush();
		const post = capture(term);
		const redrawsAfterSettle = tui.fullRedraws;
		const reference = await renderReference(SETTLED_WIDTH, ROWS, texts, underTmux, underTmux);
		return { before, interim, post, reference, redrawsBeforeSettle, redrawsAfterSettle, texts };
	} finally {
		tui.stop();
	}
}

describe("width-settle debounce red-team", () => {
	it("DEFAULT-HOST-STALE-BAND repairs wrapped transcript after settling", async () => {
		const result = await runWidthRepair(false);
		const postRows = nonEmpty(result.post.scrollback);
		const referenceRows = nonEmpty(result.reference.scrollback);
		finishCase(
			"DEFAULT-HOST-STALE-BAND",
			"After a shrink from 44 to 22 columns, the settled terminal state matches a clean 22-column render and the settled write is a real full redraw.",
			{
				postStateMatchesFreshTarget: postRows.join("\n") === referenceRows.join("\n"),
				settledRedrawExactlyOne: result.redrawsAfterSettle - result.redrawsBeforeSettle === 1,
				settledWriteClearsAndReplays: result.post.writeLog.includes("\x1b[2J\x1b[H\x1b[3J"),
				widthChangedContentVisible: result.post.viewport.some(line => line.startsWith("R31-")),
			},
			{
				startingWidth: START_WIDTH,
				settledWidth: SETTLED_WIDTH,
				beforeViewport: result.before.viewport,
				interimViewport: result.interim.viewport,
				postViewport: result.post.viewport,
				postScrollbackRows: postRows.length,
				referenceScrollbackRows: referenceRows.length,
				interimWriteLength: result.interim.writeLog.length,
				settledWriteLength: result.post.writeLog.length,
				settledFullRedrawDelta: result.redrawsAfterSettle - result.redrawsBeforeSettle,
			},
		);
	});

	it("TMUX-STALE-BAND settled repair replays the full transcript so scrollback is repaired too", async () => {
		const result = await runWidthRepair(true);
		// The reference buffer carries construction-time interior blank rows (it is
		// rendered incrementally), so content is compared via nonEmpty. Stale blank
		// bands in the POST buffer are still caught: after a real clear+replay the
		// post buffer must have no interior blank rows, asserted separately below.
		const postTrimmed = trimTrailingBlank(result.post.scrollback);
		const postRows = nonEmpty(result.post.scrollback);
		const referenceRows = nonEmpty(result.reference.scrollback);
		finishCase(
			"TMUX-STALE-BAND",
			"With TMUX set, interim frames stay viewport-only, but the ONE debounced settled repair is a full clear+replay: post-settle scrollback must match a clean 22-column render row-for-row. The replay storm is avoided by running once per settled sequence, not once per SIGWINCH.",
			{
				postStateMatchesFreshTarget: postRows.join("\n") === referenceRows.join("\n"),
				postHasNoInteriorBlankRows: postTrimmed.every(line => line.length > 0),
				postViewportMatchesFreshTarget: result.post.viewport.join("\n") === result.reference.viewport.join("\n"),
				settledRedrawExactlyOne: result.redrawsAfterSettle - result.redrawsBeforeSettle === 1,
				// The settled repair forces the scrollback clear even where per-event
				// full clears keep 3J suppressed (forceScrollbackClear): replaying
				// WITHOUT erasing history would stack the new transcript on top of
				// the stale-width copy.
				settledWriteClearsAndReplays: result.post.writeLog.includes("\x1b[2J\x1b[H\x1b[3J"),
				widthChangedContentVisible: result.post.viewport.some(line => line.startsWith("R31-")),
			},
			{
				host: "TMUX",
				startingWidth: START_WIDTH,
				settledWidth: SETTLED_WIDTH,
				postViewport: result.post.viewport,
				postScrollbackRows: postRows.length,
				referenceScrollbackRows: referenceRows.length,
				missingOrStaleRows: referenceRows.filter((line, index) => postRows[index] !== line).slice(0, 8),
				interimWriteLength: result.interim.writeLog.length,
				settledWriteLength: result.post.writeLog.length,
				settledFullRedrawDelta: result.redrawsAfterSettle - result.redrawsBeforeSettle,
			},
		);
	});

	it("UNRELATED-FORCE keeps the settle timer sane after a forced render", async () => {
		delete process.env.TMUX;
		const texts = transcriptTexts();
		const term = new VirtualTerminal(START_WIDTH, ROWS, { isProcessTerminal: false });
		const tui = new TUI(term);
		try {
			tui.start();
			await settle(term);
			await addTranscript(tui, term, texts);
			term.clearWriteLog();
			term.resize(SETTLED_WIDTH, ROWS);
			await settle(term);
			const redrawsAfterResize = tui.fullRedraws;
			await Bun.sleep(400);
			term.clearWriteLog();
			const redrawsBeforeUnrelated = tui.fullRedraws;
			tui.requestRender(true, "test.unrelated");
			await settle(term);
			const unrelatedWriteLog = term.getWriteLog().join("");
			const redrawsAfterUnrelated = tui.fullRedraws;
			term.clearWriteLog();
			await Bun.sleep(SETTLE_MS - 400 + 150);
			await term.flush();
			const settleWriteLog = term.getWriteLog().join("");
			const redrawsAfterSettle = tui.fullRedraws;
			const reference = await renderReference(SETTLED_WIDTH, ROWS, texts, false, false);
			const post = capture(term);
			finishCase(
				"UNRELATED-FORCE",
				"An unrelated forced render may commit first, but the armed width timer must still produce at most one trailing settle frame and leave the target-width transcript correct.",
				{
					unrelatedForcedOneFrame: redrawsAfterUnrelated - redrawsBeforeUnrelated === 1,
					settleAddsExactlyOneFrame: redrawsAfterSettle - redrawsAfterUnrelated === 1,
					settleWriteIsFullRepair: settleWriteLog.includes("\x1b[2J\x1b[H\x1b[3J"),
					finalStateMatchesFreshTarget:
						nonEmpty(post.scrollback).join("\n") === nonEmpty(reference.scrollback).join("\n"),
					noExtraSettleFrames: countSequence(settleWriteLog, "\x1b[2J\x1b[H\x1b[3J") === 1,
				},
				{
					redrawsAfterResize,
					redrawsBeforeUnrelated,
					redrawsAfterUnrelated,
					redrawsAfterSettle,
					unrelatedWriteLength: unrelatedWriteLog.length,
					settleWriteLength: settleWriteLog.length,
					settleWriteExcerpt: writeExcerpt(settleWriteLog, 2400),
				},
			);
		} finally {
			tui.stop();
		}
	});

	async function runOscillation(widths: number[]): Promise<{
		beforeSettle: number;
		afterSettle: number;
		post: Capture;
		reference: Capture;
		interimWriteLength: number;
	}> {
		delete process.env.TMUX;
		const texts = transcriptTexts();
		const term = new VirtualTerminal(START_WIDTH, ROWS, { isProcessTerminal: false });
		const tui = new TUI(term);
		try {
			tui.start();
			await settle(term);
			await addTranscript(tui, term, texts);
			term.clearWriteLog();
			for (const width of widths) {
				term.resize(width, ROWS);
				await settle(term);
			}
			const interimWriteLength = term.getWriteLog().join("").length;
			const beforeSettle = tui.fullRedraws;
			await Bun.sleep(SETTLE_MS + 150);
			await term.flush();
			const post = capture(term);
			const afterSettle = tui.fullRedraws;
			const finalWidth = widths.at(-1) ?? START_WIDTH;
			const reference = await renderReference(finalWidth, ROWS, texts, false, false);
			return { beforeSettle, afterSettle, post, reference, interimWriteLength };
		} finally {
			tui.stop();
		}
	}

	it("RAPID-OSCILLATION emits one settle repair when the final width differs", async () => {
		const widths = [36, 28, 36, 28, 36, 30, 34, 30];
		const result = await runOscillation(widths);
		finishCase(
			"RAPID-OSCILLATION-ENDS-DIFFERENT",
			"Many width changes inside one debounce window produce exactly one settled redraw, and the final target-width frame is correct.",
			{
				exactlyOneSettledRedraw: result.afterSettle - result.beforeSettle === 1,
				finalStateMatchesFreshTarget:
					nonEmpty(result.post.scrollback).join("\n") === nonEmpty(result.reference.scrollback).join("\n"),
				interimFramesWereWritten: result.interimWriteLength > 0,
			},
			{
				widths,
				finalWidth: widths.at(-1),
				interimWriteLength: result.interimWriteLength,
				settledRedrawDelta: result.afterSettle - result.beforeSettle,
				postViewport: result.post.viewport,
			},
		);
	});

	it("RAPID-OSCILLATION still emits one settle repair when the drag returns to its starting width", async () => {
		const widths = [36, 28, 36, 28, 36, 30, 34, START_WIDTH];
		const result = await runOscillation(widths);
		finishCase(
			"RAPID-OSCILLATION-ENDS-SAME",
			"A drag that ends back at its starting width still gets exactly one repair: the render pipeline does not guarantee a frame committed at the final geometry after the final resize event, so skipping could drop the only repair.",
			{
				exactlyOneSettledRedraw: result.afterSettle - result.beforeSettle === 1,
				finalStateMatchesFreshTarget:
					nonEmpty(result.post.scrollback).join("\n") === nonEmpty(result.reference.scrollback).join("\n"),
				interimFramesWereWritten: result.interimWriteLength > 0,
			},
			{
				widths,
				baselineWidth: START_WIDTH,
				finalWidth: widths.at(-1),
				interimWriteLength: result.interimWriteLength,
				settledRedrawDelta: result.afterSettle - result.beforeSettle,
				postViewport: result.post.viewport,
			},
		);
	});

	it("HEIGHT-ONLY-REGRESSION remains byte-identical and never arms a settle timer", async () => {
		const legacy = await runHeightScenario(true);
		const current = await runHeightScenario(false);
		finishCase(
			"HEIGHT-ONLY-REGRESSION",
			"A height-only resize storm follows the pre-change forced height path byte-for-byte and emits no later width-settle write.",
			{
				viewportByteIdentical: current.immediate.viewport.join("\n") === legacy.immediate.viewport.join("\n"),
				scrollbackByteIdentical: current.immediate.scrollback.join("\n") === legacy.immediate.scrollback.join("\n"),
				writeLogByteIdentical: current.immediate.writeLog === legacy.immediate.writeLog,
				redrawCountByteIdentical:
					current.redrawsAfterImmediate - current.redrawsBefore ===
					legacy.redrawsAfterImmediate - legacy.redrawsBefore,
				noDelayedCurrentWrite: current.delayedWriteLog === "",
				noDelayedLegacyWrite: legacy.delayedWriteLog === "",
			},
			{
				heights: [8, 10, 6, 9, 7],
				currentImmediateWriteLength: current.immediate.writeLog.length,
				legacyImmediateWriteLength: legacy.immediate.writeLog.length,
				currentImmediateRedrawDelta: current.redrawsAfterImmediate - current.redrawsBefore,
				legacyImmediateRedrawDelta: legacy.redrawsAfterImmediate - legacy.redrawsBefore,
				currentDelayedWriteLength: current.delayedWriteLog.length,
				legacyDelayedWriteLength: legacy.delayedWriteLog.length,
			},
		);
	});

	it("TIMING-BOUNDARY waits for 1000ms and extends the window at t=900ms", async () => {
		delete process.env.TMUX;
		const term = new VirtualTerminal(START_WIDTH, ROWS, { isProcessTerminal: false });
		const tui = new TUI(term);
		try {
			tui.start();
			await settle(term);
			await addTranscript(tui, term);
			term.clearWriteLog();
			term.resize(36, ROWS);
			await settle(term);
			const firstResizeAt = performance.now();
			const redrawsAfterFirstResize = tui.fullRedraws;
			await Bun.sleep(850);
			term.resize(28, ROWS);
			await settle(term);
			const secondResizeAt = performance.now();
			const redrawsAfterSecondResize = tui.fullRedraws;
			term.clearWriteLog();

			// The first deadline is now past, but the t=850-900ms change must have
			// re-armed the timer. No settle write may occur at the first deadline.
			const firstDeadlineProbeDelay = Math.max(0, SETTLE_MS - (performance.now() - firstResizeAt) + 150);
			await Bun.sleep(firstDeadlineProbeDelay);
			await term.flush();
			const beforeExtendedDeadlineWrite = term.getWriteLog().join("");
			const redrawsBeforeExtendedDeadline = tui.fullRedraws;
			const elapsedFromFirstResize = performance.now() - firstResizeAt;
			const elapsedBetweenResizes = secondResizeAt - firstResizeAt;

			const secondDeadlineWait = Math.max(0, SETTLE_MS - (performance.now() - secondResizeAt) + 150);
			await Bun.sleep(secondDeadlineWait);
			await term.flush();
			const afterExtendedDeadlineWrite = term.getWriteLog().join("");
			const redrawsAfterExtendedDeadline = tui.fullRedraws;
			finishCase(
				"TIMING-BOUNDARY",
				"No settled redraw occurs before about 1000ms, and a width change near t=900ms pushes the single settle deadline out by another 1000ms.",
				{
					noEarlySettleAtFirstDeadline: beforeExtendedDeadlineWrite === "",
					noEarlyRedrawAtFirstDeadline: redrawsBeforeExtendedDeadline === redrawsAfterSecondResize,
					// The only real precondition: the second change landed inside the
					// first window. Asserting a tight upper bound here would fail correct
					// code whenever the CI scheduler pauses between the two resizes.
					secondChangeInsideFirstWindow: elapsedBetweenResizes < SETTLE_MS,
					exactlyOneExtendedSettle: redrawsAfterExtendedDeadline - redrawsAfterSecondResize === 1,
					extendedSettleWritesRepair: afterExtendedDeadlineWrite.includes("\x1b[2J\x1b[H\x1b[3J"),
				},
				{
					firstResizeAt: firstResizeAt.toFixed(1),
					secondResizeAt: secondResizeAt.toFixed(1),
					elapsedBetweenResizes: elapsedBetweenResizes.toFixed(1),
					elapsedFromFirstResizeAtProbe: elapsedFromFirstResize.toFixed(1),
					redrawsAfterFirstResize,
					redrawsAfterSecondResize,
					redrawsBeforeExtendedDeadline,
					redrawsAfterExtendedDeadline,
					beforeExtendedDeadlineWriteLength: beforeExtendedDeadlineWrite.length,
					afterExtendedDeadlineWriteLength: afterExtendedDeadlineWrite.length,
					beforeExtendedDeadlineWriteExcerpt: writeExcerpt(beforeExtendedDeadlineWrite, 1400),
					afterExtendedDeadlineWriteExcerpt: writeExcerpt(afterExtendedDeadlineWrite, 1400),
				},
			);
		} finally {
			tui.stop();
		}
	});
});
