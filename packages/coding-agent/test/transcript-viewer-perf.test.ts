import { expect, test } from "bun:test";
import {
	createToolTranscriptRenderDescriptor,
	renderToolDisplayLines,
	TOOL_RESULT_MAX_EXPANDED_LINES,
	toolDisplayText,
} from "../src/modes/components/tool-transcript-format";
import { TranscriptViewerOverlay, transcriptViewerEntries } from "../src/modes/components/transcript-viewer-overlay";
import { initTheme, theme } from "../src/modes/theme/theme";
import { TranscriptItemRegistry } from "../src/modes/transcript-item-registry";

initTheme();
const fields = (resultText: string) => ({
	name: "bash",
	args: { command: "echo result" },
	intent: "Run command",
	resultText,
	isError: false,
	hasResult: true,
});

function result(lines: number): string {
	return Array.from({ length: lines }, (_, index) => `result-${index}`).join("\n");
}

test("bounds expanded tool rendering independently of raw result size", () => {
	const oneThousand = toolDisplayText(fields(result(1_000)), true);
	const oneHundredThousand = toolDisplayText(fields(result(100_000)), true);
	const callBlockLines = toolDisplayText(fields(""), false).split("\n").length;
	const bound = callBlockLines + TOOL_RESULT_MAX_EXPANDED_LINES + 1;
	const richRenderedBound = bound + 2;
	expect(oneThousand.split("\n").length).toBeLessThanOrEqual(bound);
	expect(oneHundredThousand.split("\n").length).toBe(oneThousand.split("\n").length);

	const renderedToolContentLineCount = (resultText: string) => {
		const registry = new TranscriptItemRegistry();
		registry.register({
			id: "tool:large",
			kind: "tool",
			source: "large",
			getPayload: () => ({
				text: toolDisplayText(fields(resultText), true),
				metadata: { ...fields(resultText), arguments: { command: "echo result" } },
				source: "large",
			}),
		});
		const assistantText = result(150);
		registry.register({
			id: "assistant",
			kind: "assistant-text",
			source: "assistant",
			getPayload: () => ({ text: assistantText, metadata: {}, source: "assistant" }),
		});
		const viewer = new TranscriptViewerOverlay({
			getEntries: () => transcriptViewerEntries(registry),
			onClose: () => {},
		});
		viewer.handleInput(" ");
		const rendered = viewer.render(80);
		const toolHeader = rendered.findIndex(line => line.includes("[bash]"));
		const assistantHeader = rendered.findIndex((line, index) => index > toolHeader && line.includes("[Response]"));
		expect(toolHeader).toBeGreaterThanOrEqual(0);
		expect(assistantHeader).toBeGreaterThan(toolHeader);
		return assistantHeader - toolHeader - 2;
	};

	const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 1_000 });
	try {
		const renderedOneThousand = renderedToolContentLineCount(result(1_000));
		expect(renderedOneThousand).toBeLessThanOrEqual(richRenderedBound);

		const maxLineWidth = 150;
		const overWidthResult = (lines: number) =>
			Array.from({ length: lines }, () => "x".repeat(maxLineWidth)).join("\n");
		const wrappedBound = bound * Math.ceil(maxLineWidth / 75);
		const renderedOverWidthOneThousand = renderedToolContentLineCount(overWidthResult(1_000));
		const renderedOverWidthOneHundredThousand = renderedToolContentLineCount(overWidthResult(100_000));
		expect(renderedOverWidthOneThousand).toBeLessThanOrEqual(wrappedBound);
		expect(renderedOverWidthOneHundredThousand).toBe(renderedOverWidthOneThousand);
	} finally {
		if (rows) Object.defineProperty(process.stdout, "rows", rows);
		else Reflect.deleteProperty(process.stdout, "rows");
	}

	const assistantRegistry = new TranscriptItemRegistry();
	assistantRegistry.register({
		id: "assistant",
		kind: "assistant-text",
		source: "assistant",
		getPayload: () => ({ text: result(150), metadata: {}, source: "assistant" }),
	});
	const assistant = transcriptViewerEntries(assistantRegistry).find(entry => entry.id === "assistant");
	expect(assistant?.getDisplayText).toBeUndefined();
	expect(assistant?.payload.text.split("\n")).toHaveLength(150);
});

test("caps a valid 50,000-line result before wrapping while preserving source omission accounting", () => {
	const descriptor = createToolTranscriptRenderDescriptor({
		name: "bash",
		args: {},
		resultContent: Array.from({ length: 50_000 }, () => "x".repeat(19)).join("\n"),
		hasResult: true,
	});
	const lines = renderToolDisplayLines(descriptor, 1, theme);
	expect(lines).toHaveLength(TOOL_RESULT_MAX_EXPANDED_LINES + 11);
	expect(lines.at(-1)).toBe("... 49900 more lines");
});

test("keeps rich expanded-tool recompute below the frame budget without a cache", () => {
	const descriptor = createToolTranscriptRenderDescriptor({
		name: "edit",
		args: { path: "src/example.ts" },
		resultContent: "done",
		detailsData: { diff: Array.from({ length: 200 }, (_, index) => `+line ${index}`).join("\n") },
		hasResult: true,
	});
	const timings = Array.from({ length: 50 }, () => {
		const started = performance.now();
		renderToolDisplayLines(descriptor, 80, theme);
		return performance.now() - started;
	}).sort((left, right) => left - right);
	const p95 = timings[Math.ceil(timings.length * 0.95) - 1] ?? Infinity;
	expect(p95).toBeLessThan(16);
});
