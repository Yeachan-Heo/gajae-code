import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ModeStateSchema,
	RequiredOnWriteEnvelopeSchema,
	readGjcJson,
	SkillActiveStateSchema,
	WorkflowStateEnvelopeSchema,
} from "@gajae-code/coding-agent/gjc-runtime/state-schema";
import { WORKFLOW_STATE_VERSION } from "@gajae-code/coding-agent/skill-state/workflow-state-contract";

const roots: string[] = [];

async function tempFile(name: string, content: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-schema-"));
	roots.push(dir);
	const file = path.join(dir, name);
	await fs.writeFile(file, content);
	return file;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("state-schema (A1)", () => {
	it("accepts a minimal envelope and preserves unknown keys (lenient/additive)", () => {
		const parsed = WorkflowStateEnvelopeSchema.safeParse({
			skill: "ralplan",
			active: true,
			current_phase: "planner",
			version: 1,
			updated_at: "2026-01-01T00:00:00.000Z",
			rounds: [{ n: 1 }],
			topology: { free: ["form"] },
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect((parsed.data as Record<string, unknown>).rounds).toEqual([{ n: 1 }]);
			expect((parsed.data as Record<string, unknown>).topology).toEqual({ free: ["form"] });
		}
	});

	it("rejects wrong scalar types on known fields", () => {
		expect(WorkflowStateEnvelopeSchema.safeParse({ version: "1" }).success).toBe(false);
		expect(WorkflowStateEnvelopeSchema.safeParse({ active: "yes" }).success).toBe(false);
		expect(WorkflowStateEnvelopeSchema.safeParse({ updated_at: 123 }).success).toBe(false);
	});

	it("RequiredOnWriteEnvelopeSchema requires anchored fields incl. stamped receipt", () => {
		const validReceipt = {
			version: 1,
			skill: "ralplan",
			owner: "gjc-state-cli",
			command: "gjc state ralplan write",
			state_path: "/x/.gjc/state/ralplan-state.json",
			storage_path: "/x/.gjc/state/ralplan-state.json",
			mutated_at: "2026-01-01T00:00:00.000Z",
			fresh_until: "2026-01-01T00:30:00.000Z",
			status: "fresh",
			mutation_id: "ralplan:2026-01-01T00:00:00.000Z",
			content_sha256: {
				algorithm: "sha256",
				value: "abc",
				covered_path: "$",
				computed_at: "2026-01-01T00:00:00.000Z",
			},
		};
		const ok = RequiredOnWriteEnvelopeSchema.safeParse({
			skill: "ralplan",
			version: WORKFLOW_STATE_VERSION,
			updated_at: "2026-01-01T00:00:00.000Z",
			current_phase: "planner",
			active: true,
			receipt: validReceipt,
		});
		expect(ok.success).toBe(true);

		const v1 = RequiredOnWriteEnvelopeSchema.safeParse({
			skill: "ralplan",
			version: 1,
			updated_at: "2026-01-01T00:00:00.000Z",
			current_phase: "planner",
			active: true,
			receipt: validReceipt,
		});
		expect(v1.success).toBe(false);
		// missing content_sha256 -> rejected (write fail-closed depends on this)
		const noChecksum = RequiredOnWriteEnvelopeSchema.safeParse({
			skill: "ralplan",
			version: WORKFLOW_STATE_VERSION,
			updated_at: "2026-01-01T00:00:00.000Z",
			current_phase: "planner",
			active: true,
			receipt: { ...validReceipt, content_sha256: undefined },
		});
		expect(noChecksum.success).toBe(false);
		// missing top-level required field -> rejected
		expect(RequiredOnWriteEnvelopeSchema.safeParse({ skill: "ralplan" }).success).toBe(false);
	});

	it("ModeState and SkillActiveState schemas are lenient", () => {
		expect(ModeStateSchema.safeParse({ active: true, current_phase: "x", extra: 1 }).success).toBe(true);
		expect(ModeStateSchema.safeParse({ active: "no" }).success).toBe(false);
		expect(SkillActiveStateSchema.safeParse({ version: 1, active_skills: [{ skill: "ralplan" }] }).success).toBe(
			true,
		);
		expect(SkillActiveStateSchema.safeParse({ active_skills: [{}] }).success).toBe(false);
	});
});

describe("readGjcJson (A2)", () => {
	it("returns null for a missing file", async () => {
		const result = await readGjcJson(path.join(os.tmpdir(), "gjc-nope-xyz.json"), WorkflowStateEnvelopeSchema);
		expect(result).toBeNull();
	});

	it("returns ok for valid content and preserves raw", async () => {
		const file = await tempFile("ok.json", JSON.stringify({ skill: "ralplan", version: 1, extra: "keep" }));
		const result = await readGjcJson(file, WorkflowStateEnvelopeSchema);
		expect(result?.ok).toBe(true);
		if (result?.ok) expect((result.value as Record<string, unknown>).extra).toBe("keep");
	});

	it("fails open (ok:false) on invalid JSON without throwing", async () => {
		const file = await tempFile("bad.json", "{not json");
		const result = await readGjcJson(file, WorkflowStateEnvelopeSchema);
		expect(result?.ok).toBe(false);
		if (result && !result.ok) expect(result.error).toContain("invalid JSON");
	});

	it("fails open (ok:false) on schema-invalid content, attaching raw", async () => {
		const file = await tempFile("schema-bad.json", JSON.stringify({ version: "not-a-number" }));
		const result = await readGjcJson(file, WorkflowStateEnvelopeSchema);
		expect(result?.ok).toBe(false);
		if (result && !result.ok) expect(result.raw).toEqual({ version: "not-a-number" });
	});
});
