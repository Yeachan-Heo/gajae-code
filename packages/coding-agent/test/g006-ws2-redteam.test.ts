import { describe, expect, test } from "bun:test";
import { validateDisplayLine } from "../src/modes/components/ansi-display-validator";
import {
	buildToolTranscriptEntry,
	createToolTranscriptRenderDescriptor,
	INPUT_MAX_JSON_DEPTH,
	INPUT_MAX_JSON_NODES,
	INPUT_MAX_SCALAR_LEN,
	INPUT_MAX_SOURCE_BYTES,
	INPUT_MAX_SOURCE_LINES,
	renderToolDisplayLines,
	TOOL_RESULT_MAX_EXPANDED_LINES,
} from "../src/modes/components/tool-transcript-format";
import { type TranscriptViewerEntry, TranscriptViewerOverlay } from "../src/modes/components/transcript-viewer-overlay";
import { initTheme, theme } from "../src/modes/theme/theme";

initTheme();

const ESC = "\x1b";
const control = /[\x00-\x1f\x7f-\x9f]/;
const sgr = /\x1b\[[0-9;]*m/g;

function stripSgr(value: string): string {
	return value.replace(sgr, "");
}

function assertOnlyBalancedSgr(lines: string[]): void {
	for (const line of lines) {
		expect(stripSgr(line)).not.toContain(ESC);
		expect(stripSgr(line)).not.toMatch(control);
		let active = false;
		for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
			active = !match[1]!.split(";").includes("0") && match[1] !== "0";
		}
		expect(active).toBe(false);
	}
}

function descriptor(overrides: Record<string, unknown> = {}) {
	return createToolTranscriptRenderDescriptor({
		name: "edit",
		args: { path: "src/file.ts" },
		resultContent: "done",
		hasResult: true,
		...overrides,
	});
}

function richEntry(kind: string, canonical = "canonical"): TranscriptViewerEntry {
	return {
		id: `${kind}:entry`,
		kind,
		label: kind,
		payload: { text: canonical, metadata: {}, source: canonical },
		foldable: true,
		...(kind === "tool" ? { renderDescriptor: descriptor(), richRenderEligible: true } : {}),
		...(kind === "tool" ? { getDisplayText: () => "display" } : {}),
		...({ renderLines: () => [`${ESC}[31mTRUSTED${ESC}[0m`] } as unknown as Record<string, unknown>),
	};
}

describe("G006 WS2 red-team", () => {
	test("rejects malformed and non-SGR control-sequence evasions without leaking live controls", () => {
		const malicious = [
			`split${ESC}\n[31mlive`,
			`nested${ESC}[38;5;;mbad`,
			`empty${ESC}[;mbad`,
			`huge${ESC}[999999999mbad`,
			`colon${ESC}[38:5:196mbad`,
			`c1\x9b31mbad`,
			`lone${ESC}`,
			`long${ESC}[${"1;".repeat(10_000)}m`,
			`osc${ESC}]0;title ${ESC}[31mhidden${ESC}\\ tail`,
			`overwrite\b\r${ESC}[2Jbad`,
		].join("\n");
		const rendered = malicious.split("\n").map(validateDisplayLine);
		for (const line of rendered) {
			expect(line).not.toMatch(control);
			expect(line).not.toContain(ESC);
		}
	});

	test("uses descriptor rendering only for selected expanded non-raw tool entries", () => {
		const entries = [
			richEntry("custom"),
			richEntry("tool"),
			{ ...richEntry("tool"), id: "tool:without-descriptor", renderDescriptor: undefined },
		];
		const viewer = new TranscriptViewerOverlay({ getEntries: () => entries, onClose: () => {} });
		viewer.handleInput(" ");
		expect(viewer.render(100).join("\n")).not.toContain("TRUSTED");
		viewer.handleInput("j");
		viewer.handleInput(" ");
		expect(viewer.render(100).join("\n")).not.toContain("TRUSTED");
		expect(viewer.render(100).join("\n")).toContain("✓ done");
		viewer.handleInput("r");
		expect(viewer.render(100).join("\n")).not.toContain("✓ done");
		viewer.handleInput("j");
		viewer.handleInput(" ");
		expect(viewer.render(100).join("\n")).not.toContain("TRUSTED");
	});

	test("keeps hostile expanded observer entries on the capped plain projection", () => {
		const result = ["one", "two", "three", "four"].join("\n");
		const canonical = `observer${ESC}]52;c;copy\x07${ESC}[2J\x01\n${result}`;
		const entry = buildToolTranscriptEntry({
			canonicalPayload: { text: canonical, metadata: {}, source: canonical },
			renderDescriptor: descriptor({ resultContent: result }),
			capabilities: { copyable: true, foldable: true, rawViewable: true },
			identity: { id: "tool:observer", label: "edit", display: "full" },
		});
		const viewer = new TranscriptViewerOverlay({
			getEntries: () => [entry],
			onClose: () => {},
			maxExpandedLines: 2,
		});

		viewer.handleInput(" ");
		const rendered = viewer.render(100).join("\n");
		expect(entry.richRenderEligible).toBe(false);
		expect(rendered).not.toContain("✓ done");
		expect(rendered).not.toContain("input truncated for rendering");
		expect(rendered).toContain("... 3 more lines");
	});

	test("holds every input boundary and degrades oversized recursive and wide details safely", () => {
		const atBytes = "a".repeat(INPUT_MAX_SOURCE_BYTES);
		const overBytes = "a".repeat(INPUT_MAX_SOURCE_BYTES + 1);
		const atLines = Array.from({ length: INPUT_MAX_SOURCE_LINES + 1 }, () => "").join("\n");
		const overLines = `${atLines}\n`;
		const atScalar = "x".repeat(INPUT_MAX_SCALAR_LEN);
		const overScalarByOne = "x".repeat(INPUT_MAX_SCALAR_LEN + 1);
		const overScalar = "x".repeat(INPUT_MAX_SCALAR_LEN + 2);
		const aggregateOverBytes = Array.from({ length: 129 }, () => atScalar);
		const isDetailsTruncated = (value: unknown) =>
			renderToolDisplayLines(descriptor({ detailsData: value }), 80, theme).includes(
				"... input truncated for rendering (press r for raw)",
			);
		const isResultTruncated = (value: string) =>
			renderToolDisplayLines(descriptor({ resultContent: value }), 80, theme).includes(
				"... input truncated for rendering (press r for raw)",
			);
		const scalarBoundaries = [
			isResultTruncated(atBytes),
			isResultTruncated(overBytes),
			isResultTruncated(atLines),
			isResultTruncated(overLines),
			isDetailsTruncated(atScalar),
			isDetailsTruncated(overScalarByOne),
			isDetailsTruncated(overScalar),
			isDetailsTruncated(aggregateOverBytes),
		];
		let depth32: unknown = "leaf";
		let depth33: unknown = "leaf";
		for (let index = 0; index < INPUT_MAX_JSON_DEPTH; index++) depth32 = { child: depth32 };
		for (let index = 0; index <= INPUT_MAX_JSON_DEPTH; index++) depth33 = { child: depth33 };
		const nodeLimit = Array.from({ length: INPUT_MAX_JSON_NODES - 1 }, () => 0);
		const nodeOver = Array.from({ length: INPUT_MAX_JSON_NODES }, () => 0);
		const structuralBoundaries = [depth32, depth33, nodeLimit, nodeOver].map(isDetailsTruncated);
		const deep = depth33;
		const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`key-${index}`, index]));
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => renderToolDisplayLines(descriptor({ detailsData: deep }), 80, theme)).not.toThrow();
		expect(() => renderToolDisplayLines(descriptor({ detailsData: wide }), 80, theme)).not.toThrow();
		expect(() => renderToolDisplayLines(descriptor({ args: cyclic, detailsData: cyclic }), 80, theme)).not.toThrow();
		expect(descriptor({ args: cyclic, detailsData: cyclic }).inputTruncated).toBe(true);
		expect(scalarBoundaries).toEqual([false, true, false, true, false, true, true, true]);
		expect(structuralBoundaries).toEqual([false, true, false, true]);
	});

	test("sanitizes hostile diff and JSON data before styling and keeps wrapped SGR balanced", () => {
		const hostile = `+1|added ${ESC}]0;title${ESC}\\ ${ESC}[31mred${ESC}[0m 😀 漢字`;
		const diffLines = renderToolDisplayLines(
			descriptor({ detailsData: { path: "src/file.ts", diff: hostile } }),
			8,
			theme,
		);
		assertOnlyBalancedSgr(diffLines);
		const jsonLines = renderToolDisplayLines(
			descriptor({ name: "bash", detailsData: { value: hostile }, resultContent: "ok" }),
			8,
			theme,
		);
		assertOnlyBalancedSgr(jsonLines);
	});

	test("applies a post-wrap 100-line cap solely to diff results with an uncolorable sentinel", () => {
		const diff = Array.from({ length: 200 }, (_, index) => `+${index + 1}|x`).join("\n");
		const lines = renderToolDisplayLines(descriptor({ detailsData: { path: "src/file.ts", diff } }), 80, theme);
		expect(lines.filter(line => line.includes("more lines"))).toEqual(["... 100 more lines"]);
		expect(lines.indexOf("path: src/file.ts")).toBeGreaterThanOrEqual(0);
		expect(lines.join("\n")).toContain("✓ done");
		expect(lines.filter(line => /^\x1b\[/.test(line) && line.includes("more lines"))).toHaveLength(0);
		expect(TOOL_RESULT_MAX_EXPANDED_LINES).toBe(100);
	});

	test("copies byte-exact canonical payload while raw mode bypasses rich lines", () => {
		const canonical = `raw${ESC}]52;c;copy\x07${ESC}[31mstyled`;
		const copied: string[] = [];
		const viewer = new TranscriptViewerOverlay({
			getEntries: () => [richEntry("tool", canonical)],
			onClose: () => {},
			copyToClipboard: text => copied.push(text),
		});
		viewer.handleInput(" ");
		expect(viewer.render(100).join("\n")).toContain("✓ done");
		viewer.handleInput("y");
		expect(copied).toEqual([canonical]);
		viewer.handleInput("r");
		const raw = viewer.render(100).join("\n");
		expect(raw).not.toContain("✓ done");
		expect(raw).not.toContain(`${ESC}[31mstyled`);
	});
});
