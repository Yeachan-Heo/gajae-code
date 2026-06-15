import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	answerHash,
	appendOrMergeDeepInterviewRound,
	appendOrMergeRound,
	buildAnswerShell,
	type DeepInterviewRoundRecord,
	type DeepInterviewTriggerMetadata,
	deriveRoundKey,
	enrichDeepInterviewRoundScoring,
	enrichRoundWithScoring,
	ensureDeepInterviewStateShape,
	projectCompactState,
	questionHash,
	readDeepInterviewStateCompact,
	validateDeepInterviewScoredTransition,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-recorder";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-deep-interview-recorder-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function shell(over: Partial<Parameters<typeof buildAnswerShell>[0]> = {}): DeepInterviewRoundRecord {
	return buildAnswerShell(
		{
			interviewId: "iv1",
			round: 1,
			questionId: "q1",
			questionText: "What is the core entity?",
			component: "conflict-detection",
			dimension: "goal",
			ambiguity: 0.6,
			selectedOptions: ["A"],
			...over,
		},
		"2026-01-01T00:00:00.000Z",
	);
}

function trigger(over: Partial<DeepInterviewTriggerMetadata> = {}): DeepInterviewTriggerMetadata {
	return {
		kind: "A",
		name: "direct contradiction",
		status: "active",
		component: "conflict-detection",
		dimension: "goal",
		...over,
	};
}

describe("deep-interview recorder: identity & hashing", () => {
	it("prefers interview_id + round_id, falls back to interview_id + round + question.id", () => {
		expect(deriveRoundKey("iv1", { round_id: "r-abc", round: 2, questionId: "q9" })).toBe("iv1::rid:r-abc");
		expect(deriveRoundKey("iv1", { round: 2, questionId: "q9" })).toBe("iv1::r:2::q:q9");
		expect(deriveRoundKey("iv1", { round: 2 })).toBe("iv1::r:2::q:noqid");
		expect(deriveRoundKey(undefined, { round: 1, questionId: "q1" })).toBe("nointerview::r:1::q:q1");
	});

	it("hashes are stable and content-sensitive for replay detection", () => {
		expect(questionHash("same")).toBe(questionHash("same"));
		expect(questionHash("a")).not.toBe(questionHash("b"));
		expect(answerHash(["A"], undefined)).toBe(answerHash(["A"], undefined));
		expect(answerHash(["A"], undefined)).not.toBe(answerHash(["B"], undefined));
		expect(answerHash([], "free text")).not.toBe(answerHash([], "other text"));
	});

	it("answer shells record hashes, component/dimension, and answered lifecycle", () => {
		const s = shell();
		expect(s.lifecycle).toBe("answered");
		expect(s.question_hash).toBe(questionHash("What is the core entity?"));
		expect(s.answer_hash).toBe(answerHash(["A"], undefined));
		expect(s.component).toBe("conflict-detection");
		expect(s.round_key).toBe("iv1::r:1::q:q1");
	});
});

describe("deep-interview recorder: append-or-merge", () => {
	it("creates one record per key", () => {
		const r = appendOrMergeRound([], shell());
		expect(r.action).toBe("created");
		expect(r.rounds).toHaveLength(1);
	});

	it("is a deterministic no-op on identical replay", () => {
		const first = appendOrMergeRound([], shell());
		const replay = appendOrMergeRound(first.rounds, shell());
		expect(replay.action).toBe("noop");
		expect(replay.rounds).toHaveLength(1);
	});

	it("replaces the prior shell when the same key has different hashes", () => {
		const first = appendOrMergeRound([], shell());
		const changed = appendOrMergeRound(first.rounds, shell({ selectedOptions: ["B"] }));
		expect(changed.action).toBe("replaced");
		expect(changed.rounds).toHaveLength(1);
		expect(changed.rounds[0].answer_hash).toBe(answerHash(["B"], undefined));
	});
});

describe("deep-interview recorder: scoring enrichment", () => {
	it("updates the same record to scored and never appends a second", () => {
		const created = appendOrMergeRound([], shell()).rounds;
		const { rounds, record } = enrichRoundWithScoring(created, {
			interviewId: "iv1",
			round: 1,
			questionId: "q1",
			scores: { goal: 0.5 },
			ambiguity: 0.5,
		});
		expect(rounds).toHaveLength(1);
		expect(record.lifecycle).toBe("scored");
		expect(record.scores).toEqual({ goal: 0.5 });
		expect(record.question_hash).toBe(questionHash("What is the core entity?")); // shell fields preserved
	});

	it("creates a scored record if scoring arrives with no shell", () => {
		const { rounds, record } = enrichRoundWithScoring([], {
			interviewId: "iv1",
			round: 3,
			questionId: "q3",
			scores: { goal: 0.4 },
			ambiguity: 0.4,
		});
		expect(rounds).toHaveLength(1);
		expect(record.lifecycle).toBe("scored");
	});
});

describe("deep-interview recorder: transition validator", () => {
	const prior: DeepInterviewRoundRecord = {
		...shell(),
		lifecycle: "scored",
		scores: { goal: 0.5 },
		ambiguity: 0.5,
	};

	it("passes when an active trigger lowers the dimension and raises ambiguity", () => {
		const next: DeepInterviewRoundRecord = {
			...shell({ round: 2, questionId: "q2" }),
			lifecycle: "scored",
			scores: { goal: 0.3 },
			ambiguity: 0.62,
			triggers: [trigger()],
		};
		expect(validateDeepInterviewScoredTransition(prior, next).ok).toBe(true);
	});

	it("fails when an active trigger improves the affected dimension", () => {
		const next: DeepInterviewRoundRecord = {
			...shell({ round: 2, questionId: "q2" }),
			lifecycle: "scored",
			scores: { goal: 0.8 },
			ambiguity: 0.62,
			triggers: [trigger()],
		};
		const result = validateDeepInterviewScoredTransition(prior, next);
		expect(result.ok).toBe(false);
		expect(result.violations.join(" ")).toContain("improved clarity");
	});

	it("fails when an active trigger does not raise ambiguity", () => {
		const next: DeepInterviewRoundRecord = {
			...shell({ round: 2, questionId: "q2" }),
			lifecycle: "scored",
			scores: { goal: 0.3 },
			ambiguity: 0.4,
			triggers: [trigger()],
		};
		const result = validateDeepInterviewScoredTransition(prior, next);
		expect(result.ok).toBe(false);
		expect(result.violations.join(" ")).toContain("did not raise ambiguity");
	});

	it("exempts disputed/unresolved triggers only with a rationale", () => {
		const disputedNoRationale: DeepInterviewRoundRecord = {
			...shell({ round: 2 }),
			lifecycle: "scored",
			scores: { goal: 0.9 },
			ambiguity: 0.4,
			triggers: [trigger({ status: "disputed" })],
		};
		expect(validateDeepInterviewScoredTransition(prior, disputedNoRationale).ok).toBe(false);

		const disputedWithRationale: DeepInterviewRoundRecord = {
			...disputedNoRationale,
			triggers: [trigger({ status: "disputed", rationale: "user retracted the contradiction" })],
		};
		expect(validateDeepInterviewScoredTransition(prior, disputedWithRationale).ok).toBe(true);
	});
});

describe("deep-interview recorder: contradiction fixture (round N vs N-2)", () => {
	it("a contradiction of an N-2 established fact yields ambiguity_N > ambiguity_{N-1} and passes the validator", () => {
		// N-2 established a fact (goal clear); N-1 is a non-contradictory baseline; N contradicts.
		const established = [
			{ id: "f1", statement: "Core entity is Task", round: 1, dimension: "goal", disputed: false },
		];
		const roundN1: DeepInterviewRoundRecord = {
			...shell({ round: 2, questionId: "q2" }),
			lifecycle: "scored",
			scores: { goal: 0.8 },
			ambiguity: 0.3,
		};
		const roundN: DeepInterviewRoundRecord = {
			...shell({ round: 3, questionId: "q3" }),
			lifecycle: "scored",
			scores: { goal: 0.4 },
			ambiguity: 0.55,
			triggers: [
				trigger({
					contradictedFactId: "f1",
					priorDimensionScore: 0.8,
					newDimensionScore: 0.4,
					priorAmbiguity: 0.3,
					newAmbiguity: 0.55,
					evidence: "Round 3 says the core entity is Project, contradicting f1",
				}),
			],
		};
		expect(roundN.ambiguity).toBeGreaterThan(roundN1.ambiguity as number);
		expect(validateDeepInterviewScoredTransition(roundN1, roundN).ok).toBe(true);
		expect(established[0].id).toBe("f1");

		// Fail variant: same contradiction but the scorer failed to raise ambiguity.
		const broken: DeepInterviewRoundRecord = { ...roundN, ambiguity: 0.25 };
		expect(validateDeepInterviewScoredTransition(roundN1, broken).ok).toBe(false);
	});
});

describe("deep-interview recorder: state-shape migration & compact projection", () => {
	it("defaults rounds and established_facts for legacy/empty state without deleting fields", () => {
		const migrated = ensureDeepInterviewStateShape({ state: { initial_idea: "x" }, skill: "deep-interview" });
		expect(migrated.state?.rounds).toEqual([]);
		expect(migrated.state?.established_facts).toEqual([]);
		expect((migrated.state as Record<string, unknown>).initial_idea).toBe("x");
		expect(migrated.skill).toBe("deep-interview");
	});

	it("compact projection separates pending shells from scored rounds and surfaces latest ambiguity", () => {
		const rounds: DeepInterviewRoundRecord[] = [
			{ ...shell({ round: 1, questionId: "q1" }), lifecycle: "scored", scores: { goal: 0.7 }, ambiguity: 0.4 },
			{ ...shell({ round: 2, questionId: "q2" }), lifecycle: "scored", scores: { goal: 0.6 }, ambiguity: 0.35 },
			{ ...shell({ round: 3, questionId: "q3" }), lifecycle: "answered" },
		];
		const compact = projectCompactState({ state: { rounds, established_facts: [] }, threshold: 0.05 }, { lastN: 1 });
		expect(compact.current_ambiguity).toBe(0.35);
		expect(compact.recent_scored_rounds).toHaveLength(1);
		expect(compact.pending_shells).toHaveLength(1);
		expect(compact.pending_shells[0].round).toBe(3);
		expect(compact.threshold).toBe(0.05);
	});
});

describe("deep-interview recorder: persistence (state-writer backed)", () => {
	function statePathFor(cwd: string): string {
		return path.join(cwd, ".gjc", "state", "deep-interview-state.json");
	}

	it("persists exactly one durable record per key and no-ops identical replay", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		const input = {
			round: 1,
			questionId: "q1",
			questionText: "Q1?",
			component: "c",
			dimension: "goal",
			selectedOptions: ["A"],
		};
		const created = await appendOrMergeDeepInterviewRound(cwd, statePath, input);
		expect(created.action).toBe("created");

		const replay = await appendOrMergeDeepInterviewRound(cwd, statePath, input);
		expect(replay.action).toBe("noop");

		const persisted = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(persisted.state.rounds).toHaveLength(1);
		expect(persisted.skill).toBe("deep-interview");
	});

	it("enriches the same record to scored without appending a second", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		await appendOrMergeDeepInterviewRound(cwd, statePath, {
			round: 1,
			questionId: "q1",
			questionText: "Q1?",
		});
		await enrichDeepInterviewRoundScoring(cwd, statePath, {
			round: 1,
			questionId: "q1",
			scores: { goal: 0.5 },
			ambiguity: 0.5,
		});
		const persisted = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(persisted.state.rounds).toHaveLength(1);
		expect(persisted.state.rounds[0].lifecycle).toBe("scored");
		expect(persisted.state.current_ambiguity).toBe(0.5);
	});

	it("refuses to persist an invalid scored transition and does not falsely converge", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		// Round 1 establishes a clear baseline (goal 0.5, ambiguity 0.5).
		await appendOrMergeDeepInterviewRound(cwd, statePath, {
			round: 1,
			questionId: "q1",
			questionText: "Q1?",
			dimension: "goal",
		});
		await enrichDeepInterviewRoundScoring(cwd, statePath, {
			round: 1,
			questionId: "q1",
			scores: { goal: 0.5 },
			ambiguity: 0.5,
		});
		// Round 2 claims an active goal contradiction yet improves clarity and drops
		// ambiguity — an impossible scored transition that would falsely converge.
		await appendOrMergeDeepInterviewRound(cwd, statePath, {
			round: 2,
			questionId: "q2",
			questionText: "Q2?",
			dimension: "goal",
		});
		await expect(
			enrichDeepInterviewRoundScoring(cwd, statePath, {
				round: 2,
				questionId: "q2",
				scores: { goal: 0.8 },
				ambiguity: 0.4,
				triggers: [trigger()],
			}),
		).rejects.toThrow(/invalid and was refused/);

		// Durable state is untouched: round 2 stays an unscored shell and the latest
		// persisted ambiguity is the prior round's, not the refused 0.4.
		const persisted = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(persisted.state.rounds).toHaveLength(2);
		const round2 = persisted.state.rounds.find((r: DeepInterviewRoundRecord) => r.round === 2);
		expect(round2.lifecycle).toBe("answered");
		expect(persisted.state.current_ambiguity).toBe(0.5);
	});

	it("persists a valid scored transition that lowers the dimension and raises ambiguity", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		await appendOrMergeDeepInterviewRound(cwd, statePath, {
			round: 1,
			questionId: "q1",
			questionText: "Q1?",
			dimension: "goal",
		});
		await enrichDeepInterviewRoundScoring(cwd, statePath, {
			round: 1,
			questionId: "q1",
			scores: { goal: 0.5 },
			ambiguity: 0.5,
		});
		await appendOrMergeDeepInterviewRound(cwd, statePath, {
			round: 2,
			questionId: "q2",
			questionText: "Q2?",
			dimension: "goal",
		});
		await enrichDeepInterviewRoundScoring(cwd, statePath, {
			round: 2,
			questionId: "q2",
			scores: { goal: 0.3 },
			ambiguity: 0.62,
			triggers: [trigger()],
		});
		const persisted = JSON.parse(await fs.readFile(statePath, "utf-8"));
		const round2 = persisted.state.rounds.find((r: DeepInterviewRoundRecord) => r.round === 2);
		expect(round2.lifecycle).toBe("scored");
		expect(persisted.state.current_ambiguity).toBe(0.62);
	});

	it("reads a compact slice and migrates legacy on-disk state safely", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		// Legacy envelope lacking rounds/established_facts.
		await fs.writeFile(
			statePath,
			`${JSON.stringify({ skill: "deep-interview", state: { initial_idea: "legacy" } })}\n`,
			"utf-8",
		);
		const compact = await readDeepInterviewStateCompact(statePath);
		expect(compact.established_facts).toEqual([]);
		expect(compact.recent_scored_rounds).toEqual([]);
		expect(compact.pending_shells).toEqual([]);
	});
});
