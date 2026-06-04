import { describe, expect, it } from "bun:test";
import { WorkflowStateEnvelopeSchema } from "@gajae-code/coding-agent/gjc-runtime/state-schema";
import { migrateWorkflowState, normalizeLegacyState } from "../../src/gjc-runtime/state-migrations";
import { WORKFLOW_STATE_VERSION } from "../../src/skill-state/workflow-state-contract";

describe("state migrations", () => {
	it("migrates v1 state to v2, normalizes phase, and preserves extra keys", () => {
		const legacy = {
			version: 1,
			current_phase: "unknown-phase",
			phase: "unknown-phase",
			extra: { nested: true },
			items: ["keep", "all"],
		};

		const result = migrateWorkflowState(legacy, "ralplan");

		expect(result.fromVersion).toBe(1);
		expect(result.toVersion).toBe(WORKFLOW_STATE_VERSION);
		expect(result.changed).toBe(true);
		expect(result.state.version).toBe(WORKFLOW_STATE_VERSION);
		expect(result.state.skill).toBe("ralplan");
		expect(result.state.current_phase).toBe("planner");
		expect(result.state.phase).toBe("planner");
		expect(result.state.extra).toEqual({ nested: true });
		expect(result.state.items).toEqual(["keep", "all"]);
		expect(legacy.version).toBe(1);
		expect(legacy.current_phase).toBe("unknown-phase");
	});

	it("normalizes a missing-version legacy state to v2", () => {
		const result = normalizeLegacyState(
			{
				phase: "planning",
				extra: "preserved",
			},
			"ralplan",
		);

		expect(result.changed).toBe(true);
		expect(result.state.version).toBe(WORKFLOW_STATE_VERSION);
		expect(result.state.skill).toBe("ralplan");
		expect(result.state.active).toBe(true);
		expect(result.state.current_phase).toBe("planner");
		expect(result.state.phase).toBe("planner");
		expect(result.state.extra).toBe("preserved");
	});

	it("is idempotent for v2 state", () => {
		const current = {
			version: WORKFLOW_STATE_VERSION,
			skill: "ralplan",
			current_phase: "planner",
			extra: "keep",
		};

		const result = migrateWorkflowState(current, "ralplan");

		expect(result).toEqual({
			state: current,
			fromVersion: WORKFLOW_STATE_VERSION,
			toVersion: WORKFLOW_STATE_VERSION,
			changed: false,
		});
	});

	it("emits schema-valid migrated envelopes without requiring a checksum", () => {
		const { state } = normalizeLegacyState(
			{
				version: 1,
				current_phase: "unknown-phase",
				receipt: { custom_receipt_key: "keep" },
			},
			"ralplan",
		);

		const parsed = WorkflowStateEnvelopeSchema.safeParse(state);

		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect((parsed.data.receipt as Record<string, unknown>).custom_receipt_key).toBe("keep");
		}
	});

	it("does not throw on empty or unknown-shaped objects", () => {
		expect(() => migrateWorkflowState({}, "ralplan")).not.toThrow();
		expect(() =>
			migrateWorkflowState(
				{
					version: 1,
					current_phase: 123,
					phase: { nested: "wrong shape" },
					receipt: "not an object",
					extra: null,
				},
				"ralplan",
			),
		).not.toThrow();
	});
});
