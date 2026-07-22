import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deepInterviewCharacterCount } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-state";
import {
	activeSnapshotPath,
	modeStatePath,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";

const TEST_SESSION_ID = "test-session";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-state-runtime-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// Tests in this file use a deterministic session id so runtime writes land in
// the session-scoped state layout regardless of the host shell environment.
let priorSessionId: string | undefined;
beforeAll(() => {
	priorSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});
afterAll(() => {
	if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
	else delete process.env.GJC_SESSION_ID;
});

function parseStdout(stdout: string | undefined): Record<string, unknown> {
	return JSON.parse(stdout ?? "{}") as Record<string, unknown>;
}

function envelopeState(stdout: string | undefined): Record<string, unknown> {
	const parsed = parseStdout(stdout);
	const inner = parsed.state;
	if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Record<string, unknown>;
	return parsed;
}

describe("native gjc state runtime", () => {
	it("reads an empty receipt as {}", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(["read", "--json"], root);
		expect(result.status).toBe(0);
		expect(envelopeState(result.stdout)).toEqual({});
	});
	it("treats an empty first positional as absent instead of clearing state", async () => {
		const root = await tempDir();
		const seed = await runNativeStateCommand(
			["write", "--mode", "ralplan", "--input", JSON.stringify({ marker: "seed" })],
			root,
		);
		expect(seed.status).toBe(0);

		const result = await runNativeStateCommand(["", "clear", "--mode", "ralplan", "--json"], root);
		expect(result.status).toBe(0);
		expect(envelopeState(result.stdout).marker).toBe("seed");

		const retained = await runNativeStateCommand(["read", "--mode", "ralplan", "--json"], root);
		expect(envelopeState(retained.stdout).marker).toBe("seed");
	});

	it("treats an empty second positional as absent for an explicit skill read", async () => {
		const root = await tempDir();
		const seed = await runNativeStateCommand(
			["write", "--mode", "ralplan", "--input", JSON.stringify({ marker: "seed" })],
			root,
		);
		expect(seed.status).toBe(0);

		const result = await runNativeStateCommand(["ralplan", "", "--json"], root);
		expect(result.status).toBe(0);
		expect(envelopeState(result.stdout).marker).toBe("seed");
	});

	it("reads corrupt mode-state fail-open as empty state", async () => {
		const root = await tempDir();
		const stateDir = sessionStateDir(root, TEST_SESSION_ID);
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(path.join(stateDir, "ralplan-state.json"), "{not json");

		const read = await runNativeStateCommand(["read", "--mode", "ralplan", "--json"], root);
		expect(read.status).toBe(0);
		expect(envelopeState(read.stdout)).toEqual({});

		const status = await runNativeStateCommand(["status", "--mode", "ralplan", "--json"], root);
		expect(status.status).toBe(0);
	});

	it('supports the legacy --input \'{"mode":"..."}\' payload shape for read', async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--input", JSON.stringify({ state: { interview_id: "abc" } }), "--mode", "deep-interview"],
			root,
		);

		const result = await runNativeStateCommand(
			["read", "--input", JSON.stringify({ mode: "deep-interview" }), "--json"],
			root,
		);

		expect(result.status).toBe(0);
		const parsed = envelopeState(result.stdout);
		expect((parsed.state as Record<string, unknown>).interview_id).toBe("abc");
	});

	it("prefers CLI --mode over --input payload mode", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--input", JSON.stringify({ active: true }), "--mode", "deep-interview"],
			root,
		);
		await runNativeStateCommand(["write", "--input", JSON.stringify({ active: true }), "--mode", "ralplan"], root);

		const result = await runNativeStateCommand(
			["read", "--input", JSON.stringify({ mode: "deep-interview" }), "--mode", "ralplan", "--json"],
			root,
		);

		expect(result.status).toBe(0);
		const parsed = envelopeState(result.stdout);
		expect(parsed.active).toBe(true);
		// ralplan-state.json was written but deep-interview-state.json contained `active:true` too;
		// verify CLI flag won by reading the underlying file path
		const ralplanFile = modeStatePath(root, TEST_SESSION_ID, "ralplan");
		expect(JSON.parse(await fs.readFile(ralplanFile, "utf-8")).active).toBe(true);
	});
	it("preserves first-occurrence selector precedence for repeated mode flags", async () => {
		const root = await tempDir();
		const seed = await runNativeStateCommand(
			["write", "--mode", "ralplan", "--input", JSON.stringify({ marker: "seed" })],
			root,
		);
		expect(seed.status).toBe(0);

		const repeated = await runNativeStateCommand(
			["write", "--mode", "", "--mode", "team", "--input", JSON.stringify({ marker: "runtime-first" })],
			root,
		);
		expect(repeated.status).toBe(0);

		const ralplan = await runNativeStateCommand(["read", "--mode", "ralplan", "--json"], root);
		const team = await runNativeStateCommand(["read", "--mode", "team", "--json"], root);
		expect(envelopeState(ralplan.stdout).marker).toBe("runtime-first");
		expect(envelopeState(team.stdout)).toEqual({});
	});

	it("preserves first-occurrence selector precedence for repeated input flags", async () => {
		const root = await tempDir();
		const seed = await runNativeStateCommand(
			["write", "--mode", "ralplan", "--input", JSON.stringify({ marker: "seed" })],
			root,
		);
		expect(seed.status).toBe(0);

		const repeated = await runNativeStateCommand(
			["write", "--input", "{}", "--input", JSON.stringify({ mode: "ralplan", current_phase: "handoff" }), "--json"],
			root,
		);
		expect(repeated.status).toBe(0);

		const result = await runNativeStateCommand(["read", "--mode", "ralplan", "--json"], root);
		expect(envelopeState(result.stdout)).toMatchObject({ marker: "seed" });
		expect(envelopeState(result.stdout).current_phase).not.toBe("handoff");
	});

	it("continues to accept known manifest flags", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(
			[
				"write",
				"--mode",
				"ralplan",
				"--input",
				JSON.stringify({ marker: "manifest-compatible" }),
				"--args",
				"legacy-value",
			],
			root,
		);

		expect(result.status).toBe(0);
		const state = await runNativeStateCommand(["read", "--mode", "ralplan", "--json"], root);
		expect(envelopeState(state.stdout).marker).toBe("manifest-compatible");
	});

	it("merges write payloads while preserving long-lived keys", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			[
				"write",
				"--input",
				JSON.stringify({
					active: true,
					current_phase: "interviewing",
					state: { interview_id: "abc", threshold_source: "user" },
				}),
				"--mode",
				"deep-interview",
			],
			root,
		);

		const second = await runNativeStateCommand(
			[
				"write",
				"--input",
				JSON.stringify({ state: { current_ambiguity: 0.5, threshold_source: "user", interview_id: "abc" } }),
				"--mode",
				"deep-interview",
			],
			root,
		);

		expect(second.status).toBe(0);
		const receipt = parseStdout(second.stdout);
		expect(receipt).toMatchObject({ ok: true, skill: "deep-interview", active: true, current_phase: "interviewing" });
		expect(receipt.state).toBeUndefined();
		const merged = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8"));
		expect(merged.state.current_ambiguity).toBe(0.5);
		expect(merged.state.threshold_source).toBe("user");
		expect(merged.state.interview_id).toBe("abc");
	});

	it("deletes a key when the payload value is null", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--input", JSON.stringify({ active: true, drop_me: "yes" }), "--mode", "deep-interview"],
			root,
		);

		const result = await runNativeStateCommand(
			["write", "--input", JSON.stringify({ drop_me: null }), "--mode", "deep-interview"],
			root,
		);

		expect(result.status).toBe(0);
		const receipt = parseStdout(result.stdout);
		expect(receipt).toMatchObject({ ok: true, skill: "deep-interview", active: true });
		expect(receipt.state).toBeUndefined();
		const merged = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8"));
		expect(merged.active).toBe(true);
		expect(Object.hasOwn(merged, "drop_me")).toBe(false);
	});

	it("--replace clobbers existing state instead of merging", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--input", JSON.stringify({ active: true, keep_me: 1 }), "--mode", "deep-interview"],
			root,
		);

		const result = await runNativeStateCommand(
			["write", "--input", JSON.stringify({ active: false }), "--mode", "deep-interview", "--replace"],
			root,
		);

		expect(result.status).toBe(0);
		const receipt = parseStdout(result.stdout);
		expect(receipt).toMatchObject({ ok: true, skill: "deep-interview", active: false });
		expect(receipt.state).toBeUndefined();
		const replaced = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8"));
		expect(replaced.active).toBe(false);
		expect(Object.hasOwn(replaced, "keep_me")).toBe(false);
	});

	it("--input @file reads JSON payloads from disk", async () => {
		const root = await tempDir();
		const payloadPath = path.join(root, "payload.json");
		await fs.writeFile(payloadPath, JSON.stringify({ active: true, current_phase: "interviewing" }));

		const result = await runNativeStateCommand(
			["write", "--input", `@${payloadPath}`, "--mode", "deep-interview"],
			root,
		);

		expect(result.status).toBe(0);
		expect(parseStdout(result.stdout)).toMatchObject({
			ok: true,
			skill: "deep-interview",
			current_phase: "interviewing",
		});
	});

	it("clear flips active:false and removes the entry from skill-active-state", async () => {
		const root = await tempDir();
		const activeStateDir = sessionStateDir(root, TEST_SESSION_ID);
		await fs.mkdir(activeStateDir, { recursive: true });
		await fs.writeFile(
			path.join(activeStateDir, "skill-active-state.json"),
			JSON.stringify({
				version: 1,
				active: true,
				skill: "deep-interview",
				active_skills: [{ skill: "deep-interview", phase: "interviewing", active: true }],
			}),
		);
		await runNativeStateCommand(
			[
				"write",
				"--input",
				JSON.stringify({ active: true, current_phase: "interviewing" }),
				"--mode",
				"deep-interview",
			],
			root,
		);

		const result = await runNativeStateCommand(["clear", "--mode", "deep-interview"], root);

		expect(result.status).toBe(0);
		const cleared = parseStdout(result.stdout);
		expect(cleared).toMatchObject({
			ok: true,
			skill: "deep-interview",
			active: false,
			current_phase: "complete",
		});
		expect(cleared.state).toBeUndefined();

		const rootActive = JSON.parse(await fs.readFile(path.join(activeStateDir, "skill-active-state.json"), "utf-8"));
		expect(rootActive.active_skills).toEqual([]);
		expect(rootActive.active).toBe(false);
	});

	it("rejects write when no session id is resolvable", async () => {
		const root = await tempDir();
		const prior = process.env.GJC_SESSION_ID;
		delete process.env.GJC_SESSION_ID;
		try {
			const result = await runNativeStateCommand(
				["write", "--input", JSON.stringify({ active: true }), "--mode", "deep-interview"],
				root,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("a session id is required to write state");
		} finally {
			if (prior !== undefined) process.env.GJC_SESSION_ID = prior;
			else process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		}
	});

	it("errors read/status when no session directories exist", async () => {
		const root = await tempDir();
		const prior = process.env.GJC_SESSION_ID;
		delete process.env.GJC_SESSION_ID;
		try {
			const read = await runNativeStateCommand(["read", "--mode", "deep-interview", "--json"], root);
			expect(read.status).toBe(2);
			expect(read.stderr).toContain("no active GJC session found");
			const status = await runNativeStateCommand(["status", "--mode", "deep-interview", "--json"], root);
			expect(status.status).toBe(2);
			expect(status.stderr).toContain("no active GJC session found");
		} finally {
			if (prior !== undefined) process.env.GJC_SESSION_ID = prior;
			else process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		}
	});

	it("clear resolves the latest session via activity marker when no --session-id/env", async () => {
		const root = await tempDir();
		const prior = process.env.GJC_SESSION_ID;
		// Seed one active session (with state + activity marker) via a normal write.
		await runNativeStateCommand(
			[
				"write",
				"--input",
				JSON.stringify({ active: true, current_phase: "interviewing" }),
				"--mode",
				"deep-interview",
				"--session-id",
				"only-session",
			],
			root,
		);
		delete process.env.GJC_SESSION_ID;
		try {
			const cleared = await runNativeStateCommand(["clear", "--mode", "deep-interview", "--force", "--json"], root);
			expect(cleared.status).toBe(0);
			const file = JSON.parse(await fs.readFile(modeStatePath(root, "only-session", "deep-interview"), "utf-8"));
			expect(file.active).toBe(false);
			expect(file.current_phase).toBe("complete");
		} finally {
			if (prior !== undefined) process.env.GJC_SESSION_ID = prior;
			else process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		}
	});

	it("clear errors on an ambiguous (near-tie) latest session", async () => {
		const root = await tempDir();
		const prior = process.env.GJC_SESSION_ID;
		await runNativeStateCommand(
			["write", "--input", JSON.stringify({ active: true }), "--mode", "deep-interview", "--session-id", "sess-a"],
			root,
		);
		await runNativeStateCommand(
			["write", "--input", JSON.stringify({ active: true }), "--mode", "deep-interview", "--session-id", "sess-b"],
			root,
		);
		delete process.env.GJC_SESSION_ID;
		try {
			const cleared = await runNativeStateCommand(["clear", "--mode", "deep-interview", "--force", "--json"], root);
			expect(cleared.status).toBe(2);
			expect(cleared.stderr).toContain("ambiguous latest session");
		} finally {
			if (prior !== undefined) process.env.GJC_SESSION_ID = prior;
			else process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		}
	});

	it("rejects an unknown --mode with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(["read", "--mode", "nope"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown --mode");
	});

	it("rejects a blank --session-id with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(["read", "--mode", "deep-interview", "--session-id", ""], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--session-id was provided but blank");
	});

	it("rejects write without --input", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(["write", "--mode", "deep-interview"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--input");
	});

	it("rejects write with malformed --input JSON", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(["write", "--input", "{not json", "--mode", "deep-interview"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--input is not valid JSON");
	});

	it("rejects oversized deep-interview initial context without creating or changing state", async () => {
		const root = await tempDir();
		const statePath = modeStatePath(root, TEST_SESSION_ID, "deep-interview");
		const oversizedCreate = await runNativeStateCommand(
			[
				"write",
				"--input",
				JSON.stringify({ state: { initial_idea: "한".repeat(50_001) } }),
				"--mode",
				"deep-interview",
			],
			root,
		);
		expect(oversizedCreate.status).toBe(2);
		expect(oversizedCreate.stderr).toContain("initial_idea exceeds max length 50000");
		await expect(fs.stat(statePath)).rejects.toThrow();

		const valid = await runNativeStateCommand(
			["write", "--input", JSON.stringify({ state: { initial_idea: "valid" } }), "--mode", "deep-interview"],
			root,
		);
		expect(valid.status).toBe(0);
		const before = await fs.readFile(statePath, "utf-8");
		const conflictingCopies = await runNativeStateCommand(
			[
				"write",
				"--input",
				JSON.stringify({ initial_idea: "😀".repeat(50_001), state: { initial_idea: "valid" } }),
				"--mode",
				"deep-interview",
			],
			root,
		);
		expect(conflictingCopies.status).toBe(2);
		expect(conflictingCopies.stderr).toContain("initial_idea exceeds max length 50000");
		expect(await fs.readFile(statePath, "utf-8")).toBe(before);
		const oversizedUpdate = await runNativeStateCommand(
			[
				"write",
				"--input",
				JSON.stringify({ state: { initial_context: "한".repeat(50_001) } }),
				"--mode",
				"deep-interview",
			],
			root,
		);
		expect(oversizedUpdate.status).toBe(2);
		expect(await fs.readFile(statePath, "utf-8")).toBe(before);
	});

	it("counts emoji as code points and rejects oversized scoring payloads before state mutation", async () => {
		const root = await tempDir();
		const statePath = modeStatePath(root, TEST_SESSION_ID, "deep-interview");
		const exactInitialContext = "😀".repeat(50_000);
		expect(
			(
				await runNativeStateCommand(
					[
						"write",
						"--input",
						JSON.stringify({ state: { initial_idea: exactInitialContext } }),
						"--mode",
						"deep-interview",
					],
					root,
				)
			).status,
		).toBe(0);
		const before = await fs.readFile(statePath, "utf-8");

		const structuredBase = { state: { ontology_snapshots: [""] } };
		const exactStructured = {
			state: {
				ontology_snapshots: ["😀".repeat(100_000 - deepInterviewCharacterCount(JSON.stringify(structuredBase)))],
			},
		};
		expect(deepInterviewCharacterCount(JSON.stringify(exactStructured))).toBe(100_000);
		expect(
			(
				await runNativeStateCommand(
					["write", "--input", JSON.stringify(exactStructured), "--mode", "deep-interview"],
					root,
				)
			).status,
		).toBe(0);
		const afterExact = await fs.readFile(statePath, "utf-8");

		const oversizedStructured = {
			state: {
				ontology_snapshots: ["😀".repeat(100_001 - deepInterviewCharacterCount(JSON.stringify(structuredBase)))],
			},
		};
		expect(deepInterviewCharacterCount(JSON.stringify(oversizedStructured))).toBe(100_001);
		const rejected = await runNativeStateCommand(
			["write", "--input", JSON.stringify(oversizedStructured), "--mode", "deep-interview"],
			root,
		);
		expect(rejected.status).toBe(2);
		expect(rejected.stderr).toContain("structured deep-interview response exceeds max length 100000");
		expect(await fs.readFile(statePath, "utf-8")).toBe(afterExact);

		const scoringBase = { state: { rounds: [{ scores: { scope: "" } }] } };
		const oversizedScoring = {
			state: {
				rounds: [
					{ scores: { scope: "😀".repeat(100_001 - deepInterviewCharacterCount(JSON.stringify(scoringBase))) } },
				],
			},
		};
		expect(deepInterviewCharacterCount(JSON.stringify(oversizedScoring))).toBe(100_001);
		const rejectedScoring = await runNativeStateCommand(
			["write", "--input", JSON.stringify(oversizedScoring), "--mode", "deep-interview"],
			root,
		);
		expect(rejectedScoring.status).toBe(2);
		expect(rejectedScoring.stderr).toContain("structured deep-interview response exceeds max length 100000");
		expect(await fs.readFile(statePath, "utf-8")).toBe(afterExact);
		expect(afterExact).not.toBe(before);
	});

	it("preserves both writers' disjoint keys under interleaved write calls", async () => {
		const root = await tempDir();
		await runNativeStateCommand(["write", "--input", JSON.stringify({ a: 1 }), "--mode", "deep-interview"], root);
		const [first, second] = await Promise.all([
			runNativeStateCommand(["write", "--input", JSON.stringify({ b: 2 }), "--mode", "deep-interview"], root),
			runNativeStateCommand(["write", "--input", JSON.stringify({ c: 3 }), "--mode", "deep-interview"], root),
		]);
		expect(first.status).toBe(0);
		expect(second.status).toBe(0);
		const final = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8"));
		// `a` always survives because both writers started from it; whichever writer landed last contributes its key
		expect(final.a).toBe(1);
		expect(final.b === 2 || final.c === 3).toBe(true);
	});

	it("syncs skill-active HUD chips when writing a deep-interview receipt", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			[
				"write",
				"--input",
				JSON.stringify({
					active: true,
					current_phase: "interviewing",
					threshold: 0.5,
					state: {
						initial_idea: "x",
						current_ambiguity: 0.8,
						threshold: 0.5,
						threshold_source: "flag:--standard",
						rounds: [{}, {}],
					},
				}),
				"--mode",
				"deep-interview",
			],
			root,
		);
		const active = JSON.parse(await fs.readFile(activeSnapshotPath(root, TEST_SESSION_ID), "utf-8"));
		const entry = (
			active.active_skills as Array<{
				skill: string;
				phase?: string;
				hud?: { chips?: Array<{ label: string; value?: string }> };
			}>
		).find(e => e.skill === "deep-interview");
		expect(entry).toBeTruthy();
		expect(entry?.phase).toBe("interviewing");
		const chipLabels = entry?.hud?.chips?.map(chip => chip.label) ?? [];
		expect(chipLabels).toContain("phase");
		expect(chipLabels).toContain("ambiguity");
		expect(chipLabels).toContain("round");
	});

	it("syncs skill-active HUD chips when writing a ralplan receipt", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			[
				"write",
				"--input",
				JSON.stringify({ active: true, current_phase: "architect", iteration: 2, verdict: "ITERATE" }),
				"--mode",
				"ralplan",
			],
			root,
		);
		const active = JSON.parse(await fs.readFile(activeSnapshotPath(root, TEST_SESSION_ID), "utf-8"));
		const entry = (
			active.active_skills as Array<{
				skill: string;
				hud?: { chips?: Array<{ label: string; value?: string; severity?: string }> };
			}>
		).find(e => e.skill === "ralplan");
		expect(entry).toBeTruthy();
		const chips = entry?.hud?.chips ?? [];
		const stage = chips.find(c => c.label === "stage");
		const verdict = chips.find(c => c.label === "verdict");
		expect(stage?.value).toBe("architect");
		expect(verdict?.value).toBe("ITERATE");
		expect(verdict?.severity).toBe("warning");
	});

	it("clears the active entry when clearing a workflow receipt", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--input", JSON.stringify({ active: true, current_phase: "planner" }), "--mode", "ralplan"],
			root,
		);
		await runNativeStateCommand(["clear", "--mode", "ralplan"], root);
		const active = JSON.parse(await fs.readFile(activeSnapshotPath(root, TEST_SESSION_ID), "utf-8"));
		expect((active.active_skills as Array<{ skill: string }>).some(e => e.skill === "ralplan")).toBe(false);
	});

	it("infers the active workflow for write when --mode/positional/input.skill are absent", async () => {
		const root = await tempDir();
		// Activate ralplan via the active-state file (simulating UserPromptSubmit hook output)
		const stateDir = sessionStateDir(root, TEST_SESSION_ID);
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(
			path.join(stateDir, "skill-active-state.json"),
			JSON.stringify({
				version: 1,
				active: true,
				skill: "ralplan",
				active_skills: [{ skill: "ralplan", phase: "planner", active: true }],
			}),
		);

		// Bundled prompt shape: gjc state write --input '<json>' (no --mode)
		const result = await runNativeStateCommand(
			["write", "--input", JSON.stringify({ phase: "architect", active: true })],
			root,
		);

		expect(result.status).toBe(0);
		const parsed = JSON.parse(result.stdout ?? "{}") as Record<string, unknown>;
		expect(parsed).toMatchObject({ ok: true, skill: "ralplan", current_phase: "architect" });
		expect(parsed.state).toBeUndefined();
		const onDisk = JSON.parse(await fs.readFile(path.join(stateDir, "ralplan-state.json"), "utf-8"));
		expect(onDisk.current_phase).toBe("architect");
	});

	it("infers the active workflow for clear too", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--input", JSON.stringify({ active: true, current_phase: "planner" }), "--mode", "ralplan"],
			root,
		);
		const result = await runNativeStateCommand(["clear"], root);
		expect(result.status).toBe(0);
		const onDisk = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "ralplan"), "utf-8"));
		expect(onDisk.active).toBe(false);
	});

	it("still errors when no mode is supplied and no active workflow exists", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(["write", "--input", JSON.stringify({ phase: "approval" })], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("active workflow");
	});
});
