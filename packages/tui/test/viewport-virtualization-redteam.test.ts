import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

const FLAG = "PI_TUI_VIRTUAL_VIEWPORT";

type Mutation = (state: ScenarioState, tui: TUI, term: VirtualTerminal) => void;

interface Step {
	name: string;
	mutate: Mutation;
}

interface ScriptedScenario {
	name: string;
	initialLines: string[];
	width?: number;
	height?: number;
	steps: Step[];
}

interface ScenarioState {
	lines: string[];
}

abstract class ScriptedLines implements Component {
	protected lines: string[];

	constructor(lines: string[]) {
		this.lines = lines.slice();
	}

	setLines(lines: string[]): void {
		this.lines = lines.slice();
	}

	setLine(index: number, value: string): void {
		const next = this.lines.slice();
		next[index] = value;
		this.lines = next;
	}

	append(value: string): void {
		this.lines = [...this.lines, value];
	}

	invalidate(): void {}

	abstract render(width: number): string[];
}

class CachedLines extends ScriptedLines {
	render(_width: number): string[] {
		return this.lines;
	}
}

class FreshLines extends ScriptedLines {
	render(_width: number): string[] {
		return this.lines.map(line => `${line}`);
	}
}

function makeRows(count: number): string[] {
	return Array.from({ length: count }, (_value, index) => `line-${index}`);
}

function boundaryRows(count: number): string[] {
	return Array.from({ length: count }, (_value, index) => `boundary-${index}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(1);
	await term.flush();
}

function capture(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function applyLines(state: ScenarioState, component: ScriptedLines): void {
	component.setLines(state.lines);
}

const scenarios: ScriptedScenario[] = [
	{
		name: "rapid interleaved appends and bottom edits",
		initialLines: makeRows(48),
		steps: [
			{
				name: "append then edit new bottom line",
				mutate: state => {
					state.lines = [...state.lines, "append-A", "append-B"];
					state.lines[state.lines.length - 1] = "append-B-edited";
				},
			},
			{
				name: "edit previous bottom and append again",
				mutate: state => {
					state.lines[state.lines.length - 2] = "append-A-edited";
					state.lines = [...state.lines, "append-C"];
				},
			},
			{
				name: "burst append with newest bottom edit",
				mutate: state => {
					state.lines = [...state.lines, "append-D", "append-E", "append-F"];
					state.lines[state.lines.length - 1] = "append-F-edited";
				},
			},
		],
	},
	{
		name: "off-screen top edit without line-count change",
		initialLines: makeRows(70),
		steps: [
			{
				name: "edit first hidden line",
				mutate: state => {
					state.lines[0] = "line-0-offscreen-edited-same-count";
				},
			},
			{
				name: "edit second hidden line",
				mutate: state => {
					state.lines[1] = "line-1-offscreen-edited-same-count";
				},
			},
		],
	},
	{
		name: "edits around the virtual window boundary",
		height: 16,
		initialLines: boundaryRows(64),
		steps: [
			{
				name: "edit line at total minus height minus nine",
				mutate: state => {
					const index = state.lines.length - 16 - 9;
					state.lines[index] = `${state.lines[index]}-edited`;
				},
			},
			{
				name: "edit line at total minus height minus eight",
				mutate: state => {
					const index = state.lines.length - 16 - 8;
					state.lines[index] = `${state.lines[index]}-edited`;
				},
			},
			{
				name: "edit line at total minus height minus seven",
				mutate: state => {
					const index = state.lines.length - 16 - 7;
					state.lines[index] = `${state.lines[index]}-edited`;
				},
			},
		],
	},
	{
		name: "shrinking transcript below viewport",
		height: 18,
		initialLines: makeRows(44),
		steps: [
			{
				name: "shrink to fewer than terminal rows",
				mutate: state => {
					state.lines = ["short-0", "short-1", "short-2"];
				},
			},
			{
				name: "shrink to a single line",
				mutate: state => {
					state.lines = ["single-after-shrink"];
				},
			},
		],
	},
	{
		name: "overlay toggles while appending",
		initialLines: makeRows(36),
		steps: [
			{
				name: "show overlay after append",
				mutate: (state, tui) => {
					state.lines = [...state.lines, "overlay-append-A"];
					tui.showOverlay(new CachedLines(["overlay-one", "overlay-two"]), { anchor: "center" });
				},
			},
			{
				name: "hide overlay after append",
				mutate: (state, tui) => {
					state.lines = [...state.lines, "overlay-append-B"];
					tui.hideOverlay();
				},
			},
			{
				name: "show overlay with fresh bottom line",
				mutate: (state, tui) => {
					state.lines = [...state.lines, "overlay-append-C"];
					tui.showOverlay(new CachedLines(["overlay-three", "overlay-four"]), { anchor: "bottom-center" });
				},
			},
		],
	},
	{
		name: "width resize down then up",
		width: 48,
		initialLines: [
			"width-row-0-abcdefghijklmnopqrstuvwxyz",
			"width-row-1-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
			...makeRows(24),
		],
		steps: [
			{
				name: "resize width down",
				mutate: (_state, _tui, term) => {
					term.resize(24, term.rows);
				},
			},
			{
				name: "resize width up",
				mutate: (_state, _tui, term) => {
					term.resize(56, term.rows);
				},
			},
		],
	},
	{
		name: "height resize",
		height: 14,
		initialLines: makeRows(45),
		steps: [
			{
				name: "resize height taller",
				mutate: (_state, _tui, term) => {
					term.resize(term.columns, 20);
				},
			},
			{
				name: "resize height shorter",
				mutate: (_state, _tui, term) => {
					term.resize(term.columns, 9);
				},
			},
		],
	},
	{
		name: "wide and bang-fit truncation lines in window",
		width: 22,
		initialLines: [
			...makeRows(34),
			`wide-ascii-${"x".repeat(80)}`,
			"bang-fit-!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
			"wide-cjk-界".repeat(20),
		],
		steps: [
			{
				name: "edit wide visible tail",
				mutate: state => {
					state.lines[state.lines.length - 1] = "wide-cjk-edited-界".repeat(20);
				},
			},
			{
				name: "append additional wide bang line",
				mutate: state => {
					state.lines = [...state.lines, "new-bang-!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"];
				},
			},
		],
	},
	{
		name: "empty transcript",
		initialLines: [],
		steps: [
			{
				name: "empty rerender remains empty",
				mutate: () => {},
			},
			{
				name: "append after empty",
				mutate: state => {
					state.lines = ["after-empty"];
				},
			},
		],
	},
	{
		name: "transcript shorter than viewport",
		height: 12,
		initialLines: ["short-a", "short-b"],
		steps: [
			{
				name: "edit short transcript line",
				mutate: state => {
					state.lines[1] = "short-b-edited";
				},
			},
			{
				name: "append but remain shorter than viewport",
				mutate: state => {
					state.lines = [...state.lines, "short-c"];
				},
			},
		],
	},
];

async function runScenario(
	scenario: ScriptedScenario,
	componentFactory: (lines: string[]) => ScriptedLines,
	flagOn: boolean,
): Promise<string[][]> {
	Bun.env[FLAG] = flagOn ? "1" : "0";

	const term = new VirtualTerminal(scenario.width ?? 40, scenario.height ?? 12);
	const tui = new TUI(term);
	const component = componentFactory(scenario.initialLines);
	const state: ScenarioState = { lines: scenario.initialLines.slice() };
	const snapshots: string[][] = [];
	tui.addChild(component);

	try {
		tui.start();
		await settle(term);
		snapshots.push(capture(term));

		for (const step of scenario.steps) {
			step.mutate(state, tui, term);
			applyLines(state, component);
			tui.requestRender();
			await settle(term);
			snapshots.push(capture(term));
		}
	} finally {
		tui.stop();
	}

	return snapshots;
}

describe("virtual viewport byte-identity red-team scenarios", () => {
	let previousFlag: string | undefined;
	let previousTmux: string | undefined;
	let monotonicNow = 0;

	beforeEach(() => {
		previousFlag = Bun.env[FLAG];
		previousTmux = Bun.env.TMUX;
		delete Bun.env.TMUX;
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousFlag === undefined) delete Bun.env[FLAG];
		else Bun.env[FLAG] = previousFlag;
		if (previousTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = previousTmux;
	});

	for (const scenario of scenarios) {
		it(`${scenario.name} with stable cached line instances`, async () => {
			const off = await runScenario(scenario, lines => new CachedLines(lines), false);
			const on = await runScenario(scenario, lines => new CachedLines(lines), true);
			expect(on).toEqual(off);
		});

		it(`${scenario.name} with fresh line instances`, async () => {
			const off = await runScenario(scenario, lines => new FreshLines(lines), false);
			const on = await runScenario(scenario, lines => new FreshLines(lines), true);
			expect(on).toEqual(off);
		});
	}
});
