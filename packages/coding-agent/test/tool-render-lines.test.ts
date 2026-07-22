import { expect, test } from "bun:test";
import {
	createToolTranscriptRenderDescriptor,
	INPUT_MAX_SOURCE_BYTES,
	renderToolDisplayLines,
} from "../src/modes/components/tool-transcript-format";
import { initTheme, theme } from "../src/modes/theme/theme";

initTheme();

test("renders a capped, SGR-styled edit diff without charging call or status lines", () => {
	const diff = Array.from({ length: 200 }, (_, index) => `+added ${index}`).join("\n");
	const lines = renderToolDisplayLines(
		createToolTranscriptRenderDescriptor({
			name: "edit",
			args: { path: "src/example.ts" },
			resultContent: "done",
			detailsData: { path: "src/example.ts", diff },
			hasResult: true,
		}),
		40,
		theme,
	);
	expect(lines.some(line => line.includes("\x1b[") && line.includes("added"))).toBe(true);
	expect(lines).toContain("... 100 more lines");
	expect(lines).toContain("path: src/example.ts");
	expect(lines.join("\n")).toContain("✓ done");
});

test("renders structured details as a JSON tree and leaves unmapped tools plain", () => {
	const structured = renderToolDisplayLines(
		createToolTranscriptRenderDescriptor({
			name: "bash",
			args: {},
			resultContent: "ok",
			detailsData: { nested: { answer: 42 } },
			hasResult: true,
		}),
		80,
		theme,
	);
	expect(structured.join("\n")).toContain("nested");
	const plain = renderToolDisplayLines(
		createToolTranscriptRenderDescriptor({
			name: "custom",
			args: {},
			resultContent: "plain result",
			hasResult: true,
		}),
		80,
		theme,
	);
	expect(plain.join("\n")).toContain("plain result");
});

test("degrades over-budget input before rich helpers", () => {
	const lines = renderToolDisplayLines(
		createToolTranscriptRenderDescriptor({
			name: "edit",
			args: {},
			resultContent: "done",
			detailsData: { diff: "x".repeat(8_193) },
			hasResult: true,
		}),
		80,
		theme,
	);
	expect(lines).toContain("... input truncated for rendering (press r for raw)");
	expect(lines.join("\n")).not.toContain("should not render");
});

test("uses fixed fallback statuses and bounded result text for oversized errors and arguments", () => {
	const oversized = "x".repeat(INPUT_MAX_SOURCE_BYTES + 1);
	const error = renderToolDisplayLines(
		createToolTranscriptRenderDescriptor({
			name: "bash",
			args: {},
			resultContent: oversized,
			hasResult: true,
			isError: true,
		}),
		80,
		theme,
	);
	const oversizedScalar = "x".repeat(8_193);
	const args = renderToolDisplayLines(
		createToolTranscriptRenderDescriptor({
			name: "bash",
			args: { command: oversizedScalar },
			resultContent: "ok",
			hasResult: true,
		}),
		80,
		theme,
	);
	expect(error).toContain("✗ Error");
	expect(error).toContain("... input truncated for rendering (press r for raw)");
	expect(args).toContain("... input truncated for rendering (press r for raw)");
});
