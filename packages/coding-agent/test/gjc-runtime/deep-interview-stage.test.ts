import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { deepInterviewDraftPath } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-stage";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";

const TEST_SESSION_ID = "stage-test-session";
const tempRoots: string[] = [];
const originalSessionId = process.env.GJC_SESSION_ID;

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-deep-interview-stage-"));
	tempRoots.push(dir);
	return dir;
}

beforeAll(() => {
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
	if (originalSessionId !== undefined) process.env.GJC_SESSION_ID = originalSessionId;
	else delete process.env.GJC_SESSION_ID;
});

function parse(stdout: string | undefined): Record<string, unknown> {
	return JSON.parse(stdout ?? "{}") as Record<string, unknown>;
}

async function readState(root: string): Promise<Record<string, unknown>> {
	const raw = await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8");
	return JSON.parse(raw) as Record<string, unknown>;
}

async function seed(root: string): Promise<void> {
	const result = await runNativeDeepInterviewCommand(["--json", "clarify the staged transition surface"], root);
	expect(result.status).toBe(0);
}

async function run(root: string, args: string[]): Promise<{ status: number; stdout?: string; stderr?: string }> {
	return runNativeDeepInterviewCommand(args, root);
}

describe("deep-interview staged transitions", () => {
	it("stages, checks, and applies a payload against seeded state", async () => {
		const root = await tempDir();
		await seed(root);
		const before = await readState(root);

		const staged = await run(root, [
			"stage",
			"--for",
			"record-round",
			"--input",
			JSON.stringify({
				state: {
					rounds: [{ round: 1, round_key: "r1", question_text: "What output format?", lifecycle: "answered" }],
					current_ambiguity: 0.42,
					free_form_note: "flexible fields survive",
				},
			}),
			"--json",
		]);
		expect(staged.status).toBe(0);
		const stagedSummary = parse(staged.stdout);
		expect(stagedSummary.ok).toBe(true);
		expect(typeof stagedSummary.draft_id).toBe("string");

		const checked = await run(root, ["check", "--json"]);
		expect(checked.status).toBe(0);
		const checkSummary = parse(checked.stdout);
		expect(checkSummary.ok).toBe(true);
		expect(checkSummary.would_apply).toBe(true);
		expect(checkSummary.result_round_count).toBe(1);

		const applied = await run(root, ["apply", "--json"]);
		expect(applied.status).toBe(0);
		const applySummary = parse(applied.stdout);
		expect(applySummary.ok).toBe(true);
		expect(applySummary.draft_id).toBe(stagedSummary.draft_id);

		const after = await readState(root);
		const state = after.state as Record<string, unknown>;
		expect((state.rounds as unknown[]).length).toBe(1);
		expect(state.current_ambiguity).toBe(0.42);
		expect(state.free_form_note).toBe("flexible fields survive");
		// Prior seeded fields survive the merge.
		expect(state.initial_idea).toBe("clarify the staged transition surface");
		expect(after.state_revision).toBeGreaterThan((before.state_revision as number) ?? 0);
		// Draft is consumed.
		await expect(fs.stat(deepInterviewDraftPath(root, TEST_SESSION_ID))).rejects.toThrow();
	});

	it("check and apply run the identical merge (dry-run parity)", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, [
			"stage",
			"--for",
			"update-facts",
			"--input",
			JSON.stringify({ state: { established_facts: [{ fact: "output is JSON", round: 1 }] } }),
			"--json",
		]);
		const checkSummary = parse((await run(root, ["check", "--json"])).stdout);
		expect(checkSummary.ok).toBe(true);
		await run(root, ["apply", "--json"]);
		const after = await readState(root);
		const state = after.state as Record<string, unknown>;
		expect((state.established_facts as unknown[]).length).toBe(checkSummary.result_fact_count);
	});

	it("rejects non-initialize staging against missing state", async () => {
		const root = await tempDir();
		const result = await run(root, [
			"stage",
			"--for",
			"record-round",
			"--input",
			JSON.stringify({ state: { rounds: [] } }),
			"--json",
		]);
		expect(result.status).toBe(2);
		expect(parse(result.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_STATE_MISSING" });
	});

	it("allows initialize-context staging against missing state", async () => {
		const root = await tempDir();
		const staged = await run(root, [
			"stage",
			"--for",
			"initialize-context",
			"--input",
			JSON.stringify({ state: { initial_idea: "fresh idea", rounds: [] } }),
			"--json",
		]);
		expect(staged.status).toBe(0);
		const applied = await run(root, ["apply", "--json"]);
		expect(applied.status).toBe(0);
		const after = await readState(root);
		expect((after.state as Record<string, unknown>).initial_idea).toBe("fresh idea");
		expect(after.current_phase).toBe("interviewing");
	});

	it("rejects a second stage while a draft is pending", async () => {
		const root = await tempDir();
		await seed(root);
		const payload = JSON.stringify({ state: { rounds: [] } });
		await run(root, ["stage", "--for", "merge-state", "--input", payload, "--json"]);
		const second = await run(root, ["stage", "--for", "merge-state", "--input", payload, "--json"]);
		expect(second.status).toBe(2);
		expect(parse(second.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_DRAFT_EXISTS" });
	});

	it("auto-invalidates the draft on stale revision at apply", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({ state: { note: "staged before concurrent write" } }),
			"--json",
		]);
		// Concurrent writer bumps state_revision underneath the draft.
		const statePath = modeStatePath(root, TEST_SESSION_ID, "deep-interview");
		const current = await readState(root);
		current.state_revision = ((current.state_revision as number) ?? 0) + 1;
		await fs.writeFile(statePath, `${JSON.stringify(current, null, 2)}\n`, "utf-8");

		const applied = await run(root, ["apply", "--json"]);
		expect(applied.status).toBe(2);
		expect(parse(applied.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_REVISION_CONFLICT" });
		// Draft was invalidated — apply again reports no draft.
		const reapplied = await run(root, ["apply", "--json"]);
		expect(parse(reapplied.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_NO_DRAFT" });
	});

	it("check reports (not throws) a revision conflict without consuming the draft", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({ state: { note: "conflict check" } }),
			"--json",
		]);
		const statePath = modeStatePath(root, TEST_SESSION_ID, "deep-interview");
		const current = await readState(root);
		current.state_revision = ((current.state_revision as number) ?? 0) + 1;
		await fs.writeFile(statePath, `${JSON.stringify(current, null, 2)}\n`, "utf-8");

		const checked = await run(root, ["check", "--json"]);
		expect(checked.status).toBe(3);
		expect(parse(checked.stdout)).toMatchObject({ ok: false, code: "DI_STAGE_REVISION_CONFLICT" });
		// Draft still present: check never consumes.
		await expect(fs.stat(deepInterviewDraftPath(root, TEST_SESSION_ID))).resolves.toBeDefined();
	});

	it("discard removes the pending draft and is idempotent", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, ["stage", "--for", "merge-state", "--input", JSON.stringify({ state: {} }), "--json"]);
		const first = parse((await run(root, ["discard", "--json"])).stdout);
		expect(first).toMatchObject({ ok: true, removed: true });
		const second = parse((await run(root, ["discard", "--json"])).stdout);
		expect(second).toMatchObject({ ok: true, removed: false });
	});

	it("inherits the session from GJC_SESSION_ID with no identity flags", async () => {
		const root = await tempDir();
		await seed(root);
		const staged = await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({ state: { note: "session came from env" } }),
			"--json",
		]);
		expect(parse(staged.stdout).session_id).toBe(TEST_SESSION_ID);
	});

	it("rejects invalid JSON, non-object payloads, and unknown transitions", async () => {
		const root = await tempDir();
		await seed(root);
		const badJson = await run(root, ["stage", "--for", "merge-state", "--input", "{not json", "--json"]);
		expect(parse(badJson.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_INPUT_INVALID" });
		const nonObject = await run(root, ["stage", "--for", "merge-state", "--input", "[1,2]", "--json"]);
		expect(parse(nonObject.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_INPUT_INVALID" });
		const badTransition = await run(root, ["stage", "--for", "bogus", "--input", "{}", "--json"]);
		expect(parse(badTransition.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_USAGE" });
		const noInput = await run(root, ["stage", "--for", "merge-state", "--json"]);
		expect(parse(noInput.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_USAGE" });
	});

	it("rejects payloads that violate core bounded-input schema but passes free-form fields", async () => {
		const root = await tempDir();
		await seed(root);
		const oversized = await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({ state: { initial_idea: "x".repeat(50_001) } }),
			"--json",
		]);
		expect(parse(oversized.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_INPUT_INVALID" });

		// Unknown free-form keys are NOT schema violations.
		const freeForm = await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({ state: { my_custom_extension: { nested: ["anything"] }, another: 7 } }),
			"--json",
		]);
		expect(freeForm.status).toBe(0);
		await run(root, ["apply", "--json"]);
		const after = await readState(root);
		const state = after.state as Record<string, unknown>;
		expect(state.my_custom_extension).toEqual({ nested: ["anything"] });
		expect(state.another).toBe(7);
	});

	it("accepts @file input", async () => {
		const root = await tempDir();
		await seed(root);
		const payloadPath = path.join(root, "draft-payload.json");
		await fs.writeFile(payloadPath, JSON.stringify({ state: { note: "from file" } }), "utf-8");
		const staged = await run(root, ["stage", "--for", "merge-state", "--input", `@${payloadPath}`, "--json"]);
		expect(staged.status).toBe(0);
		const applied = await run(root, ["apply", "--json"]);
		expect(applied.status).toBe(0);
		const after = await readState(root);
		expect((after.state as Record<string, unknown>).note).toBe("from file");
	});

	it("reports missing draft for check/apply when nothing is staged", async () => {
		const root = await tempDir();
		await seed(root);
		const checked = await run(root, ["check", "--json"]);
		expect(parse(checked.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_NO_DRAFT" });
		const applied = await run(root, ["apply", "--json"]);
		expect(parse(applied.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_NO_DRAFT" });
	});

	it("reports a typed session error when no session id is resolvable", async () => {
		const root = await tempDir();
		const saved = process.env.GJC_SESSION_ID;
		delete process.env.GJC_SESSION_ID;
		try {
			const staged = await run(root, [
				"stage",
				"--for",
				"initialize-context",
				"--input",
				JSON.stringify({ state: { initial_idea: "no session anywhere" } }),
				"--json",
			]);
			expect(staged.status).toBe(2);
			expect(parse(staged.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_SESSION_REQUIRED" });
		} finally {
			process.env.GJC_SESSION_ID = saved;
		}
	});

	it("merges an incremental round patch without resending prior rounds", async () => {
		const root = await tempDir();
		await seed(root);
		const stageRound = (record: Record<string, unknown>) =>
			run(root, [
				"stage",
				"--for",
				"record-round",
				"--input",
				JSON.stringify({ state: { rounds: [record] } }),
				"--json",
			]);
		await stageRound({ round: 1, round_key: "r1", question_text: "q1", lifecycle: "answered" });
		await run(root, ["apply", "--json"]);
		// Second patch carries ONLY round 2 — round 1 must survive the merge.
		await stageRound({ round: 2, round_key: "r2", question_text: "q2", lifecycle: "answered" });
		await run(root, ["apply", "--json"]);
		// Third patch enriches ONLY round 1 to scored — still no resend of round 2.
		await stageRound({ round: 1, round_key: "r1", lifecycle: "scored", ambiguity: 0.3 });
		const applied = parse((await run(root, ["apply", "--json"])).stdout);
		expect(applied.ok).toBe(true);
		const after = await readState(root);
		const rounds = (after.state as Record<string, unknown>).rounds as Record<string, unknown>[];
		expect(rounds.length).toBe(2);
		const round1 = rounds.find(r => r.round_key === "r1");
		expect(round1?.lifecycle).toBe("scored");
		expect(round1?.question_text).toBe("q1");
	});

	it("derives current_ambiguity from the latest scored round, ignoring hand-set values", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, [
			"stage",
			"--for",
			"record-round",
			"--input",
			JSON.stringify({
				state: {
					// Agent tries to hand-set an unrelated current_ambiguity.
					current_ambiguity: 0.01,
					rounds: [{ round: 1, round_key: "r1", lifecycle: "scored", ambiguity: 0.37 }],
				},
			}),
			"--json",
		]);
		const checked = parse((await run(root, ["check", "--json"])).stdout);
		expect(checked.result_ambiguity).toBe(0.37);
		const applied = parse((await run(root, ["apply", "--json"])).stdout);
		expect(applied.current_ambiguity).toBe(0.37);
		const after = await readState(root);
		expect((after.state as Record<string, unknown>).current_ambiguity).toBe(0.37);
	});

	it("clamps derived ambiguity to the deterministic floor on disputed facts", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({
				state: {
					established_facts: [{ id: "f1", statement: "disputed fact", round: 1, disputed: true }],
					rounds: [{ round: 1, round_key: "r1", lifecycle: "scored", ambiguity: 0.02 }],
				},
			}),
			"--json",
		]);
		const applied = parse((await run(root, ["apply", "--json"])).stdout);
		// One unresolved disputed fact => floor 0.10 > reported 0.02.
		expect(applied.current_ambiguity).toBe(0.1);
		const after = await readState(root);
		const state = after.state as Record<string, unknown>;
		expect(state.current_ambiguity).toBe(0.1);
		const round = (state.rounds as Record<string, unknown>[]).find(r => r.round_key === "r1");
		expect(round?.reported_ambiguity).toBe(0.02);
		expect(round?.ambiguity).toBe(0.1);
	});
});
