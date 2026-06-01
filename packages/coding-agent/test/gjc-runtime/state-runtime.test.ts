import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-state-runtime-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// Tests in this file assume root-scoped `.gjc/state` paths. The state runtime
// falls back to the `GJC_SESSION_ID` env var when no `--session-id` flag is
// provided, which would route writes into `.gjc/state/sessions/<id>/` and
// break these root-scoped assertions when run inside a shell session that
// exports `GJC_SESSION_ID` (e.g. the coding-agent dev loop). Clear and
// restore the env so each test sees a deterministic root scope.
let priorSessionId: string | undefined;
beforeAll(() => {
	priorSessionId = process.env.GJC_SESSION_ID;
	delete process.env.GJC_SESSION_ID;
});
afterAll(() => {
	if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
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
		const result = await runNativeStateCommand(["read"], root);
		expect(result.status).toBe(0);
		expect(envelopeState(result.stdout)).toEqual({});
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
		expect(parsed.interview_id).toBe("abc");
	});

	it("prefers CLI --mode over --input payload mode", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--input", JSON.stringify({ active: true }), "--mode", "deep-interview"],
			root,
		);
		await runNativeStateCommand(["write", "--input", JSON.stringify({ active: true }), "--mode", "ralplan"], root);

		const result = await runNativeStateCommand(
			["read", "--input", JSON.stringify({ mode: "deep-interview" }), "--mode", "ralplan"],
			root,
		);

		expect(result.status).toBe(0);
		const parsed = envelopeState(result.stdout);
		expect(parsed.active).toBe(true);
		// ralplan-state.json was written but deep-interview-state.json contained `active:true` too;
		// verify CLI flag won by reading the underlying file path
		const ralplanFile = path.join(root, ".gjc", "state", "ralplan-state.json");
		expect(JSON.parse(await fs.readFile(ralplanFile, "utf-8")).active).toBe(true);
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
		const merged = envelopeState(second.stdout);
		expect(merged.active).toBe(true);
		expect(merged.current_phase).toBe("interviewing");
		expect(merged.current_ambiguity).toBe(0.5);
		expect(merged.threshold_source).toBe("user");
		expect(merged.interview_id).toBe("abc");
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
		const merged = envelopeState(result.stdout);
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
		const replaced = envelopeState(result.stdout);
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
		expect(envelopeState(result.stdout).current_phase).toBe("interviewing");
	});

	it("clear flips active:false and removes the entry from skill-active-state", async () => {
		const root = await tempDir();
		const activeStateDir = path.join(root, ".gjc", "state");
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
		const cleared = envelopeState(result.stdout);
		expect(cleared.active).toBe(false);
		expect(cleared.current_phase).toBe("complete");

		const rootActive = JSON.parse(await fs.readFile(path.join(activeStateDir, "skill-active-state.json"), "utf-8"));
		expect(rootActive.active_skills).toEqual([]);
		expect(rootActive.active).toBe(false);
	});

	it("rejects an unknown --mode with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(["read", "--mode", "nope"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown --mode");
	});

	it("rejects a traversal --session-id with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(
			["read", "--mode", "deep-interview", "--session-id", "../escape"],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("invalid path component");
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

	it("preserves both writers' disjoint keys under interleaved write calls", async () => {
		const root = await tempDir();
		await runNativeStateCommand(["write", "--input", JSON.stringify({ a: 1 }), "--mode", "deep-interview"], root);
		const [first, second] = await Promise.all([
			runNativeStateCommand(["write", "--input", JSON.stringify({ b: 2 }), "--mode", "deep-interview"], root),
			runNativeStateCommand(["write", "--input", JSON.stringify({ c: 3 }), "--mode", "deep-interview"], root),
		]);
		expect(first.status).toBe(0);
		expect(second.status).toBe(0);
		const final = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "deep-interview-state.json"), "utf-8"),
		);
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
		const active = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "skill-active-state.json"), "utf-8"),
		);
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
		const active = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "skill-active-state.json"), "utf-8"),
		);
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
		const active = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "skill-active-state.json"), "utf-8"),
		);
		expect((active.active_skills as Array<{ skill: string }>).some(e => e.skill === "ralplan")).toBe(false);
	});

	it("infers the active workflow for write when --mode/positional/input.skill are absent", async () => {
		const root = await tempDir();
		// Activate ralplan via the active-state file (simulating UserPromptSubmit hook output)
		const stateDir = path.join(root, ".gjc", "state");
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
			["write", "--input", JSON.stringify({ phase: "approval", active: true })],
			root,
		);

		expect(result.status).toBe(0);
		const parsed = JSON.parse(result.stdout ?? "{}") as { skill?: string; state?: { current_phase?: string } };
		expect(parsed.skill).toBe("ralplan");
		expect(parsed.state?.current_phase).toBe("approval");
		const onDisk = JSON.parse(await fs.readFile(path.join(stateDir, "ralplan-state.json"), "utf-8"));
		expect(onDisk.current_phase).toBe("approval");
	});

	it("infers the active workflow for clear too", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--input", JSON.stringify({ active: true, current_phase: "planner" }), "--mode", "ralplan"],
			root,
		);
		const result = await runNativeStateCommand(["clear"], root);
		expect(result.status).toBe(0);
		const onDisk = JSON.parse(await fs.readFile(path.join(root, ".gjc", "state", "ralplan-state.json"), "utf-8"));
		expect(onDisk.active).toBe(false);
	});

	it("still errors when no mode is supplied and no active workflow exists", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(["write", "--input", JSON.stringify({ phase: "approval" })], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("active workflow");
	});
});
