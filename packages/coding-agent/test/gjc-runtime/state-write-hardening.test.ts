import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-state-write-hardening-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

let priorSessionId: string | undefined;
beforeAll(() => {
	priorSessionId = process.env.GJC_SESSION_ID;
	delete process.env.GJC_SESSION_ID;
});
afterAll(() => {
	if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
});

function stateFrom(stdout: string | undefined): Record<string, unknown> {
	const parsed = JSON.parse(stdout ?? "{}");
	return parsed.state as Record<string, unknown>;
}

async function writeState(root: string, mode: string, state: Record<string, unknown>, extra: string[] = []) {
	return runNativeStateCommand(["write", "--mode", mode, "--input", JSON.stringify(state), "--json", ...extra], root);
}

describe("gjc state write hardening", () => {
	it("allows a valid manifest transition", async () => {
		const root = await tempDir();
		await writeState(root, "ralplan", { current_phase: "planner" });
		const result = await writeState(root, "ralplan", { current_phase: "architect" });
		expect(result.status).toBe(0);
		expect(stateFrom(result.stdout).current_phase).toBe("architect");
	});

	it("rejects a known-bad jump", async () => {
		const root = await tempDir();
		await writeState(root, "ralplan", { current_phase: "planner" });
		const result = await writeState(root, "ralplan", { current_phase: "final" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("invalid ralplan phase transition from planner to final");
	});

	it("allows --force to bypass a known-bad jump", async () => {
		const root = await tempDir();
		await writeState(root, "ralplan", { current_phase: "planner" });
		const result = await writeState(root, "ralplan", { current_phase: "final" }, ["--force"]);
		expect(result.status).toBe(0);
		expect(stateFrom(result.stdout).current_phase).toBe("final");
	});

	it.each([
		["ralplan", "planner"],
		["ultragoal", "active"],
		["team", "running"],
	])("allows %s handoff writes without --force", async (mode, fromPhase) => {
		const root = await tempDir();
		await writeState(root, mode, { current_phase: fromPhase });
		const result = await writeState(root, mode, { current_phase: "handoff" });
		expect(result.status).toBe(0);
		expect(stateFrom(result.stdout).current_phase).toBe("handoff");
	});

	it("allows unknown legacy target phases", async () => {
		const root = await tempDir();
		await writeState(root, "ralplan", { current_phase: "planner" });
		const result = await writeState(root, "ralplan", { current_phase: "legacy-custom" });
		expect(result.status).toBe(0);
		expect(stateFrom(result.stdout).current_phase).toBe("legacy-custom");
	});

	it("allows seeds with no prior phase", async () => {
		const root = await tempDir();
		const result = await writeState(root, "ralplan", { current_phase: "final" });
		expect(result.status).toBe(0);
		expect(stateFrom(result.stdout).current_phase).toBe("final");
	});

	it("rejects non-object existing state before write", async () => {
		const root = await tempDir();
		const stateDir = path.join(root, ".gjc", "state");
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(path.join(stateDir, "ralplan-state.json"), JSON.stringify([]));
		const result = await writeState(root, "ralplan", { current_phase: "planner" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("existing state for ralplan must be a JSON object");
	});

	it("rejects wrong-typed active and current_phase", async () => {
		const root = await tempDir();
		const badActive = await writeState(root, "ralplan", { active: "yes" });
		expect(badActive.status).not.toBe(0);
		expect(badActive.stderr).toContain("state.active must be a boolean");

		const badPhase = await writeState(root, "ralplan", { current_phase: 12 });
		expect(badPhase.status).not.toBe(0);
		expect(badPhase.stderr).toContain("state.current_phase must be a string");
	});

	it("preserves free-form extension fields through write", async () => {
		const root = await tempDir();
		const extension = {
			current_phase: "interviewing",
			rounds: [{ id: "r1", arbitrary: { ok: true } }],
			topology: { nodes: ["a"] },
			ontology_snapshots: [{ any: "shape" }],
			architect_findings: [{ severity: "WATCH", extra: 1 }],
			new_requirements: ["keep"],
			ci_gates: { custom: ["gate"] },
			research_findings: [{ source: "x" }],
			extension_field: { nested: true },
		};
		const result = await writeState(root, "deep-interview", extension);
		expect(result.status).toBe(0);
		const written = stateFrom(result.stdout);
		expect(written.rounds).toEqual(extension.rounds);
		expect(written.topology).toEqual(extension.topology);
		expect(written.ontology_snapshots).toEqual(extension.ontology_snapshots);
		expect(written.architect_findings).toEqual(extension.architect_findings);
		expect(written.new_requirements).toEqual(extension.new_requirements);
		expect(written.ci_gates).toEqual(extension.ci_gates);
		expect(written.research_findings).toEqual(extension.research_findings);
		expect(written.extension_field).toEqual(extension.extension_field);
	});
});
