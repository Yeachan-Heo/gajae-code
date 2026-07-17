import { afterEach, describe, expect, it } from "bun:test";
import {
	__textHelperPerfCounters,
	type Component,
	Ellipsis,
	normalizeTerminalOutput,
	TUI,
	truncateLinesToWidth,
	truncateToWidth,
	visibleWidth,
	visibleWidths,
} from "@gajae-code/tui";
import { ImageProtocol, TERMINAL } from "@gajae-code/tui/terminal-capabilities";
import { getDefaultTabWidth, setDefaultTabWidth } from "@gajae-code/utils";
import { VirtualTerminal } from "./virtual-terminal";

const REPORT_PATH = "artifacts/g011-qa-report.json";
const SEGMENT_RESET = "\x1b[0m";
const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x1b\\";

type Verdict = "passed" | "failed";
type CaseResult = {
	id: string;
	contractRef: string;
	scenario: string;
	expectedBehavior: string;
	verdict: Verdict;
	details?: Record<string, unknown>;
};

const cases: CaseResult[] = [];
const originalTabWidth = getDefaultTabWidth();

class FixedLines implements Component {
	constructor(private lines: string[]) {}
	setLines(lines: string[]): void {
		this.lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.lines;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(25);
	await term.flush();
}

function record(result: CaseResult): void {
	cases.push(result);
}

function renderedLineReference(line: string, width: number): string {
	if (TERMINAL.isImageLine(line)) return line;
	const normalized = normalizeTerminalOutput(line);
	if (visibleWidth(normalized) > width) {
		const truncated = truncateToWidth(normalized, width, Ellipsis.Omit);
		return truncated + (truncated.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
	}
	return normalized + (normalized.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
}

function findFirstDiff(a: string, b: string): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) if (a[i] !== b[i]) return i;
	return a.length === b.length ? -1 : len;
}

afterEach(() => {
	setDefaultTabWidth(originalTabWidth);
});

describe("G011 batched text natives red-team", () => {
	it("PARITY-FUZZ: batched truncate/width helpers equal per-line helpers across adversarial Unicode classes", () => {
		const corpus = [
			"",
			" ",
			"\t",
			"\tstart",
			"mid\tdle",
			"end\t",
			"plain ascii sentence",
			"punctuation !? [] {} <> #$%",
			"\x00",
			"trailing\x00",
			"\x00 padded",
			"\ud800",
			"lone high \ud800 end",
			"lone low \udc00 end",
			"\x1b[31mred\x1b[0m normal",
			"nested \x1b[1m\x1b[32mgreen-bold\x1b[0m done",
			"e\u0301 café n\u0303",
			"가나다 한글",
			"한 conjoining jamo",
			"한글한mix",
			"中文日本語カタカナひらがな",
			"ภาษาไทยกำลังทดสอบ",
			"ພາສາລາວກຳລັງທົດສອບ",
			"مرحبا بالعالم",
			"עברית שלום",
			"👩‍💻 developer emoji",
			"👨‍👩‍👧‍👦 family zwj",
			"🏳️‍🌈 flag sequence",
			"zero\u200dwidth\u200djoiners",
			"line with \r carriage and \n newline markers",
			"a".repeat(4096),
			`${"界".repeat(512)}${"a".repeat(512)}`,
			"mixed \x1b[36mANSI界e\u0301👩‍🚀\x1b[0m\tRTL مرحبا",
		];
		const widths = [0, 1, 2, 3, 4, 5, 8, 12, 20, 40, 80, 200];
		const optionCombos = [
			{ ellipsis: Ellipsis.Unicode, pad: false },
			{ ellipsis: Ellipsis.Ascii, pad: false },
			{ ellipsis: Ellipsis.Omit, pad: false },
			{ ellipsis: Ellipsis.Unicode, pad: true },
			{ ellipsis: null, pad: null },
			{ ellipsis: "" as unknown as Ellipsis, pad: undefined },
		];
		let mismatch: Record<string, unknown> | undefined;
		for (const width of widths) {
			for (const combo of optionCombos) {
				const batch = truncateLinesToWidth(corpus, width, combo.ellipsis, combo.pad);
				const perLine = corpus.map(line => truncateToWidth(line, width, combo.ellipsis, combo.pad));
				if (JSON.stringify(batch) !== JSON.stringify(perLine) && mismatch === undefined) {
					const index = batch.findIndex((value, i) => value !== perLine[i]);
					mismatch = { width, combo, index, input: corpus[index], batched: batch[index], perLine: perLine[index] };
				}
			}
		}
		const visibleBatch = visibleWidths(corpus);
		const visiblePerLine = corpus.map(line => visibleWidth(line));
		const visibleMismatchIndex = visibleBatch.findIndex((value, i) => value !== visiblePerLine[i]);
		const explicitParityCases = [
			{ input: "", width: 1, ellipsis: Ellipsis.Unicode, pad: true },
			{ input: "trailing\x00", width: 20, ellipsis: Ellipsis.Unicode, pad: true },
			{ input: "\ud800", width: 4, ellipsis: Ellipsis.Unicode, pad: true },
			{ input: "fits", width: 4, ellipsis: Ellipsis.Unicode, pad: false },
		];
		const explicitParity = explicitParityCases.map(entry => {
			const batched = truncateLinesToWidth([entry.input], entry.width, entry.ellipsis, entry.pad)[0];
			const single = truncateToWidth(entry.input, entry.width, entry.ellipsis, entry.pad);
			return { ...entry, batched, single, passed: batched === single };
		});
		const explicitMismatch = explicitParity.find(entry => !entry.passed);

		record({
			id: "PARITY-FUZZ",
			contractRef: "G011.1",
			scenario: "Diverse text corpus across widths and ellipsis/pad combinations",
			expectedBehavior: "Batched native helpers deep-equal per-line helpers",
			verdict:
				mismatch === undefined && visibleMismatchIndex < 0 && explicitMismatch === undefined ? "passed" : "failed",
			details: {
				corpusSize: corpus.length,
				widthCount: widths.length,
				optionComboCount: optionCombos.length,
				truncateMismatch: mismatch,
				visibleMismatchIndex,
				explicitMismatch,
				explicitParity,
			},
		});
		expect(mismatch).toBeUndefined();
		expect(visibleMismatchIndex).toBe(-1);
		expect(explicitMismatch).toBeUndefined();
	});

	it("FRAME-PARITY and FFI-COUNT: mixed frame emits reference bytes and uses few native calls", async () => {
		const previousIme = Bun.env.GJC_TUI_IME_CURSOR;
		Bun.env.GJC_TUI_IME_CURSOR = "0";
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = mutable.imageProtocol;
		mutable.imageProtocol = ImageProtocol.Kitty;
		__textHelperPerfCounters.reset();
		const width = 18;
		const term = new VirtualTerminal(width, 8);
		const image = `${ImageProtocol.Kitty}a=T,f=100;${"Q".repeat(64)}\x1b\\`;
		const lines = [
			"ascii short",
			"中文中文中文中文中文 overflow",
			"\x1b[35mcolored界界界界界\x1b[0m tail",
			image,
			"emoji 👩‍💻👨‍👩‍👧‍👦🏳️‍🌈 overflow",
			"thai กำลังทดสอบยาวมาก",
		];
		const expectedPayload = lines.map(line => renderedLineReference(line, width)).join("\r\n");
		const expectedFullWrite = `\x1b[?2004h\x1b[?25l\x1b[16t\x1b[?2026h\x1b[2J\x1b[H\x1b[3J${expectedPayload}\x1b[?25l\x1b[?2026l`;
		const tui = new TUI(term);
		try {
			tui.addChild(new FixedLines(lines));
			tui.start();
			await settle(term);
			const actual = term.getWriteLog().join("");
			const diffAt = findFirstDiff(actual, expectedFullWrite);
			record({
				id: "FRAME-PARITY",
				contractRef: "G011.2",
				scenario: "Full render of mixed ASCII, ANSI, CJK, emoji, Thai, and Kitty image lines",
				expectedBehavior: "TUI emitted bytes match per-line normalization/truncation reference exactly",
				verdict: actual === expectedFullWrite ? "passed" : "failed",
				details: {
					actualByteLength: actual.length,
					expectedByteLength: expectedFullWrite.length,
					diffAt,
					actualSlice: actual.slice(Math.max(0, diffAt - 20), diffAt + 40),
					expectedSlice: expectedFullWrite.slice(Math.max(0, diffAt - 20), diffAt + 40),
				},
			});
			record({
				id: "FFI-COUNT",
				contractRef: "G011.3",
				scenario: "Frame with multiple non-ASCII overflowing non-image lines",
				expectedBehavior: "Frame normalization uses O(1)/few batched native calls, not O(N)",
				verdict:
					__textHelperPerfCounters.visibleWidthsCalls <= 1 &&
					__textHelperPerfCounters.truncateLinesToWidthCalls <= 1
						? "passed"
						: "failed",
				details: {
					lineCount: lines.length,
					visibleWidthsCalls: __textHelperPerfCounters.visibleWidthsCalls,
					truncateLinesToWidthCalls: __textHelperPerfCounters.truncateLinesToWidthCalls,
				},
			});
		} finally {
			tui.stop();
			mutable.imageProtocol = originalProtocol;
			if (previousIme === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousIme;
		}
	});

	it("TAB-WIDTH: runtime changes invalidate cached tab width and TUI truncation cache", async () => {
		setDefaultTabWidth(2);
		const width2 = visibleWidth("a\tb");
		setDefaultTabWidth(6);
		const width6 = visibleWidth("a\tb");
		const batch = visibleWidths(["\t", "a\tb"]);

		const term = new VirtualTerminal(5, 4);
		const component = new FixedLines(["a\tbbbb"]);
		const tui = new TUI(term);
		let initialPayload = "";
		let changedPayload = "";
		try {
			setDefaultTabWidth(2);
			tui.addChild(component);
			tui.start();
			await settle(term);
			initialPayload = renderedLineReference("a\tbbbb", 5);
			expect(term.getWriteLog().join("")).toContain(initialPayload);
			term.clearWriteLog();

			setDefaultTabWidth(6);
			await settle(term);
			changedPayload = renderedLineReference("a\tbbbb", 5);
			expect(changedPayload).not.toBe(initialPayload);
			expect(term.getWriteLog().join("")).toContain(changedPayload);
		} finally {
			tui.dispose();
			tui.stop();
		}

		const passed =
			width2 === 4 &&
			width6 === 8 &&
			JSON.stringify(batch) === JSON.stringify([6, 8]) &&
			changedPayload !== initialPayload;
		record({
			id: "TAB-WIDTH",
			contractRef: "G011.4",
			scenario: "Change default tab width at runtime without manual invalidation",
			expectedBehavior:
				"Tab-bearing helper widths recompute and TUI cached truncation bytes refresh with the new tab width",
			verdict: passed ? "passed" : "failed",
			details: { width2, width6, batch, initialPayload, changedPayload },
		});
	});

	it("NULLISH and EMPTY-BATCH: guard nullish inputs and empty arrays", () => {
		let nullishPassed = true;
		const nullishOutputs: unknown[] = [];
		try {
			nullishOutputs.push(
				truncateToWidth(undefined as unknown as string, undefined as unknown as number, undefined, undefined),
			);
			nullishOutputs.push(truncateToWidth(null as unknown as string, null as unknown as number, null, null));
			nullishOutputs.push(
				truncateToWidth("abcdef", null as unknown as number, "" as unknown as Ellipsis, undefined),
			);
			nullishPassed = JSON.stringify(nullishOutputs) === JSON.stringify(["", "", ""]);
		} catch (error) {
			nullishPassed = false;
			nullishOutputs.push(String(error));
		}
		const emptyTruncate = truncateLinesToWidth([], 10);
		const emptyWidths = visibleWidths([]);
		record({
			id: "NULLISH",
			contractRef: "G011.5",
			scenario: "Nullish text/width/ellipsis/pad inputs",
			expectedBehavior: "truncateToWidth does not throw and coerces to safe prior defaults",
			verdict: nullishPassed ? "passed" : "failed",
			details: { nullishOutputs },
		});
		record({
			id: "EMPTY-BATCH",
			contractRef: "G011.6",
			scenario: "Empty batched helper inputs",
			expectedBehavior: "truncateLinesToWidth([]) and visibleWidths([]) return [] without native error",
			verdict: emptyTruncate.length === 0 && emptyWidths.length === 0 ? "passed" : "failed",
			details: { emptyTruncate, emptyWidths },
		});
	});

	it("writes artifacts/g011-qa-report.json", async () => {
		const blockers = cases
			.filter(entry => entry.verdict === "failed")
			.map(entry => ({
				id: entry.id,
				contractRef: entry.contractRef,
				reason: `${entry.id} failed: ${entry.expectedBehavior}`,
				details: entry.details,
			}));
		const status: Verdict = blockers.length === 0 ? "passed" : "failed";
		const coverage = [
			[
				"G011.1",
				"Batched truncateLinesToWidth/visibleWidths equal per-line helpers for all input classes",
				["PARITY-FUZZ", "EMPTY-BATCH"],
			],
			["G011.2", "Frame hot path emits byte-identical output vs per-line normalization reference", ["FRAME-PARITY"]],
			["G011.3", "Frame normalization uses O(1)/few batched FFI calls", ["FFI-COUNT"]],
			["G011.4", "Tab-width cache invalidation recomputes widths with new tab width", ["TAB-WIDTH"]],
			["G011.5", "Nullish truncateToWidth arguments do not throw and match guarded prior behavior", ["NULLISH"]],
			["G011.6", "Empty batched helper inputs return [] without native error", ["EMPTY-BATCH"]],
		] as const;
		const report = {
			schemaVersion: 1,
			kind: "algorithm-boundary-report",
			story: "G011",
			status,
			e2eStatus: status,
			redTeamStatus: status,
			evidence: cases.map(entry => `${entry.id}:${entry.verdict}`),
			e2eCommands: ["bun test packages/tui/test/g011-batched-natives-redteam.test.ts"],
			redTeamCommands: ["bun test packages/tui/test/g011-batched-natives-redteam.test.ts"],
			artifactPath: REPORT_PATH,
			contractCoverage: coverage.map(([contractRef, obligation, ids]) => ({
				contractRef,
				obligation,
				status: ids.some(id => cases.find(entry => entry.id === id)?.verdict === "failed") ? "failed" : "passed",
				surfaceEvidenceRefs: ids.map(id => `SE-${id}`),
				adversarialCaseRefs: ids,
			})),
			surfaceEvidence: cases.map(entry => ({
				id: `SE-${entry.id}`,
				contractRef: entry.contractRef,
				surface: "algorithm",
				invocation: "bun test packages/tui/test/g011-batched-natives-redteam.test.ts",
				verdict: entry.verdict,
			})),
			adversarialCases: cases,
			blockers,
		};
		await Bun.write(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
		const loaded = await Bun.file(REPORT_PATH).json();
		expect(loaded.kind).toBe("algorithm-boundary-report");
		expect(loaded.adversarialCases.map((entry: CaseResult) => entry.id).sort()).toEqual(
			["EMPTY-BATCH", "FFI-COUNT", "FRAME-PARITY", "NULLISH", "PARITY-FUZZ", "TAB-WIDTH"].sort(),
		);
	});
});
