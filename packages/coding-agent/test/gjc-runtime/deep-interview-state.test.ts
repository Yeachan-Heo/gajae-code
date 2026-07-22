import { describe, expect, it } from "bun:test";
import { deriveDeepInterviewHud } from "@gajae-code/coding-agent/skill-state/workflow-hud";
import {
	assertDeepInterviewEnvelopeInputLimits,
	assertDeepInterviewInputWithinLimit,
	assertDeepInterviewIntentReview,
	assertDeepInterviewStructuredResponseWithinLimit,
	createDeepInterviewIntentManifest,
	DEEP_INTERVIEW_FREETEXT_FIELDS,
	deepInterviewObservedIntentDigest,
	deriveRoundKey,
	isDeepInterviewFreeTextField,
	MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH,
	MAX_INITIAL_CONTEXT_LENGTH,
	MAX_USER_RESPONSE_LENGTH,
	mergeDeepInterviewEnvelope,
	mergeDeepInterviewRounds,
	normalizeDeepInterviewEnvelope,
	reviewDeepInterviewIntent,
} from "../../src/gjc-runtime/deep-interview-state";

function inner(envelope: { state?: Record<string, unknown> }): Record<string, unknown> {
	return (envelope.state ?? {}) as Record<string, unknown>;
}

describe("deep-interview-state: normalizeDeepInterviewEnvelope", () => {
	it("hoists flattened legacy transcript fields into nested state and strips the top-level copy", () => {
		const normalized = normalizeDeepInterviewEnvelope({
			skill: "deep-interview",
			current_phase: "interviewing",
			rounds: [{ round_key: "k1", round: 1, lifecycle: "answered" }],
			current_ambiguity: 0.5,
			topology: { last_targeted_component_id: "api" },
			threshold: 0.05,
		});
		expect(inner(normalized).rounds).toEqual([{ round_key: "k1", round: 1, lifecycle: "answered" }]);
		expect(inner(normalized).current_ambiguity).toBe(0.5);
		expect((inner(normalized).topology as Record<string, unknown>).last_targeted_component_id).toBe("api");
		expect("rounds" in normalized).toBe(false);
		expect("current_ambiguity" in normalized).toBe(false);
		expect("topology" in normalized).toBe(false);
		// `threshold` is legitimately dual: kept at the top level and mirrored into state.
		expect(normalized.threshold).toBe(0.05);
		expect(inner(normalized).threshold).toBe(0.05);
	});

	it("is idempotent on an already-canonical envelope", () => {
		const once = normalizeDeepInterviewEnvelope({
			skill: "deep-interview",
			state: { rounds: [{ round_key: "k1", round: 1, lifecycle: "scored", ambiguity: 0.4 }], established_facts: [] },
		});
		const twice = normalizeDeepInterviewEnvelope(once);
		expect(twice).toEqual(once);
	});

	it("defaults rounds/established_facts and preserves unknown fields", () => {
		const normalized = normalizeDeepInterviewEnvelope({
			state: { initial_idea: "x" },
			custom_unknown: { keep: true },
		});
		expect(inner(normalized).rounds).toEqual([]);
		expect(inner(normalized).established_facts).toEqual([]);
		expect(inner(normalized).initial_idea).toBe("x");
		expect(normalized.custom_unknown).toEqual({ keep: true });
	});
});

describe("deep-interview-state: mergeDeepInterviewRounds", () => {
	it("merges scoring into the same durable key without appending", () => {
		const answered = { round_key: "iv::r:1::q:q1", round: 1, lifecycle: "answered", question_hash: "h" };
		const scored = { round_key: "iv::r:1::q:q1", round: 1, lifecycle: "scored", ambiguity: 0.4 };
		const merged = mergeDeepInterviewRounds([answered], [scored]);
		expect(merged).toHaveLength(1);
		expect(merged[0].lifecycle).toBe("scored");
		expect(merged[0].ambiguity).toBe(0.4);
		expect(merged[0].question_hash).toBe("h");
	});

	it("preserves distinct opaque legacy rounds verbatim and dedupes exact copies", () => {
		const a = { n: 1, transcript: "full" };
		const b = { n: 2, transcript: "full" };
		const merged = mergeDeepInterviewRounds([a], [a, b]);
		expect(merged).toEqual([a, b]);
	});

	it("never collapses distinct legacy rounds that share a round number", () => {
		const merged = mergeDeepInterviewRounds(
			[],
			[
				{ round: 1, note: "first" },
				{ round: 1, note: "second" },
			],
		);
		expect(merged).toHaveLength(2);
	});

	it("synthesizes a stable durable key from question_id when round_key is absent", () => {
		const answered = { round: 2, question_id: "q2", lifecycle: "answered" };
		const scored = { round: 2, question_id: "q2", lifecycle: "scored", ambiguity: 0.3 };
		const merged = mergeDeepInterviewRounds([answered], [scored]);
		expect(merged).toHaveLength(1);
		expect(merged[0].round_key).toBe(deriveRoundKey(undefined, { round: 2, questionId: "q2" }));
	});
});

describe("deep-interview-state: mergeDeepInterviewEnvelope", () => {
	it("preserves existing rounds when an incoming partial state omits them", () => {
		const existing = {
			skill: "deep-interview",
			state: {
				rounds: [{ round_key: "k1", round: 1, lifecycle: "scored", ambiguity: 0.5 }],
				established_facts: [],
				interview_id: "iv",
			},
		};
		const merged = mergeDeepInterviewEnvelope(existing, {
			state: { current_ambiguity: 0.4, topology: { last_targeted_component_id: "api" } },
		});
		expect(inner(merged).rounds).toHaveLength(1);
		expect(inner(merged).current_ambiguity).toBe(0.4);
		expect(inner(merged).interview_id).toBe("iv");
		expect("rounds" in merged).toBe(false);
	});

	it("preserves established facts when incoming partial state omits them", () => {
		const facts = [{ id: "f1", statement: "confirmed fact", round: 1, disputed: false }];
		const existing = {
			skill: "deep-interview",
			state: {
				rounds: [{ round_key: "k1", round: 1, lifecycle: "scored", ambiguity: 0.5 }],
				established_facts: facts,
				topology: { status: "confirmed" },
			},
		};

		const nestedPartial = mergeDeepInterviewEnvelope(existing, { state: { current_ambiguity: 0.3 } });
		expect(inner(nestedPartial).established_facts).toEqual(facts);
		expect(inner(nestedPartial).current_ambiguity).toBe(0.3);
		expect(inner(nestedPartial).rounds).toHaveLength(1);

		const topLevelPartial = mergeDeepInterviewEnvelope(existing, { current_phase: "handoff" });
		expect(inner(topLevelPartial).established_facts).toEqual(facts);
		expect(topLevelPartial.current_phase).toBe("handoff");
	});

	it("allows explicit established facts replacement", () => {
		const existing = {
			state: {
				rounds: [],
				established_facts: [{ id: "f1", statement: "old fact", round: 1, disputed: false }],
			},
		};

		const merged = mergeDeepInterviewEnvelope(existing, { state: { established_facts: [] } });
		expect(inner(merged).established_facts).toEqual([]);
	});

	it("replace returns the normalized incoming envelope", () => {
		const merged = mergeDeepInterviewEnvelope(
			{ state: { rounds: [{ round_key: "k1" }] } },
			{ active: false },
			{ replace: true },
		);
		expect(inner(merged).rounds).toEqual([]);
		expect(merged.active).toBe(false);
	});
});

describe("deep-interview-state: deriveDeepInterviewHud", () => {
	function chipMap(payload: Record<string, unknown>, options?: Parameters<typeof deriveDeepInterviewHud>[1]) {
		const hud = deriveDeepInterviewHud(payload, options);
		return Object.fromEntries((hud.chips ?? []).map(chip => [chip.label, chip.value]));
	}

	it("derives round/ambiguity/threshold and topology-aware target+weakest", () => {
		const chips = chipMap({
			current_phase: "interviewing",
			state: {
				rounds: [{ round_key: "k1" }, { round_key: "k2" }],
				current_ambiguity: 0.42,
				threshold: 0.05,
				topology: {
					last_targeted_component_id: "api",
					components: [
						{ id: "api", status: "active", weakest_dimension: "constraints" },
						{ id: "ui", status: "active", weakest_dimension: "goal" },
					],
				},
			},
		});
		expect(chips.round).toBe("2");
		expect(chips.ambiguity).toBe("42%/5%");
		expect(chips.target).toBe("api");
		expect(chips.weakest).toBe("constraints");
	});

	it("omits target and weakest chips for legacy_missing topology", () => {
		const chips = chipMap({
			current_phase: "interviewing",
			state: { rounds: [], current_ambiguity: 1, topology: { status: "legacy_missing" } },
		});
		expect(Object.keys(chips)).not.toContain("target");
		expect(Object.keys(chips)).not.toContain("weakest");
	});

	it("falls back to the latest scored round ambiguity when current_ambiguity is absent", () => {
		const chips = chipMap({
			state: {
				rounds: [
					{ round_key: "k1", lifecycle: "scored", ambiguity: 0.6 },
					{ round_key: "k2", lifecycle: "answered" },
				],
			},
		});
		expect(chips.ambiguity).toBe("60%");
	});
});

describe("deep-interview-state: deriveDeepInterviewHud legacy_missing topology", () => {
	it("omits target/weakest even when legacy_missing topology carries stale fields", () => {
		const hud = deriveDeepInterviewHud({
			current_phase: "interviewing",
			state: {
				rounds: [{ round_key: "k1" }],
				current_ambiguity: 0.7,
				topology: {
					status: "legacy_missing",
					last_targeted_component_id: "stale-api",
					components: [{ id: "stale-api", status: "active", weakest_dimension: "goal" }],
				},
			},
		});
		const labels = (hud.chips ?? []).map(chip => chip.label);
		expect(labels).not.toContain("target");
		expect(labels).not.toContain("weakest");
		expect(labels).toContain("round");
	});
});

describe("deep-interview-state: intent contract", () => {
	const lockedItems = [
		{ id: "artifact:report", category: "artifact" as const, statement: "Produce an audit report" },
		{ id: "surface:review", category: "surface" as const, statement: "Provide the reviewer UI" },
		{ id: "integration:export", category: "integration" as const, statement: "Export to the archive" },
		{ id: "constraint:retention", category: "constraint" as const, statement: "Retain records for seven years" },
	];

	it("creates a deterministic category-prefixed Round 0 manifest", () => {
		const confirmation = { round: 0 as const, answer_hash: "a".repeat(64) };
		const forward = createDeepInterviewIntentManifest(lockedItems, confirmation);
		const reverse = createDeepInterviewIntentManifest([...lockedItems].reverse(), confirmation);
		expect(reverse).toEqual(forward);
		expect(forward.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(() =>
			createDeepInterviewIntentManifest(
				[{ id: "surface:wrong", category: "artifact", statement: "Mismatched prefix" }],
				confirmation,
			),
		).toThrow("invalid intent category");
	});

	it("validates redacted approval evidence, substitutions, and deterministic observed digests", () => {
		const answerHash = "a".repeat(64);
		const locked = createDeepInterviewIntentManifest(lockedItems, { round: 0, answer_hash: answerHash });
		const observed = lockedItems.filter(item => item.id !== "integration:export");
		const approved = reviewDeepInterviewIntent(locked, observed, {
			status: "approved",
			supporting_substitutions: [
				{
					removed_id: "integration:export",
					replacement_ids: ["artifact:report"],
					rationale: "The report is delivered directly to the archive",
				},
			],
			approval_round: 3,
			answer_hash: "b".repeat(64),
			user_answer_evidence: `answer_hash:${"b".repeat(64)}`,
		});
		expect(approved.removed_locked_ids).toEqual(["integration:export"]);
		expect(approved.locked_digest).toBe(locked.digest);
		expect(approved.observed_digest).toBe(deepInterviewObservedIntentDigest(observed.map(item => item.id)));
		expect(approved.user_answer_evidence).not.toContain("archive");

		const recorded = [{ round: 3, answer_hash: "b".repeat(64) }];

		for (const input of [
			{ ...approved, status: "unknown" },
			{ ...approved, approval_round: Number.NaN },
			{ ...approved, approval_round: 0 },
			{ ...approved, approval_round: 1.5 },
			{ ...approved, answer_hash: "not-a-hash" },
			{ ...approved, user_answer_evidence: "Approved replacement" },
			{ ...approved, user_answer_evidence: `answer_hash:${"b".repeat(65)}` },
			{
				...approved,
				supporting_substitutions: [{ ...approved.supporting_substitutions[0], replacement_ids: ["missing:id"] }],
			},
			{
				...approved,
				supporting_substitutions: [approved.supporting_substitutions[0], approved.supporting_substitutions[0]],
			},
		]) {
			expect(() =>
				assertDeepInterviewIntentReview(
					input,
					locked,
					observed.map(item => item.id),
					recorded,
				),
			).toThrow();
		}

		expect(() =>
			assertDeepInterviewIntentReview(
				{ ...approved, unexpected: true },
				locked,
				observed.map(item => item.id),
				recorded,
			),
		).toThrow("invalid intent review");
		expect(() =>
			assertDeepInterviewIntentReview(
				{ ...approved, approval_round: 4 },
				locked,
				observed.map(item => item.id),
				recorded,
			),
		).toThrow("approval evidence is invalid");
	});

	it("does not require approval when the observed manifest preserves every locked intent", () => {
		const locked = createDeepInterviewIntentManifest(lockedItems, { round: 0, answer_hash: "a".repeat(64) });
		const review = reviewDeepInterviewIntent(
			locked,
			[
				...lockedItems,
				{
					id: "surface:admin",
					category: "surface",
					statement: "Add an administrator view",
				},
			],
			{
				status: "not_required",
				supporting_substitutions: [],
			},
		);
		expect(review.removed_locked_ids).toEqual([]);
	});
	it("rejects locked contract replacement and deletion through shared merges", () => {
		const locked = createDeepInterviewIntentManifest(lockedItems, { round: 0, answer_hash: "a".repeat(64) });
		const replacement = createDeepInterviewIntentManifest(
			[{ id: "artifact:other", category: "artifact", statement: "Produce another artifact" }],
			{ round: 0, answer_hash: "b".repeat(64) },
		);
		expect(() =>
			mergeDeepInterviewEnvelope(
				{ state: { intent_contract: locked } },
				{ state: { intent_contract: replacement } },
			),
		).toThrow("cannot be replaced");
		expect(() =>
			mergeDeepInterviewEnvelope({ state: { intent_contract: locked } }, { state: { intent_contract: null } }),
		).toThrow("cannot be deleted");
		expect(() =>
			mergeDeepInterviewEnvelope(
				{ state: { intent_contract: locked } },
				{ state: { intent_contract: replacement } },
				{ replace: true },
			),
		).toThrow("cannot be replaced");
		const preserved = mergeDeepInterviewEnvelope(
			{ state: { intent_contract_required: true, intent_contract: locked, stale: true } },
			{ state: { rounds: [] } },
			{ replace: true },
		);
		expect(preserved.state).toMatchObject({ intent_contract_required: true, intent_contract: locked, rounds: [] });
	});
});

describe("deep-interview-state: free-text field allowlist + input size limits", () => {
	it("marks prose fields as free-text and structural fields as not", () => {
		expect(isDeepInterviewFreeTextField("initial_context")).toBe(true);
		expect(isDeepInterviewFreeTextField("user_response")).toBe(true);
		expect(isDeepInterviewFreeTextField("goal")).toBe(true);
		expect(isDeepInterviewFreeTextField("id")).toBe(false);
		expect(isDeepInterviewFreeTextField("category")).toBe(false);
		expect(DEEP_INTERVIEW_FREETEXT_FIELDS.has("description")).toBe(true);
	});

	it("accepts shell metacharacters in free-text prose within the size cap", () => {
		const prose = "run `git status`; echo $(pwd) | grep x && true";
		expect(() => assertDeepInterviewInputWithinLimit(prose, MAX_USER_RESPONSE_LENGTH, "user_response")).not.toThrow();
	});

	it("enforces the size caps", () => {
		expect(() =>
			assertDeepInterviewInputWithinLimit(
				"x".repeat(MAX_INITIAL_CONTEXT_LENGTH + 1),
				MAX_INITIAL_CONTEXT_LENGTH,
				"initial_context",
			),
		).toThrow(/exceeds max length/);
		expect(() =>
			assertDeepInterviewInputWithinLimit("x".repeat(MAX_USER_RESPONSE_LENGTH), MAX_USER_RESPONSE_LENGTH),
		).not.toThrow();
	});

	it("bounds one serialized structured response using JavaScript Unicode string length", () => {
		const propertyOverhead = JSON.stringify({ response: "" }).length;
		const exact = { response: "한".repeat(MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH - propertyOverhead) };
		const oversized = { response: "한".repeat(MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH - propertyOverhead + 1) };

		expect(JSON.stringify(exact)).toHaveLength(MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH);
		expect(() => assertDeepInterviewStructuredResponseWithinLimit(exact)).not.toThrow();
		expect(JSON.stringify(oversized)).toHaveLength(MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH + 1);
		expect(() => assertDeepInterviewStructuredResponseWithinLimit(oversized)).toThrow(
			"structured deep-interview response exceeds max length 100000",
		);
	});

	it("allows optional undefined object fields that JSON serialization omits", () => {
		expect(() =>
			assertDeepInterviewStructuredResponseWithinLimit({
				question: "What is the boundary?",
				round_id: undefined,
				customInput: undefined,
			}),
		).not.toThrow();
	});
	it("rejects non-serializable structured responses", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => assertDeepInterviewStructuredResponseWithinLimit(cyclic)).toThrow(
			"invalid structured deep-interview response",
		);
	});

	it("bounds legacy round answer aliases before persistence without constraining generated answer objects", () => {
		const exact = "😀".repeat(MAX_USER_RESPONSE_LENGTH);
		for (const field of ["custom_input", "customInput", "user_response", "answer"] as const) {
			expect(() =>
				assertDeepInterviewEnvelopeInputLimits({ state: { rounds: [{ [field]: exact }] } }),
			).not.toThrow();
			expect(() =>
				assertDeepInterviewEnvelopeInputLimits({ state: { rounds: [{ [field]: `${exact}😀` }] } }),
			).toThrow(`state.rounds[0].${field} exceeds max length 10000`);
		}
		expect(() =>
			assertDeepInterviewEnvelopeInputLimits({ state: { rounds: [{ lifecycle: "scored", answer: { score: 1 } }] } }),
		).not.toThrow();
	});

	it("pins the documented cap values", () => {
		expect(MAX_INITIAL_CONTEXT_LENGTH).toBe(50_000);
		expect(MAX_USER_RESPONSE_LENGTH).toBe(10_000);
		expect(MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH).toBe(100_000);
	});
});
