import * as os from "node:os";
import { $ } from "bun";
import { Loader } from "../src/components/loader";
import { renderMetrics } from "../src/metrics";
import { type Component, TUI } from "../src/tui";
import { VirtualTerminal } from "../test/virtual-terminal";

// Replay the same decorative updates in both revisions. The loader timer is
// stopped so scheduling jitter cannot change the number or contents of frames.
const LINE_COUNT = 10_000;
const WARMUP_FRAMES = 30;
const MEASURED_FRAMES = 240;
const FRAME_INTERVAL_MS = 16;
const COLUMNS = 120;
const ROWS = 40;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class Transcript implements Component {
	#lines = Array.from(
		{ length: LINE_COUNT },
		(_, i) => `\x1b[36m履歴 ${i}: 固定の長い会話 / stable transcript\x1b[0m`,
	);
	invalidate(): void {}
	render(): string[] {
		return this.#lines;
	}
}

const output = process.argv.find(arg => arg.startsWith("--output="))?.slice("--output=".length);
if (!output) throw new Error("Usage: bun packages/tui/bench/loader-reflow.ts --output=artifacts/loader-reflow.json");
const term = new VirtualTerminal(COLUMNS, ROWS);
const tui = new TUI(term, undefined, { widthSettleMs: 0 });
const transcript = new Transcript();
let frame = 0;
const loader = new Loader(
	tui,
	() => `\x1b[38;2;80;${100 + (frame % 100)};255m${SPINNER[Math.floor(frame / 5) % SPINNER.length]}\x1b[0m`,
	text => text,
	"Working",
	undefined,
	{ timeDependentColor: true, renderScope: "layout" },
);
loader.stop();
tui.addChild(transcript);
tui.addChild(loader);
tui.setBottomPinnedComponent(loader);

async function replayFrame(): Promise<void> {
	frame++;
	loader.setMessage("Working");
	await Bun.sleep(FRAME_INTERVAL_MS);
	await term.flush();
}

try {
	tui.start();
	await term.waitForRender();
	for (let i = 0; i < WARMUP_FRAMES; i++) await replayFrame();
	term.clearWriteLog();
	TUI.resetRenderCountersForTest();
	renderMetrics.reset();
	renderMetrics.enable();
	const cpuStart = process.cpuUsage();
	const started = performance.now();
	for (let i = 0; i < MEASURED_FRAMES; i++) await replayFrame();
	const elapsedMs = performance.now() - started;
	const cpu = process.cpuUsage(cpuStart);
	const metrics = renderMetrics.snapshot();
	if (metrics.renderCount !== MEASURED_FRAMES) {
		throw new Error(`Expected ${MEASURED_FRAMES} committed frames, got ${metrics.renderCount}`);
	}
	const result = {
		gitSha: (await $`git rev-parse HEAD`.quiet().text()).trim(),
		capturedAt: new Date().toISOString(),
		bunVersion: Bun.version,
		platform: process.platform,
		arch: process.arch,
		cpu: os.cpus()[0]?.model,
		fixture: {
			lines: LINE_COUNT,
			columns: COLUMNS,
			rows: ROWS,
			warmupFrames: WARMUP_FRAMES,
			measuredFrames: MEASURED_FRAMES,
			frameIntervalMs: FRAME_INTERVAL_MS,
		},
		elapsedMs,
		cpuMs: (cpu.user + cpu.system) / 1_000,
		renderDurations: metrics.renderDurations,
		reflowMeasurements: TUI.getRenderCountersForTest().widthReflowVisibleWidthCalls,
		terminal: {
			viewportAnsi: term.getViewportAnsi(),
			scrollBuffer: term.getScrollBuffer(),
			writes: term.getWriteLog(),
		},
	};
	await Bun.write(output, `${JSON.stringify(result, null, 2)}\n`);
	process.stdout.write(
		`${JSON.stringify({ output, cpuMs: result.cpuMs, renderDurations: result.renderDurations, reflowMeasurements: result.reflowMeasurements })}\n`,
	);
} finally {
	renderMetrics.disable();
	loader.stop();
	tui.stop();
}
