import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runDeepInterviewDraftCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-draft";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";

type CommandResult = { status: number; stdout?: string; stderr?: string };
type Draft = { id: string; draft_revision: number; base_revision: number; receipt?: Record<string, unknown> };

async function workspace(): Promise<{ cwd: string; root: string; restore(): Promise<void> }> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-draft-consume-workspace-"));
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-draft-consume-root-"));
	const previous = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
	process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = root;
	return {
		cwd,
		root,
		async restore() {
			if (previous === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = previous;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

function json(result: CommandResult): Record<string, unknown> {
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout ?? "{}") as Record<string, unknown>;
}

function draft(result: CommandResult): Draft {
	return json(result).draft as Draft;
}

async function native(cwd: string, args: string[]): Promise<CommandResult> {
	return runNativeDeepInterviewCommand(args, cwd);
}

async function kickoff(cwd: string, session: string): Promise<void> {
	expect((await native(cwd, ["--session-id", session, "--json", "draft-owned interview"])).status).toBe(0);
}

async function create(cwd: string, kind: string, session: string, extra: string[] = []): Promise<Draft> {
	return draft(await native(cwd, ["draft", "create", "--for", kind, "--session-id", session, ...extra, "--json"]));
}

async function edit(
	cwd: string,
	id: string,
	revision: number,
	op: string,
	target: string,
	value?: string,
): Promise<Draft> {
	const args = [
		"draft",
		"edit",
		"--draft-id",
		id,
		"--expected-draft-revision",
		String(revision),
		"--op",
		op,
		"--path",
		target,
	];
	if (value !== undefined) args.push("--value", value);
	return draft(await native(cwd, [...args, "--json"]));
}

async function setSetup(cwd: string, input: Draft): Promise<Draft> {
	let current = input;
	for (const [target, value] of [
		["/type", "greenfield"],
		["/interview_id", "interview-1"],
		["/initial_context_summary", "summary"],
		["/codebase_context", "context"],
		["/threshold", "0.05"],
		["/trace_summary", "trace"],
	])
		current = await edit(cwd, current.id, current.draft_revision, "set", target, value);
	current = await edit(cwd, current.id, current.draft_revision, "append", "/challenge_modes_used", "challenge");
	return edit(cwd, current.id, current.draft_revision, "append", "/trace", "seed");
}

async function consume(cwd: string, kind: string, current: Draft): Promise<CommandResult> {
	return native(cwd, [
		kind,
		"--draft-id",
		current.id,
		"--expected-draft-revision",
		String(current.draft_revision),
		"--json",
	]);
}
async function confirmSingleActiveTopology(cwd: string, session: string): Promise<void> {
	let topology = await create(cwd, "confirm-topology", session);
	topology = await edit(cwd, topology.id, topology.draft_revision, "append", "/components");
	topology = await edit(cwd, topology.id, topology.draft_revision, "set", "/components/0/id", "core");
	topology = await edit(cwd, topology.id, topology.draft_revision, "set", "/components/0/name", "Core");
	topology = await edit(cwd, topology.id, topology.draft_revision, "set", "/components/0/status", "deferred");
	topology = await edit(cwd, topology.id, topology.draft_revision, "set", "/components/0/active", "false");
	topology = await edit(cwd, topology.id, topology.draft_revision, "append", "/deferred_components", "core");
	json(await consume(cwd, "confirm-topology", topology));
}

async function state(cwd: string, session: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(modeStatePath(cwd, session, "deep-interview"), "utf8")) as Record<
		string,
		unknown
	>;
}
async function populateCompleteResult(cwd: string, input: Draft): Promise<Draft> {
	let current = input;
	current = await edit(cwd, current.id, current.draft_revision, "append", "/component_updates");
	current = await edit(cwd, current.id, current.draft_revision, "append", "/triggers");
	current = await edit(cwd, current.id, current.draft_revision, "remove", "/triggers/0");
	current = await edit(cwd, current.id, current.draft_revision, "append", "/fact_ops");
	current = await edit(cwd, current.id, current.draft_revision, "remove", "/fact_ops/0");
	for (const target of ["/ontology/entities", "/ontology/relationships", "/ontology/reasoning"]) {
		current = await edit(cwd, current.id, current.draft_revision, "append", target);
		current = await edit(cwd, current.id, current.draft_revision, "remove", `${target}/0`);
	}
	current = await edit(cwd, current.id, current.draft_revision, "set", "/bookkeeping/resolution", "direct");
	current = await edit(cwd, current.id, current.draft_revision, "append", "/bookkeeping/round_ids", "r1");
	current = await edit(cwd, current.id, current.draft_revision, "set", "/bookkeeping/counter_deltas/count", "0");
	for (const dimension of ["goal", "constraints", "criteria"]) {
		current = await edit(cwd, current.id, current.draft_revision, "set", `/global_scores/${dimension}`, "1");
		current = await edit(
			cwd,
			current.id,
			current.draft_revision,
			"set",
			`/component_updates/0/scores/${dimension}`,
			"1",
		);
	}
	for (const [target, value] of [
		["/component_updates/0/component_id", "core"],
		["/targeting/target_component_id", "core"],
		["/targeting/target_dimension", "goal"],
		["/targeting/weakest_component_id", "core"],
		["/targeting/weakest_dimension", "goal"],
	])
		current = await edit(cwd, current.id, current.draft_revision, "set", target, value);
	const nullEdit = await native(cwd, [
		"draft",
		"edit",
		"--draft-id",
		current.id,
		"--expected-draft-revision",
		String(current.draft_revision),
		"--op",
		"set",
		"--path",
		"/targeting/last_targeted_component_id",
		"--null",
		"--json",
	]);
	expect(
		((json(nullEdit).draft as { payload: Record<string, unknown> }).payload.targeting as Record<string, unknown>)
			.last_targeted_component_id,
	).toBeNull();
	current = draft(nullEdit);
	return current;
}

describe("CLI-owned deep-interview draft consumption", () => {
	it("consumes a greenfield setup draft through the public route and replays its receipt", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "setup");
			const prepared = await setSetup(env.cwd, await create(env.cwd, "initialize-context", "setup"));
			const checked = json(await native(env.cwd, ["draft", "check", "--draft-id", prepared.id, "--json"]));
			expect(checked).toMatchObject({ valid: true, stale: false, state_revision: 0 });
			const first = json(await consume(env.cwd, "initialize-context", prepared));
			expect(first).toMatchObject({ consumed: true, draft_id: prepared.id });
			const after = await state(env.cwd, "setup");
			expect(after.state_revision).toBe(1);
			expect((after.state as Record<string, unknown>).initial_idea).toBe("draft-owned interview");
			const replay = json(await consume(env.cwd, "initialize-context", prepared));
			expect(replay.receipt).toEqual(first.receipt);
			expect((await state(env.cwd, "setup")).state_revision).toBe(1);
		} finally {
			await env.restore();
		}
	});

	it("scaffolds topology objects and defers scalar array entries before consume", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "topology");
			const setup = await setSetup(env.cwd, await create(env.cwd, "initialize-context", "topology"));
			json(await consume(env.cwd, "initialize-context", setup));
			let topology = await create(env.cwd, "confirm-topology", "topology");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "append", "/components");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "set", "/components/0/id", "core");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "set", "/components/0/name", "Core");
			topology = await edit(
				env.cwd,
				topology.id,
				topology.draft_revision,
				"set",
				"/components/0/status",
				"deferred",
			);
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "set", "/components/0/active", "false");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "append", "/deferred_components", "core");
			expect(json(await consume(env.cwd, "confirm-topology", topology))).toMatchObject({ consumed: true });
			expect((await state(env.cwd, "topology")).state_revision).toBe(2);
		} finally {
			await env.restore();
		}
	});
	it("initializes required empty scalar arrays through the public draft route", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "zero-deferrals");
			const setup = await setSetup(env.cwd, await create(env.cwd, "initialize-context", "zero-deferrals"));
			json(await consume(env.cwd, "initialize-context", setup));
			let topology = await create(env.cwd, "confirm-topology", "zero-deferrals");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "append", "/components");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "set", "/components/0/id", "core");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "append", "/deferred_components");
			expect(json(await native(env.cwd, ["draft", "check", "--draft-id", topology.id, "--json"]))).toMatchObject({
				valid: true,
			});
			expect(json(await consume(env.cwd, "confirm-topology", topology))).toMatchObject({ consumed: true });
			expect(
				((await state(env.cwd, "zero-deferrals")).state as { topology: Record<string, unknown> }).topology,
			).toMatchObject({
				deferred_components: [],
			});
		} finally {
			await env.restore();
		}
	});
	it("applies a complete greenfield result through a CLI-owned draft", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "result");
			const setup = await setSetup(env.cwd, await create(env.cwd, "initialize-context", "result"));
			json(await consume(env.cwd, "initialize-context", setup));
			let topology = await create(env.cwd, "confirm-topology", "result");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "append", "/components");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "set", "/components/0/id", "core");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "set", "/components/0/name", "Core");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "append", "/deferred_components", "core");
			topology = await edit(env.cwd, topology.id, topology.draft_revision, "remove", "/deferred_components/0");
			json(await consume(env.cwd, "confirm-topology", topology));
			let answer = await create(env.cwd, "record-answer", "result", [
				"--round",
				"1",
				"--question-id",
				"q1",
				"--round-id",
				"r1",
				"--component-id",
				"core",
				"--dimension",
				"goal",
			]);
			answer = await edit(
				env.cwd,
				answer.id,
				answer.draft_revision,
				"set",
				"/question",
				JSON.stringify("Question?"),
			);
			answer = await edit(env.cwd, answer.id, answer.draft_revision, "append", "/answer/selected_options", "yes");
			answer = draft(
				await runDeepInterviewDraftCommand(
					[
						"edit",
						"--draft-id",
						answer.id,
						"--expected-draft-revision",
						String(answer.draft_revision),
						"--op",
						"set",
						"--path",
						"/answer/custom_input",
						"--null",
						"--json",
					],
					env.cwd,
				),
			);
			json(await consume(env.cwd, "record-answer", answer));
			const complete = await populateCompleteResult(
				env.cwd,
				await create(env.cwd, "apply-round-result", "result", ["--round-key", "interview-1::rid:r1"]),
			);
			expect(json(await consume(env.cwd, "apply-round-result", complete))).toMatchObject({ consumed: true });
			const projected = await state(env.cwd, "result");
			expect(projected.current_phase).toBe("interviewing");
			expect(
				(projected.state as { rounds: Array<{ scores: Record<string, number> }> }).rounds[0]?.scores,
			).toMatchObject({
				goal: 1,
				constraints: 1,
				criteria: 1,
			});
		} finally {
			await env.restore();
		}
	});

	it("consumes a record-answer draft with its complete round identity and nullable custom input", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "answer");
			const setup = await setSetup(env.cwd, await create(env.cwd, "initialize-context", "answer"));
			json(await consume(env.cwd, "initialize-context", setup));
			await confirmSingleActiveTopology(env.cwd, "answer");
			let answer = await create(env.cwd, "record-answer", "answer", [
				"--round",
				"1",
				"--question-id",
				"q1",
				"--round-id",
				"r1",
				"--component-id",
				"core",
				"--dimension",
				"goal",
			]);
			answer = await edit(
				env.cwd,
				answer.id,
				answer.draft_revision,
				"set",
				"/question",
				JSON.stringify("What matters?"),
			);
			answer = await edit(env.cwd, answer.id, answer.draft_revision, "append", "/answer/selected_options", "speed");
			answer = draft(
				await runDeepInterviewDraftCommand(
					[
						"edit",
						"--draft-id",
						answer.id,
						"--expected-draft-revision",
						String(answer.draft_revision),
						"--op",
						"set",
						"--path",
						"/answer/custom_input",
						"--null",
						"--json",
					],
					env.cwd,
				),
			);
			json(await consume(env.cwd, "record-answer", answer));
			const rounds = ((await state(env.cwd, "answer")).state as { rounds: Array<Record<string, unknown>> }).rounds;
			expect(rounds[0]).toMatchObject({
				round: 1,
				question_id: "q1",
				round_id: "r1",
				component: "core",
				dimension: "goal",
				lifecycle: "answered",
			});
		} finally {
			await env.restore();
		}
	});

	it("rejects stale edit, discard, and consume; reports stale checks and supports only valid rebases", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "conflicts");
			const initial = await create(env.cwd, "initialize-context", "conflicts");
			expect(
				(
					await native(env.cwd, [
						"draft",
						"edit",
						"--draft-id",
						initial.id,
						"--expected-draft-revision",
						"2",
						"--op",
						"set",
						"--path",
						"/type",
						"--value",
						"greenfield",
						"--json",
					])
				).stderr,
			).toContain("DI_DRAFT_REVISION_CONFLICT");
			expect(
				(
					await native(env.cwd, [
						"draft",
						"discard",
						"--draft-id",
						initial.id,
						"--expected-draft-revision",
						"2",
						"--json",
					])
				).stderr,
			).toContain("DI_DRAFT_REVISION_CONFLICT");
			const prepared = await setSetup(env.cwd, initial);
			const competing = await setSetup(env.cwd, await create(env.cwd, "initialize-context", "conflicts"));
			json(await consume(env.cwd, "initialize-context", competing));
			const check = json(await native(env.cwd, ["draft", "check", "--draft-id", prepared.id, "--json"]));
			expect(check).toMatchObject({ stale: true, state_revision: 1 });
			expect((await consume(env.cwd, "initialize-context", prepared)).status).toBe(3);
			expect(
				(
					await native(env.cwd, [
						"draft",
						"rebase",
						"--draft-id",
						prepared.id,
						"--expected-draft-revision",
						String(prepared.draft_revision),
						"--to-state-revision",
						"0",
						"--json",
					])
				).stderr,
			).toContain("DI_STATE_REVISION_CONFLICT");
			const rebased = draft(
				await native(env.cwd, [
					"draft",
					"rebase",
					"--draft-id",
					prepared.id,
					"--expected-draft-revision",
					String(prepared.draft_revision),
					"--to-state-revision",
					"1",
					"--json",
				]),
			);
			expect(rebased.base_revision).toBe(1);
		} finally {
			await env.restore();
		}
	});

	it("fails closed for absent, corrupt, terminal, ambiguous, and mixed-mode mutations before changing state", async () => {
		const env = await workspace();
		try {
			const absent = await native(env.cwd, [
				"draft",
				"create",
				"--for",
				"initialize-context",
				"--session-id",
				"absent",
				"--json",
			]);
			expect(absent).toMatchObject({ status: 2, stderr: expect.stringContaining("DI_STATE_ABSENT") });
			expect(
				(
					await native(env.cwd, [
						"initialize-context",
						"--draft-id",
						"missing",
						"--expected-draft-revision",
						"1",
						"--input-json",
						"{}",
						"--json",
					])
				).stderr,
			).toContain("DI_INPUT_MODE_CONFLICT");
			await kickoff(env.cwd, "closed");
			const before = await state(env.cwd, "closed");
			const missingShell = await native(env.cwd, [
				"draft",
				"create",
				"--for",
				"apply-round-result",
				"--session-id",
				"closed",
				"--json",
			]);
			expect(missingShell).toMatchObject({
				status: 2,
				stderr: expect.stringContaining("DI_PENDING_SHELL_NOT_FOUND"),
			});
			const corrupt = await create(env.cwd, "initialize-context", "closed");
			await fs.writeFile(modeStatePath(env.cwd, "closed", "deep-interview"), "{broken");
			expect((await native(env.cwd, ["draft", "check", "--draft-id", corrupt.id, "--json"])).stderr).toContain(
				"DI_STATE",
			);
			await Bun.write(
				modeStatePath(env.cwd, "closed", "deep-interview"),
				JSON.stringify({ ...before, current_phase: "complete", active: false }),
			);
			expect((await native(env.cwd, ["--session-id", "closed", "--json"])).status).toBe(2);
		} finally {
			await env.restore();
		}
	});

	it("repairs a failed receipt persistence through semantic replay without another state mutation", async () => {
		const env = await workspace();
		const prior = process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE;
		try {
			await kickoff(env.cwd, "receipt");
			const prepared = await setSetup(env.cwd, await create(env.cwd, "initialize-context", "receipt"));
			process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE = "1";
			const failed = await consume(env.cwd, "initialize-context", prepared);
			expect(failed).toMatchObject({
				status: 2,
				stderr: expect.stringContaining("DI_DRAFT_RECEIPT_PERSIST_FAILED"),
			});
			expect((await state(env.cwd, "receipt")).state_revision).toBe(1);
			delete process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE;
			const repaired = json(await consume(env.cwd, "initialize-context", prepared));
			expect(repaired).toMatchObject({ consumed: true, draft_id: prepared.id });
			expect((await state(env.cwd, "receipt")).state_revision).toBe(1);
		} finally {
			if (prior === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE = prior;
			await env.restore();
		}
	});
	it("fails closed when a competing write advances state after attempt persistence", async () => {
		const env = await workspace();
		const prior = process.env.GJC_DEEP_INTERVIEW_DRAFT_INJECT_COMPETING_WRITE;
		try {
			await kickoff(env.cwd, "attempt-conflict");
			let prepared = await setSetup(env.cwd, await create(env.cwd, "initialize-context", "attempt-conflict"));
			prepared = await edit(
				env.cwd,
				prepared.id,
				prepared.draft_revision,
				"set",
				"/trace_summary",
				"must-not-apply",
			);
			process.env.GJC_DEEP_INTERVIEW_DRAFT_INJECT_COMPETING_WRITE = "1";
			expect(await consume(env.cwd, "initialize-context", prepared)).toMatchObject({
				status: 3,
				stderr: expect.stringContaining("DI_STATE_REVISION_CONFLICT"),
			});
			delete process.env.GJC_DEEP_INTERVIEW_DRAFT_INJECT_COMPETING_WRITE;
			expect(await consume(env.cwd, "initialize-context", prepared)).toMatchObject({
				status: 3,
				stderr: expect.stringContaining("DI_STATE_REVISION_CONFLICT"),
			});
			const after = await state(env.cwd, "attempt-conflict");
			expect(after.state_revision).toBe(1);
			expect((after.state as Record<string, unknown>).trace_summary).not.toBe("must-not-apply");
			expect((after.state as Record<string, unknown>).injected_competing_write).toBe(true);
			const rebased = draft(
				await native(env.cwd, [
					"draft",
					"rebase",
					"--draft-id",
					prepared.id,
					"--expected-draft-revision",
					String(prepared.draft_revision),
					"--to-state-revision",
					"1",
					"--json",
				]),
			);
			expect(rebased.base_revision).toBe(1);
			expect(json(await consume(env.cwd, "initialize-context", rebased))).toMatchObject({ consumed: true });
			expect((await state(env.cwd, "attempt-conflict")).state_revision).toBe(2);
		} finally {
			if (prior === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_INJECT_COMPETING_WRITE;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_INJECT_COMPETING_WRITE = prior;
			await env.restore();
		}
	});
});
