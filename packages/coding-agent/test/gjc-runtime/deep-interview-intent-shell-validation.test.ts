import { describe, expect, it } from "bun:test";
import { validateDeepInterviewV1Envelope } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-state";

/**
 * Regression for the deep-interview flake: the Round 0 intent-contract shell
 * deliberately carries the sentinel component `"review-topology"` (see ask.ts /
 * deep-interview-recorder.ts buildAnswerShell). Once topology is confirmed,
 * `hasTopologyComponents` is true and `"review-topology"` is not one of the real
 * component ids, so the component check must exempt the round-zero intent shell
 * exactly as the sibling dimension check already exempts `"topology"`. Without the
 * exemption the whole envelope failed `DI_STATE_SCHEMA_INVALID` depending on the
 * ordering of Round 0 recording vs `confirm-topology`.
 */
function envelopeWithConfirmedTopology(roundComponent: string): Record<string, unknown> {
	return {
		skill: "deep-interview",
		schema_version: 1,
		state: {
			type: "greenfield",
			threshold: 0.05,
			threshold_units: 500,
			established_facts: [],
			topology: {
				status: "confirmed",
				components: [
					{ id: "transport" },
					{ id: "protocol-schema" },
					{ id: "core-api" },
					{ id: "aux-api" },
					{ id: "cli-entrypoint" },
				],
			},
			rounds: [
				{
					round_key: "iv1::r:0::q:intent-confirmation",
					round: 0,
					question_id: "intent-confirmation",
					question_text: "Confirm locked intent",
					question_hash: "a".repeat(64),
					answer_hash: "b".repeat(64),
					answered_at: "2026-01-01T00:00:00.000Z",
					lifecycle: "answered",
					component: roundComponent,
					dimension: "topology",
				},
			],
		},
	};
}

describe("validateDeepInterviewV1Envelope: round-0 intent shell component", () => {
	it("accepts the review-topology sentinel after topology is confirmed", () => {
		expect(() => validateDeepInterviewV1Envelope(envelopeWithConfirmedTopology("review-topology"))).not.toThrow();
	});

	it("still rejects an unknown component on the round-0 shell", () => {
		expect(() => validateDeepInterviewV1Envelope(envelopeWithConfirmedTopology("not-a-component"))).toThrow(
			"DI_STATE_SCHEMA_INVALID",
		);
	});
});
