import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	appendOrMergeDeepInterviewRound,
	applyAmbiguityFloorToEnvelope,
	clampReportedAmbiguity,
	computeAmbiguityFloor,
	disputeFactsFromRetractedRound,
	enrichDeepInterviewRoundScoring,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-recorder";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];
let priorSessionId: string | undefined;

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-deep-interview-ambiguity-"));
	tempRoots.push(dir);
	return dir;
}

beforeAll(() => {
	priorSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
	else delete process.env.GJC_SESSION_ID;
});

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function fact(over: Record<string, unknown> = {}): Record<string, unknown> {
	return { id: "f1", statement: "Core entity is Task", round: 1, disputed: false, ...over };
}

describe("deep-interview ambiguity: deterministic floor", () => {
	it("is zero for empty state", () => {
		expect(computeAmbiguityFloor({}).floor).toBe(0);
		expect(computeAmbiguityFloor(undefined).floor).toBe(0);
	});

	it("adds 0.10 per unresolved disputed fact", () => {
		const breakdown = computeAmbiguityFloor({
			established_facts: [fact({ disputed: true }), fact({ id: "f2", disputed: true }), fact({ id: "f3" })],
		});
		expect(breakdown.floor).toBe(0.2);
		expect(breakdown.disputed_fact_count).toBe(2);
	});

	it("releases contradiction pressure when a disputed fact is superseded", () => {
		const breakdown = computeAmbiguityFloor({
			established_facts: [
				fact({ disputed: true, superseded_by: "f9" }),
				fact({ id: "f9", statement: "Core entity is Project" }),
			],
		});
		expect(breakdown.floor).toBe(0);
		expect(breakdown.disputed_fact_count).toBe(0);
	});

	it("adds 0.05 per unscored active component once topology is confirmed", () => {
		const topology = {
			status: "confirmed",
			components: [
				{ id: "a", status: "active", clarity_scores: { goal: 0.9, constraints: 0.8, criteria: 0.9 } },
				{ id: "b", status: "active", clarity_scores: { goal: 0.9, constraints: null, criteria: 0.9 } },
				{ id: "c", status: "deferred", clarity_scores: {} },
				{ id: "d", status: "active" },
			],
		};
		const breakdown = computeAmbiguityFloor({ topology });
		expect(breakdown.unscored_active_component_count).toBe(2);
		expect(breakdown.floor).toBe(0.1);
		// Unconfirmed topology must not arm the gap pressure.
		expect(computeAmbiguityFloor({ topology: { ...topology, status: "pending" } }).floor).toBe(0);
	});

	it("adds bounded auto-answer dilution", () => {
		const rounds = [
			{ round_key: "k1", round: 1, lifecycle: "scored" },
			{ round_key: "k2", round: 2, lifecycle: "scored" },
		];
		const breakdown = computeAmbiguityFloor({ rounds, auto_answered_rounds: [2] });
		expect(breakdown.auto_answer_ratio).toBe(0.5);
		expect(breakdown.floor).toBe(0.03);
		// Ratio (and thus the dilution term) is capped at 1 even with more auto rounds than scored rounds.
		const saturated = computeAmbiguityFloor({ rounds, auto_answered_rounds: [1, 2, 3, 4] });
		expect(saturated.auto_answer_ratio).toBe(1);
		expect(saturated.floor).toBe(0.05);
	});

	it("clamps reported ambiguity to max(reported, floor) within [0, 1]", () => {
		expect(clampReportedAmbiguity(0.03, 0.2)).toEqual({ effective: 0.2, clamped: true });
		expect(clampReportedAmbiguity(0.5, 0.2)).toEqual({ effective: 0.5, clamped: false });
		expect(clampReportedAmbiguity(-1, 0)).toEqual({ effective: 0, clamped: false });
		expect(clampReportedAmbiguity(2, 0)).toEqual({ effective: 1, clamped: false });
	});
});

describe("deep-interview ambiguity: retraction disputes facts", () => {
	it("disputes only facts from the retracted round, preserving resolved and foreign facts", () => {
		const facts = [
			fact({ id: "f1", round: 2 }),
			fact({ id: "f2", round: 2, disputed: true, superseded_by: "f9" }),
			fact({ id: "f3", round: 3 }),
		];
		const result = disputeFactsFromRetractedRound(facts, 2);
		expect(result.disputedIds).toEqual(["f1"]);
		expect(result.facts[0].disputed).toBe(true);
		expect(result.facts[1].disputed).toBe(true);
		expect(result.facts[1].superseded_by).toBe("f9");
		expect(result.facts[2].disputed).toBe(false);
		// Input is never mutated.
		expect(facts[0].disputed).toBe(false);
	});
});

describe("deep-interview ambiguity: envelope floor application", () => {
	it("clamps current_ambiguity and the latest scored round, preserving the reported value", () => {
		const envelope = {
			state: {
				current_ambiguity: 0.04,
				established_facts: [fact({ disputed: true })],
				rounds: [
					{ round_key: "k1", round: 1, lifecycle: "scored", ambiguity: 0.3, answered_at: "t" },
					{ round_key: "k2", round: 2, lifecycle: "scored", ambiguity: 0.04, answered_at: "t" },
				],
			},
		};
		const applied = applyAmbiguityFloorToEnvelope(envelope);
		expect(applied.clamped).toBe(true);
		expect(applied.breakdown.floor).toBe(0.1);
		const inner = applied.envelope.state as Record<string, unknown>;
		expect(inner.current_ambiguity).toBe(0.1);
		const rounds = inner.rounds as Record<string, unknown>[];
		// Historical round untouched; latest scored round clamped with audit trail.
		expect(rounds[0].ambiguity).toBe(0.3);
		expect(rounds[1].ambiguity).toBe(0.1);
		expect(rounds[1].reported_ambiguity).toBe(0.04);
		expect(rounds[1].ambiguity_floor).toBe(0.1);
		// Original envelope is not mutated.
		expect(envelope.state.current_ambiguity).toBe(0.04);
	});

	it("is a no-op when the reported score already exceeds the floor, and is idempotent", () => {
		const envelope = {
			state: {
				current_ambiguity: 0.5,
				established_facts: [fact({ disputed: true })],
				rounds: [{ round_key: "k1", round: 1, lifecycle: "scored", ambiguity: 0.5, answered_at: "t" }],
			},
		};
		const first = applyAmbiguityFloorToEnvelope(envelope);
		expect(first.clamped).toBe(false);
		expect((first.envelope.state as Record<string, unknown>).current_ambiguity).toBe(0.5);
		const second = applyAmbiguityFloorToEnvelope(first.envelope);
		expect(second.clamped).toBe(false);
		expect(second.envelope.state).toEqual(first.envelope.state);
	});
});

describe("deep-interview ambiguity: recorder integration (dynamic rise and fall)", () => {
	function statePathFor(cwd: string): string {
		return modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
	}

	it("scoring is clamped by the floor when disputed facts exist", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		await appendOrMergeDeepInterviewRound(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", questionText: "Q1?" },
			{ sessionId: TEST_SESSION_ID },
		);
		// Seed a disputed fact directly into persisted state (as the skill's state write would).
		const persisted = JSON.parse(await fs.readFile(statePath, "utf-8"));
		persisted.state.established_facts = [fact({ disputed: true })];
		await fs.writeFile(statePath, JSON.stringify(persisted));

		const { record } = await enrichDeepInterviewRoundScoring(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", scores: { goal: 0.95 }, ambiguity: 0.03 },
			{ sessionId: TEST_SESSION_ID },
		);
		expect(record.ambiguity).toBe(0.1);
		expect(record.reported_ambiguity).toBe(0.03);
		expect(record.ambiguity_floor).toBe(0.1);
		const after = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(after.state.current_ambiguity).toBe(0.1);
		expect(after.state.ambiguity_floor.disputed_fact_count).toBe(1);
	});

	it("retracting a scored answer disputes that round's facts and raises current_ambiguity (A -> B pivot)", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		const input = { round: 1, questionId: "q1", questionText: "Q1?", selectedOptions: ["A"] };
		await appendOrMergeDeepInterviewRound(cwd, statePath, input, { sessionId: TEST_SESSION_ID });
		await enrichDeepInterviewRoundScoring(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", scores: { goal: 0.9 }, ambiguity: 0.06 },
			{ sessionId: TEST_SESSION_ID },
		);
		// The scored round established a fact.
		const persisted = JSON.parse(await fs.readFile(statePath, "utf-8"));
		persisted.state.established_facts = [fact({ round: 1 })];
		await fs.writeFile(statePath, JSON.stringify(persisted));

		// The user changes the round-1 answer: A -> B.
		const replaced = await appendOrMergeDeepInterviewRound(
			cwd,
			statePath,
			{ ...input, selectedOptions: ["B"] },
			{ sessionId: TEST_SESSION_ID },
		);
		expect(replaced.action).toBe("replaced");
		expect(replaced.disputedFactIds).toEqual(["f1"]);
		const after = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(after.state.established_facts[0].disputed).toBe(true);
		// Ambiguity rose mechanically from 0.06 to the 0.10 floor without any scorer trigger.
		expect(after.state.current_ambiguity).toBe(0.1);
	});

	it("superseding the disputed fact releases the floor so convergence can resume", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		await appendOrMergeDeepInterviewRound(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", questionText: "Q1?" },
			{ sessionId: TEST_SESSION_ID },
		);
		const persisted = JSON.parse(await fs.readFile(statePath, "utf-8"));
		persisted.state.established_facts = [
			fact({ disputed: true, superseded_by: "f9" }),
			fact({ id: "f9", statement: "Core entity is Project", round: 2 }),
		];
		await fs.writeFile(statePath, JSON.stringify(persisted));

		const { record } = await enrichDeepInterviewRoundScoring(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", scores: { goal: 0.97 }, ambiguity: 0.03 },
			{ sessionId: TEST_SESSION_ID },
		);
		expect(record.ambiguity).toBe(0.03);
		expect(record.reported_ambiguity).toBeUndefined();
		const after = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(after.state.current_ambiguity).toBe(0.03);
	});
});
