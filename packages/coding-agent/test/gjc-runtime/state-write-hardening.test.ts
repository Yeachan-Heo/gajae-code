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

function receiptFrom(stdout: string | undefined): Record<string, unknown> {
	const parsed = JSON.parse(stdout ?? "{}") as Record<string, unknown>;
	expect(parsed.state).toBeUndefined();
	return parsed;
}

async function writeState(root: string, mode: string, state: Record<string, unknown>, extra: string[] = []) {
	return runNativeStateCommand(["write", "--mode", mode, "--input", JSON.stringify(state), "--json", ...extra], root);
}

async function writeRawState(root: string, mode: string, state: unknown) {
	const stateDir = path.join(root, ".gjc", "state");
	await fs.mkdir(stateDir, { recursive: true });
	await fs.writeFile(
		path.join(stateDir, `${mode}-state.json`),
		typeof state === "string" ? state : JSON.stringify(state),
	);
}

describe("gjc state write hardening", () => {
	it("allows a valid manifest transition", async () => {
		const root = await tempDir();
		await writeState(root, "ralplan", { current_phase: "planner" });
		const result = await writeState(root, "ralplan", { current_phase: "architect" });
		expect(result.status).toBe(0);
		expect(receiptFrom(result.stdout).current_phase).toBe("architect");
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
		expect(receiptFrom(result.stdout).current_phase).toBe("final");
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
		expect(receiptFrom(result.stdout).current_phase).toBe("handoff");
	});

	it("rejects unknown legacy target phases unless forced", async () => {
		const root = await tempDir();
		await writeState(root, "ralplan", { current_phase: "planner" });
		const rejected = await writeState(root, "ralplan", { current_phase: "legacy-custom" });
		expect(rejected.status).not.toBe(0);
		expect(rejected.stderr).toContain('unknown ralplan phase "legacy-custom"');

		const forced = await writeState(root, "ralplan", { current_phase: "legacy-custom" }, ["--force"]);
		expect(forced.status).toBe(0);
		expect(receiptFrom(forced.stdout).current_phase).toBe("legacy-custom");
	});

	it("fresh write without current_phase persists the manifest initial phase", async () => {
		const root = await tempDir();
		const result = await writeState(root, "ralplan", { active: true });
		expect(result.status).toBe(0);
		expect(receiptFrom(result.stdout).current_phase).toBe("planner");
		const onDisk = JSON.parse(await fs.readFile(path.join(root, ".gjc", "state", "ralplan-state.json"), "utf-8"));
		expect(onDisk.current_phase).toBe("planner");
	});

	it("defaults blank incoming current_phase to the manifest initial phase", async () => {
		const root = await tempDir();
		const result = await writeState(root, "ralplan", { current_phase: "" });
		expect(result.status).toBe(0);
		expect(receiptFrom(result.stdout).current_phase).toBe("planner");
		const onDisk = JSON.parse(await fs.readFile(path.join(root, ".gjc", "state", "ralplan-state.json"), "utf-8"));
		expect(onDisk.current_phase).toBe("planner");
	});

	it("defaults retained blank legacy current_phase to the manifest initial phase", async () => {
		const root = await tempDir();
		await writeRawState(root, "ralplan", {
			skill: "ralplan",
			version: 2,
			active: true,
			current_phase: "  ",
		});

		const result = await writeState(root, "ralplan", { active: true });
		expect(result.status).toBe(0);
		expect(receiptFrom(result.stdout).current_phase).toBe("planner");
		const onDisk = JSON.parse(await fs.readFile(path.join(root, ".gjc", "state", "ralplan-state.json"), "utf-8"));
		expect(onDisk.current_phase).toBe("planner");
	});

	it("rejects retained unknown existing phases unless forced", async () => {
		const root = await tempDir();
		await writeRawState(root, "ralplan", {
			skill: "ralplan",
			version: 2,
			active: true,
			current_phase: "legacy-custom",
		});

		const rejected = await writeState(root, "ralplan", { active: true });
		expect(rejected.status).not.toBe(0);
		expect(rejected.stderr).toContain('unknown ralplan phase "legacy-custom"');

		const forced = await writeState(root, "ralplan", { active: true }, ["--force"]);
		expect(forced.status).toBe(0);
		expect(receiptFrom(forced.stdout).current_phase).toBe("legacy-custom");
	});

	it("reads unknown legacy phases fail-open", async () => {
		const root = await tempDir();
		const stateDir = path.join(root, ".gjc", "state");
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(
			path.join(stateDir, "ralplan-state.json"),
			JSON.stringify({ skill: "ralplan", version: 1, active: true, current_phase: "legacy-custom" }),
		);
		const result = await runNativeStateCommand(["read", "--mode", "ralplan", "--json"], root);
		expect(result.status).toBe(0);
		expect((JSON.parse(result.stdout ?? "{}") as Record<string, unknown>).state).toMatchObject({
			current_phase: "legacy-custom",
		});
	});

	it("corrupt existing state fails open for read and status but write and clear require force", async () => {
		const root = await tempDir();
		await writeRawState(root, "ralplan", "{broken json");

		const read = await runNativeStateCommand(["read", "--mode", "ralplan", "--json"], root);
		expect(read.status).toBe(0);
		const status = await runNativeStateCommand(["status", "--mode", "ralplan", "--json"], root);
		expect(status.status).toBe(0);

		const rejectedWrite = await writeState(root, "ralplan", { current_phase: "planner" });
		expect(rejectedWrite.status).not.toBe(0);
		expect(rejectedWrite.stderr).toContain("use --force to overwrite");

		const forcedWrite = await writeState(root, "ralplan", { current_phase: "planner" }, ["--force"]);
		expect(forcedWrite.status).toBe(0);

		await writeRawState(root, "ralplan", "{broken json");
		const rejectedClear = await runNativeStateCommand(["clear", "--mode", "ralplan", "--json"], root);
		expect(rejectedClear.status).not.toBe(0);
		expect(rejectedClear.stderr).toContain("use --force to overwrite");

		const forcedClear = await runNativeStateCommand(["clear", "--mode", "ralplan", "--json", "--force"], root);
		expect(forcedClear.status).toBe(0);
		expect(receiptFrom(forcedClear.stdout).current_phase).toBe("complete");
	});

	it("allows seeds with no prior phase", async () => {
		const root = await tempDir();
		const result = await writeState(root, "ralplan", { current_phase: "final" });
		expect(result.status).toBe(0);
		expect(receiptFrom(result.stdout).current_phase).toBe("final");
	});

	it("rejects non-object existing state before write", async () => {
		const root = await tempDir();
		await writeRawState(root, "ralplan", []);
		const result = await writeState(root, "ralplan", { current_phase: "planner" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("use --force to overwrite");
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
		const written = receiptFrom(result.stdout);
		expect(written).toMatchObject({ ok: true, skill: "deep-interview", current_phase: "interviewing" });
		const onDisk = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "deep-interview-state.json"), "utf-8"),
		);
		expect(onDisk.state.rounds).toEqual(extension.rounds);
		expect(onDisk.state.topology).toEqual(extension.topology);
		expect(onDisk.state.ontology_snapshots).toEqual(extension.ontology_snapshots);
		expect(onDisk.architect_findings).toEqual(extension.architect_findings);
		expect(onDisk.new_requirements).toEqual(extension.new_requirements);
		expect(onDisk.ci_gates).toEqual(extension.ci_gates);
		expect(onDisk.research_findings).toEqual(extension.research_findings);
		expect(onDisk.extension_field).toEqual(extension.extension_field);
	});
});
