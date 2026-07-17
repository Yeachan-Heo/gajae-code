// Advisory perf baselines: recording only; hard gating deferred to perf-gates.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __animationSchedulerTestHooks } from "@gajae-code/tui";
import { __editorPerfCounters, Editor } from "@gajae-code/tui/components/editor";
import { __loaderPerfCounters, Loader } from "@gajae-code/tui/components/loader";
import { __markdownPerfCounters, clearRenderCache, Markdown } from "@gajae-code/tui/components/markdown";
import { renderMetrics } from "@gajae-code/tui/metrics";
import { __textHelperPerfCounters } from "@gajae-code/tui/utils";
import { $flag } from "@gajae-code/utils";
import { makeRecordedSession, type ReplayFixture, runReplay } from "./replay-harness";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes";

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

	it("records markdown lexer invocations and lexed bytes during long streaming renders", () => {
		const markdown = new Markdown("", 0, 0, defaultMarkdownTheme);
		let content = "";
		for (let i = 0; i < 48; i++) {
			content += `## streamed heading ${i}\n\n- token **${i}** with \`inline code\` and [link](https://example.com/${i})\n\n`;
			markdown.setText(content);
			const lines = markdown.render(96);
			expect(lines.length).toBeGreaterThan(0);
		}

		console.log(
			`[perf-baseline] markdown streaming lexerInvocations=${__markdownPerfCounters.lexerInvocations} lexedBytes=${__markdownPerfCounters.lexedBytes}`,
		);
		expectFiniteNonNegative(__markdownPerfCounters.lexerInvocations);
		expectFiniteNonNegative(__markdownPerfCounters.lexedBytes);
	});

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
	}
});

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
