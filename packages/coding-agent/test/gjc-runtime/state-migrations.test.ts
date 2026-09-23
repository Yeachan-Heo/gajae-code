import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkflowStateEnvelopeSchema } from "@gajae-code/coding-agent/gjc-runtime/state-schema";
import {
	migrateAndPersistLegacyState,
	migrateWorkflowState,
	normalizeLegacyState,
} from "../../src/gjc-runtime/state-migrations";
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

	it("rejects malformed explicit versions without persisting or revoking authority", async () => {
		const invalidVersions: unknown[] = [
			"1",
			"2",
			1.5,
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			"NaN",
			null,
			undefined,
			true,
			{},
		];
		for (const version of invalidVersions) {
			const state = {
				version,
				active: true,
				current_phase: "handoff",
				spec_path: "/tmp/approved.md",
				state: {
					crystal: { lifecycle: "ready" },
					execution_approval: "approved",
					execution_approval_receipt: { method: "explicit-state-action" },
				},
			};

			expect(() => migrateWorkflowState(state, "deep-interview")).toThrow("invalid explicit version");
			expect(() => normalizeLegacyState(state, "deep-interview")).toThrow("invalid explicit version");
			expect(state.spec_path).toBe("/tmp/approved.md");
			expect(state.state.crystal).toEqual({ lifecycle: "ready" });
			expect(state.state.execution_approval).toBe("approved");
		}

		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-migration-invalid-version-"));
		const statePath = path.join(cwd, ".gjc", "state", "deep-interview.json");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		const persistedState = {
			version: "1",
			active: true,
			current_phase: "handoff",
			spec_path: "/tmp/approved.md",
			state: {
				crystal: { lifecycle: "ready" },
				execution_approval: "approved",
				execution_approval_receipt: { method: "explicit-state-action" },
			},
		};
		const before = `${JSON.stringify(persistedState)}\n`;
		try {
			await fs.writeFile(statePath, before);
			await expect(
				migrateAndPersistLegacyState({
					cwd,
					skill: "deep-interview",
					statePath: path.relative(cwd, statePath),
					sessionId: "test-session",
				}),
			).rejects.toThrow("invalid explicit version");
			expect(await fs.readFile(statePath, "utf-8")).toBe(before);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("continues to reject genuine future numeric versions", () => {
		expect(() => migrateWorkflowState({ version: WORKFLOW_STATE_VERSION + 1 }, "ralplan")).toThrow(
			"unsupported future version",
		);
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

	it("preserves current-version deep-interview Crystal authorization during migration", () => {
		const current = {
			version: WORKFLOW_STATE_VERSION,
			skill: "deep-interview",
			active: true,
			current_phase: "handoff",
			updated_at: "2026-01-01T00:00:00.000Z",
			spec_path: "/tmp/deep-interview-approved.md",
			spec_sha256: "a".repeat(64),
			spec_slug: "approved",
			spec_stage: "final",
			state: {
				crystal: { lifecycle: "ready", spec_version: 2 },
				execution_approval: "approved",
				execution_approval_receipt: { method: "explicit-state-action" },
			},
		};

		const migrated = migrateWorkflowState(current, "deep-interview");
		expect(migrated.changed).toBe(false);
		expect(migrated.state).toBe(current);

		const normalized = normalizeLegacyState(current, "deep-interview");
		expect(normalized.state.current_phase).toBe("handoff");
		expect(normalized.state.spec_path).toBe(current.spec_path);
		expect((normalized.state.state as Record<string, unknown>).crystal).toEqual(current.state.crystal);
		expect((normalized.state.state as Record<string, unknown>).execution_approval).toBe("approved");
	});

	it("revokes Crystal execution authority from migrated deep-interview state", () => {
		const result = normalizeLegacyState(
			{
				version: 1,
				active: true,
				current_phase: "handoff",
				spec_path: "/tmp/forged.md",
				spec_sha256: "a".repeat(64),
				state: {
					crystal: { lifecycle: "ready" },
					execution_approval: "approved",
					execution_approval_receipt: { method: "explicit-state-action" },
				},
			},
			"deep-interview",
		);

		expect(result.changed).toBe(true);
		expect(result.state.current_phase).toBe("interviewing");
		expect(result.state.spec_path).toBeUndefined();
		expect(result.state.spec_sha256).toBeUndefined();
		const inner = result.state.state as Record<string, unknown>;
		expect(inner.crystal).toBeUndefined();
		expect(inner.execution_approval).toBe("not-approved");
		expect(inner.execution_approval_receipt).toBeUndefined();
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
