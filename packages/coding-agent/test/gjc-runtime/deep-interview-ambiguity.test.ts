import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deriveAmbiguityMilestone } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-ambiguity";
import {
	answerHash,
	appendOrMergeDeepInterviewRound,
	applyAmbiguityFloorToEnvelope,
	clampReportedAmbiguity,
	computeAmbiguityFloor,
	disputeFactsFromRetractedRound,
	enrichDeepInterviewRoundScoring,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-recorder";
import { runDeepInterviewRepairCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-repair";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import {
	applyDeepInterviewRoundResultV1,
	canonicalDeepInterviewJson,
	deepInterviewRoundResultDigest,
	validateDeepInterviewV1Envelope,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-state";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import {
	verifyWorkflowEnvelopeReceiptValue,
	workflowEnvelopeContentSha256,
} from "@gajae-code/coding-agent/gjc-runtime/state-writer";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];
let priorSessionId: string | undefined;

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-deep-interview-ambiguity-"));
	tempRoots.push(dir);
	return dir;
}
async function seedRecorderState(cwd: string): Promise<void> {
	const result = await runNativeDeepInterviewCommand(["--json", "seed recorder state"], cwd);
	expect(result.status).toBe(0);
	const initialized = await runDeepInterviewRepairCommand(
		[
			"initialize-context",
			"--session-id",
			TEST_SESSION_ID,
			"--schema-version",
			"1",
			"--expected-revision",
			"0",
			"--input-json",
			'{"type":"greenfield","threshold":0.05}',
			"--json",
		],
		cwd,
	);
	expect(initialized.status).toBe(0);
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
				{ id: "a", status: "active", clarity_scores: { goal: 0.9, constraints: 0.8, criteria: 0.9, context: 0.9 } },
				{
					id: "b",
					status: "active",
					clarity_scores: { goal: 0.9, constraints: null, criteria: 0.9, context: 0.9 },
				},
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
		expect(breakdown.floor).toBe(0.025);
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
		await seedRecorderState(cwd);
		await appendOrMergeDeepInterviewRound(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", questionText: "Q1?" },
			{ sessionId: TEST_SESSION_ID },
		);
		const write = await runNativeStateCommand(
			[
				"write",
				"--mode",
				"deep-interview",
				"--input",
				JSON.stringify({ state: { established_facts: [fact({ disputed: true })] } }),
			],
			cwd,
		);
		expect(write.status).toBe(0);

		const { record } = await enrichDeepInterviewRoundScoring(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", scores: { goal: 0.95, constraints: 0.95, criteria: 0.95 }, ambiguity: 0.03 },
			{ sessionId: TEST_SESSION_ID },
		);
		expect(record.ambiguity).toBe(0.1);
		expect(record.reported_ambiguity).toBe(0.05);
		expect(record.ambiguity_floor).toBe(0.1);
		const after = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(after.state.current_ambiguity).toBe(0.1);
		expect(after.state.ambiguity_floor.disputed_fact_count).toBe(1);
	});

	it("rejects retraction of a scored answer, preserving its facts and state", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		await seedRecorderState(cwd);
		const input = { round: 1, questionId: "q1", questionText: "Q1?", selectedOptions: ["A"] };
		await appendOrMergeDeepInterviewRound(cwd, statePath, input, { sessionId: TEST_SESSION_ID });
		await enrichDeepInterviewRoundScoring(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", scores: { goal: 0.9, constraints: 0.9, criteria: 0.9 }, ambiguity: 0.06 },
			{ sessionId: TEST_SESSION_ID },
		);
		// The scored round established a fact.
		const write = await runNativeStateCommand(
			[
				"write",
				"--mode",
				"deep-interview",
				"--input",
				JSON.stringify({ state: { established_facts: [fact({ round: 1 })] } }),
			],
			cwd,
		);
		expect(write.status).toBe(0);

		// A scored answer is immutable evidence; retraction is rejected rather than
		// rewriting its answer or mutating the facts it established.
		await expect(
			appendOrMergeDeepInterviewRound(
				cwd,
				statePath,
				{ ...input, selectedOptions: ["B"] },
				{ sessionId: TEST_SESSION_ID },
			),
		).rejects.toThrow("DI_ANSWER_LIFECYCLE_CONFLICT");
		const after = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(after.state.established_facts[0].disputed).toBe(false);
		expect(after.state.rounds[0].answer_hash).toBe(answerHash(["A"], undefined));
		expect(after.state.current_ambiguity).toBe(0.1);
	});

	it("superseding the disputed fact releases the floor so convergence can resume", async () => {
		const cwd = await tempDir();
		const statePath = statePathFor(cwd);
		await seedRecorderState(cwd);
		await appendOrMergeDeepInterviewRound(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", questionText: "Q1?" },
			{ sessionId: TEST_SESSION_ID },
		);
		const write = await runNativeStateCommand(
			[
				"write",
				"--mode",
				"deep-interview",
				"--input",
				JSON.stringify({
					state: {
						established_facts: [
							fact({ disputed: true, superseded_by: "f9" }),
							fact({ id: "f9", statement: "Core entity is Project", round: 2 }),
						],
					},
				}),
			],
			cwd,
		);
		expect(write.status).toBe(0);

		const { record } = await enrichDeepInterviewRoundScoring(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", scores: { goal: 0.97, constraints: 0.97, criteria: 0.97 }, ambiguity: 0.03 },
			{ sessionId: TEST_SESSION_ID },
		);
		expect(record.ambiguity).toBe(0.03);
		expect(record.reported_ambiguity).toBe(0.03);
		const after = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(after.state.current_ambiguity).toBe(0.03);
	});
});
describe("deep-interview v1 core contracts", () => {
	it("uses ready-first milestones, canonical round digests, and value receipt classification", () => {
		expect(deriveAmbiguityMilestone(3_000, 3_000)).toBe("ready");
		expect(deriveAmbiguityMilestone(3_100, 3_000)).toBe("progress");
		expect(deriveAmbiguityMilestone(6_000, 5_000)).toBe("progress");
		expect(deriveAmbiguityMilestone(7_000, 8_000)).toBe("ready");
		const result = { z: ["x"], a: { beta: 2, alpha: 1 } };
		expect(deepInterviewRoundResultDigest({ round: 1, question_id: "q", result })).toBe(
			deepInterviewRoundResultDigest({ result: { a: { alpha: 1, beta: 2 }, z: ["x"] }, round: 1, question_id: "q" }),
		);
		expect(canonicalDeepInterviewJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');

		const filePath = "/tmp/state.json";
		const envelope = {
			skill: "deep-interview",
			schema_version: 1,
			receipt: {
				version: 1,
				skill: "deep-interview",
				owner: "gjc-runtime",
				command: "gjc deep-interview",
				state_path: "/tmp/active.json",
				storage_path: filePath,
				mutated_at: "2026-01-01T00:00:00.000Z",
				fresh_until: "2026-01-01T00:30:00.000Z",
				status: "fresh",
				mutation_id: "m1",
				content_sha256: {
					algorithm: "sha256",
					value: "",
					covered_path: filePath,
					computed_at: "2026-01-01T00:00:00.000Z",
				},
			},
		};
		envelope.receipt.content_sha256.value = workflowEnvelopeContentSha256(envelope);
		expect(verifyWorkflowEnvelopeReceiptValue(envelope, filePath)).toBe("native-valid");
		const mismatchedSkill = structuredClone(envelope);
		mismatchedSkill.receipt.skill = "ralplan";
		mismatchedSkill.receipt.content_sha256.value = workflowEnvelopeContentSha256(mismatchedSkill);
		expect(verifyWorkflowEnvelopeReceiptValue(mismatchedSkill, filePath)).toBe("receipt-malformed");
		const normalizedPaths = structuredClone(envelope);
		normalizedPaths.receipt.storage_path = "/tmp/../tmp/state.json";
		normalizedPaths.receipt.content_sha256.covered_path = "/tmp/../tmp/state.json";
		normalizedPaths.receipt.content_sha256.value = workflowEnvelopeContentSha256(normalizedPaths);
		expect(verifyWorkflowEnvelopeReceiptValue(normalizedPaths, filePath)).toBe("native-valid");
		const invalidComputedAt = structuredClone(envelope);
		invalidComputedAt.receipt.content_sha256.computed_at = "not-a-date";
		invalidComputedAt.receipt.content_sha256.value = workflowEnvelopeContentSha256(invalidComputedAt);
		expect(verifyWorkflowEnvelopeReceiptValue(invalidComputedAt, filePath)).toBe("receipt-malformed");
		expect(verifyWorkflowEnvelopeReceiptValue({ skill: "deep-interview", schema_version: 1 }, filePath)).toBe(
			"receipt-missing",
		);
		expect(verifyWorkflowEnvelopeReceiptValue({ receipt: null }, filePath)).toBe("receipt-malformed");
		expect(verifyWorkflowEnvelopeReceiptValue({ skill: "other" }, filePath)).toBe("legacy");
	});
	it("persists component scores before flooring and validates v1 lifecycle safety", () => {
		const envelope = {
			skill: "deep-interview",
			schema_version: 1,
			state: {
				type: "greenfield",
				threshold: 0.3,
				current_ambiguity: 0.2,
				rounds: [
					{
						round_key: "r1",
						round: 1,
						question_id: "q1",
						question_text: "Question?",
						question_hash: "question",
						answer_hash: "answer",
						lifecycle: "answered",
						answered_at: "2026-01-01T00:00:00.000Z",
					},
				],
				established_facts: [],
				topology: { status: "confirmed", components: [{ id: "core", active: true }] },
			},
		};
		const result = {
			global_scores: { goal: 0.2, constraints: 0.3, criteria: 0.4, context: 0.5 },
			component_scores: { core: { goal: 0.2, constraints: 0.3, criteria: 0.4, context: 0.5 } },
			ontology: [],
		};
		const applied = applyDeepInterviewRoundResultV1(envelope, "r1", result, "2026-01-01T00:01:00.000Z");
		expect(applied.kind).toBe("write");
		if (applied.kind !== "write") throw new Error("expected write");
		expect(
			(applied.envelope.state?.topology as { components: { clarity_scores: unknown }[] }).components[0]
				.clarity_scores,
		).toEqual(result.component_scores.core);
		expect((applied.envelope.state?.floor as number) ?? 0).toBe(0);
		expect(applied.projection.score_units).toEqual({
			goal: 2_000,
			constraints: 3_000,
			criteria: 4_000,
		});
		expect(applied.projection.transition).toEqual({
			round_key: "r1",
			lifecycle: "scored",
			auto_answer_streak: 0,
		});
		expect(applied.projection.targeting).toEqual({
			target_component_id: "core",
			target_dimension: "goal",
			last_targeted_component_id: "core",
		});
		expect(applied.projection.ontology_counts).toEqual({ stable: 0, changed: 0, new: 0, basis: "no_entities" });
		expect(applied.projection.direction).toBe("initial");
		validateDeepInterviewV1Envelope(applied.envelope as Record<string, unknown>);

		const invalid = structuredClone(applied.envelope) as Record<string, unknown>;
		delete (invalid.state as { rounds: Record<string, unknown>[] }).rounds[0].round_result_digest;
		expect(() => validateDeepInterviewV1Envelope(invalid)).toThrow("DI_STATE_SCHEMA_INVALID");
		const replay = applyDeepInterviewRoundResultV1(applied.envelope, "r1", result, "2026-01-01T00:02:00.000Z");
		expect(replay.kind).toBe("noop");
		expect(() =>
			applyDeepInterviewRoundResultV1(
				applied.envelope,
				"r1",
				{ ...result, global_scores: { ...result.global_scores, goal: 0.1 } },
				"2026-01-01T00:02:00.000Z",
			),
		).toThrow("DI_ROUND_RESULT_CONFLICT");
	});
});
