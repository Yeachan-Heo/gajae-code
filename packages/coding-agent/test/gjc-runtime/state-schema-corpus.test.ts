import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { migrateWorkflowState } from "@gajae-code/coding-agent/gjc-runtime/state-migrations";
import {
	RequiredOnWriteEnvelopeSchema,
	WorkflowStateEnvelopeSchema,
} from "@gajae-code/coding-agent/gjc-runtime/state-schema";

const fixturesRoot = path.join(import.meta.dir, "..", "fixtures", "gjc-state");

async function readFixture(relativePath: string): Promise<Record<string, unknown>> {
	const content = await fs.readFile(path.join(fixturesRoot, relativePath), "utf8");
	return JSON.parse(content) as Record<string, unknown>;
}

async function fixtureNames(version: "v1" | "v2"): Promise<string[]> {
	const dir = path.join(fixturesRoot, version);
	const entries = await fs.readdir(dir);
	return entries.filter(entry => entry.endsWith(".json")).sort();
}

function skillFromFixtureName(name: string): string {
	return name.replace(/-(valid|legacy)\.json$/, "");
}

describe("workflow state schema golden corpus", () => {
	it("keeps every v2 fixture schema-valid, write-valid, and migration-stable", async () => {
		const names = await fixtureNames("v2");
		expect(names.length).toBeGreaterThan(0);

		for (const name of names) {
			const fixture = await readFixture(path.join("v2", name));
			const skill = skillFromFixtureName(name);

			expect(WorkflowStateEnvelopeSchema.safeParse(fixture).success, name).toBe(true);
			expect(RequiredOnWriteEnvelopeSchema.safeParse(fixture).success, name).toBe(true);

			const migrated = migrateWorkflowState(fixture, skill);
			expect(migrated.changed, name).toBe(false);
			expect(migrated.fromVersion, name).toBe(2);
			expect(migrated.toVersion, name).toBe(2);
			expect(migrated.state, name).toEqual(fixture);
		}
	});

	it("migrates every v1 fixture to deterministic schema-valid v2 while preserving extras", async () => {
		const names = await fixtureNames("v1");
		expect(names.length).toBeGreaterThan(0);

		for (const name of names) {
			const fixture = await readFixture(path.join("v1", name));
			const skill = skillFromFixtureName(name);
			const before = structuredClone(fixture);

			const migrated = migrateWorkflowState(fixture, skill);
			expect(migrated.changed, name).toBe(true);
			expect(migrated.toVersion, name).toBe(2);
			expect(migrated.state.version, name).toBe(2);
			expect(migrated.state.skill, name).toBe(skill);
			expect(WorkflowStateEnvelopeSchema.safeParse(migrated.state).success, name).toBe(true);

			for (const [key, value] of Object.entries(before)) {
				if (["version", "skill", "current_phase", "phase"].includes(key)) continue;
				expect(migrated.state[key], `${name}:${key}`).toEqual(value);
			}

			const migratedAgain = migrateWorkflowState(migrated.state, skill);
			expect(migratedAgain.changed, name).toBe(false);
			expect(migratedAgain.state, name).toEqual(migrated.state);
			expect(migrateWorkflowState(before, skill), name).toEqual(migrated);
			expect(fixture, `${name}:fixture object not mutated`).toEqual(before);
		}
	});
});
