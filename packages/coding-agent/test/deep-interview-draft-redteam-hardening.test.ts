import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runDeepInterviewDraftCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-draft";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";

type CommandResult = { status: number; stdout?: string; stderr?: string };
type Draft = {
	id: string;
	kind: string;
	draft_revision: number;
	base_revision: number;
	status?: string;
	payload?: Record<string, unknown>;
	receipt?: Record<string, unknown>;
	attempt?: Record<string, unknown>;
};
type Issue = Record<string, unknown>;

async function workspace(): Promise<{ cwd: string; restore(): Promise<void> }> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-draft-redteam-workspace-"));
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-draft-redteam-root-"));
	const previous = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
	process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = root;
	return {
		cwd,
		async restore() {
			if (previous === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = previous;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

function parsed(result: CommandResult): Record<string, unknown> {
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout ?? "{}") as Record<string, unknown>;
}

function draft(result: CommandResult): Draft {
	return parsed(result).draft as Draft;
}

function stderrIssue(result: CommandResult): Issue {
	expect(result.stderr).toBeTruthy();
	return (JSON.parse(result.stderr ?? "{}").issue ?? {}) as Issue;
}

async function native(cwd: string, args: string[]): Promise<CommandResult> {
	return runNativeDeepInterviewCommand(args, cwd);
}

async function draftApi(cwd: string, args: string[]): Promise<CommandResult> {
	return runDeepInterviewDraftCommand(args, cwd);
}

async function kickoff(cwd: string, session: string): Promise<void> {
	expect((await native(cwd, ["--session-id", session, "--json", "red-team interview"])).status).toBe(0);
}

async function create(cwd: string, kind: string, session: string, extra: string[] = []): Promise<Draft> {
	return draft(await native(cwd, ["draft", "create", "--for", kind, "--session-id", session, ...extra, "--json"]));
}

async function edit(
	cwd: string,
	input: Draft,
	ops: string[],
	expected: string | number = input.draft_revision,
	viaApi = false,
): Promise<Draft> {
	const args = ["edit", "--draft-id", input.id, "--expected-draft-revision", String(expected), ...ops, "--json"];
	return draft(viaApi ? await draftApi(cwd, args) : await native(cwd, ["draft", ...args]));
}

async function consume(cwd: string, kind: string, input: Draft, expected: string | number = input.draft_revision) {
	return native(cwd, [kind, "--draft-id", input.id, "--expected-draft-revision", String(expected), "--json"]);
}

async function show(cwd: string, id: string): Promise<Draft> {
	return draft(await native(cwd, ["draft", "show", "--draft-id", id, "--json"]));
}

async function state(cwd: string, session: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(modeStatePath(cwd, session, "deep-interview"), "utf8")) as Record<
		string,
		unknown
	>;
}

function stateRevision(value: Record<string, unknown>): number {
	return typeof value.state_revision === "number" ? value.state_revision : 0;
}

async function setupDraft(cwd: string, session: string): Promise<Draft> {
	const input = await create(cwd, "initialize-context", session);
	return edit(
		cwd,
		input,
		[
			"--op",
			"set",
			"--path",
			"/type",
			"--value",
			"greenfield",
			"--op",
			"set",
			"--path",
			"/threshold",
			"--value",
			"0.05",
			"--op",
			"set",
			"--path",
			"/interview_id",
			"--value",
			"interview-1",
			"--op",
			"set",
			"--path",
			"/initial_context_summary",
			"--value",
			"summary",
		],
		"latest",
	);
}

async function confirmTopology(cwd: string, session: string, active: boolean): Promise<Draft> {
	let topology = await create(cwd, "confirm-topology", session);
	const operations = [
		"--op",
		"append",
		"--path",
		"/components",
		"--op",
		"set",
		"--path",
		"/components/0/id",
		"--value",
		"core",
		"--op",
		"set",
		"--path",
		"/components/0/name",
		"--value",
		"Core",
		"--op",
		"set",
		"--path",
		"/components/0/status",
		"--value",
		active ? "active" : "deferred",
		"--op",
		"set",
		"--path",
		"/components/0/active",
		"--value",
		String(active),
		"--op",
		"append",
		"--path",
		"/deferred_components",
	];
	if (!active) operations.push("--value", "core");
	topology = await edit(cwd, topology, operations, "latest");
	await consume(cwd, "confirm-topology", topology);
	return topology;
}

async function recordAnswer(cwd: string, session: string, round: number): Promise<Draft> {
	let answer = await create(cwd, "record-answer", session, [
		"--round",
		String(round),
		"--question-id",
		`q${round}`,
		"--round-id",
		`r${round}`,
		"--component-id",
		"core",
		"--dimension",
		"goal",
	]);
	answer = await edit(
		cwd,
		answer,
		[
			"--op",
			"set",
			"--path",
			"/question",
			"--value",
			JSON.stringify(`Question ${round}?`),
			"--op",
			"append",
			"--path",
			"/answer/selected_options",
			"--value",
			"yes",
			"--op",
			"set",
			"--path",
			"/answer/custom_input",
			"--null",
		],
		"latest",
	);
	parsed(await consume(cwd, "record-answer", answer));
	return answer;
}

async function resultDraft(
	cwd: string,
	session: string,
	round: number,
	globalScore = 1,
	componentGoal?: number,
): Promise<Draft> {
	const result = await create(cwd, "apply-round-result", session, ["--round-key", `interview-1::rid:r${round}`]);
	const operations = [
		"--op",
		"set",
		"--path",
		"/global_scores/goal",
		"--value",
		String(globalScore),
		"--op",
		"set",
		"--path",
		"/global_scores/constraints",
		"--value",
		"1",
		"--op",
		"set",
		"--path",
		"/global_scores/criteria",
		"--value",
		"1",
	];
	if (componentGoal !== undefined) {
		operations.push(
			"--op",
			"append",
			"--path",
			"/component_updates",
			"--op",
			"set",
			"--path",
			"/component_updates/0/component_id",
			"--value",
			"core",
			"--op",
			"set",
			"--path",
			"/component_updates/0/scores/goal",
			"--value",
			String(componentGoal),
			"--op",
			"set",
			"--path",
			"/component_updates/0/scores/constraints",
			"--value",
			"1",
			"--op",
			"set",
			"--path",
			"/component_updates/0/scores/criteria",
			"--value",
			"1",
		);
	}
	return edit(cwd, result, operations, "latest");
}

describe("deep-interview draft red-team hardening", () => {
	it("fails closed when a check-valid draft races a competing state write", async () => {
		const env = await workspace();
		const previous = process.env.GJC_DEEP_INTERVIEW_DRAFT_INJECT_COMPETING_WRITE;
		try {
			await kickoff(env.cwd, "check-race");
			let prepared = await setupDraft(env.cwd, "check-race");
			prepared = await edit(env.cwd, prepared, [
				"--op",
				"set",
				"--path",
				"/trace_summary",
				"--value",
				"must-not-apply",
			]);
			const checked = parsed(await native(env.cwd, ["draft", "check", "--draft-id", prepared.id, "--json"]));
			expect(checked).toMatchObject({ valid: true, stale: false, state_revision: 0 });
			let competing = await setupDraft(env.cwd, "check-race");
			competing = await edit(env.cwd, competing, ["--op", "set", "--path", "/language", "--value", "typescript"]);
			parsed(await consume(env.cwd, "initialize-context", competing));
			expect(stateRevision(await state(env.cwd, "check-race"))).toBe(1);
			process.env.GJC_DEEP_INTERVIEW_DRAFT_INJECT_COMPETING_WRITE = "1";
			const raced = await consume(env.cwd, "initialize-context", prepared);
			expect(raced.status).toBe(3);
			const issue = stderrIssue(raced);
			expect(issue).toMatchObject({ code: "DI_STATE_REVISION_CONFLICT" });
			expect(issue.message).not.toBe(issue.code);
			expect(String(issue.recovery)).toContain("draft rebase");
			const after = await state(env.cwd, "check-race");
			expect(stateRevision(after)).toBe(2);
			expect((after.state as Record<string, unknown>).trace_summary).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_INJECT_COMPETING_WRITE;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_INJECT_COMPETING_WRITE = previous;
			await env.restore();
		}
	});

	it("keeps a state-invariant failure retryable across repeated consumes and then succeeds", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "repeat-failure");
			const setup = await setupDraft(env.cwd, "repeat-failure");
			parsed(await consume(env.cwd, "initialize-context", setup));
			await confirmTopology(env.cwd, "repeat-failure", true);
			await recordAnswer(env.cwd, "repeat-failure", 1);
			let result = await resultDraft(env.cwd, "repeat-failure", 1, 1, 0.5);
			const checked = parsed(await native(env.cwd, ["draft", "check", "--draft-id", result.id, "--json"]));
			expect(checked).toMatchObject({ valid: false });
			expect((checked.issues as Issue[])[0]).toMatchObject({
				code: "DI_STATE_SCHEMA_INVALID",
				invariant: "global_scores_must_equal_component_min",
				path: "/global_scores/goal",
				expected: 0.5,
				actual: 1,
			});
			const before = stateRevision(await state(env.cwd, "repeat-failure"));
			for (let attempt = 0; attempt < 2; attempt++) {
				const failed = await consume(env.cwd, "apply-round-result", result);
				expect(failed.status).not.toBe(0);
				const issue = stderrIssue(failed);
				expect(issue).toMatchObject({
					code: "DI_STATE_SCHEMA_INVALID",
					invariant: "global_scores_must_equal_component_min",
					path: "/global_scores/goal",
					expected: 0.5,
					actual: 1,
				});
				expect(issue.message).not.toBe(issue.code);
				expect(stateRevision(await state(env.cwd, "repeat-failure"))).toBe(before);
				expect((await show(env.cwd, result.id)).attempt).toBeUndefined();
			}
			result = await edit(env.cwd, result, ["--op", "set", "--path", "/global_scores/goal", "--value", "0.5"]);
			const repairedCheck = parsed(await native(env.cwd, ["draft", "check", "--draft-id", result.id, "--json"]));
			expect(repairedCheck).toMatchObject({ valid: true, stale: false });
			expect(parsed(await consume(env.cwd, "apply-round-result", result))).toMatchObject({ consumed: true });
			expect(stateRevision(await state(env.cwd, "repeat-failure"))).toBe(before + 1);
		} finally {
			await env.restore();
		}
	});

	it("reports exact check and consume details for rounds scored out of order", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "order-detail");
			const setup = await setupDraft(env.cwd, "order-detail");
			parsed(await consume(env.cwd, "initialize-context", setup));
			await confirmTopology(env.cwd, "order-detail", false);
			await recordAnswer(env.cwd, "order-detail", 1);
			await recordAnswer(env.cwd, "order-detail", 2);
			const result = await resultDraft(env.cwd, "order-detail", 2);
			const checked = parsed(await native(env.cwd, ["draft", "check", "--draft-id", result.id, "--json"]));
			const expected = {
				code: "DI_STATE_SCHEMA_INVALID",
				invariant: "rounds_must_be_scored_in_order",
				path: "/state/rounds[round_key=interview-1::rid:r1]/lifecycle",
				expected: "scored",
				actual: "answered",
			};
			expect(checked).toMatchObject({ valid: false });
			expect((checked.issues as Issue[])[0]).toMatchObject(expected);
			expect((checked.issues as Issue[])[0].message).not.toBe(expected.code);
			const before = stateRevision(await state(env.cwd, "order-detail"));
			const failed = await consume(env.cwd, "apply-round-result", result);
			expect(failed.status).not.toBe(0);
			expect(stderrIssue(failed)).toMatchObject(expected);
			expect(stateRevision(await state(env.cwd, "order-detail"))).toBe(before);
		} finally {
			await env.restore();
		}
	});

	it("applies nested batch edits atomically when the last operation is invalid", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "batch-last");
			const created = await create(env.cwd, "record-answer", "batch-last", ["--round", "1", "--question-id", "q1"]);
			const failed = await native(env.cwd, [
				"draft",
				"edit",
				"--draft-id",
				created.id,
				"--expected-draft-revision",
				"latest",
				"--op",
				"append",
				"--path",
				"/answer/selected_options",
				"--value",
				"yes",
				"--op",
				"set",
				"--path",
				"/answer/custom_input",
				"--null",
				"--op",
				"set",
				"--path",
				"/answer/selected_options/0/nested",
				"--value",
				"nope",
				"--json",
			]);
			expect(failed.status).toBe(2);
			expect(stderrIssue(failed)).toMatchObject({ code: "DI_DRAFT_INVALID_PATH" });
			const untouched = await show(env.cwd, created.id);
			expect(untouched.draft_revision).toBe(created.draft_revision);
			expect(untouched.payload).toEqual({});
			const valid = await edit(
				env.cwd,
				created,
				[
					"--op",
					"set",
					"--path",
					"/question",
					"--value",
					JSON.stringify("Atomic?"),
					"--op",
					"append",
					"--path",
					"/answer/selected_options",
					"--value",
					"yes",
				],
				"latest",
			);
			expect(valid.draft_revision).toBe(created.draft_revision + 1);
			expect(valid.payload).toMatchObject({
				question: JSON.stringify("Atomic?"),
				answer: { selected_options: ["yes"] },
			});
		} finally {
			await env.restore();
		}
	});

	it("rejects path-before-op and duplicate flags without touching the draft", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "malformed-ops");
			const created = await create(env.cwd, "record-answer", "malformed-ops", [
				"--round",
				"1",
				"--question-id",
				"q1",
			]);
			const pathBeforeOp = await draftApi(env.cwd, [
				"edit",
				"--draft-id",
				created.id,
				"--expected-draft-revision",
				"latest",
				"--path",
				"/question",
				"--op",
				"set",
				"--value",
				JSON.stringify("bad ordering"),
				"--json",
			]);
			expect(pathBeforeOp.status).toBe(2);
			expect(stderrIssue(pathBeforeOp)).toMatchObject({ code: "DI_INVALID_ARGUMENT" });
			const duplicatePath = await native(env.cwd, [
				"draft",
				"edit",
				"--draft-id",
				created.id,
				"--expected-draft-revision",
				"latest",
				"--op",
				"set",
				"--path",
				"/question",
				"--path",
				"/answer/custom_input",
				"--value",
				JSON.stringify("duplicate"),
				"--json",
			]);
			expect(duplicatePath.status).toBe(2);
			expect(stderrIssue(duplicatePath)).toMatchObject({ code: "DI_INVALID_ARGUMENT" });
			expect((await show(env.cwd, created.id)).payload).toEqual({});
			const acceptedLatest = await edit(
				env.cwd,
				created,
				["--op", "set", "--path", "/question", "--value", JSON.stringify("latest edit")],
				"latest",
			);
			expect(acceptedLatest.draft_revision).toBe(created.draft_revision + 1);
		} finally {
			await env.restore();
		}
	});

	it("rejects latest for consume, rebase, and discard while edit accepts it", async () => {
		const env = await workspace();
		try {
			await kickoff(env.cwd, "latest-restrictions");
			const created = await create(env.cwd, "initialize-context", "latest-restrictions");
			const consumeLatest = await consume(env.cwd, "initialize-context", created, "latest");
			expect(consumeLatest.status).toBe(2);
			expect(stderrIssue(consumeLatest)).toMatchObject({ code: "DI_DRAFT_REVISION_CONFLICT" });
			const rebaseLatest = await native(env.cwd, [
				"draft",
				"rebase",
				"--draft-id",
				created.id,
				"--expected-draft-revision",
				"latest",
				"--to-state-revision",
				"0",
				"--json",
			]);
			expect(rebaseLatest.status).toBe(2);
			expect(stderrIssue(rebaseLatest)).toMatchObject({ code: "DI_DRAFT_REVISION_CONFLICT" });
			const discardLatest = await native(env.cwd, [
				"draft",
				"discard",
				"--draft-id",
				created.id,
				"--expected-draft-revision",
				"latest",
				"--json",
			]);
			expect(discardLatest.status).toBe(2);
			expect(stderrIssue(discardLatest)).toMatchObject({ code: "DI_DRAFT_REVISION_CONFLICT" });
			expect(await show(env.cwd, created.id)).toMatchObject({
				status: "active",
				draft_revision: created.draft_revision,
			});
		} finally {
			await env.restore();
		}
	});

	it("replays the same receipt after receipt persistence fails", async () => {
		const env = await workspace();
		const previous = process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE;
		try {
			await kickoff(env.cwd, "receipt-replay");
			const prepared = await setupDraft(env.cwd, "receipt-replay");
			process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE = "1";
			const failed = await consume(env.cwd, "initialize-context", prepared);
			expect(failed.status).toBe(2);
			expect(stderrIssue(failed)).toMatchObject({ code: "DI_DRAFT_RECEIPT_PERSIST_FAILED" });
			expect(stateRevision(await state(env.cwd, "receipt-replay"))).toBe(1);
			delete process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE;
			const repaired = parsed(await consume(env.cwd, "initialize-context", prepared));
			const replay = parsed(await consume(env.cwd, "initialize-context", prepared));
			expect(repaired).toMatchObject({ consumed: true, draft_id: prepared.id });
			expect(replay).toMatchObject({ consumed: true, draft_id: prepared.id });
			expect(replay.receipt).toEqual(repaired.receipt);
			expect((await show(env.cwd, prepared.id)).receipt).toEqual(repaired.receipt as Record<string, unknown>);
			expect(stateRevision(await state(env.cwd, "receipt-replay"))).toBe(1);
		} finally {
			if (previous === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE = previous;
			await env.restore();
		}
	});
});
