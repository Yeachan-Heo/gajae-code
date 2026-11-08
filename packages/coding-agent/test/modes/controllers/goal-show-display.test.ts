import { describe, expect, it } from "bun:test";
import { Text } from "@gajae-code/tui";
import fc from "fast-check";
import type { Goal } from "../../../src/goals/state";
import { GoalModeController } from "../../../src/modes/controllers/goal-mode-controller";
import { ModeGate } from "../../../src/modes/controllers/mode-gate";
import type { AgentSession } from "../../../src/session/agent-session";
import type { SessionContext, SessionManager } from "../../../src/session/session-manager";

const ESC = "\u001b";
const BEL = "\u0007";
const OSC52 = `${ESC}]52;c;cGF5bG9hZA==${BEL}`;
const OSC0 = `${ESC}]0;pwned-title${BEL}`;
const OSC8 = `${ESC}]8;;https://attacker.invalid/track${BEL}`;
const OSC8_END = `${ESC}]8;;${BEL}`;
const ERASE_LINE = `${ESC}[2K`;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** Same erase-only J/K class as the TUI frame filter. OSC is left in place. */
function stripEraseJk(bytes: string): string {
	return bytes.replace(/\u001b\[[0-?]*[ -/]*[JK]/g, "").replace(/\u009b[0-?]*[ -/]*[JK]/g, "");
}

/** Same control class as the goal status display. U+FFFD and lone surrogates stay. */
function visibleObjective(text: string): string {
	const re = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
	if (re.exec(text) === null) return text;
	const stripped = text.includes("\u001b") ? Bun.stripANSI(text) : text;
	re.lastIndex = 0;
	return stripped.replace(re, "");
}

function paintStatus(message: string): string {
	const rendered = `\u001b[2m${message}\u001b[39m`;
	return new Text(rendered, 1, 0).render(240).map(stripEraseJk).join("\n");
}

function goalRecord(objective: string): Goal {
	return {
		id: "g1",
		objective,
		status: "active",
		tokensUsed: 12,
		timeUsedSeconds: 3,
		createdAt: 1,
		updatedAt: 2,
	};
}

function harness(objective: string) {
	let stored: { goal?: Goal } | undefined;
	const statuses: string[] = [];
	const titles: string[] = [];
	const session = {
		settings: { get: (key: string) => key === "goal.enabled" },
		setGoalModeState(next: { goal?: Goal } | undefined) {
			stored = next;
		},
		getGoalModeState() {
			return stored;
		},
	} as unknown as AgentSession;
	const controller = new GoalModeController({
		session,
		sessionManager: {} as SessionManager,
		modeGate: new ModeGate(),
		get planModeActive() {
			return false;
		},
		get inputCallback() {
			return undefined;
		},
		get hasPendingSubmission() {
			return false;
		},
		get hasPendingImages() {
			return false;
		},
		get editorText() {
			return "";
		},
		startPendingSubmission() {
			throw new Error("goal show must not submit");
		},
		showStatus(message) {
			statuses.push(message);
		},
		showWarning() {},
		showError(message) {
			throw new Error(message);
		},
		async showHookConfirm() {
			return false;
		},
		async showHookSelector(title) {
			titles.push(title);
			return undefined;
		},
		async showHookEditor() {
			return undefined;
		},
		updateGoalModeStatus() {},
	});
	const sessionContext = {
		mode: "goal",
		modeData: { goal: goalRecord(objective) },
		messages: [],
		models: {},
		configuredModelChains: {},
		injectedTtsrRules: [],
		selectedMCPToolNames: [],
		hasPersistedMCPToolSelection: false,
	} as SessionContext;
	return { controller, sessionContext, statuses, titles, stored: () => stored };
}

async function showGoal(objective: string) {
	const opened = harness(objective);
	const restored = await opened.controller.restoreFromSession(opened.sessionContext, { recoveryHydration: true });
	await opened.controller.handleCommand("show");
	return { ...opened, restored, status: opened.statuses.at(-1) ?? "" };
}

async function openMenu(objective: string) {
	const opened = harness(objective);
	await opened.controller.restoreFromSession(opened.sessionContext, { recoveryHydration: true });
	await opened.controller.handleCommand();
	return opened;
}

const ATTACK = `Ship ${OSC52}${OSC0}${OSC8}click${OSC8_END}${ERASE_LINE} the release`;

describe("goal show display", () => {
	it("paints a restored objective without OSC through /goal show", async () => {
		const opened = await showGoal(ATTACK);
		expect(opened.restored).toBe(true);
		expect(opened.stored()?.goal?.objective).toBe(ATTACK);
		const painted = paintStatus(opened.status);
		expect(painted).not.toContain(`${ESC}]52`);
		expect(painted).not.toContain(`${ESC}]0`);
		expect(painted).not.toContain(`${ESC}]8`);
		expect(painted).toContain("Ship");
		expect(painted).toContain("click");
		expect(painted).toContain("the release");
		expect(opened.status).not.toMatch(CONTROL_RE);
	});

	it("keeps OSC after the erase-only J/K filter and drops CSI 2K", () => {
		const painted = paintStatus(`before${ERASE_LINE}${OSC52}after`);
		expect(painted).not.toContain("[2K");
		expect(painted).toContain(`${ESC}]52`);
		expect(painted).toContain("before");
		expect(painted).toContain("after");
	});

	it("keeps surrounding spaces, a newline, a tab, and ordinary unicode", async () => {
		const spaced = "  Ship the release  ";
		const spacedShow = await showGoal(spaced);
		expect(spacedShow.status).toContain(`Objective: ${spaced}\nStatus:`);
		expect(spacedShow.stored()?.goal?.objective).toBe(spaced);
		expect((await openMenu(spaced)).titles[0]).toBe(`Goal: ${spaced} (active)`);

		const lines = "Line one\nLine two";
		expect((await showGoal(lines)).status).toContain(`Objective: ${lines}\nStatus:`);
		expect((await openMenu(lines)).titles[0]).toBe(`Goal: ${lines} (active)`);

		const tabbed = "Ship\tthe release";
		expect((await showGoal(tabbed)).status).toContain(`Objective: ${tabbed}\nStatus:`);

		const unicode = "배송 목표";
		expect((await showGoal(unicode)).status).toContain(`Objective: ${unicode}\nStatus:`);
		expect((await openMenu(unicode)).titles[0]).toBe(`Goal: ${unicode} (active)`);

		const marked = "\u202EShip the release";
		expect((await showGoal(marked)).status).toContain(`Objective: ${marked}\nStatus:`);

		const clean = `Keep ${"x".repeat(70)}`;
		expect((await openMenu(clean)).titles[0]).toBe(`Goal: ${clean.slice(0, 47)}… (active)`);
	});

	it("clips the menu title after controls are removed", async () => {
		const cut = `${"A".repeat(10)}${OSC52}${"B".repeat(50)}`;
		const visible = visibleObjective(cut);
		const summary = visible.length > 48 ? `${visible.slice(0, 47)}…` : visible;
		const title = (await openMenu(cut)).titles[0] ?? "";
		expect(title).toBe(`Goal: ${summary} (active)`);
		expect(title).not.toContain(ESC);
		expect(title).toContain("A".repeat(10));
	});

	it("keeps a replacement character next to a lone surrogate", async () => {
		const objective = "Keep \uFFFD marker \uD800";
		const shown = await showGoal(objective);
		expect(shown.restored).toBe(true);
		expect(shown.stored()?.goal?.objective).toBe(objective);
		expect(shown.status).toContain("Objective: Keep \uFFFD marker \uD800\nStatus:");
		const title = (await openMenu(objective)).titles[0] ?? "";
		expect(title).toBe("Goal: Keep \uFFFD marker \uD800 (active)");
		expect(title).toContain("\uFFFD");
	});

	it("property: goal show drops terminal controls, fc.property seed 694, numRuns 64", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.string({ maxLength: 60, unit: "binary" }),
				fc.constantFrom("", "\uFFFD", "\uD800", "\uFFFD\uD800"),
				async (binary, marker) => {
					const objective = `${marker}${binary}`;
					const opened = await showGoal(objective);
					const visible = visibleObjective(objective);
					const status = opened.status;
					const preserved = visible === objective ? status.includes(`Objective: ${objective}\nStatus:`) : true;
					return (
						status.startsWith(`Objective: ${visible}\nStatus:`) &&
						!CONTROL_RE.test(status) &&
						opened.stored()?.goal?.objective === objective &&
						preserved &&
						(marker === "" || status.includes(marker))
					);
				},
			),
			{ seed: 694, numRuns: 64 },
		);
	});
});
