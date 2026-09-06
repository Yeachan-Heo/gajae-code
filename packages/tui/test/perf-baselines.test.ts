// Advisory perf baselines: recording only; hard gating deferred to perf-gates.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __animationSchedulerTestHooks, type Component, CURSOR_MARKER, TUI } from "@gajae-code/tui";
import { __editorPerfCounters, Editor } from "@gajae-code/tui/components/editor";
import { __loaderPerfCounters, Loader } from "@gajae-code/tui/components/loader";
import * as markdownCache from "@gajae-code/tui/components/markdown";
import { __markdownPerfCounters, clearRenderCache, Markdown } from "@gajae-code/tui/components/markdown";
import { type RenderMetricsSnapshot, renderMetrics } from "@gajae-code/tui/metrics";
import { __textHelperPerfCounters, visibleWidth } from "@gajae-code/tui/utils";
import { $flag } from "@gajae-code/utils";
import { makeRecordedSession, type ReplayFixture, runReplay } from "./replay-harness";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

function expectFiniteNonNegative(value: number): void {
	expect(Number.isFinite(value)).toBe(true);
	expect(value).toBeGreaterThanOrEqual(0);
}

describe("advisory performance baselines", () => {
	beforeEach(() => {
		clearRenderCache();
		__markdownPerfCounters.reset();
		__editorPerfCounters.reset();
		__loaderPerfCounters.reset();
		__animationSchedulerTestHooks.reset();
		__textHelperPerfCounters.reset();
		renderMetrics.disable();
		renderMetrics.reset();
	});
	afterEach(() => {
		clearRenderCache();
		__markdownPerfCounters.reset();
		__editorPerfCounters.reset();
		__loaderPerfCounters.reset();
		__animationSchedulerTestHooks.reset();
		__textHelperPerfCounters.reset();
		renderMetrics.disable();
		renderMetrics.reset();
	});

	it("records markdown actual-streaming retention and completed-revisit tradeoffs", async () => {
		const reports = [];
		const theme = {
			...defaultMarkdownTheme,
			highlightCode: (code: string) => code.split("\n").map(line => `\x1b[36m${line}\x1b[0m`),
		};
		const stats = markdownCache.getMarkdownCacheStats;
		try {
			for (const fixture of ["ascii", "growing-fence", "completed-revisit"]) {
				for (const cadence of [16, 64]) {
					for (let repetition = -1; repetition < 2; repetition++) {
						clearRenderCache();
						__markdownPerfCounters.reset();
						let now = 1_000_000;
						markdownCache.__setMarkdownNowForTest(() => now);
						Bun.gc(true);
						const before = process.memoryUsage();
						let md: Markdown | undefined = new Markdown("", 0, 0, theme);
						md.setStreaming(true);
						let content = fixture === "growing-fence" ? "```ts\n" : "";
						const peaks = stats();
						const sample = () => {
							const snapshot = stats();
							for (const name of ["render", "parse", "highlight"] as const) {
								peaks[name].count = Math.max(peaks[name].count, snapshot[name].count);
								peaks[name].accountedSize = Math.max(peaks[name].accountedSize, snapshot[name].accountedSize);
							}
							return snapshot;
						};
						const start = performance.now();
						for (let i = 0; i < 64; i++) {
							now += cadence;
							content +=
								fixture === "growing-fence"
									? `const value${i} = "${"x".repeat(500)}";\n`
									: `${i}: ${"word ".repeat(108)}\n`;
							md.setText(content);
							md.render(96);
							const snapshot = sample();
							expect(snapshot.render.count).toBe(0);
							expect(snapshot.parse.count).toBe(0);
						}
						const preFinal = sample();
						if (fixture === "growing-fence") content += "```\n";
						md.setText(content, { streaming: false });
						const final = md.renderWithViewportAnchorSource(96, { id: "message" });
						const postFinal = sample();
						const workloadCalls = __markdownPerfCounters.lexerInvocations;
						const normalizedCodeUnits = __markdownPerfCounters.lexedBytes;
						if (fixture === "completed-revisit") {
							for (let i = 0; i < 24; i++) {
								new Markdown(`revisit ${i}\n${content}`, 0, 0, theme).render(96);
								sample();
							}
						}
						const afterPressure = sample();
						const beforeWarm = __markdownPerfCounters.lexerInvocations;
						const unitsBeforeWarm = __markdownPerfCounters.lexedBytes;
						let warm: Markdown | undefined = new Markdown(content, 0, 0, theme);
						const revisited = warm.renderWithViewportAnchorSource(96, { id: "message" });
						const sameWidthLexers = __markdownPerfCounters.lexerInvocations - beforeWarm;
						const sameWidthUnits = __markdownPerfCounters.lexedBytes - unitsBeforeWarm;
						expect(revisited.lines).toBe(final.lines); // Original render survived pressure.
						expect(sameWidthLexers).toBe(0);
						expect(sameWidthUnits).toBe(0);
						sample();
						warm.render(95);
						const warmLexers = __markdownPerfCounters.lexerInvocations - beforeWarm;
						const reflowLexers = warmLexers - sameWidthLexers;
						const reflowUnits = __markdownPerfCounters.lexedBytes - unitsBeforeWarm - sameWidthUnits;
						const expectedReflowLexers = fixture === "completed-revisit" ? 1 : 0;
						expect(reflowLexers).toBe(expectedReflowLexers);
						expect(reflowUnits).toBe(expectedReflowLexers * content.length);
						expect(revisited).toEqual(final);
						const elapsedMs = performance.now() - start;
						Bun.gc(true);
						const live = process.memoryUsage();
						const retained = sample();
						md.dispose();
						md = undefined;
						warm.dispose();
						warm = undefined;
						Bun.gc(true);
						const released = process.memoryUsage();
						const report = {
							fixture,
							context: {
								bun: Bun.version,
								platform: process.platform,
								arch: process.arch,
								theme: "defaultMarkdownTheme + deterministic cyan line highlighter",
								width: 96,
								reflowWidth: 95,
								updates: 64,
								fixtureIdentity: "new deterministic fixture; non-identical to prior 70034-unit research",
								accounting: "UTF16 retained payload; not heap/RSS",
								peakScope: "streaming + completion + pressure + warm reflow; excludes oracle",
							},
							cadence,
							repetition,
							finalHash: Bun.hash(JSON.stringify(final)).toString(16),
							fixtureUtf8Bytes: Buffer.byteLength(content),
							workloadCalls,
							normalizedCodeUnits,
							warmLexers,
							sameWidthLexers,
							sameWidthUnits,
							reflowLexers,
							reflowUnits,
							pressureClassification:
								fixture === "completed-revisit"
									? "render survived; parse evicted by size, one reflow miss"
									: "fit-budget completed reuse",
							peaks,
							preFinal,
							postFinal,
							afterPressure,
							retained,
							elapsedMs,
							heapLiveDelta: live.heapUsed - before.heapUsed,
							rssLiveDelta: live.rss - before.rss,
							heapAfterDisposeDelta: released.heapUsed - before.heapUsed,
							rssAfterDisposeDelta: released.rss - before.rss,
						};
						// A fresh component alone is not a cold oracle. Exclude oracle work
						// from the workload and warm counters above.
						clearRenderCache();
						const beforeOracle = __markdownPerfCounters.lexerInvocations;
						const oracle = new Markdown(content, 0, 0, theme).renderWithViewportAnchorSource(96, {
							id: "message",
						});
						expect(__markdownPerfCounters.lexerInvocations).toBe(beforeOracle + 1);
						expect(final).toEqual(oracle);
						if (repetition >= 0) reports.push(report);
					}
				}
			}
		} finally {
			markdownCache.__setMarkdownNowForTest(undefined);
		}
		if (process.env.GJC_MARKDOWN_REPORT)
			await Bun.write(process.env.GJC_MARKDOWN_REPORT, JSON.stringify(reports, null, 2));
		console.log(
			`[perf-baseline] markdown ${reports.length} repetitions; normalizedCodeUnits are UTF-16 units, accounted bytes are not heap/RSS; baseline selected UTF8 payload is incomparable`,
		);
	}, 120_000);

	it("records editor relayouts and visibleWidth measurements for a large paste plus cursor-only movement", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.focused = true;
		editor.setBorderVisible(false);
		editor.setText(
			Array.from(
				{ length: 1_200 },
				(_, i) => `line-${i.toString().padStart(4, "0")} ascii words plus wide 한글 token ${i % 17}`,
			).join("\n"),
		);

		renderMetrics.reset();
		renderMetrics.enable();
		for (let i = 0; i < 80; i++) {
			editor.handleInput(i % 2 === 0 ? "\x1b[D" : "\x1b[C");
			const lines = editor.render(100);
			expect(lines.length).toBeGreaterThan(0);
		}
		const visibleWidthMeasurements = renderMetrics.snapshot().helperStats["text.visibleWidth"]?.count ?? 0;

		console.log(
			`[perf-baseline] editor cursor movement layoutTextInvocations=${__editorPerfCounters.layoutTextInvocations} visibleWidthMeasurements=${visibleWidthMeasurements}`,
		);
		expectFiniteNonNegative(__editorPerfCounters.layoutTextInvocations);
		expectFiniteNonNegative(visibleWidthMeasurements);
	});

	// This baselines shared scheduler registrants and timer creation for concurrent loaders.
	it("records shared scheduler state with concurrent loaders", () => {
		const renderRequests: string[] = [];
		const ui = { requestRender: (_force?: boolean, source?: string) => renderRequests.push(source ?? "") };
		const loaders = Array.from(
			{ length: 12 },
			(_, i) =>
				new Loader(
					ui as never,
					text => text,
					text => text,
					`loading-${i}`,
					["-", "+"],
				),
		);
		try {
			console.log(
				`[perf-baseline] loader concurrent=${loaders.length} liveIntervals=${__loaderPerfCounters.liveIntervals} activeTimers=${__animationSchedulerTestHooks.getActiveTimerCount(80)} startedTimers=${__animationSchedulerTestHooks.getStartedTimerCount(80)}`,
			);
			expect(__loaderPerfCounters.liveIntervals).toBe(loaders.length);
			expect(__animationSchedulerTestHooks.getActiveTimerCount(80)).toBe(1);
			expect(__animationSchedulerTestHooks.getStartedTimerCount(80)).toBe(1);
			expect(renderRequests.length).toBeGreaterThanOrEqual(loaders.length);
		} finally {
			for (const loader of loaders) loader.stop();
		}
		expect(__loaderPerfCounters.liveIntervals).toBe(0);
	});

	it("records native text-helper call counts per frame over a replay", async () => {
		const replay = await runReplay(makeRecordedSession(30, 0x51a7));
		const frames = replay.metrics.renderCount;
		const truncateCalls = __textHelperPerfCounters.truncateToWidthCalls;
		const wrapCalls = __textHelperPerfCounters.wrapTextWithAnsiCalls;
		console.log(
			`[perf-baseline] replay text helpers frames=${frames} truncateToWidthCalls=${truncateCalls} wrapTextWithAnsiCalls=${wrapCalls} truncatePerFrame=${(truncateCalls / frames).toFixed(2)} wrapPerFrame=${(wrapCalls / frames).toFixed(2)}`,
		);
		expectFiniteNonNegative(frames);
		expect(Number.isFinite(truncateCalls)).toBe(true);
		expectFiniteNonNegative(wrapCalls);
	});

	it("records line normalization/diff baselines for a 10k-line transcript append", async () => {
		await runTranscriptAppendBaseline(10_000, "10k");
	}, 60000);

	if ($flag("PI_TUI_PERF_GATES")) {
		it("records line normalization/diff baselines for a 100k-line transcript append", async () => {
			await runTranscriptAppendBaseline(100_000, "100k");
		}, 120000);

		it("records width-scan CPU, fresh input, and actual-resize evidence", async () => {
			// A comparison checkout must not accidentally import the candidate through workspace links.
			expect(import.meta.resolve("@gajae-code/tui")).toBe(new URL("../src/index.ts", import.meta.url).href);
			const reports = [];
			for (const metrics of [false, true]) {
				for (const count of [64, 8_000, 40_000]) {
					for (const phase of ["normal", "input"] as const)
						reports.push(await runWidthScanWorkload(count, phase, metrics));
				}
				reports.push(await runWidthScanWorkload(40_000, "resize", metrics));
			}
			const report = {
				schemaVersion: 1,
				bun: Bun.version,
				platform: process.platform,
				arch: process.arch,
				runtime: process.execPath,
				tuiEntry: import.meta.resolve("@gajae-code/tui"),
				sourceSha256: sha256(await Bun.file(new URL("../src/tui.ts", import.meta.url)).arrayBuffer()),
				fixtureSourceSha256: sha256(await Bun.file(new URL(import.meta.url)).arrayBuffer()),
				nativeSha256: process.env.GJC_WIDTH_SCAN_NATIVE_SHA ?? null,
				flags: {
					virtualViewport: process.env.PI_TUI_VIRTUAL_VIEWPORT ?? null,
					tmux: process.env.TMUX ?? null,
					screen: process.env.STY ?? null,
				},
				reports,
			};
			if (process.env.GJC_WIDTH_SCAN_REPORT)
				await Bun.write(process.env.GJC_WIDTH_SCAN_REPORT, JSON.stringify(report, null, 2));
			console.log(
				`[width-scan] ${reports.length} workloads; 5 warmups + 20 samples; CPU/frame/input scopes separate`,
			);
		}, 120000);
	}
});

type WidthScanPhase = "normal" | "input" | "resize";

class WidthScanTranscript implements Component {
	tail = "tail-setup";

	constructor(readonly lines: string[]) {}

	invalidate(): void {}

	render(): string[] {
		return [...this.lines, this.tail];
	}
}

function sha256(value: string | ArrayBuffer): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function widthScanDigest(value: unknown): string {
	return sha256(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)));
}

async function runWidthScanWorkload(count: number, phase: WidthScanPhase, metrics: boolean) {
	const lines = Array.from({ length: count }, (_value, index) => {
		const text = `${index.toString().padStart(6, "0")} :: stable transcript 한글 wide 界 payload`;
		return index % 3 === 0 ? `\x1b[36m${text}\x1b[0m` : text;
	});
	const fixtureHash = widthScanDigest(lines);
	const terminal = new VirtualTerminal(100, 30, { isProcessTerminal: true });
	const tui = new TUI(terminal, false, { widthSettleMs: 0 });
	const transcript = new WidthScanTranscript(lines);
	let editor: Editor | undefined;
	let initialRawRows: string[];
	const samples: Array<{
		observedMs: number;
		cpuUserMicros: number;
		cpuSystemMicros: number;
		bytes: number;
		writes: number;
		stateHash: string;
	}> = [];
	let warmMemory: NodeJS.MemoryUsage | undefined;
	let liveMemory: NodeJS.MemoryUsage | undefined;
	let frameMetrics: RenderMetricsSnapshot;
	let measuredFrames = 0;
	let startupBytes = 0;
	let teardownBytes = 0;
	try {
		tui.addChild(transcript);
		// The resize control has no width-padded editor/suffix: every raw row fits
		// both 99 and 100 columns, so it must visit the full history.
		if (phase !== "resize") {
			editor = new Editor(defaultEditorTheme);
			tui.addChild(editor);
			editor.setBorderVisible(false);
			editor.setText("input");
			tui.setBottomPinnedComponent(editor);
			tui.setFocus(editor);
		}
		initialRawRows = tui.render(100);
		// TUI extracts this marker before forming the rows scanned for reflow.
		expect(
			initialRawRows.every(line => visibleWidth(line.replace(CURSOR_MARKER, "")) <= (phase === "resize" ? 99 : 100)),
		).toBe(true);
		tui.start();
		const setup = tui.requestRenderWithGeneration(false, "width-scan.setup");
		expect(await tui.waitForRenderCommit(setup, 5_000)).toBe(true);
		await terminal.flush();
		startupBytes = terminal.getWriteLog().reduce((sum, text) => sum + Buffer.byteLength(text), 0);
		if (metrics) renderMetrics.enable();
		else renderMetrics.disable();
		for (let sample = 0; sample < 25; sample++) {
			terminal.clearWriteLog();
			if (sample === 5) {
				Bun.gc(true);
				warmMemory = process.memoryUsage();
				renderMetrics.reset();
			}
			const cpuStart = process.cpuUsage();
			let started = performance.now();
			let generation: number;
			if (phase === "resize") {
				terminal.resize(terminal.columns === 100 ? 99 : 100, 30);
				// Obtain a waiter without turning this real resize into a semantic mutation.
				generation = tui.requestRenderWithGeneration(false, "resize");
			} else {
				transcript.tail = `tail-${sample.toString().padStart(2, "0")}`;
				generation = tui.requestRenderWithGeneration(false, "width-scan.normal");
				if (phase === "input") {
					started = performance.now();
					terminal.sendInput(String.fromCharCode(65 + sample));
				}
			}
			expect(await tui.waitForRenderCommit(generation, 5_000)).toBe(true);
			await terminal.flush();
			const viewport = terminal.getViewport();
			expect(viewport.some(line => line.trim() === transcript.tail)).toBe(true);
			if (editor) {
				const expected = phase === "input" ? `input${"ABCDEFGHIJKLMNOPQRSTUVWXY".slice(0, sample + 1)}` : "input";
				expect(editor.getText()).toBe(expected);
				expect(viewport.map(line => line.trim())).toContain(`${expected}${defaultEditorTheme.symbols.inputCursor}`);
			}
			const observedMs = performance.now() - started;
			const cpu = process.cpuUsage(cpuStart);
			if (sample >= 5) {
				measuredFrames++;
				const writes = terminal.getWriteLog();
				samples.push({
					observedMs,
					cpuUserMicros: cpu.user,
					cpuSystemMicros: cpu.system,
					bytes: writes.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
					writes: writes.length,
					stateHash: widthScanDigest({
						writes,
						viewport,
						scrollback: terminal.getScrollBuffer(),
						observation: tui.getViewportObservation(),
						anchors: tui.getViewportAnchorSnapshot(),
					}),
				});
			}
		}
		frameMetrics = renderMetrics.snapshot();
		expect(measuredFrames).toBe(20);
		if (metrics) expect(frameMetrics.renderCount).toBe(20);
		Bun.gc(true);
		liveMemory = process.memoryUsage();
	} finally {
		terminal.clearWriteLog();
		tui.stop();
		tui.dispose();
		await terminal.flush();
		teardownBytes = terminal.getWriteLog().reduce((sum, text) => sum + Buffer.byteLength(text), 0);
		terminal.reset();
		terminal.clearWriteLog();
		renderMetrics.disable();
		renderMetrics.reset();
	}
	Bun.gc(true);
	return {
		count,
		phase,
		metrics,
		fixtureHash,
		actualRawRows: initialRawRows.length,
		fixtureUtf8Bytes: lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0),
		widths: phase === "resize" ? [100, 99] : [100],
		rows: 30,
		warmups: 5,
		measuredFrames,
		startupBytes,
		teardownBytes,
		frame: metrics ? frameMetrics.renderDurations : null,
		lineCounts: metrics ? frameMetrics.lineCounts : null,
		memory: { warm: warmMemory, live: liveMemory, afterDispose: process.memoryUsage() },
		memoryScope: "Forced-GC samples; fixture and disposed harness remain referenced; not a leak/reclaim proof",
		latencyScope:
			phase === "input"
				? "Dispatch through verified fresh emulator content"
				: "Request through verified emulator content; includes scheduling",
		frameScope:
			"Synchronous render/immediate commit after preparations; excludes deferred terminal/emulator completion",
		cpuScope:
			"Process CPU for mutation/resize/input through fresh observation, including queued normal work; excludes state hashing and memory samples",
		samples,
	};
}

async function runTranscriptAppendBaseline(lineCount: number, label: string): Promise<void> {
	const fixture: ReplayFixture = {
		cols: 100,
		rows: 30,
		turns: [
			{
				userText: "append large transcript",
				assistantChunks: ["large transcript follows"],
				outputBlock: Array.from(
					{ length: lineCount },
					(_, i) => `${i.toString().padStart(6, "0")} deterministic transcript row payload`,
				),
			},
		],
	};
	const replay = await runReplay(fixture);
	const normalized = replay.metrics.lineCounts.normalized;
	const diffed = replay.metrics.lineCounts.diffed;
	console.log(
		`[perf-baseline] ${label} transcript frames=${replay.metrics.renderCount} normalizedLast=${normalized?.last ?? 0} normalizedMax=${normalized?.max ?? 0} diffedLast=${diffed?.last ?? 0} diffedMax=${diffed?.max ?? 0}`,
	);
	expectFiniteNonNegative(replay.metrics.renderCount);
	expectFiniteNonNegative(normalized?.max ?? 0);
	expectFiniteNonNegative(diffed?.max ?? 0);
}
