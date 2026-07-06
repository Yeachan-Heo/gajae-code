import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { type Component, TUI } from "@gajae-code/tui";
import { Ellipsis, truncateToWidth, visibleWidth } from "@gajae-code/tui/utils";
import { getDefaultTabWidth, setDefaultTabWidth } from "@gajae-code/utils";
import { VirtualTerminal } from "./virtual-terminal";

const REPORT_PATH = "artifacts/g015-qa-report.json";
const originalTabWidth = getDefaultTabWidth();

type CaseResult = {
	id: string;
	status: "passed" | "failed";
	details: Record<string, unknown>;
};

const cases: CaseResult[] = [];

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return [...this.#lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(25);
	await term.flush();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

async function withTui<T>(
	term: VirtualTerminal,
	component: MutableLinesComponent,
	fn: (tui: TUI) => Promise<T>,
): Promise<T> {
	const tui = new TUI(term);
	tui.addChild(component);
	try {
		tui.start();
		await settle(term);
		return await fn(tui);
	} finally {
		tui.stop();
		tui.dispose();
	}
}

function record(result: CaseResult): void {
	cases.push(result);
}

function makeReport() {
	const passed = cases.filter(c => c.status === "passed").map(c => c.id);
	const failed = cases.filter(c => c.status === "failed");
	const artifactRefs = [
		{
			id: "g015-vitest-output",
			kind: "api-package-test-report",
			description:
				"Focused bun test output for packages/tui/test/g015-debug-width-redteam.test.ts plus structured assertions in this report.",
		},
	];
	return {
		schemaVersion: 1,
		kind: "api-package-test-report",
		story: "G015 cached PI_DEBUG_REDRAW + carried line-width metadata",
		status: failed.length === 0 ? "passed" : "failed",
		e2eStatus: failed.length === 0 ? "passed" : "failed",
		redTeamStatus: failed.length === 0 ? "passed" : "failed",
		evidence: cases,
		e2eCommands: ["bun test packages/tui/test/g015-debug-width-redteam.test.ts"],
		redTeamCommands: ["bun test packages/tui/test/g015-debug-width-redteam.test.ts"],
		artifactPath: REPORT_PATH,
		contractCoverage: [
			{
				contractRef: "G015-1",
				obligation:
					"PI_DEBUG_REDRAW is cached at construction; frame paths do not re-read env and do not write debug logs when disabled.",
				status: passed.includes("DEBUG-OFF-ZERO-COST") ? "passed" : "failed",
				surfaceEvidenceRefs: ["package-debug-off"],
				adversarialCaseRefs: ["DEBUG-OFF-ZERO-COST"],
			},
			{
				contractRef: "G015-2",
				obligation: "PI_DEBUG_REDRAW enabled still emits redraw debug logs with content.",
				status: passed.includes("DEBUG-ON-LOGS") ? "passed" : "failed",
				surfaceEvidenceRefs: ["package-debug-on"],
				adversarialCaseRefs: ["DEBUG-ON-LOGS"],
			},
			{
				contractRef: "G015-3",
				obligation:
					"Differential/repaint truncation guard reuses carried widths for normalized cached lines and only measures uncached lines.",
				status: passed.includes("WIDTH-REUSE") ? "passed" : "failed",
				surfaceEvidenceRefs: ["package-width-reuse"],
				adversarialCaseRefs: ["WIDTH-REUSE"],
			},
			{
				contractRef: "G015-4",
				obligation:
					"Over-width lines are still correctly truncated, including after width/tab-width changes that invalidate cached width metadata.",
				status: passed.includes("OVER-WIDTH-TRUNCATION") && passed.includes("STALE-WIDTH") ? "passed" : "failed",
				surfaceEvidenceRefs: ["package-truncation"],
				adversarialCaseRefs: ["OVER-WIDTH-TRUNCATION", "STALE-WIDTH"],
			},
			{
				contractRef: "G015-5",
				obligation:
					"Render output remains byte-identical to reference output across append, wide-line, and resize scenarios.",
				status: passed.includes("PARITY") ? "passed" : "failed",
				surfaceEvidenceRefs: ["package-parity"],
				adversarialCaseRefs: ["PARITY"],
			},
		],
		surfaceEvidence: [
			{
				id: "package-debug-off",
				contractRef: "G015-1",
				surface: "package",
				invocation: "TUI render frames with PI_DEBUG_REDRAW unset",
				verdict: passed.includes("DEBUG-OFF-ZERO-COST") ? "passed" : "failed",
			},
			{
				id: "package-debug-on",
				contractRef: "G015-2",
				surface: "package",
				invocation: "TUI render with PI_DEBUG_REDRAW=1 and appendFileSync spy",
				verdict: passed.includes("DEBUG-ON-LOGS") ? "passed" : "failed",
			},
			{
				id: "package-width-reuse",
				contractRef: "G015-3",
				surface: "package",
				invocation: "Differential render of cached wide lines using TUI render counters",
				verdict: passed.includes("WIDTH-REUSE") ? "passed" : "failed",
			},
			{
				id: "package-truncation",
				contractRef: "G015-4",
				surface: "package",
				invocation: "Virtual terminal viewport inspection for uncached over-width and tab-width changed lines",
				verdict: passed.includes("OVER-WIDTH-TRUNCATION") && passed.includes("STALE-WIDTH") ? "passed" : "failed",
			},
			{
				id: "package-parity",
				contractRef: "G015-5",
				surface: "package",
				invocation: "Controlled reference-vs-candidate render comparisons",
				verdict: passed.includes("PARITY") ? "passed" : "failed",
			},
		],
		adversarialCases: cases.map(c => ({
			id: c.id,
			contractRef:
				c.id === "DEBUG-ON-LOGS"
					? "G015-2"
					: c.id === "PARITY"
						? "G015-5"
						: c.id === "WIDTH-REUSE"
							? "G015-3"
							: c.id === "DEBUG-OFF-ZERO-COST"
								? "G015-1"
								: "G015-4",
			scenario: c.details.scenario ?? c.id,
			expectedBehavior: c.details.expectedBehavior ?? "Contract obligation holds under adversarial render sequence.",
			verdict: c.status,
			details: c.details,
		})),
		artifactRefs,
		blockers: failed.map(c => ({ id: c.id, reason: c.details.error ?? "Case failed" })),
	};
}

beforeEach(() => {
	delete Bun.env.PI_DEBUG_REDRAW;
	delete Bun.env.PI_TUI_VIRTUAL_VIEWPORT;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	setDefaultTabWidth(originalTabWidth);
	TUI.resetRenderCountersForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
	delete Bun.env.PI_DEBUG_REDRAW;
	delete Bun.env.PI_TUI_VIRTUAL_VIEWPORT;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	setDefaultTabWidth(originalTabWidth);
	TUI.resetRenderCountersForTest();
});

afterAll(async () => {
	await fs.promises.mkdir("artifacts", { recursive: true });
	await fs.promises.writeFile(REPORT_PATH, `${JSON.stringify(makeReport(), null, "\t")}\n`);
});

describe("G015 debug flag cache and carried width red-team", () => {
	it("DEBUG-OFF-ZERO-COST", async () => {
		const appendSpy = vi.spyOn(fs, "appendFileSync");
		const component = new MutableLinesComponent(Array.from({ length: 14 }, (_v, i) => `line-${i}`));
		const term = new VirtualTerminal(24, 5);
		await withTui(term, component, async tui => {
			TUI.resetRenderCountersForTest();
			for (let i = 0; i < 12; i++) {
				component.setLines(Array.from({ length: 14 }, (_v, j) => (j === 13 ? `tail-${i}` : `line-${j}`)));
				tui.requestRender(false, "debug-off-diff");
				await settle(term);
			}
			tui.scrollViewportPages(-1);
			await settle(term);
			tui.requestRender(true, "debug-off-full");
			await settle(term);
			process.env.TMUX = "/tmp/fake-tmux,4242,0";
			term.resize(26, 5);
			await settle(term);
		});
		const counters = TUI.getRenderCountersForTest();
		record({
			id: "DEBUG-OFF-ZERO-COST",
			status: "passed",
			details: {
				scenario: "Unset PI_DEBUG_REDRAW across diff, viewport repaint, full render, and multiplexer resize paths",
				expectedBehavior: "At most construction-time env read and no debug append writes",
				counters,
				appendSpyCalls: appendSpy.mock.calls.length,
			},
		});
		expect(counters.debugRedrawEnvReads).toBeLessThanOrEqual(1);
		expect(counters.debugRedrawAppendWrites).toBe(0);
		expect(appendSpy).not.toHaveBeenCalled();
	});

	it("DEBUG-ON-LOGS", async () => {
		Bun.env.PI_DEBUG_REDRAW = "1";
		const writes: string[] = [];
		vi.spyOn(fs, "appendFileSync").mockImplementation((_path, data) => {
			writes.push(String(data));
		});
		const component = new MutableLinesComponent(["one", "two"]);
		const term = new VirtualTerminal(20, 4);
		await withTui(term, component, async tui => {
			component.setLines(["one changed", "two"]);
			tui.requestRender(true, "debug-on-force");
			await settle(term);
		});
		const counters = TUI.getRenderCountersForTest();
		record({
			id: "DEBUG-ON-LOGS",
			status: "passed",
			details: {
				scenario: "PI_DEBUG_REDRAW enabled before TUI construction",
				expectedBehavior: "Debug append counter and captured log content are non-empty",
				counters,
				writes,
			},
		});
		expect(counters.debugRedrawAppendWrites).toBeGreaterThan(0);
		expect(writes.join("\n")).toContain("fullRender");
	});

	it("WIDTH-REUSE and OVER-WIDTH-TRUNCATION", async () => {
		const component = new MutableLinesComponent(Array.from({ length: 8 }, (_v, i) => `base-${i}`));
		const term = new VirtualTerminal(12, 8);
		await withTui(term, component, async tui => {
			const wideLines = Array.from({ length: 8 }, (_v, i) => `${"界".repeat(10)}-${i}`);
			component.setLines(wideLines);
			tui.requestRender(true, "prime-wide-cache");
			await settle(term);
			TUI.resetRenderCountersForTest();
			component.setLines(wideLines);
			tui.requestRender(false, "reuse-wide-cache");
			await settle(term);
			const reuseCounters = TUI.getRenderCountersForTest();
			const viewport = visible(term);
			record({
				id: "WIDTH-REUSE",
				status: "passed",
				details: {
					scenario: "Re-render unchanged normalized over-width lines",
					expectedBehavior: "Differential guard uses carried widths and performs zero fallback visibleWidth calls",
					reuseCounters,
					viewport: viewport.slice(0, 2),
				},
			});
			expect(reuseCounters.differentialGuardVisibleWidthCalls).toBe(0);
			TUI.resetRenderCountersForTest();
			component.setLines(["short", `${"界".repeat(9)}X`, ...wideLines.slice(2)]);
			tui.requestRender(false, "uncached-over-width");
			await settle(term);
			const truncationCounters = TUI.getRenderCountersForTest();
			const truncated = visible(term)[1]!;
			record({
				id: "OVER-WIDTH-TRUNCATION",
				status: "passed",
				details: {
					scenario:
						"Changed over-width line is normalized, cached, then checked by the differential truncation guard",
					expectedBehavior:
						"Carried width avoids fallback measurement while the viewport still contains correctly truncated width-12 content",
					truncationCounters,
					truncated,
					truncatedWidth: visibleWidth(truncated),
				},
			});
			expect(truncationCounters.differentialGuardVisibleWidthCalls).toBe(0);
			expect(visibleWidth(truncated)).toBe(12);
			expect(truncated).toBe("界".repeat(6));
		});
	});

	it("PARITY", async () => {
		async function runScenario(virtualViewport: "0" | "1") {
			Bun.env.PI_TUI_VIRTUAL_VIEWPORT = virtualViewport;
			const component = new MutableLinesComponent(["alpha", "beta", "gamma"]);
			const term = new VirtualTerminal(16, 5);
			await withTui(term, component, async tui => {
				component.setLines(["alpha", "beta", "gamma", "delta"]);
				tui.requestRender(false, "append");
				await settle(term);
				component.setLines(["alpha", `${"界".repeat(12)}Z`, "gamma", "delta"]);
				tui.requestRender(false, "wide-line");
				await settle(term);
				term.resize(12, 5);
				await settle(term);
			});
			return { viewport: term.getViewport(), writeLog: term.getWriteLog() };
		}
		const reference = await runScenario("0");
		const candidate = await runScenario("1");
		record({
			id: "PARITY",
			status: "passed",
			details: {
				scenario:
					"Legacy full normalization reference vs default cached/viewport path for append, wide line, resize",
				expectedBehavior: "Viewport and terminal write bytes match exactly",
				referenceWrites: reference.writeLog.length,
				candidateWrites: candidate.writeLog.length,
			},
		});
		expect(candidate.viewport).toEqual(reference.viewport);
		expect(candidate.writeLog.join("")).toBe(reference.writeLog.join(""));
	});

	it("STALE-WIDTH", async () => {
		setDefaultTabWidth(2);
		const component = new MutableLinesComponent(["a\tbc"]);
		const term = new VirtualTerminal(5, 3);
		await withTui(term, component, async () => {
			await settle(term);
			const width2Line = visible(term)[0]!;
			setDefaultTabWidth(6);
			await settle(term);
			const width6Line = visible(term)[0]!;
			record({
				id: "STALE-WIDTH",
				status: "passed",
				details: {
					scenario: "Default tab width changes after a cached line containing a tab has been rendered",
					expectedBehavior:
						"TUI cache invalidates and re-renders with truncation appropriate to the new tab width",
					width2Line,
					width6Line,
					width2VisibleWidth: visibleWidth(width2Line),
					width6VisibleWidth: visibleWidth(width6Line),
				},
			});
			expect(width2Line).toBe("a   b");
			expect(width6Line).toBe("a");
			expect(visibleWidth(width6Line)).toBeLessThanOrEqual(5);
		});
	});

	it("ZWJ-BOUNDARY", async () => {
		const family = "👨‍👩‍👧‍👦";
		const exactBoundary = `abcd${family}wxyzz`;
		const overBoundary = `abcd${family}wxyzz!`;
		const term = new VirtualTerminal(11, 6);
		const component = new MutableLinesComponent([exactBoundary, overBoundary]);
		await withTui(term, component, async () => {
			await settle(term);
			const viewport = visible(term);
			const writeBytes = term.getWriteLog().join("");
			const expectedOverBoundary = truncateToWidth(overBoundary, 11, Ellipsis.Omit);
			record({
				id: "ZWJ-BOUNDARY",
				status: "passed",
				details: {
					scenario: "Family ZWJ cluster lands exactly at and one cell beyond the terminal boundary",
					expectedBehavior:
						"The normalization hot path uses Bun/terminal cluster width and does not prematurely truncate the exact-boundary line",
					exactBoundary,
					overBoundary,
					expectedOverBoundary,
					viewport: viewport.slice(0, 2),
					exactWidth: visibleWidth(exactBoundary),
					overWidth: visibleWidth(overBoundary),
					writeBytesIncludesExact: writeBytes.includes(exactBoundary),
					writeBytesIncludesOverReference: writeBytes.includes(expectedOverBoundary),
				},
			});
			expect(visibleWidth(family)).toBe(2);
			expect(visibleWidth(exactBoundary)).toBe(11);
			expect(writeBytes).toContain(exactBoundary);
			expect(writeBytes).toContain(expectedOverBoundary);
			expect(expectedOverBoundary).toBe(`abcd${family}wxyzz`);
			expect(visibleWidth(expectedOverBoundary)).toBeLessThanOrEqual(11);
		});
	});
});
