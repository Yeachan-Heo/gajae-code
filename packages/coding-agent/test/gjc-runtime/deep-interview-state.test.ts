import { describe, expect, it } from "bun:test";
import {
	deriveRoundKey,
	mergeDeepInterviewEnvelope,
	mergeDeepInterviewRounds,
	normalizeDeepInterviewEnvelope,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-state";
import { deriveDeepInterviewHud } from "@gajae-code/coding-agent/skill-state/workflow-hud";

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
