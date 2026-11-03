import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { renderSkillHudBar } from "../src/modes/components/skill-hud/render";
import { STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";
import { theme } from "../src/modes/theme/theme";
import type { SkillActiveEntry } from "../src/skill-state/active-state";

function renderHudText(entries: readonly SkillActiveEntry[], width: number): string {
	return Bun.stripANSI(renderSkillHudBar(entries, width)?.join("\n") ?? "");
}

function visibleWidth(text: string): number {
	return Bun.stringWidth(Bun.stripANSI(text));
}

describe("skill HUD bar renderer", () => {
	it("omits the bar when no active skills exist", () => {
		expect(renderSkillHudBar([], 80)).toBeNull();
	});

	it("renders active skill and phase compactly", () => {
		const rendered = renderHudText([{ skill: "deep-interview", phase: "intent-first" }], 80);

		expect(rendered).not.toContain("hud");
		expect(rendered).toContain("deep-interview:intent-first");
	});

	it("uses the three width tiers and preserves severity", () => {
		const entry = {
			skill: "autoresearch",
			phase: "research",
			hud: {
				version: 1 as const,
				chips: [
					{ label: "experiments", value: "2/4", priority: 10 },
					{ label: "failed", value: "1", priority: 1, severity: "warning" as const },
				],
			},
		};
		const wide = renderHudText([entry], 100);
		const medium = renderHudText([entry], 80);
		const tight = renderHudText([entry], 40);

		expect(wide).toContain("experiments=2/4");
		expect(medium).toContain("experiments=2/4");
		expect(medium).not.toContain("failed=1");
		expect(tight).toContain("autoresearch");
		expect(tight).toContain(theme?.status.warning ?? "[!]");
	});

	it("caps the HUD at two lines", () => {
		const entries = Array.from({ length: 8 }, (_, index) => ({ skill: `skill-${index}`, phase: "running" }));
		const rendered = renderSkillHudBar(entries, 20);
		expect(rendered).not.toBeNull();
		expect(rendered?.length).toBeLessThanOrEqual(2);
	});

	it("wraps long wide content into physical rows without embedded newlines", () => {
		const rows = renderSkillHudBar(
			[
				{
					skill: "ultragoal",
					phase: "executing",
					hud: {
						version: 1,
						summary: "long-running aggregate execution",
						chips: [
							{ label: "goals", value: "1/2", priority: 10 },
							{ label: "current", value: "G002:Stabilize long HUD wrapping", priority: 20 },
							{ label: "ledger", value: "goal_started:2026-08-22T02:27:00.000Z", priority: 30 },
							{ label: "status", value: "active", priority: 40 },
						],
					},
				},
			],
			100,
		);
		expect(rows).not.toBeNull();
		expect(rows).toHaveLength(2);
		expect(rows?.every(row => !row.includes("\n") && visibleWidth(row) <= 100)).toBe(true);
		expect(rows?.join("\n")).toContain("ultragoal:executing");
	});

	it("uses terminal-cell widths and keeps severity beside narrow content", () => {
		const rendered = renderSkillHudBar(
			[
				{
					skill: "가나다라마",
					phase: "研究",
					hud: { version: 1, chips: [{ label: "blocked", value: "yes", severity: "blocked" }] },
				},
			],
			10,
		);
		expect(rendered).not.toBeNull();
		const rows = rendered ?? [];
		const text = rows.join("\n");
		expect(rows.every(row => Bun.stringWidth(Bun.stripANSI(row)) > 0)).toBe(true);
		expect(rows.every(row => Bun.stringWidth(Bun.stripANSI(row)) <= 10)).toBe(true);
		expect(rows[0]).not.toBe("◆");
		expect(text).toContain(theme?.status.error ?? "[!!]");
		const longSkillRows = renderSkillHudBar(
			[
				{
					skill: "averyverylongskillname",
					hud: { version: 1, chips: [{ label: "blocked", value: "yes", severity: "blocked" }] },
				},
			],
			10,
		);
		expect(longSkillRows?.join("\n")).toContain(theme?.status.error ?? "[!!]");
	});

	it("sanitizes dynamic text and truncates to width", () => {
		const rendered = renderSkillHudBar(
			[{ skill: "team\n\u001b[31mred", phase: "running\twith-a-very-long-phase-name" }],
			30,
		);
		expect(rendered).not.toBeNull();
		expect(rendered?.every(row => !row.includes("\n") && !row.includes("\t"))).toBe(true);
		expect(visibleWidth((rendered ?? []).join("\n"))).toBeLessThanOrEqual(30);
	});

	it("is included as a native status-line rail without changing preset segments", () => {
		expect(STATUS_LINE_PRESETS.default.leftSegments).toEqual(["model", "mode", "git", "pr", "path"]);
		const rendered = renderHudText([{ skill: "team", phase: "running" }], 100);
		expect(rendered).toContain("◆ team:running");
	});

	it("omits inactive entries so statusLine.showSkillHud can gate the rail", () => {
		expect(renderSkillHudBar([{ skill: "team", phase: "running", active: false }], 100)).toBeNull();
	});
	it("renders normalized HUD chips in priority order with stale warning", () => {
		const rendered = renderHudText(
			[
				{
					skill: "ralplan",
					phase: "planning",
					stale: true,
					hud: {
						version: 1,
						summary: "consensus",
						chips: [
							{ label: "verdict", value: "ITERATE", priority: 40, severity: "warning" },
							{ label: "stage", value: "critic", priority: 10 },
						],
					},
				},
			],
			120,
		);
		expect(rendered).toContain("ralplan:planning");
		expect(rendered).toContain("consensus");
		expect(rendered).toContain("stage=critic");
		expect(rendered).toContain("verdict=ITERATE");
		expect(rendered).toContain(theme?.status.warning ?? "[!]");
	});

	it("sanitizes HUD chips and keeps constrained rendering within width", () => {
		const rendered = renderSkillHudBar(
			[
				{
					skill: "team\n\u001b[31mred",
					phase: "running\twith-a-very-long-phase-name",
					hud: {
						version: 1,
						summary: "workers\nok",
						chips: [{ label: "latest\t", value: "a-very-long-message-with-\u001b[31mansi" }],
					},
				},
			],
			35,
		);
		expect(rendered).not.toBeNull();
		expect(rendered?.every(row => !row.includes("\n") && !row.includes("\t"))).toBe(true);
		expect(rendered?.every(row => visibleWidth(row) <= 35)).toBe(true);
	});
	it("renders gate and receipt status from canonical state entries", () => {
		const rendered = renderHudText(
			[
				{
					skill: "deep-interview",
					phase: "interviewing",
					hud: {
						version: 1,
						chips: [
							{ label: "gate", value: "approval-required", priority: 5, severity: "warning" },
							{ label: "blocked", value: "execution approval missing", priority: 10, severity: "blocked" },
							{ label: "next", value: "ask user for approval", priority: 20 },
						],
					},
					receipt: {
						version: 1,
						skill: "deep-interview",
						owner: "gjc-state-cli",
						command: "gjc state deep-interview write",
						state_path: ".gjc/state/skill-active-state.json",
						storage_path: ".gjc/state/deep-interview-state.json",
						mutated_at: new Date().toISOString(),
						fresh_until: new Date(Date.now() + 60_000).toISOString(),
						status: "fresh",
						mutation_id: "test",
					},
				},
			],
			160,
		);
		expect(rendered).toContain("deep-interview:interviewing");
		expect(rendered).toContain("next=ask user for approval");
		expect(rendered).toContain(theme?.status.error ?? "[!!]");
		expect(rendered).not.toContain("receipt=fresh");
	});

	it("shows only the callee after a D->R handoff (caller demoted to inactive entry, HUD filters it out)", () => {
		// After `gjc state deep-interview handoff --to ralplan`, the caller
		// entry is preserved in active_skills with active:false and handoff_to
		// lineage for audit; the HUD filters on active!==false so only ralplan
		// appears in the rendered bar.
		const rendered = renderHudText([{ skill: "ralplan", phase: "planning" }], 80);

		expect(rendered).toContain("ralplan:planning");
		expect(rendered).not.toContain("deep-interview");
	});

	it("shows only the callee after an R->U handoff", () => {
		const rendered = renderHudText([{ skill: "ultragoal", phase: "goal-planning" }], 80);

		expect(rendered).toContain("ultragoal:goal-planning");
		expect(rendered).not.toContain("ralplan");
	});

	it("shows only the callee after a backward U->R handoff", () => {
		const rendered = renderHudText([{ skill: "ralplan", phase: "planning" }], 80);
		expect(rendered).toContain("ralplan:planning");
		expect(rendered).not.toContain("ultragoal");
	});

	it("collapses the planning pipeline to the most-recently-activated stage", () => {
		// `gjc ralplan` then `gjc ultragoal` activate their own rows without
		// running the handoff verb, so both arrive at the HUD active. Only the
		// current (newest) stage should render.
		const rendered = renderHudText(
			[
				{ skill: "ralplan", phase: "final", active: true, updated_at: "2026-01-01T00:00:00.000Z" },
				{ skill: "ultragoal", phase: "executing", active: true, updated_at: "2026-01-01T00:05:00.000Z" },
			],
			80,
		);

		expect(rendered).toContain("ultragoal:executing");
		expect(rendered).not.toContain("ralplan");
	});

	it("keeps team alongside ultragoal since team is not part of the planning pipeline", () => {
		const rendered = renderHudText(
			[
				{ skill: "ultragoal", phase: "executing", active: true, updated_at: "2026-01-01T00:00:00.000Z" },
				{ skill: "team", phase: "running", active: true, updated_at: "2026-01-01T00:05:00.000Z" },
			],
			80,
		);

		expect(rendered).toContain("ultragoal:executing");
		expect(rendered).toContain("team:running");
	});

	it("collapses the pipeline NaN-safely: a valid timestamp wins over a missing one regardless of order", () => {
		const entries = [
			{ skill: "ralplan", phase: "final", active: true },
			{ skill: "ultragoal", phase: "executing", active: true, updated_at: "2026-01-01T00:05:00.000Z" },
		];
		const forward = renderHudText(entries, 80);
		const reversed = renderHudText([...entries].reverse(), 80);

		expect(forward).toContain("ultragoal:executing");
		expect(forward).not.toContain("ralplan");
		expect(reversed).toContain("ultragoal:executing");
		expect(reversed).not.toContain("ralplan");
	});

	it("renders a single deterministic pipeline stage when no entry has a timestamp", () => {
		const rendered = renderHudText(
			[
				{ skill: "ralplan", phase: "final", active: true },
				{ skill: "ultragoal", phase: "executing", active: true },
			],
			80,
		);

		// Exactly one planning-pipeline entry survives the collapse.
		expect(rendered).toContain("ultragoal:executing");
		expect(rendered).not.toContain("ralplan:final");
	});

	it("does not emit warn:stale for an entry without explicit stale flag (no 24h derivation)", () => {
		// Pre-G003 the renderer relied on withDerivedStale to flag aged entries.
		// Post-G003, only explicit `entry.stale === true` produces the chip.
		const rendered = renderHudText([{ skill: "team", phase: "running", updated_at: "2000-01-01T00:00:00.000Z" }], 80);
		expect(rendered).toContain("team:running");
		expect(rendered).not.toContain("warn:stale");
	});

	it("keeps an internal double space in a summary", () => {
		const rendered = renderHudText(
			[{ skill: "team", phase: "run", hud: { version: 1, summary: "hello  world" } }],
			240,
		);
		expect(rendered).toContain("hello  world");
	});

	it("keeps a clipboard-shaped label with no introducer", () => {
		const rendered = renderHudText(
			[{ skill: "team", phase: "run", hud: { version: 1, summary: "]52;c;QQ==" } }],
			240,
		);
		expect(rendered).toContain("]52;c;QQ==");
	});

	it("keeps a tab as a space between skill words", () => {
		const rendered = renderHudText([{ skill: "team\tred", phase: "run" }], 240);
		expect(rendered).toContain("team red");
		expect(rendered).not.toContain("\t");
	});

	it("keeps a carriage return as a space", () => {
		const rendered = renderHudText([{ skill: "team\rred", phase: "run" }], 240);
		expect(rendered).toContain("team red");
	});

	it("keeps letters around a color code", () => {
		const rendered = renderHudText([{ skill: "team\u001b[31mred", phase: "run" }], 240);
		expect(rendered).toContain("teamred");
	});

	it("keeps a bracketed note that is not a control", () => {
		const rendered = renderHudText(
			[{ skill: "team", phase: "run", hud: { version: 1, summary: "see [31m] later" } }],
			240,
		);
		expect(rendered).toContain("see [31m] later");
	});

	it("keeps printable skill text, fc.property seed 70022, numRuns 64", () => {
		fc.assert(
			fc.property(
				fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,16}$/),
				fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,12}$/),
				(skill, phase) => {
					const plain = Bun.stripANSI((renderSkillHudBar([{ skill, phase }], 240) ?? []).join("\n"));
					return plain.includes(`${skill}:${phase}`);
				},
			),
			{ seed: 70022, numRuns: 64 },
		);
	});

	it("keeps introducer-free clipboard text, fc.property seed 70023, numRuns 64", () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[A-Za-z0-9+/=]{1,12}$/), payload => {
				const summary = `]52;c;${payload}`;
				const plain = Bun.stripANSI(
					(renderSkillHudBar([{ skill: "team", phase: "run", hud: { version: 1, summary } }], 240) ?? []).join(
						"\n",
					),
				);
				return plain.includes(summary);
			}),
			{ seed: 70023, numRuns: 64 },
		);
	});
});

const STACKED_CLIPBOARD = "before \u001b\u001b\u001b]0;x\u0007]0;y\u0007]52;c;QQ==\u0007 after";

function rawHud(entry: SkillActiveEntry, width = 240): string {
	return (renderSkillHudBar([entry], width) ?? []).join("\n");
}

function entryForField(field: "skill" | "phase" | "summary" | "label" | "value", payload: string): SkillActiveEntry {
	if (field === "skill") return { skill: payload, phase: "run" };
	if (field === "phase") return { skill: "team", phase: payload };
	if (field === "summary") return { skill: "team", phase: "run", hud: { version: 1, summary: payload } };
	if (field === "label") {
		return { skill: "team", phase: "run", hud: { version: 1, chips: [{ label: payload, value: "1" }] } };
	}
	return { skill: "team", phase: "run", hud: { version: 1, chips: [{ label: "exp", value: payload }] } };
}

describe("skill HUD terminal controls", () => {
	for (const field of ["skill", "phase", "summary", "label", "value"] as const) {
		it(`does not reassemble a clipboard sequence from stacked escapes in ${field}`, () => {
			const rendered = rawHud(entryForField(field, STACKED_CLIPBOARD));
			expect(rendered).toContain("before");
			expect(rendered).toContain("after");
			expect(rendered).not.toContain("\u001b]52;c;QQ==\u0007");
			expect(rendered).not.toContain("\u001b]");
			expect(rendered).not.toContain("\u0007");
			expect(rendered).not.toContain("\u009d");
		});
	}

	it("does not emit a window-title sequence from the skill field", () => {
		const rendered = rawHud({ skill: "team\u001b]0;pwned\u0007", phase: "run" });
		expect(rendered).toContain("team");
		expect(rendered).not.toContain("\u001b]0");
		expect(rendered).not.toContain("\u0007");
	});

	it("does not emit a hyperlink sequence from a summary", () => {
		const rendered = rawHud({
			skill: "team",
			phase: "run",
			hud: { version: 1, summary: "\u001b]8;;https://attacker.invalid\u0007click\u001b]8;;\u0007" },
		});
		expect(rendered).toContain("click");
		expect(rendered).not.toContain("\u001b]8");
		expect(rendered).not.toContain("\u0007");
	});

	it("does not emit an 8-bit OSC from a chip value", () => {
		const rendered = rawHud({
			skill: "team",
			phase: "run",
			hud: { version: 1, chips: [{ label: "exp", value: "\u009d52;c;QQ==\u009c" }] },
		});
		expect(rendered).not.toContain("\u009d");
		expect(rendered).not.toContain("\u009c");
		expect(rendered).toContain("exp");
	});

	it("does not emit a bell from a phase", () => {
		const rendered = rawHud({ skill: "team", phase: "run\u0007ning" });
		expect(rendered).toContain("running");
		expect(rendered).not.toContain("\u0007");
	});

	it("does not reassemble a clipboard sequence across a removed color code", () => {
		const rendered = rawHud({
			skill: "team",
			phase: "run",
			hud: { version: 1, summary: "before \u001b\u001b[0m]52;c;QQ==\u0007 after" },
		});
		expect(rendered).toContain("before");
		expect(rendered).toContain("after");
		expect(rendered).not.toContain("\u001b]52");
		expect(rendered).not.toContain("\u0007");
	});

	it("does not reassemble a clipboard sequence when the row is truncated", () => {
		const rendered = rawHud({ skill: "team", phase: "run", hud: { version: 1, summary: STACKED_CLIPBOARD } }, 80);
		expect(rendered).not.toContain("\u001b]");
		expect(rendered).not.toContain("\u0007");
		expect(rendered).not.toContain("\u009d");
	});

	it("does not reassemble terminal controls, fc.property seed 70021, numRuns 64", () => {
		const terminator = fc.constantFrom("\u0007", "\u001b\\", "\u009c");
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 8 }),
				fc.integer({ min: 0, max: 4 }),
				fc.stringMatching(/^[A-Za-z0-9]{0,6}$/),
				fc.stringMatching(/^[A-Za-z0-9+/=]{0,8}$/),
				terminator,
				fc.constantFrom("skill", "phase", "summary", "label", "value"),
				(escCount, titles, title, payload, term, field) => {
					let body = "\u001b".repeat(escCount);
					for (let index = 0; index < titles; index += 1) body += `]0;${title}${term}`;
					body += `]52;c;${payload}${term}`;
					const rendered = rawHud(entryForField(field, `before ${body} after`));
					const withoutCsi = rendered.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
					return (
						!rendered.includes("\u001b]") &&
						!rendered.includes("\u009d") &&
						!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(withoutCsi)
					);
				},
			),
			{ seed: 70021, numRuns: 64 },
		);
	});
});
