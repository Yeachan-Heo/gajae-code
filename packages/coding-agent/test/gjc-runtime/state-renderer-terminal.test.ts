import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { modeStatePath, sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { renderUltragoalStatusMarkdown as renderPublicUltragoalStatus } from "@gajae-code/coding-agent/gjc-runtime/state-renderer";
import { sanitizeDisplayLine, sanitizeText } from "@gajae-code/utils";
import fc from "fast-check";
import {
	buildStateStatusSummary,
	renderContractMarkdown,
	renderHistoryMarkdown,
	renderStateMarkdown,
	renderStateStatusLine,
	renderUltragoalStatusMarkdown,
} from "../../src/gjc-runtime/state-renderer";
import { runNativeStateCommand } from "../../src/gjc-runtime/state-runtime";
import { runNativeUltragoalCommand } from "../../src/gjc-runtime/ultragoal-runtime";
import type { SkillManifest, WorkflowTransition } from "../../src/gjc-runtime/workflow-manifest";

const SESSION = "term-session";
const OSC52 = "\u001b]52;c;cHduZWQtY2xpcGJvYXJk\u0007";
const OSC0 = "\u001b]0;spoofed-title\u0007";
const CSI = "\u001b[2J";
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
const PROPERTY_SEED = 638;
const PROPERTY_RUNS = 64;
// Status sanitizers have no length cap. Every sample runs at N and at 2N.
// Elapsed time is the work check. Output length is only a size cap.
const BOUND_N = 256 * 1024;
const BOUND_MS = 2000;
const BOUND_SLACK_MS = 50;

function sized(unit: string, units: number): string {
	return unit.repeat(Math.ceil(units / unit.length)).slice(0, units);
}

function exactRepeat(unit: string, units: number): string {
	return unit.repeat(Math.floor(units / unit.length));
}

/** OSC 52 with a payload and no BEL or ST terminator. */
function openOsc(units: number): string {
	const prefix = "\u001b]52;c;";
	return prefix + "A".repeat(Math.max(0, units - prefix.length));
}

/** One CSI introducer and parameter digits. No final byte in 0x40-0x7E. */
function openCsi(units: number): string {
	return `\u001b[${"1".repeat(Math.max(0, units - 2))}`;
}

function renderPhase(input: string): string {
	return renderStateMarkdown("ultragoal", { current_phase: input }, manifestFor([]));
}

function renderGoal(input: string): string {
	return renderUltragoalStatusMarkdown({
		exists: true,
		status: input,
		paths: { goalsPath: "goals.json" },
		gjcObjective: input,
		currentGoal: { id: "g1", status: "pending" },
		counts: { pending: 1 },
		goals: [{}],
	});
}

function renderLine(input: string): string {
	return renderStateStatusLine({
		skill: "ultragoal",
		phase: input,
		active: true,
		fresh: false,
		next: ["active"],
		receipt_status: "fresh",
		storage_path: "state.json",
	});
}

function expectScale(make: (units: number) => string, render: (input: string) => string, copies: number): void {
	const small = make(BOUND_N);
	const large = make(BOUND_N * 2);
	expect(small.length).toBeGreaterThan(BOUND_N - 16);
	expect(large.length).toBeGreaterThan(BOUND_N * 2 - 16);
	render(make(64));
	const smallStarted = performance.now();
	const smallText = render(small);
	const smallMs = performance.now() - smallStarted;
	const largeStarted = performance.now();
	const largeText = render(large);
	const largeMs = performance.now() - largeStarted;
	expect(smallMs).toBeLessThan(BOUND_MS);
	expect(largeMs).toBeLessThan(BOUND_MS);
	// 2N is about twice the work when the scan is linear. A much larger jump fails.
	// The slack covers a short timer spike. Output length is not this check.
	expect(largeMs).toBeLessThan(smallMs * 3 + BOUND_SLACK_MS);
	expect(smallText.length).toBeLessThanOrEqual(small.length * copies + 800);
	expect(largeText.length).toBeLessThanOrEqual(large.length * copies + 800);
	assertNoTerminalControls(smallText);
	assertNoTerminalControls(largeText);
}

function assertNoTerminalControls(text: string | undefined): void {
	expect(text).toBeDefined();
	expect(CONTROL.test(text ?? "")).toBe(false);
}

function manifestFor(transitions: WorkflowTransition[]): SkillManifest {
	return {
		skill: "ultragoal",
		states: [],
		initialState: "pending",
		terminalStates: [],
		transitions,
		verbs: [],
		typedArgs: [],
		retention: [],
		hudFields: [],
		graphLabel: "ultragoal",
		stopReleasingPhases: [],
		phaseLock: [],
		canonicalOverrides: [],
	};
}

function nextTransitionLine(rendered: string): string | undefined {
	const marker = "\n- Valid next transitions: ";
	const idx = rendered.lastIndexOf(marker);
	if (idx < 0) return undefined;
	const start = idx + 1;
	const end = rendered.indexOf("\n", start);
	return rendered.slice(start, end === -1 ? undefined : end);
}

const attackChunk = fc.constantFrom(
	"\u001b]52;c;cGF5bG9hZA==\u0007",
	"\u001b]0;title\u0007",
	"\u001b[2J",
	"\u001b[2K",
	"\u009d52;c;cGF5bG9hZA==\u0007",
	"\u0000",
	"\u0007",
	"\u007f",
	"\u202e",
	"\r\n",
	"\n",
);
const noisy = fc
	.tuple(fc.string({ minLength: 0, maxLength: 8 }), attackChunk, fc.string({ minLength: 0, maxLength: 8 }))
	.map(([left, attack, right]) => `${left}${attack}${right}`);
const plain = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 .,_:-]{0,16}$/);

async function withSession(fn: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "state-terminal-"));
	const prior = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = SESSION;
	try {
		await fn(cwd);
	} finally {
		if (prior === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = prior;
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

async function plantState(cwd: string, state: Record<string, unknown>): Promise<void> {
	const file = modeStatePath(cwd, SESSION, "ultragoal");
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(state));
}

async function plantGoals(cwd: string, plan: Record<string, unknown>): Promise<void> {
	const dir = sessionUltragoalDir(cwd, SESSION);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "goals.json"), JSON.stringify(plan));
}

describe("state terminal text", () => {
	it("state read strips OSC and CSI from a planted phase, receipt, and artifact", async () => {
		await withSession(async cwd => {
			await plantState(cwd, {
				skill: "ultragoal",
				active: true,
				current_phase: `pending${OSC52}${CSI}`,
				updated_at: "2026-01-01T00:00:00.000Z",
				receipt: {
					status: `fresh${OSC0}`,
					mutation_id: `m1${OSC52}`,
					fresh_until: "2026-01-01T00:00:00.000Z",
				},
				artifact_path: `notes/out${OSC52}`,
			});
			const read = await runNativeStateCommand(["read", "--mode", "ultragoal"], cwd);
			expect(read.status).toBe(0);
			assertNoTerminalControls(read.stdout);
			expect(read.stdout).toContain("Current phase: pending");
			expect(read.stdout).toContain("Receipt: fresh");
			expect(read.stdout).toContain("mutation_id: m1");
			expect(read.stdout).toContain("notes/out");
		});
	});

	it("state read prints a compact elision count and drops entry text", async () => {
		await withSession(async cwd => {
			await plantState(cwd, {
				skill: "ultragoal",
				active: true,
				current_phase: "pending",
				rounds: [`note${OSC52}${CSI}`, "plain-round"],
			});
			const read = await runNativeStateCommand(["read", "--mode", "ultragoal"], cwd);
			expect(read.status).toBe(0);
			assertNoTerminalControls(read.stdout);
			expect(read.stdout).toContain("  - rounds: 2 entries (elided)");
			expect(read.stdout).not.toContain("plain-round");
			expect(read.stdout).not.toContain("cHdu");
		});
	});

	it("state read keeps a plain compact elision count", async () => {
		await withSession(async cwd => {
			await plantState(cwd, {
				skill: "ultragoal",
				active: true,
				current_phase: "pending",
				rounds: ["alpha"],
			});
			const read = await runNativeStateCommand(["read", "--mode", "ultragoal"], cwd);
			expect(read.status).toBe(0);
			expect(read.stdout).toContain("  - rounds: 1 entries (elided)");
			expect(read.stdout).toContain("Current phase: pending");
		});
	});

	it("state read matches transitions on the stored phase, not the stripped text", async () => {
		await withSession(async cwd => {
			await plantState(cwd, { skill: "ultragoal", active: true, current_phase: "pen\u0000ding" });
			const read = await runNativeStateCommand(["read", "--mode", "ultragoal"], cwd);
			expect(read.status).toBe(0);
			assertNoTerminalControls(read.stdout);
			expect(read.stdout).toContain("Current phase: pending");
			expect(read.stdout).toContain("Valid next transitions: none");
		});
	});

	it("state status strips OSC from a planted phase", async () => {
		await withSession(async cwd => {
			await plantState(cwd, { skill: "ultragoal", active: true, current_phase: `pending${OSC52}` });
			const status = await runNativeStateCommand(["status", "--mode", "ultragoal"], cwd);
			expect(status.status).toBe(0);
			assertNoTerminalControls(status.stdout);
			expect(status.stdout).toContain("phase=pending");
		});
	});

	it("state status flattens a break in the phase row", async () => {
		await withSession(async cwd => {
			await plantState(cwd, { skill: "ultragoal", active: true, current_phase: "pending\nactive" });
			const status = await runNativeStateCommand(["status", "--mode", "ultragoal"], cwd);
			expect(status.status).toBe(0);
			expect(status.stdout).toBe("ultragoal: phase=pending active stale next=none\n");
		});
	});

	it("ultragoal status strips OSC from a planted objective and goal id", async () => {
		await withSession(async cwd => {
			await plantGoals(cwd, {
				version: 1,
				gjcObjective: `Ship the status text${OSC52}`,
				goals: [{ id: `G001${OSC0}`, title: "Title", objective: "Do the work", status: "pending" }],
			});
			const status = await runNativeUltragoalCommand(["status"], cwd);
			expect(status.status).toBe(0);
			assertNoTerminalControls(status.stdout);
			expect(status.stdout).toContain("- objective: Ship the status text");
			expect(status.stdout).toContain("- current: G001 (pending)");
		});
	});

	it("state read keeps a plain phase, receipt, and artifact path", async () => {
		await withSession(async cwd => {
			await plantState(cwd, {
				skill: "ultragoal",
				active: true,
				current_phase: "pending",
				updated_at: "2026-01-01T00:00:00.000Z",
				receipt: { status: "fresh", mutation_id: "m1", fresh_until: "2099-01-01T00:00:00.000Z" },
				artifact_path: "notes/plan.md",
			});
			const read = await runNativeStateCommand(["read", "--mode", "ultragoal"], cwd);
			expect(read.status).toBe(0);
			expect(read.stdout).toContain("Current phase: pending");
			expect(read.stdout).toContain("Valid next transitions: active, handoff");
			expect(read.stdout).toContain("Receipt: fresh");
			expect(read.stdout).toContain("mutation_id: m1");
			expect(read.stdout).toContain("notes/plan.md");
		});
	});

	it("state read keeps a line break in the phase prose", async () => {
		await withSession(async cwd => {
			await plantState(cwd, { skill: "ultragoal", active: true, current_phase: "pending\nactive" });
			const read = await runNativeStateCommand(["read", "--mode", "ultragoal"], cwd);
			expect(read.status).toBe(0);
			expect(read.stdout).toContain("Current phase: pending\nactive");
		});
	});

	it("state status keeps a plain phase and its next labels", async () => {
		await withSession(async cwd => {
			await plantState(cwd, { skill: "ultragoal", active: true, current_phase: "pending" });
			const status = await runNativeStateCommand(["status", "--mode", "ultragoal"], cwd);
			expect(status.status).toBe(0);
			expect(status.stdout).toBe("ultragoal: phase=pending stale next=active,handoff\n");
		});
	});

	it("state status json keeps the stored phase", async () => {
		await withSession(async cwd => {
			const phase = `pending${OSC52}`;
			await plantState(cwd, { skill: "ultragoal", active: true, current_phase: phase });
			const status = await runNativeStateCommand(["status", "--mode", "ultragoal", "--json"], cwd);
			expect(status.status).toBe(0);
			const parsed = JSON.parse(status.stdout ?? "{}") as { phase?: string };
			expect(parsed.phase).toBe(phase);
		});
	});

	it("ultragoal status keeps a plain objective and goal id", async () => {
		await withSession(async cwd => {
			await plantGoals(cwd, {
				version: 1,
				gjcObjective: "Ship the status text",
				goals: [{ id: "G001", title: "Title", objective: "Do the work", status: "pending" }],
			});
			const status = await runNativeUltragoalCommand(["status"], cwd);
			expect(status.status).toBe(0);
			expect(status.stdout).toContain("- status: pending");
			expect(status.stdout).toContain("- objective: Ship the status text");
			expect(status.stdout).toContain("- current: G001 (pending)");
			expect(status.stdout).toContain("goals.json");
		});
	});

	it("ultragoal status keeps a line break in the objective", async () => {
		await withSession(async cwd => {
			await plantGoals(cwd, {
				version: 1,
				gjcObjective: "Ship the status text\nand the follow-up",
				goals: [{ id: "G001", title: "Title", objective: "Do the work", status: "pending" }],
			});
			const status = await runNativeUltragoalCommand(["status"], cwd);
			expect(status.status).toBe(0);
			expect(status.stdout).toContain("- objective: Ship the status text\nand the follow-up");
		});
	});

	it("public renderer strips OSC, CSI, breaks, and bidi from a counts key", () => {
		const key = `custom${OSC52}${CSI}\n\u202e`;
		const summary = {
			exists: true,
			status: "pending",
			paths: { goalsPath: "goals.json" },
			counts: { [key]: 3 },
			goals: [{}, {}, {}],
		};
		const before = structuredClone(summary);
		const rendered = renderPublicUltragoalStatus(summary);
		expect(summary).toEqual(before);
		const goalsLine = rendered.split("\n").find(line => line.startsWith("- goals: "));
		expect(goalsLine).toBe(`- goals: 3 (${sanitizeDisplayLine(key)}=3)`);
		expect(CONTROL.test(rendered)).toBe(false);
		expect(rendered).not.toContain("\u202e");
	});

	it("public renderer keeps a plain custom counts key", () => {
		const rendered = renderPublicUltragoalStatus({
			exists: true,
			status: "pending",
			paths: { goalsPath: "goals.json" },
			counts: { "needs-review": 2 },
			goals: [{}, {}],
		});
		expect(rendered).toContain("- goals: 2 (needs-review=2)");
	});

	it("ultragoal status json keeps the stored objective", async () => {
		await withSession(async cwd => {
			const objective = `Ship the status text${OSC52}`;
			await plantGoals(cwd, {
				version: 1,
				gjcObjective: objective,
				goals: [{ id: "G001", title: "Title", objective: "Do the work", status: "pending" }],
			});
			const status = await runNativeUltragoalCommand(["status", "--json"], cwd);
			expect(status.status).toBe(0);
			const parsed = JSON.parse(status.stdout ?? "{}") as { gjcObjective?: string };
			expect(parsed.gjcObjective).toBe(objective);
		});
	});

	it("state contract keeps the skill heading", async () => {
		await withSession(async cwd => {
			const result = await runNativeStateCommand(["contract", "--mode", "ultragoal"], cwd);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("# ultragoal state contract");
		});
	});

	it("contract text strips a control from a string field", () => {
		const text = renderContractMarkdown("ultragoal", { note: `ok${OSC52}` });
		assertNoTerminalControls(text);
		expect(text).toContain("- note: ok");
	});

	it("contract text keeps a plain string field", () => {
		const text = renderContractMarkdown("ultragoal", { note: "operator note" });
		expect(text).toContain("- note: operator note");
	});

	it("history text strips a control from an audit verb", () => {
		const text = renderHistoryMarkdown({
			entries: [{ ts: "2026-01-01T00:00:00.000Z", skill: "ultragoal", verb: `write${OSC0}` }],
			limit: 10,
			truncated: false,
		});
		assertNoTerminalControls(text);
		expect(text).toContain("- 2026-01-01T00:00:00.000Z ultragoal write");
	});

	it("history text keeps a plain audit row", () => {
		const text = renderHistoryMarkdown({
			entries: [{ ts: "2026-01-01T00:00:00.000Z", skill: "ultragoal", verb: "write" }],
			limit: 10,
			since: "2026-01-01T00:00:00.000Z",
			truncated: false,
		});
		expect(text).toContain("- since: 2026-01-01T00:00:00.000Z");
		expect(text).toContain("- 2026-01-01T00:00:00.000Z ultragoal write");
	});

	it("property: status row stays one line and drops generated controls", () => {
		fc.assert(
			fc.property(noisy, noisy, (phase, nextLabel) => {
				const summary = {
					skill: "ultragoal" as const,
					phase,
					active: true,
					fresh: false,
					next: [nextLabel],
					receipt_status: "present",
					storage_path: "state.json",
				};
				const before = structuredClone(summary);
				const rendered = renderStateStatusLine(summary);
				const phaseShown = sanitizeDisplayLine(phase);
				const nextShown = sanitizeDisplayLine(nextLabel);
				expect(summary).toEqual(before);
				expect(rendered).toBe(`ultragoal: phase=${phaseShown} stale next=${nextShown}\n`);
				expect(rendered.slice(0, -1)).not.toMatch(/[\r\n]/);
				expect(CONTROL.test(rendered)).toBe(false);
				const again = renderStateStatusLine({ ...summary, phase: phaseShown, next: [nextShown] });
				expect(again).toBe(rendered);
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: stored phase controls do not change transition matching", () => {
		fc.assert(
			fc.property(noisy, extra => {
				const rawPhase = `pen${extra}ding`;
				const transitions: WorkflowTransition[] = [
					{ from: "pending", to: "sanitized-target", verb: "complete-goals" },
					{ from: rawPhase, to: "raw-target", verb: "checkpoint" },
				];
				const manifest = manifestFor(transitions);
				const state = { current_phase: rawPhase, active: true };
				const before = structuredClone(state);
				const summary = buildStateStatusSummary("ultragoal", state, manifest, "store");
				const rendered = renderStateMarkdown("ultragoal", state, manifest);
				const expected = transitions
					.filter(item => item.from === rawPhase)
					.map(item => sanitizeDisplayLine(item.to));
				expect(state).toEqual(before);
				expect(summary.phase).toBe(rawPhase);
				expect(summary.next).toEqual(expected);
				expect(renderStateStatusLine(summary).includes(`next=${expected.join(",")}`)).toBe(true);
				expect(summary.phase).toBe(rawPhase);
				expect(CONTROL.test(rendered)).toBe(false);
				expect(nextTransitionLine(rendered)).toBe(`- Valid next transitions: ${expected.join(", ")}`);
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: markdown prose line breaks survive controls and stay idempotent", () => {
		fc.assert(
			fc.property(noisy, plain, plain, (extra, left, right) => {
				const phase = `${left}\n${right}${extra}`;
				const manifest = manifestFor([]);
				const once = renderStateMarkdown("ultragoal", { current_phase: phase }, manifest);
				const shown = sanitizeText(phase.trim());
				const twice = renderStateMarkdown("ultragoal", { current_phase: shown }, manifest);
				expect(CONTROL.test(once)).toBe(false);
				expect(once).toContain(`Current phase: ${shown}`);
				expect(once).toContain(`${left}\n${right}`);
				expect(twice).toBe(once);
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: compact elision stays a count when entries carry controls", () => {
		fc.assert(
			fc.property(noisy, extra => {
				const rendered = renderStateMarkdown(
					"ultragoal",
					{ current_phase: "pending", rounds: [`row${extra}`] },
					manifestFor([]),
				);
				expect(CONTROL.test(rendered)).toBe(false);
				expect(rendered).toContain("  - rounds: 1 entries (elided)");
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: ultragoal prose keeps line breaks and drops controls", () => {
		fc.assert(
			fc.property(noisy, plain, (extra, word) => {
				const objective = `${word}\nfollow-up`;
				const summary = {
					exists: true,
					status: `pending${extra}`,
					paths: { goalsPath: `goals${extra}.json`, ledgerPath: `ledger${extra}.jsonl` },
					gjcObjective: `${objective}${extra}`,
					currentGoal: { id: `G${extra}1`, status: "pending" },
					counts: { [`pending${extra}`]: 1 },
					goals: [{}],
				};
				const before = structuredClone(summary);
				const rendered = renderUltragoalStatusMarkdown(summary);
				expect(summary).toEqual(before);
				expect(CONTROL.test(rendered)).toBe(false);
				expect(rendered).toContain(`(${sanitizeDisplayLine(`pending${extra}`)}=1)`);
				expect(rendered).toContain(`- objective: ${sanitizeText(`${objective}${extra}`)}`);
				expect(rendered).toContain(`${word}\nfollow-up`);
				const statusLine = rendered.split("\n").find(line => line.startsWith("- status: "));
				expect(statusLine).toBe(`- status: ${sanitizeDisplayLine(`pending${extra}`)}`);
				expect(rendered).toContain(`- current: ${sanitizeDisplayLine(`G${extra}1`)} (pending)`);
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: contract and history text drop generated controls", () => {
		fc.assert(
			fc.property(noisy, plain, (extra, note) => {
				const contract = renderContractMarkdown("ultragoal", { [`note${extra}`]: `${note}${extra}` });
				expect(CONTROL.test(contract)).toBe(false);
				expect(contract).toContain(`- ${sanitizeDisplayLine(`note${extra}`)}: ${sanitizeText(`${note}${extra}`)}`);
				const history = renderHistoryMarkdown({
					entries: [{ ts: `t${extra}`, skill: "ultragoal", verb: `write${extra}` }],
					limit: 4,
					since: `s${extra}`,
					truncated: false,
				});
				expect(CONTROL.test(history)).toBe(false);
				expect(history).toContain(`- since: ${sanitizeDisplayLine(`s${extra}`)}`);
				expect(history).toContain(sanitizeDisplayLine(`write${extra}`));
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("bounds work for oversized plain text and unterminated escapes", () => {
		// Plain, repeated OSC, open OSC, repeated CSI, open CSI, and C1.
		// Each one runs at N and at 2N on phase markdown, ultragoal status, and the status line.
		const classes: Array<{ make: (units: number) => string }> = [
			{ make: units => sized("phase note ", units) },
			{ make: units => exactRepeat("\u001b]52;c;AAAA\u0007", units) },
			{ make: openOsc },
			{ make: units => exactRepeat("\u001b[31m", units) },
			{ make: openCsi },
			{ make: units => exactRepeat("\u009d0;title", units) },
		];
		for (const sample of classes) {
			expectScale(sample.make, renderPhase, 2);
			expectScale(sample.make, renderGoal, 2);
			expectScale(sample.make, renderLine, 1);
		}
	});
});
