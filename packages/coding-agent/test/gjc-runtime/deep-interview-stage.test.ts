import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { deepInterviewDraftPath } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-stage";
import { ENVELOPE_RESERVED_STATE_KEYS } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-state";
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
					rounds: [
						{
							round: 1,
							round_key: "r1",
							question_text: "What output format?",
							lifecycle: "scored",
							ambiguity: 0.42,
						},
					],
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
		const establishedFacts = state.established_facts;
		if (!Array.isArray(establishedFacts)) {
			throw new Error("Expected state established_facts to be an array");
		}
		const resultFactCount = checkSummary.result_fact_count;
		if (typeof resultFactCount !== "number") {
			throw new Error("Expected check summary result_fact_count to be a number");
		}
		expect(establishedFacts.length).toBe(resultFactCount);
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

	it("invalidates a draft when a sanctioned writer changes state without bumping revision", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({ state: { note: "staged before reseed" } }),
			"--json",
		]);
		// Re-seed goes through writeWorkflowEnvelopeAtomic, which does NOT bump
		// state_revision — only the content sha catches this writer.
		await seed(root);
		const applied = await run(root, ["apply", "--json"]);
		expect(applied.status).toBe(2);
		expect(parse(applied.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_REVISION_CONFLICT" });
	});

	it("strips runtime-owned lifecycle keys from staged payloads", async () => {
		const root = await tempDir();
		await seed(root);
		const staged = await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({
				current_phase: "handoff",
				active: false,
				skill: "ralplan",
				state_revision: 999,
				state: { note: "phase smuggle attempt" },
			}),
			"--json",
		]);
		expect(staged.status).toBe(0);
		const stagedSummary = parse(staged.stdout);
		expect(stagedSummary.ignored_runtime_owned_keys).toEqual(
			expect.arrayContaining(["current_phase", "active", "skill", "state_revision"]),
		);
		const applied = await run(root, ["apply", "--json"]);
		expect(applied.status).toBe(0);
		const after = await readState(root);
		expect(after.current_phase).toBe("interviewing");
		expect(after.active).toBe(true);
		expect(after.skill).toBe("deep-interview");
	});

	it("settles an apply replay after commit as an idempotent no-op", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({ state: { note: "replay target" } }),
			"--json",
		]);
		const first = parse((await run(root, ["apply", "--json"])).stdout);
		expect(first.ok).toBe(true);
		// Simulate a crash between commit and draft removal: re-create the exact
		// consumed draft file, then replay apply.
		const after = await readState(root);
		expect(after.last_applied_draft_id).toBe(first.draft_id);
		const draftPath = deepInterviewDraftPath(root, TEST_SESSION_ID);
		await fs.writeFile(
			draftPath,
			`${JSON.stringify({
				version: 1,
				draft_id: first.draft_id,
				session_id: TEST_SESSION_ID,
				transition: "merge-state",
				staged_against_revision: 0,
				staged_against_sha256: "stale",
				payload: { state: { note: "replay target" } },
				created_at: new Date().toISOString(),
			})}\n`,
			"utf-8",
		);
		const replay = await run(root, ["apply", "--json"]);
		expect(replay.status).toBe(0);
		expect(parse(replay.stdout)).toMatchObject({ ok: true, already_applied: true, draft_id: first.draft_id });
		// Draft settled.
		await expect(fs.stat(draftPath)).rejects.toThrow();
	});

	it("honors an explicit --session-id on staged verbs", async () => {
		const root = await tempDir();
		await seed(root);
		const other = "other-session";
		const staged = await run(root, [
			"stage",
			"--for",
			"initialize-context",
			"--input",
			JSON.stringify({ state: { initial_idea: "second session" } }),
			"--session-id",
			other,
			"--json",
		]);
		expect(staged.status).toBe(0);
		expect(parse(staged.stdout).session_id).toBe(other);
		const applied = await run(root, ["apply", "--session-id", other, "--json"]);
		expect(applied.status).toBe(0);
		// Default-session draft state untouched; env-session check finds no draft.
		const checked = await run(root, ["check", "--json"]);
		expect(parse(checked.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_NO_DRAFT" });
	});

	it("rejects oversized and non-regular @file inputs before reading", async () => {
		const root = await tempDir();
		await seed(root);
		const bigPath = path.join(root, "big-payload.json");
		await fs.writeFile(bigPath, `{"state":{"note":"${"x".repeat(1_100_000)}"}}`, "utf-8");
		const oversized = await run(root, ["stage", "--for", "merge-state", "--input", `@${bigPath}`, "--json"]);
		expect(parse(oversized.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_INPUT_INVALID" });
		const dirInput = await run(root, ["stage", "--for", "merge-state", "--input", `@${root}`, "--json"]);
		expect(parse(dirInput.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_INPUT_INVALID" });
	});

	it("retains prior ambiguity when a staged patch has no valid scored round", async () => {
		const root = await tempDir();
		await seed(root);
		// Seeded state carries current_ambiguity 1.0; a bare hand-set 0.01 with no
		// scored round must NOT survive.
		await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({ state: { current_ambiguity: 0.01 } }),
			"--json",
		]);
		const applied = parse((await run(root, ["apply", "--json"])).stdout);
		expect(applied.current_ambiguity).toBe(1);
		const after = await readState(root);
		expect((after.state as Record<string, unknown>).current_ambiguity).toBe(1);
	});

	it("ignores malformed scored rounds when deriving ambiguity", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, [
			"stage",
			"--for",
			"record-round",
			"--input",
			JSON.stringify({
				state: {
					rounds: [
						// Malformed: scored lifecycle but no numeric round.
						{ round_key: "bogus", lifecycle: "scored", ambiguity: 0.01 },
						{ round: 1, round_key: "r1", lifecycle: "scored", ambiguity: 0.55 },
					],
				},
			}),
			"--json",
		]);
		const applied = parse((await run(root, ["apply", "--json"])).stdout);
		expect(applied.current_ambiguity).toBe(0.55);
	});

	it("preserves prior facts across a one-fact staged delta", async () => {
		const root = await tempDir();
		await seed(root);
		// Establish two facts, one disputed (holds the floor at 0.10).
		await run(root, [
			"stage",
			"--for",
			"update-facts",
			"--input",
			JSON.stringify({
				state: {
					established_facts: [
						{ id: "f1", statement: "confirmed fact", round: 1, disputed: false },
						{ id: "f2", statement: "disputed fact", round: 1, disputed: true },
					],
				},
			}),
			"--json",
		]);
		await run(root, ["apply", "--json"]);
		// Delta: add ONE new fact — f1/f2 must survive.
		await run(root, [
			"stage",
			"--for",
			"update-facts",
			"--input",
			JSON.stringify({
				state: { established_facts: [{ id: "f3", statement: "new fact", round: 2, disputed: false }] },
			}),
			"--json",
		]);
		const applied = parse((await run(root, ["apply", "--json"])).stdout);
		const after = await readState(root);
		const facts = (after.state as Record<string, unknown>).established_facts as Record<string, unknown>[];
		expect(facts.map(f => f.id).sort()).toEqual(["f1", "f2", "f3"]);
		expect(facts.find(f => f.id === "f2")?.disputed).toBe(true);
		// No scored round exists, so the prior seeded ambiguity (1.0) is retained;
		// the disputed-fact floor is recorded as pressure evidence.
		expect(applied.current_ambiguity).toBe(1);
		const floorInfo = (after.state as Record<string, unknown>).ambiguity_floor as Record<string, unknown>;
		expect(floorInfo.disputed_fact_count).toBe(1);
		expect(floorInfo.floor).toBe(0.1);
		// Field-wise update by id: supersede the disputed fact, floor releases.
		await run(root, [
			"stage",
			"--for",
			"update-facts",
			"--input",
			JSON.stringify({
				state: { established_facts: [{ id: "f2", disputed: false, superseded_by: "f3" }] },
			}),
			"--json",
		]);
		await run(root, ["apply", "--json"]);
		const final = await readState(root);
		const finalFacts = (final.state as Record<string, unknown>).established_facts as Record<string, unknown>[];
		expect(finalFacts.length).toBe(3);
		const f2 = finalFacts.find(f => f.id === "f2");
		expect(f2?.superseded_by).toBe("f3");
		expect(f2?.statement).toBe("disputed fact");
	});

	it("serializes a sanctioned envelope writer against an in-flight apply", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, [
			"stage",
			"--for",
			"merge-state",
			"--input",
			JSON.stringify({ state: { note: "apply under contention" } }),
			"--json",
		]);
		// Fire a sanctioned revision-preserving writer (re-seed) CONCURRENTLY with
		// apply. With the writer-wide path lock, both serialize: whichever writes
		// second sees the other's write. Legal outcomes: apply succeeds (seed ran
		// first or second under the lock) or apply reports a typed conflict —
		// never a silent overwrite of the later write or a torn state file.
		const [applied, reseeded] = await Promise.all([
			run(root, ["apply", "--json"]),
			runNativeDeepInterviewCommand(["--json", "concurrent reseed"], root),
		]);
		expect(reseeded.status).toBe(0);
		expect([0, 2]).toContain(applied.status);
		if (applied.status === 2) {
			expect(parse(applied.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_REVISION_CONFLICT" });
		}
		// State file is intact and canonical afterwards regardless of ordering.
		const after = await readState(root);
		expect(after.skill).toBe("deep-interview");
		expect(after.active).toBe(true);
		const checked = await run(root, ["check", "--json"]);
		// Any remaining draft is either consumed (NO_DRAFT) or stale-detected.
		if (checked.status !== 0) {
			const body = parse(checked.stderr ?? checked.stdout);
			expect(["DI_STAGE_NO_DRAFT", "DI_STAGE_REVISION_CONFLICT"]).toContain(body.code as string);
		}
	});

	it("read returns the envelope, revision, sha, and pending draft", async () => {
		const root = await tempDir();
		const missing = parse((await run(root, ["read", "--json"])).stdout);
		expect(missing).toMatchObject({ ok: true, verb: "read", exists: false });
		await seed(root);
		await run(root, ["stage", "--for", "merge-state", "--input", JSON.stringify({ state: {} }), "--json"]);
		const read = parse((await run(root, ["read", "--json"])).stdout);
		expect(read.exists).toBe(true);
		expect(typeof read.revision).toBe("number");
		expect(typeof read.content_sha256).toBe("string");
		expect((read.envelope as Record<string, unknown>).skill).toBe("deep-interview");
		expect((read.pending_draft as Record<string, unknown>).transition).toBe("merge-state");
	});

	it("write merges incrementally by default and replaces with --reset", async () => {
		const root = await tempDir();
		await seed(root);
		const first = parse(
			(
				await run(root, [
					"write",
					"--input",
					JSON.stringify({
						state: { note_a: "kept", established_facts: [{ id: "f1", statement: "fact", round: 1 }] },
					}),
					"--json",
				])
			).stdout,
		);
		expect(first).toMatchObject({ ok: true, verb: "write", mode: "incremental" });
		const second = parse(
			(await run(root, ["write", "--input", JSON.stringify({ state: { note_b: "added" } }), "--json"])).stdout,
		);
		expect(second.mode).toBe("incremental");
		expect(second.applied_revision).toBeGreaterThan(first.applied_revision as number);
		const merged = await readState(root);
		const mergedState = merged.state as Record<string, unknown>;
		// Incremental: both notes and prior facts survive.
		expect(mergedState.note_a).toBe("kept");
		expect(mergedState.note_b).toBe("added");
		expect((mergedState.established_facts as unknown[]).length).toBe(1);
		// Reset replaces free-form state.
		const reset = parse(
			(await run(root, ["write", "--reset", "--input", JSON.stringify({ state: { fresh: true } }), "--json"]))
				.stdout,
		);
		expect(reset.mode).toBe("reset");
		const after = await readState(root);
		const afterState = after.state as Record<string, unknown>;
		expect(afterState.fresh).toBe(true);
		expect(afterState.note_a).toBeUndefined();
		expect(afterState.note_b).toBeUndefined();
	});

	it("reset preserves canonical Crystal and spec ownership metadata", async () => {
		const root = await tempDir();
		await seed(root);
		const statePath = modeStatePath(root, TEST_SESSION_ID, "deep-interview");
		const state = await readState(root);
		state.spec_path = "/tmp/crystal.md";
		state.spec_sha256 = "a".repeat(64);
		state.spec_slug = "crystal";
		state.spec_stage = "final";
		state.state = { crystal: { lifecycle: "ready", schema_version: 1 }, execution_approval: "not-approved" };
		await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
		const reset = parse(
			(await run(root, ["write", "--reset", "--input", JSON.stringify({ state: { fresh: true } }), "--json"]))
				.stdout,
		);
		expect(reset.mode).toBe("reset");
		const after = await readState(root);
		expect((after.state as Record<string, unknown>).crystal).toEqual({ lifecycle: "ready", schema_version: 1 });
		expect(after.spec_path).toBe("/tmp/crystal.md");
		expect((after.state as Record<string, unknown>).execution_approval).toBe("not-approved");
	});

	it("write refuses while a staged draft is pending and strips runtime-owned keys", async () => {
		const root = await tempDir();
		await seed(root);
		await run(root, ["stage", "--for", "merge-state", "--input", JSON.stringify({ state: {} }), "--json"]);
		const blocked = await run(root, ["write", "--input", JSON.stringify({ state: { x: 1 } }), "--json"]);
		expect(parse(blocked.stderr)).toMatchObject({ ok: false, code: "DI_STAGE_DRAFT_EXISTS" });
		await run(root, ["discard", "--json"]);
		const smuggle = parse(
			(
				await run(root, [
					"write",
					"--input",
					JSON.stringify({ current_phase: "handoff", skill: "ralplan", state: { y: 2 } }),
					"--json",
				])
			).stdout,
		);
		expect(smuggle.ignored_runtime_owned_keys).toEqual(expect.arrayContaining(["current_phase", "skill"]));
		const after = await readState(root);
		expect(after.current_phase).toBe("interviewing");
		expect(after.skill).toBe("deep-interview");
	});

	it("clear routes through the lifecycle plumbing", async () => {
		const root = await tempDir();
		await seed(root);
		const cleared = await run(root, ["clear", "--force", "--json"]);
		expect(cleared.status).toBe(0);
		const read = parse((await run(root, ["read", "--json"])).stdout);
		// Cleared state persists a terminal envelope (active:false) or none at all.
		if (read.exists) {
			expect((read.envelope as Record<string, unknown>).active).toBe(false);
		}
	});

	it("strips recorder-owned intent keys from staged payloads", async () => {
		const root = await tempDir();
		await seed(root);
		const staged = parse(
			(
				await run(root, [
					"write",
					"--input",
					JSON.stringify({
						state: {
							intent_contract: { version: 1, status: "confirmed", items: [] },
							intent_review: { version: 1, status: "approved" },
							note: "payload with fabricated contract",
						},
					}),
					"--json",
				])
			).stdout,
		);
		expect(staged.ok).toBe(true);
		expect(staged.ignored_runtime_owned_keys).toEqual(
			expect.arrayContaining(["state.intent_contract", "state.intent_review"]),
		);
		const after = await readState(root);
		const state = after.state as Record<string, unknown>;
		expect(state.intent_contract).toBeUndefined();
		expect(state.intent_review).toBeUndefined();
		expect(state.note).toBe("payload with fabricated contract");
	});

	it("reports nested envelope-reserved keys instead of dropping them silently", async () => {
		for (const key of ENVELOPE_RESERVED_STATE_KEYS) {
			const root = await tempDir();
			await seed(root);
			const before = await readState(root);
			const staged = parse(
				(
					await run(root, [
						"write",
						"--input",
						JSON.stringify({ state: { [key]: "discarded", note: "survives" } }),
						"--json",
					])
				).stdout,
			);
			expect(staged.ok).toBe(true);
			// The discard must be named: an unqualified success would misreport the write.
			expect(staged.ignored_runtime_owned_keys).toEqual(expect.arrayContaining([`state.${key}`]));
			const after = await readState(root);
			// Envelope lifecycle is unchanged, and unreserved payload keys still land.
			expect(after.current_phase).toBe(before.current_phase);
			expect(after.active).toBe(true);
			expect((after.state as Record<string, unknown>)[key]).toBeUndefined();
			expect((after.state as Record<string, unknown>).note).toBe("survives");
		}
	});

	it("still rejects an oversized nested reserved value instead of reporting it away", async () => {
		for (const key of ENVELOPE_RESERVED_STATE_KEYS) {
			const root = await tempDir();
			await seed(root);
			const before = await readState(root);
			// Naming a discarded key must not strip it before the structured-size check:
			// an oversized value has to keep failing rather than turn into a quiet ignore.
			const result = await run(root, [
				"write",
				"--input",
				JSON.stringify({ state: { [key]: "x".repeat(200_000) } }),
				"--json",
			]);
			expect(result.status).not.toBe(0);
			const failure = parse(result.stderr && result.stderr.trim() !== "" ? result.stderr : (result.stdout ?? ""));
			expect(failure.ok).toBe(false);
			expect(failure.code).toBe("DI_STAGE_INPUT_INVALID");
			const after = await readState(root);
			expect(after.state_revision).toBe(before.state_revision);
		}
	});

	it("self-heals a poisoned intent contract in persisted state instead of bricking", async () => {
		const root = await tempDir();
		await seed(root);
		// Simulate the pre-guard poisoned write: an unverifiable contract already
		// persisted (as happened in the dogfood run before the sanitizer existed).
		const statePath = modeStatePath(root, TEST_SESSION_ID, "deep-interview");
		const current = await readState(root);
		(current.state as Record<string, unknown>).intent_contract = {
			version: 1,
			status: "confirmed",
			items: [{ id: "artifact:roadmap", category: "artifact", statement: "roadmap" }],
		};
		await fs.writeFile(statePath, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
		// Any later delta write must succeed, not fail with `invalid intent contract`.
		const written = parse(
			(await run(root, ["write", "--input", JSON.stringify({ state: { note: "after poison" } }), "--json"])).stdout,
		);
		expect(written.ok).toBe(true);
		const after = await readState(root);
		const state = after.state as Record<string, unknown>;
		expect(state.intent_contract).toBeUndefined();
		expect(state.note).toBe("after poison");
		expect(typeof after.intent_contract_healed_at).toBe("string");
	});

	it("accepts the documented initialize payload with null prose markers first try", async () => {
		const root = await tempDir();
		// The skill's Phase 1 template seeds nullable prose fields as null — this
		// exact shape must succeed on the FIRST write, with no failed probe.
		const written = parse(
			(
				await run(root, [
					"write",
					"--input",
					JSON.stringify({
						state: {
							interview_id: "iv-1",
							type: "brownfield",
							initial_idea: "future roadmap discussion",
							initial_context_summary: null,
							rounds: [],
							established_facts: [],
							trace_summary: null,
							codebase_context: null,
							restated_goal: null,
						},
					}),
					"--json",
				])
			).stdout,
		);
		expect(written.ok).toBe(true);
		const after = await readState(root);
		const state = after.state as Record<string, unknown>;
		expect(state.initial_idea).toBe("future roadmap discussion");
		// null markers delete/omit rather than persisting nulls or erroring.
		expect(state.initial_context_summary ?? undefined).toBeUndefined();
	});

	it("refreshes the active-state/HUD projection after write and apply", async () => {
		const root = await tempDir();
		await seed(root);
		const snapshotPath = path.join(root, ".gjc", `_session-${TEST_SESSION_ID}`, "state", "skill-active-state.json");
		const readHudAmbiguity = async (): Promise<string | undefined> => {
			const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8")) as Record<string, unknown>;
			const skills = snapshot.active_skills as Record<string, unknown>[];
			const entry = skills.find(s => s.skill === "deep-interview");
			const chips = ((entry?.hud as Record<string, unknown> | undefined)?.chips ?? []) as Record<string, unknown>[];
			return chips.find(c => c.label === "ambiguity")?.value as string | undefined;
		};
		// Direct write with a scored round updates the HUD projection.
		await run(root, [
			"write",
			"--input",
			JSON.stringify({ state: { rounds: [{ round: 1, round_key: "r1", lifecycle: "scored", ambiguity: 0.44 }] } }),
			"--json",
		]);
		expect(await readHudAmbiguity()).toContain("44%");
		// Staged apply refreshes it again.
		await run(root, [
			"stage",
			"--for",
			"record-round",
			"--input",
			JSON.stringify({ state: { rounds: [{ round: 2, round_key: "r2", lifecycle: "scored", ambiguity: 0.21 }] } }),
			"--json",
		]);
		await run(root, ["apply", "--json"]);
		expect(await readHudAmbiguity()).toContain("21%");
	});
});
