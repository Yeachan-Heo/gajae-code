import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Container, renderMetrics, Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import {
	__ircSidebarPerfCounters,
	type IrcSidebarTheme,
	IrcSplitViewComponent,
} from "../src/modes/components/irc-sidebar";
import { __ircLedgerPerfCounters, IrcObservationLedger } from "../src/modes/irc-observation-ledger";

const SCHEMA_VERSION = 1;
const WIDTH = 80;
const HEIGHTS = [1, 3, 10] as const;
const TRANSCRIPT_ROWS = [10_000, 100_000] as const;
const STICKY_SUFFIX_WORKLOAD_NAMES = [
	"sticky-suffix-10000-rows-height-1",
	"sticky-suffix-10000-rows-height-3",
	"sticky-suffix-10000-rows-height-10",
	"sticky-suffix-100000-rows-height-1",
	"sticky-suffix-100000-rows-height-3",
	"sticky-suffix-100000-rows-height-10",
] as const;

const stickySuffixMatrix = TRANSCRIPT_ROWS.flatMap(transcriptRows =>
	HEIGHTS.map(height => ({
		transcriptRows,
		height,
		name: `sticky-suffix-${transcriptRows}-rows-height-${height}`,
	})),
);

function assertStickySuffixMatrix(): void {
	const names = stickySuffixMatrix.map(workload => workload.name);
	if (JSON.stringify(names) !== JSON.stringify(STICKY_SUFFIX_WORKLOAD_NAMES))
		throw new Error("sticky suffix workload matrix changed");
}

const sidebarTheme = {
	fg: (_color: "dim" | "accent", text: string) => text,
	bold: (text: string) => text,
	boxSharp: { vertical: "|" },
} satisfies IrcSidebarTheme;

type HardCounters = Readonly<Record<string, number | boolean>>;
type WorkloadResult = Readonly<{ name: string; hard: HardCounters; advisory: Record<string, number> }>;
export type StickyViewportPr1Benchmark = Readonly<{
	schemaVersion: number;
	workloads: readonly WorkloadResult[];
	advisory: {
		readonly timingAndMemoryOnly: true;
		readonly wallMs: number;
		readonly cpuUserMicros: number;
		readonly cpuSystemMicros: number;
		readonly rssBytes: number;
	};
}>;

function rows(count: number, prefix: string): Text[] {
	return Array.from({ length: count }, (_, index) => new Text(`${prefix}-${index}`, 0, 0));
}

async function settle(terminal: VirtualTerminal): Promise<void> {
	await terminal.waitForRender();
	await Promise.resolve();
}

async function stickySuffixWorkload(transcriptRows: number, height: number): Promise<WorkloadResult> {
	renderMetrics.reset();
	const terminal = new VirtualTerminal(WIDTH, height, { isProcessTerminal: true });
	const tui = new TUI(terminal);
	const transcript = new Container();
	for (const row of rows(transcriptRows, "transcript")) transcript.addChild(row);
	const status = new Text("status: pinned", 0, 0);
	const suffix = Array.from({ length: height + 3 }, (_value, index) => new Text(`suffix-${index}`, 0, 0));
	tui.addChild(transcript);
	tui.addChild(status);
	for (const row of suffix) tui.addChild(row);
	tui.setBottomPinnedComponent(status);
	const flatFrameRows = transcriptRows + suffix.length + 1;
	const originalSlice = Array.prototype.slice;
	let flatFrameSlices = 0;
	let negativeControlSlices = 0;
	const isLargeFlatFrame = (receiver: unknown[]): boolean =>
		receiver.length === flatFrameRows &&
		receiver[0] === "transcript-0" &&
		receiver[transcriptRows - 1] === `transcript-${transcriptRows - 1}`;
	try {
		Array.prototype.slice = function <T>(this: T[], start?: number, end?: number): T[] {
			if (isLargeFlatFrame(this)) flatFrameSlices++;
			return originalSlice.call(this, start, end);
		};
		const negativeControl = Array.from({ length: flatFrameRows }, (_value, index) =>
			index < transcriptRows ? `transcript-${index}` : "suffix",
		);
		negativeControl.slice(0, 1);
		negativeControlSlices = flatFrameSlices;
		flatFrameSlices = 0;
		tui.start();
		await settle(terminal);
		const structural = renderMetrics.snapshot().structuralCounters;
		const selected = structural.pinnedSuffixSelectedRows ?? 0;
		const overflowFrames = structural.pinnedSuffixOverflowFrames ?? 0;
		if (flatFrameSlices !== 0) throw new Error("pinned suffix sliced the large transcript frame");
		if (negativeControlSlices !== 1) throw new Error("large-frame slice detector did not count its negative control");
		if (selected > height) throw new Error("pinned suffix selected rows exceed terminal height");
		if (overflowFrames !== 1 || selected === 0) throw new Error("pinned suffix overflow workload did not execute");
		return {
			name: `sticky-suffix-${transcriptRows}-rows-height-${height}`,
			hard: {
				largeFlatFrameSliceCalls: flatFrameSlices,
				pinnedSuffixOverflowFrames: overflowFrames,
				pinnedSuffixSelectedRows: selected,
			},
			advisory: { renderCount: renderMetrics.snapshot().renderCount },
		};
	} finally {
		Array.prototype.slice = originalSlice;
		tui.stop();
	}
}

async function equalOutputSourceWorkload(): Promise<WorkloadResult> {
	renderMetrics.reset();
	const terminal = new VirtualTerminal(WIDTH, 10);
	const tui = new TUI(terminal);
	try {
		tui.addChild(new Text("output", 0, 0));
		tui.setViewportOutputSource({ identity: "pr1-equal", revision: 1n });
		tui.start();
		await settle(terminal);
		const before = renderMetrics.snapshot().renderCount;
		for (let index = 0; index < 1_000; index++) tui.setViewportOutputSource({ identity: "pr1-equal", revision: 1n });
		await Promise.resolve();
		const snapshot = renderMetrics.snapshot();
		const equalNoops = snapshot.structuralCounters.viewportOutputSourceEqualNoops ?? 0;
		if (snapshot.renderCount !== before || equalNoops !== 1_000)
			throw new Error("equal output source requested a render");
		return {
			name: "equal-output-source-1000",
			hard: { equalNoops, renderRequests: snapshot.renderCount - before },
			advisory: {},
		};
	} finally {
		tui.stop();
	}
}

function addObservation(ledger: IrcObservationLedger, id: string): void {
	ledger.observe(
		{ observationId: id, kind: "incoming", from: "peer", to: "you", text: `observation ${id}`, timestamp: 0 },
		false,
	);
}

function sidebarCacheWorkload(): WorkloadResult {
	__ircSidebarPerfCounters.reset();
	__ircSidebarPerfCounters.enable();
	__ircLedgerPerfCounters.reset();
	__ircLedgerPerfCounters.enable();
	const ledger = new IrcObservationLedger();
	for (let index = 0; index < 9_999; index++) addObservation(ledger, `history-${index}`);
	const split = new IrcSplitViewComponent(new Text("left pane", 0, 0), ledger, sidebarTheme);
	split.setVisible(true);
	for (let index = 0; index < 100; index++) split.render(WIDTH);
	const stable = __ircSidebarPerfCounters.snapshot();
	addObservation(ledger, "mutation");
	split.render(WIDTH);
	const final = __ircSidebarPerfCounters.snapshot();
	const ledgerCounters = __ircLedgerPerfCounters.snapshot();
	if (stable.projectionMemoMisses !== 1 || stable.styledCacheMisses !== 1 || stable.wrapCalls === 0)
		throw new Error("unchanged sidebar did not reuse caches");
	if (stable.projectionMemoHits !== 99 || stable.styledCacheHits !== 99)
		throw new Error("unchanged sidebar cache counts changed");
	if (final.wrapCalls <= stable.wrapCalls || final.projectionMemoMisses !== 2 || final.styledCacheMisses !== 2)
		throw new Error("sidebar mutation did not reproject once");
	return {
		name: "irc-sidebar-near-cap-cache",
		hard: {
			ledgerEpochAdvances: ledgerCounters.epochAdvances,
			unchangedProjectionMisses: stable.projectionMemoMisses,
			unchangedProjectionHits: stable.projectionMemoHits,
			unchangedStyledMisses: stable.styledCacheMisses,
			unchangedStyledHits: stable.styledCacheHits,
			unchangedWrapCalls: stable.wrapCalls,
			mutationProjectionMisses: final.projectionMemoMisses,
			mutationStyledMisses: final.styledCacheMisses,
			mutationWrapCalls: final.wrapCalls,
		},
		advisory: {},
	};
}

export async function runStickyViewportPr1Benchmark(): Promise<StickyViewportPr1Benchmark> {
	const cpu = process.cpuUsage();
	const started = performance.now();
	const wasEnabled = renderMetrics.enabled;
	renderMetrics.enable();
	try {
		assertStickySuffixMatrix();
		const workloads: WorkloadResult[] = [];
		for (const workload of stickySuffixMatrix)
			workloads.push(await stickySuffixWorkload(workload.transcriptRows, workload.height));
		workloads.push(await equalOutputSourceWorkload(), sidebarCacheWorkload());
		const usage = process.cpuUsage(cpu);
		return {
			schemaVersion: SCHEMA_VERSION,
			workloads,
			advisory: {
				timingAndMemoryOnly: true,
				wallMs: performance.now() - started,
				cpuUserMicros: usage.user,
				cpuSystemMicros: usage.system,
				rssBytes: process.memoryUsage().rss,
			},
		};
	} finally {
		renderMetrics.reset();
		__ircSidebarPerfCounters.disable();
		__ircLedgerPerfCounters.disable();
		if (!wasEnabled) renderMetrics.disable();
	}
}

function outputPath(args: readonly string[]): string | undefined {
	const index = args.indexOf("--out");
	if (index < 0 || !args[index + 1]) return undefined;
	return args[index + 1];
}

if (import.meta.main) {
	const benchmark = await runStickyViewportPr1Benchmark();
	const output = `${JSON.stringify(benchmark, null, 2)}\n`;
	const destination = outputPath(process.argv.slice(2));
	if (destination) {
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await Bun.write(destination, output);
	} else process.stdout.write(output);
}
