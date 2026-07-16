import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import { BranchSummaryMessageComponent } from "@gajae-code/coding-agent/modes/components/branch-summary-message";
import { buildStatusFooter } from "@gajae-code/coding-agent/modes/components/execution-shared";
import { getThemeByName, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { BranchSummaryMessage } from "@gajae-code/coding-agent/session/messages";
import { evalToolRenderer } from "@gajae-code/coding-agent/tools/eval";
import {
	dedupeParseErrors,
	expandHintSuffix,
	formatCodeFrameLine,
	formatDiagnostics,
	formatExpandHint,
	formatParseErrors,
	formatScreenshot,
	getPreviewLines,
	setExpandHintOwnerFocused,
	shortenPath,
} from "@gajae-code/coding-agent/tools/render-utils";
import { setKeybindings } from "@gajae-code/tui";

beforeAll(async () => {
	const testTheme = await getThemeByName("red-claw");
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	setExpandHintOwnerFocused(true);
});

describe("tool-output expansion hints", () => {
	it("uses the configured binding in execution, eval, and summary surfaces", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+x" }));

		const footer = buildStatusFooter({
			status: "complete",
			exitCode: 0,
			truncation: undefined,
			hiddenLineCount: 3,
		});
		const summary = new BranchSummaryMessageComponent({ summary: "Summary" } as BranchSummaryMessage);

		expect(Bun.stripANSI(footer!.render(120).join("\n"))).toContain("3 more lines (Alt+X to expand)");
		expect(Bun.stripANSI(summary.render(120).join("\n"))).toContain("Branch summary (Alt+X to expand)");
		const evalOutput = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") }] },
			{ expanded: false, renderContext: { expanded: false, previewLines: 1 } } as never,
			theme,
		);

		expect(Bun.stripANSI(evalOutput.render(120).join("\n"))).toContain("Alt+X to expand");
	});

	it("preserves surrounding output when the action is unbound", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": [] }));

		expect(expandHintSuffix(theme)).toBe("");
		expect(
			Bun.stripANSI(
				buildStatusFooter({
					status: "complete",
					exitCode: 0,
					truncation: undefined,
					hiddenLineCount: 3,
				})!
					.render(120)
					.join("\n"),
			),
		).toContain("3 more lines");
		expect(
			Bun.stripANSI(
				buildStatusFooter({
					status: "complete",
					exitCode: 0,
					truncation: undefined,
					hiddenLineCount: 3,
				})!
					.render(120)
					.join("\n"),
			),
		).not.toContain("to expand");
	});

	it("suppresses hints while the composer does not own focus", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+x" }));

		setExpandHintOwnerFocused(false);
		expect(expandHintSuffix(theme)).toBe("");
		expect(formatExpandHint(theme)).toBe("");

		setExpandHintOwnerFocused(true);
		expect(expandHintSuffix(theme)).toContain("Alt+X to expand");
		expect(Bun.stripANSI(formatExpandHint(theme))).toContain("Alt+X for more");
	});
});

describe("parse error formatting", () => {
	it("deduplicates parse errors while preserving order", () => {
		const errors = [
			"foo.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
		];

		expect(dedupeParseErrors(errors)).toEqual([
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
		]);
	});

	it("formats deduplicated parse errors", () => {
		const formatted = formatParseErrors([
			"foo.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
		]);

		expect(formatted).toEqual([
			"Parse issues:",
			"- foo.ts: parse error (syntax tree contains error nodes)",
			"- bar.ts: parse error (syntax tree contains error nodes)",
		]);
	});
});

describe("formatScreenshot", () => {
	function fakeResized(
		overrides?: Partial<{
			width: number;
			height: number;
			originalWidth: number;
			originalHeight: number;
			wasResized: boolean;
			buffer: Uint8Array;
			mimeType: string;
		}>,
	): {
		buffer: Uint8Array;
		mimeType: string;
		originalWidth: number;
		originalHeight: number;
		width: number;
		height: number;
		wasResized: boolean;
		get data(): string;
	} {
		const buf = overrides?.buffer ?? new Uint8Array(2048);
		return {
			buffer: buf,
			mimeType: overrides?.mimeType ?? "image/webp",
			originalWidth: overrides?.originalWidth ?? 800,
			originalHeight: overrides?.originalHeight ?? 600,
			width: overrides?.width ?? 800,
			height: overrides?.height ?? 600,
			wasResized: overrides?.wasResized ?? false,
			get data() {
				return Buffer.from(buf).toString("base64");
			},
		};
	}

	it("formats full-res save with home-relative path", () => {
		const filePath = path.join(os.homedir(), "screenshots", "capture.png");
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(1024) });

		expect(
			formatScreenshot({
				saveFullRes: true,
				savedMimeType: "image/png",
				savedByteLength: 2048,
				dest: filePath,
				resized,
			}),
		).toEqual([
			"Screenshot captured",
			"Saved: image/png (2.00 KB) to ~/screenshots/capture.png",
			"Model: image/webp (1.00 KB, 800x600)",
		]);
	});

	it("formats non-home path without tilde", () => {
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(1024) });

		expect(
			formatScreenshot({
				saveFullRes: true,
				savedMimeType: "image/png",
				savedByteLength: 2048,
				dest: "/tmp/capture.png",
				resized,
			}),
		).toEqual([
			"Screenshot captured",
			"Saved: image/png (2.00 KB) to /tmp/capture.png",
			"Model: image/webp (1.00 KB, 800x600)",
		]);
	});

	it("formats temp-only screenshot without save line", () => {
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(3072) });

		expect(
			formatScreenshot({
				saveFullRes: false,
				savedMimeType: "image/webp",
				savedByteLength: 3072,
				dest: "/tmp/gjc-sshots-123.png",
				resized,
			}),
		).toEqual(["Screenshot captured", "Format: image/webp (3.00 KB)", "Dimensions: 800x600"]);
	});

	it("appends dimension note when image was resized", () => {
		const resized = fakeResized({
			wasResized: true,
			originalWidth: 1600,
			originalHeight: 1200,
			width: 800,
			height: 600,
		});

		const lines = formatScreenshot({
			saveFullRes: false,
			savedMimeType: "image/webp",
			savedByteLength: 2048,
			dest: "/tmp/shot.png",
			resized,
		});

		expect(lines).toContain(
			"[Image: original 1600x1200, displayed at 800x600. Multiply coordinates by 2.00 to map to original image.]",
		);
	});
});

describe("formatDiagnostics", () => {
	it("replaces tabs in rendered diagnostic text", async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();

		const formatted = formatDiagnostics(
			{
				errored: true,
				summary: "1\terror(s)",
				messages: [
					"src/example.go:183:41 [error] [compiler] too many\targuments in call (WrongArgCount)",
					"\tunparsed diagnostic\tmessage",
				],
			},
			true,
			theme!,
			() => "go",
		);

		expect(formatted).not.toContain("\t");
		expect(formatted.replace(/\s+/g, " ")).toContain("too many arguments in call");
		expect(formatted.replace(/\s+/g, " ")).toContain("unparsed diagnostic message");
		expect(formatted.replace(/\s+/g, " ")).toContain("1 error(s)");
	});
});

describe("formatCodeFrameLine", () => {
	it("pads markers as part of the gutter", () => {
		expect(formatCodeFrameLine(" ", 447, "context", 3)).toBe(" 447│context");
		expect(formatCodeFrameLine("*", 448, "match", 3)).toBe("*448│match");
		expect(formatCodeFrameLine("+", 11, "added", 3)).toBe(" +11│added");
		expect(formatCodeFrameLine("+", 235, "added", 3)).toBe("+235│added");
	});
});

describe("render helper null-safety", () => {
	it("getPreviewLines returns [] for non-string input instead of throwing", () => {
		// Mirrors the normalizeText-class bug: a (text: string) helper doing a
		// first-action string op crashes when a renderer passes an optional field.
		expect(() => getPreviewLines(undefined as unknown as string, 3, 80)).not.toThrow();
		expect(getPreviewLines(undefined as unknown as string, 3, 80)).toEqual([]);
		expect(getPreviewLines(null as unknown as string, 3, 80)).toEqual([]);
		// Sanity: real input still works.
		expect(getPreviewLines("a\nb\nc\nd", 2, 80)).toEqual(["a", "b"]);
	});

	it("shortenPath returns '' for non-string input instead of throwing", () => {
		expect(() => shortenPath(undefined as unknown as string)).not.toThrow();
		expect(shortenPath(undefined as unknown as string)).toBe("");
		expect(shortenPath(null as unknown as string)).toBe("");
		// Sanity: real input still works.
		expect(shortenPath("/home/u/x", "/home/u")).toBe("~/x");
	});
});
