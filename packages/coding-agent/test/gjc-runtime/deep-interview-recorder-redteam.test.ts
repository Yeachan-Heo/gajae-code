import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	answerHash,
	appendOrMergeDeepInterviewRound,
	buildAnswerShell,
	type DeepInterviewRoundRecord,
	type DeepInterviewTriggerMetadata,
	deriveRoundKey,
	enrichDeepInterviewRoundScoring,
	readDeepInterviewStateCompact,
	validateDeepInterviewScoredTransition,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-recorder";
import { askSchema } from "@gajae-code/coding-agent/tools/ask";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-deep-interview-recorder-redteam-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function statePathFor(cwd: string): string {
	return path.join(cwd, ".gjc", "state", "deep-interview-state.json");
}

async function readPersistedRounds(statePath: string): Promise<DeepInterviewRoundRecord[]> {
	const persisted = JSON.parse(await fs.readFile(statePath, "utf-8"));
	return persisted.state.rounds;
}

function answerInput(over: Partial<Parameters<typeof appendOrMergeDeepInterviewRound>[2]> = {}) {
	return {
		interviewId: "iv-redteam",
		round: 1,
		questionId: "q1",
		questionText: "Which entity owns the workflow?",
		component: "conflict-detection",
		dimension: "goal",
		ambiguity: 0.5,
		selectedOptions: ["A"],
		...over,
	};
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

function scoredRound(over: Partial<DeepInterviewRoundRecord> = {}): DeepInterviewRoundRecord {
	return {
		...buildAnswerShell(
			{
				interviewId: "iv-redteam",
				round: 1,
				questionId: "q1",
				questionText: "Which entity owns the workflow?",
				selectedOptions: ["A"],
				component: "conflict-detection",
				dimension: "goal",
				ambiguity: 0.5,
			},
			"2026-01-01T00:00:00.000Z",
		),
		lifecycle: "scored",
		scores: { goal: 0.5 },
		ambiguity: 0.5,
		...over,
	};
}

describe("deep-interview recorder redteam: corrupt state is fail-closed (not overwritten)", () => {
	it.each([
		["malformed JSON", "{ not json"],
		["valid JSON non-object", "42"],
	])("rejects recording against %s and preserves the corrupt file for recovery", async (_name, corruptContent) => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(statePath, corruptContent, "utf-8");

		// Fail closed: recording must not silently overwrite corrupt/tampered state.
		await expect(appendOrMergeDeepInterviewRound(cwd, statePath, answerInput())).rejects.toThrow(
			/corrupt or tampered/,
		);

		// The corrupt file is preserved unchanged for recovery.
		expect(await fs.readFile(statePath, "utf-8")).toBe(corruptContent);
	});
});

describe("deep-interview recorder redteam: persistence merge invariants", () => {
	it("replace-then-enrich keeps exactly one record and enriches the replacement answer", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		await appendOrMergeDeepInterviewRound(cwd, statePath, answerInput({ selectedOptions: ["A"] }));

		const replaced = await appendOrMergeDeepInterviewRound(cwd, statePath, answerInput({ selectedOptions: ["B"] }));
		expect(replaced.action).toBe("replaced");
		let rounds = await readPersistedRounds(statePath);
		expect(rounds).toHaveLength(1);
		expect(rounds[0].answer_hash).toBe(answerHash(["B"], undefined));

		await enrichDeepInterviewRoundScoring(cwd, statePath, {
			interviewId: "iv-redteam",
			round: 1,
			questionId: "q1",
			scores: { goal: 0.35 },
			ambiguity: 0.7,
		});

		rounds = await readPersistedRounds(statePath);
		expect(rounds).toHaveLength(1);
		expect(rounds[0].lifecycle).toBe("scored");
		expect(rounds[0].answer_hash).toBe(answerHash(["B"], undefined));
	});

	it("idempotent replay across persistence returns noop and does not append", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		const first = await appendOrMergeDeepInterviewRound(cwd, statePath, answerInput());
		const second = await appendOrMergeDeepInterviewRound(cwd, statePath, answerInput());

		expect(first.action).toBe("created");
		expect(second.action).toBe("noop");
		expect(await readPersistedRounds(statePath)).toHaveLength(1);
	});
});

describe("deep-interview recorder redteam: validator bypass attempts", () => {
	it("does not falsely pass when active ambiguity is present but not raised, even if affected score is absent", () => {
		const prior = scoredRound({ scores: { goal: 0.5 }, ambiguity: 0.5 });
		const next = scoredRound({
			round: 2,
			question_id: "q2",
			scores: { audience: 0.1 },
			ambiguity: 0.5,
			triggers: [trigger({ dimension: "goal" })],
		});

		const result = validateDeepInterviewScoredTransition(prior, next);
		expect(result.ok).toBe(false);
		expect(result.violations.join(" ")).toContain("did not raise ambiguity");
	});

	it("fails active triggers when transition metrics are missing", () => {
		const prior = scoredRound({ scores: { goal: 0.5 }, ambiguity: 0.5 });
		const next = scoredRound({
			round: 2,
			question_id: "q2",
			scores: { audience: 0.1 },
			ambiguity: undefined,
			triggers: [trigger({ dimension: "goal" })],
		});

		const result = validateDeepInterviewScoredTransition(prior, next);
		expect(result.ok).toBe(false);
		expect(result.violations.join(" ")).toMatch(/missing ambiguity metrics|missing dimension/);
	});

	it("fails disputed triggers with empty-string rationale", () => {
		const result = validateDeepInterviewScoredTransition(
			scoredRound(),
			scoredRound({
				round: 2,
				question_id: "q2",
				scores: { goal: 0.9 },
				ambiguity: 0.1,
				triggers: [trigger({ status: "disputed", rationale: "   " })],
			}),
		);

		expect(result.ok).toBe(false);
		expect(result.violations.join(" ")).toContain("has no rationale");
	});
});

describe("deep-interview recorder redteam: out-of-order re-score never compares against a future round", () => {
	it("re-scoring an earlier round compares against its chronological predecessor, not a later scored round", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);

		// Round 1: chronological predecessor — low ambiguity, high goal clarity.
		await appendOrMergeDeepInterviewRound(cwd, statePath, answerInput({ round: 1, questionId: "q1" }));
		await enrichDeepInterviewRoundScoring(cwd, statePath, {
			interviewId: "iv-redteam",
			round: 1,
			questionId: "q1",
			scores: { goal: 0.6 },
			ambiguity: 0.4,
		});

		// Round 2: answered shell, deferred for an out-of-order re-score below.
		await appendOrMergeDeepInterviewRound(cwd, statePath, answerInput({ round: 2, questionId: "q2" }));

		// Round 3: a LATER scored round with high ambiguity / low goal clarity. If the
		// validator compared against the latest round in array order, this "future" round
		// would be picked as the baseline for round 2.
		await appendOrMergeDeepInterviewRound(cwd, statePath, answerInput({ round: 3, questionId: "q3" }));
		await enrichDeepInterviewRoundScoring(cwd, statePath, {
			interviewId: "iv-redteam",
			round: 3,
			questionId: "q3",
			scores: { goal: 0.2 },
			ambiguity: 0.9,
		});

		// Re-score round 2 with an active goal trigger. This transition is VALID against
		// round 1 (ambiguity rises 0.4 -> 0.5, goal does not improve 0.6 -> 0.5) but would
		// be INVALID against the future round 3 (ambiguity 0.9 -> 0.5 does not rise; goal
		// 0.2 -> 0.5 improves). It must succeed, proving the chronological prior is used.
		await enrichDeepInterviewRoundScoring(cwd, statePath, {
			interviewId: "iv-redteam",
			round: 2,
			questionId: "q2",
			scores: { goal: 0.5 },
			ambiguity: 0.5,
			triggers: [trigger({ dimension: "goal" })],
		});

		const rounds = await readPersistedRounds(statePath);
		const round2 = rounds.find(r => r.round === 2);
		expect(round2?.lifecycle).toBe("scored");
		expect(round2?.ambiguity).toBe(0.5);
		// Round 3 stays untouched as the later scored round.
		expect(rounds.find(r => r.round === 3)?.lifecycle).toBe("scored");
	});
});

describe("deep-interview recorder redteam: round_key collision safety", () => {
	it("keeps different question ids in the same round distinct", () => {
		expect(deriveRoundKey("iv-redteam", { round: 4, questionId: "q-left" })).not.toBe(
			deriveRoundKey("iv-redteam", { round: 4, questionId: "q-right" }),
		);
	});

	it("round_id deliberately forces the same key even if round and question id differ", () => {
		expect(deriveRoundKey("iv-redteam", { round_id: "stable", round: 4, questionId: "q-left" })).toBe(
			deriveRoundKey("iv-redteam", { round_id: "stable", round: 99, questionId: "q-right" }),
		);
	});
});

describe("deep-interview recorder redteam: ask schema boundaries", () => {
	function askWithDeepInterview(deepInterview?: unknown) {
		return {
			questions: [
				{
					id: "q1",
					question: "Q?",
					options: [{ label: "A" }],
					...(deepInterview === undefined ? {} : { deepInterview }),
				},
			],
		};
	}

	it.each([
		["ambiguity below zero", { round: 1, component: "c", dimension: "goal", ambiguity: -0.001 }],
		["ambiguity above one", { round: 1, component: "c", dimension: "goal", ambiguity: 1.001 }],
		["non-integer round", { round: 1.5, component: "c", dimension: "goal", ambiguity: 0.5 }],
		["negative round", { round: -1, component: "c", dimension: "goal", ambiguity: 0.5 }],
		["empty dimension", { round: 1, component: "c", dimension: "", ambiguity: 0.5 }],
	])("rejects %s", (_name, deepInterview) => {
		expect(askSchema.safeParse(askWithDeepInterview(deepInterview)).success).toBe(false);
	});

	it("accepts well-formed metadata and absent metadata", () => {
		expect(
			askSchema.safeParse(
				askWithDeepInterview({
					round_id: "rid-1",
					round: 0,
					component: "conflict-detection",
					dimension: "goal",
					ambiguity: 1,
				}),
			).success,
		).toBe(true);
		expect(askSchema.safeParse(askWithDeepInterview()).success).toBe(true);
	});
});

describe("deep-interview recorder redteam: compact read transcript minimization", () => {
	it("returns only lastN scored rounds and separates all pending shells", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);

		for (let round = 1; round <= 6; round++) {
			await appendOrMergeDeepInterviewRound(
				cwd,
				statePath,
				answerInput({ round, questionId: `q${round}`, questionText: `Scored question ${round}?` }),
			);
			await enrichDeepInterviewRoundScoring(cwd, statePath, {
				interviewId: "iv-redteam",
				round,
				questionId: `q${round}`,
				scores: { goal: 1 - round / 10 },
				ambiguity: round / 10,
			});
		}
		for (let round = 7; round <= 9; round++) {
			await appendOrMergeDeepInterviewRound(
				cwd,
				statePath,
				answerInput({ round, questionId: `q${round}`, questionText: `Pending question ${round}?` }),
			);
		}

		const compact = await readDeepInterviewStateCompact(statePath, { lastN: 2 });
		expect(compact.recent_scored_rounds.map(r => r.round)).toEqual([5, 6]);
		expect(compact.pending_shells.map(r => r.round)).toEqual([7, 8, 9]);
		expect(compact.recent_scored_rounds.some(r => r.round < 5)).toBe(false);
		expect(compact.current_ambiguity).toBe(0.6);
	});
});
