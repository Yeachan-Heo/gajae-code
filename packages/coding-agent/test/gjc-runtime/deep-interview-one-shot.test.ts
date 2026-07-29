import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runDeepInterviewRepairCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-repair";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";

function resultOperationArgs(): string[] {
	const args: string[] = [];
	const operation = (op: "set" | "append" | "remove", target: string, value?: string, nullValue = false): void => {
		args.push("--op", op, "--path", target);
		if (value !== undefined) args.push("--value", value);
		if (nullValue) args.push("--null");
	};
	operation("append", "/component_updates");
	operation("append", "/triggers");
	operation("remove", "/triggers/0");
	operation("append", "/fact_ops");
	operation("remove", "/fact_ops/0");
	for (const target of ["/ontology/entities", "/ontology/relationships", "/ontology/reasoning"]) {
		operation("append", target);
		operation("remove", `${target}/0`);
	}
	operation("set", "/bookkeeping/resolution", "direct");
	operation("append", "/bookkeeping/round_ids", "r1");
	operation("set", "/bookkeeping/counter_deltas/count", "0");
	for (const dimension of ["goal", "constraints", "criteria"]) {
		operation("set", `/global_scores/${dimension}`, "1");
		operation("set", `/component_updates/0/scores/${dimension}`, "1");
	}
	operation("set", "/global_scores/context", "1");
	operation("set", "/component_updates/0/scores/context", "1");
	operation("remove", "/global_scores/context");
	operation("remove", "/component_updates/0/scores/context");
	operation("set", "/component_updates/0/component_id", "core");
	operation("set", "/targeting/target_component_id", "core");
	operation("set", "/targeting/target_dimension", "goal");
	operation("set", "/targeting/weakest_component_id", "core");
	operation("set", "/targeting/weakest_dimension", "goal");
	operation("set", "/targeting/last_targeted_component_id", undefined, true);
	return args;
}

describe("deep-interview one-shot round scoring", () => {
	it("prepares, validates, and applies a round in one public invocation", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-one-shot-workspace-"));
		const draftRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-one-shot-drafts-"));
		const priorDraftRoot = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
		process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = draftRoot;
		const session = "one-shot";
		try {
			expect(
				(await runNativeDeepInterviewCommand(["--session-id", session, "--json", "one-shot interview"], cwd))
					.status,
			).toBe(0);
			expect(
				(
					await runDeepInterviewRepairCommand(
						[
							"initialize-context",
							"--session-id",
							session,
							"--schema-version",
							"1",
							"--expected-revision",
							"0",
							"--input-json",
							JSON.stringify({
								type: "greenfield",
								interview_id: "interview-1",
								threshold: 0.05,
								initial_context_summary: "summary",
								codebase_context: "context",
								challenge_modes_used: ["challenge"],
								trace: ["seed"],
							}),
							"--json",
						],
						cwd,
					)
				).status,
			).toBe(0);
			expect(
				(
					await runDeepInterviewRepairCommand(
						[
							"confirm-topology",
							"--session-id",
							session,
							"--schema-version",
							"1",
							"--expected-revision",
							"1",
							"--input-json",
							JSON.stringify({
								components: [{ id: "core", name: "Core" }],
								deferred_components: [],
							}),
							"--json",
						],
						cwd,
					)
				).status,
			).toBe(0);
			expect(
				(
					await runDeepInterviewRepairCommand(
						[
							"record-answer",
							"--session-id",
							session,
							"--schema-version",
							"1",
							"--expected-revision",
							"2",
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
							"--question-json",
							JSON.stringify("Question?"),
							"--answer-json",
							JSON.stringify({ selected_options: ["yes"], custom_input: null }),
							"--json",
						],
						cwd,
					)
				).status,
			).toBe(0);

			const malformed = await runNativeDeepInterviewCommand(
				[
					"prepare-and-apply-round-result",
					"--session-id",
					session,
					"--round-key",
					"interview-1::rid:r1",
					"--op",
					"append",
					"--path",
					"/ontology/entities/1",
					"--json",
				],
				cwd,
			);
			expect(malformed.status).toBe(2);
			expect(JSON.parse(malformed.stderr ?? "{}").issue).toMatchObject({
				code: "DI_DRAFT_INVALID_PATH",
				operation_index: 0,
				path: "/ontology/entities/1",
				draft_revision: 1,
			});
			const applied = await runNativeDeepInterviewCommand(
				[
					"prepare-and-apply-round-result",
					"--session-id",
					session,
					"--round-key",
					"interview-1::rid:r1",
					...resultOperationArgs(),
					"--json",
				],
				cwd,
			);
			expect(applied.status, applied.stderr).toBe(0);
			expect(JSON.parse(applied.stdout ?? "{}")).toMatchObject({
				ok: true,
				native_projection: {
					next_action: "begin_closure",
					next_action_reason: "ambiguity_threshold_reached",
					transition: { lifecycle: "scored" },
				},
			});
			const state = JSON.parse(await fs.readFile(modeStatePath(cwd, session, "deep-interview"), "utf8")) as {
				state_revision: number;
			};
			expect(state.state_revision).toBe(4);
		} finally {
			if (priorDraftRoot === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = priorDraftRoot;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(draftRoot, { recursive: true, force: true });
		}
	});
});
