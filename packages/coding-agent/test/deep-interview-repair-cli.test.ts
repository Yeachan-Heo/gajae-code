import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEEP_INTERVIEW_REPAIR_VERBS,
	runDeepInterviewRepairCommand,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-repair";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { WORKFLOW_MANIFEST } from "@gajae-code/coding-agent/gjc-runtime/workflow-manifest";

describe("deep-interview typed repair CLI", () => {
	it("keeps typed repair verbs aligned with the public workflow manifest", () => {
		const manifestVerbs = WORKFLOW_MANIFEST["deep-interview"].verbs
			.filter(verb => verb.surface === "command-positional")
			.map(verb => verb.name);
		expect(manifestVerbs).toEqual([...DEEP_INTERVIEW_REPAIR_VERBS]);
	});

	it("reports legacy receipt-less state as healthy and inspectable", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "legacy-state";
		try {
			const statePath = path.join(cwd, ".gjc", `_session-${session}`, "state", "deep-interview-state.json");
			await fs.mkdir(path.dirname(statePath), { recursive: true });
			await fs.writeFile(
				statePath,
				JSON.stringify({
					state_revision: 7,
					state: { interview_id: "legacy", type: "greenfield", threshold: 0.05, rounds: [] },
				}),
			);

			const sanity = await runDeepInterviewRepairCommand(["sanity-check", "--session-id", session, "--json"], cwd);
			const inspect = await runDeepInterviewRepairCommand(
				["inspect", "--session-id", session, "--selector", "summary", "--json"],
				cwd,
			);

			expect(JSON.parse(sanity.stdout!)).toEqual({
				ok: true,
				command: "sanity-check",
				healthy: true,
				issues: [],
				limits_version: 1,
			});
			const view = JSON.parse(inspect.stdout!);
			expect(Object.keys(view).sort()).toEqual([
				"bytes_returned",
				"command",
				"content_sha256",
				"data",
				"limits_version",
				"next_cursor",
				"ok",
				"returned_count",
				"schema_version",
				"state_path",
				"state_revision",
				"total_count",
				"truncated",
				"view_sha256",
			]);
			expect(view).toMatchObject({
				ok: true,
				content_sha256: null,
				data: { interview_id: "legacy" },
			});
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("returns DI_OUTPUT_LIMIT_EXCEEDED with exit 3 for oversized non-paged views", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "oversized-view";
		try {
			const statePath = path.join(cwd, ".gjc", `_session-${session}`, "state", "deep-interview-state.json");
			await fs.mkdir(path.dirname(statePath), { recursive: true });
			await fs.writeFile(
				statePath,
				JSON.stringify({
					state_revision: 1,
					state: {
						interview_id: "oversized",
						type: "greenfield",
						threshold: 0.05,
						rounds: [],
						topology: {
							status: "confirmed",
							components: Array.from({ length: 16 }, (_, index) => ({
								id: `component-${index}`,
								name: "x".repeat(1024),
								active: true,
								clarity_scores: {},
							})),
						},
					},
				}),
			);

			const result = await runDeepInterviewRepairCommand(
				["inspect", "--session-id", session, "--selector", "topology", "--json"],
				cwd,
			);

			expect(result.status).toBe(3);
			expect(result.stderr).toContain("DI_OUTPUT_LIMIT_EXCEEDED");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("rejects malformed receipt-less legacy state", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "malformed-legacy-state";
		try {
			const statePath = path.join(cwd, ".gjc", `_session-${session}`, "state", "deep-interview-state.json");
			await fs.mkdir(path.dirname(statePath), { recursive: true });
			await fs.writeFile(statePath, JSON.stringify({ state_revision: 7, state: [] }));

			const sanity = await runDeepInterviewRepairCommand(["sanity-check", "--session-id", session, "--json"], cwd);
			const inspect = await runDeepInterviewRepairCommand(
				["inspect", "--session-id", session, "--selector", "summary", "--json"],
				cwd,
			);

			expect(JSON.parse(sanity.stdout!)).toMatchObject({
				ok: true,
				healthy: false,
				issues: [{ code: "DI_STATE_SCHEMA_INVALID" }],
			});
			expect(inspect.status).toBe(3);
			expect(JSON.parse(inspect.stderr!)).toEqual({
				ok: false,
				issue: { code: "DI_STATE_SCHEMA_INVALID", message: "DI_STATE_SCHEMA_INVALID" },
			});
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("rejects malformed legacy collection records before phase and CAS checks", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "malformed-legacy-collection";
		try {
			const statePath = path.join(cwd, ".gjc", `_session-${session}`, "state", "deep-interview-state.json");
			await fs.mkdir(path.dirname(statePath), { recursive: true });
			await fs.writeFile(
				statePath,
				JSON.stringify({
					state_revision: 7,
					active: false,
					state: {
						rounds: [{ lifecycle: "scored", triggers: [{ kind: "A", name: 42 }] }],
						established_facts: [],
					},
				}),
			);

			const sanity = await runDeepInterviewRepairCommand(["sanity-check", "--session-id", session, "--json"], cwd);
			const inspect = await runDeepInterviewRepairCommand(
				["inspect", "--session-id", session, "--selector", "recent-scored", "--json"],
				cwd,
			);
			const mutation = await runDeepInterviewRepairCommand(
				[
					"initialize-context",
					"--session-id",
					session,
					"--schema-version",
					"1",
					"--expected-revision",
					"0",
					"--input-json",
					'{"type":"greenfield","threshold":0.05}',
					"--json",
				],
				cwd,
			);

			expect(JSON.parse(sanity.stdout!)).toMatchObject({
				ok: true,
				healthy: false,
				issues: [{ code: "DI_STATE_SCHEMA_INVALID" }],
			});
			for (const result of [inspect, mutation]) {
				expect(result.status).toBe(3);
				expect(JSON.parse(result.stderr!)).toEqual({
					ok: false,
					issue: { code: "DI_STATE_SCHEMA_INVALID", message: "DI_STATE_SCHEMA_INVALID" },
				});
			}
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("rejects malformed legacy answers, scores, ontology snapshots, and counters before lifecycle or CAS", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "malformed-legacy-deep";
		try {
			const statePath = path.join(cwd, ".gjc", `_session-${session}`, "state", "deep-interview-state.json");
			await fs.mkdir(path.dirname(statePath), { recursive: true });
			await fs.writeFile(
				statePath,
				JSON.stringify({
					state_revision: 7,
					active: false,
					state: {
						rounds: [{ selected_options: [42], scores: { goal: "invalid" } }],
						established_facts: [],
						ontology_snapshots: [
							{
								round: 1,
								captured_at: "2026-01-01T00:00:00.000Z",
								entities: [],
								basis: "compared",
								stable_entities: 0,
								new_entities: 0,
								changed_entities: 0,
								stability_ratio: null,
							},
						],
						counters: { rounds: 1.5 },
					},
				}),
			);
			const sanity = await runDeepInterviewRepairCommand(["sanity-check", "--session-id", session, "--json"], cwd);
			const mutation = await runDeepInterviewRepairCommand(
				[
					"initialize-context",
					"--session-id",
					session,
					"--schema-version",
					"1",
					"--expected-revision",
					"0",
					"--input-json",
					'{"type":"greenfield","threshold":0.05}',
					"--json",
				],
				cwd,
			);
			expect(JSON.parse(sanity.stdout!)).toMatchObject({
				healthy: false,
				issues: [{ code: "DI_STATE_SCHEMA_INVALID" }],
			});
			expect(mutation.status).toBe(3);
			expect(JSON.parse(mutation.stderr!)).toEqual({
				ok: false,
				issue: { code: "DI_STATE_SCHEMA_INVALID", message: "DI_STATE_SCHEMA_INVALID" },
			});
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("rejects topology IDs that are not strings and projected topology views over 16KiB", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "topology-admission";
		try {
			expect(
				(await runNativeDeepInterviewCommand(["--session-id", session, "--json", "topology admission"], cwd))
					.status,
			).toBe(0);
			const command = (input: string) =>
				runDeepInterviewRepairCommand(
					[
						"confirm-topology",
						"--session-id",
						session,
						"--schema-version",
						"1",
						"--expected-revision",
						"0",
						"--input-json",
						input,
						"--json",
					],
					cwd,
				);
			expect((await command('{"components":[{"id":1}],"deferred_components":[]}')).status).toBe(2);
			const components = Array.from({ length: 16 }, (_, index) => ({
				id: `component-${index}`,
				name: "x".repeat(1024),
				status: "active",
				active: true,
			}));
			const oversized = await command(JSON.stringify({ components, deferred_components: [] }));
			expect(oversized.status).toBe(2);
			expect(JSON.parse(oversized.stderr!)).toEqual({
				ok: false,
				issue: { code: "DI_OUTPUT_LIMIT_EXCEEDED", message: "DI_OUTPUT_LIMIT_EXCEEDED" },
			});
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("projects the envelope resolution in a kickoff summary", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		try {
			expect(
				(
					await runNativeDeepInterviewCommand(
						["--session-id", "kickoff-summary", "--quick", "--json", "quick interview"],
						cwd,
					)
				).status,
			).toBe(0);

			const inspect = await runDeepInterviewRepairCommand(
				["inspect", "--session-id", "kickoff-summary", "--selector", "summary", "--json"],
				cwd,
			);

			expect(JSON.parse(inspect.stdout!).data.resolution).toBe("quick");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("projects nonempty canonical topology deferrals", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "topology-deferral";
		try {
			expect(
				(await runNativeDeepInterviewCommand(["--session-id", session, "--json", "defer this"], cwd)).status,
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
							'{"type":"greenfield","threshold":0.05}',
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
							'{"components":[{"id":"core","name":"Core","status":"active","active":true},{"id":"later","name":"Later","status":"deferred","active":true}],"deferred_components":["later"]}',
							"--json",
						],
						cwd,
					)
				).status,
			).toBe(0);

			const inspect = await runDeepInterviewRepairCommand(
				["inspect", "--session-id", session, "--selector", "topology", "--json"],
				cwd,
			);
			const topology = JSON.parse(inspect.stdout!).data;
			expect(Object.keys(topology).sort()).toEqual([
				"components",
				"confirmed_at",
				"deferrals",
				"last_targeted_component_id",
				"status",
			]);
			expect(topology.components).toHaveLength(1);
			expect(Object.keys(topology.components[0]).sort()).toEqual([
				"active",
				"deferred",
				"description",
				"id",
				"name",
				"scores",
				"weakest_dimension",
			]);
			expect(topology.components[0]).toMatchObject({ id: "core", active: true, deferred: false });
			expect(topology.deferrals).toHaveLength(1);
			expect(Object.keys(topology.deferrals[0]).sort()).toEqual([
				"component_id",
				"created_at",
				"reason",
				"until_round",
			]);
			expect(topology.deferrals[0]).toMatchObject({
				component_id: "later",
				reason: { value: "", truncated: false, original_bytes: 0 },
				until_round: null,
			});
			expect(topology.deferrals[0].created_at).toBe(topology.confirmed_at);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("projects canonical floor bookkeeping", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "canonical-views";
		try {
			const statePath = path.join(cwd, ".gjc", `_session-${session}`, "state", "deep-interview-state.json");
			await fs.mkdir(path.dirname(statePath), { recursive: true });
			await fs.writeFile(
				statePath,
				JSON.stringify({
					state_revision: 1,
					resolution: "deep",
					state: {
						type: "greenfield",
						threshold: 0.05,
						weighted_ambiguity: 0.45,
						effective_ambiguity: 0.5,
						rounds: [{ lifecycle: "scored" }, { lifecycle: "scored" }],
						auto_answered_rounds: [1],
						established_facts: [
							{ id: "disputed", disputed: true },
							{ id: "superseded", disputed: true, superseded_by: "replacement" },
						],
						topology: {
							status: "confirmed",
							components: [
								{
									id: "zero",
									name: "Zero score is scored",
									status: "active",
									active: true,
									clarity_scores: { goal: 0, constraints: 0.7, criteria: 0.8 },
								},
								{
									id: "missing-constraints",
									name: "Missing constraints",
									status: "active",
									active: true,
									clarity_scores: { goal: 0.7, criteria: 0.8 },
								},
								{
									id: "missing-criteria",
									name: "Missing criteria",
									status: "active",
									active: true,
									clarity_scores: { goal: 0.7, constraints: 0.8 },
								},
							],
						},
					},
				}),
			);

			const floor = await runDeepInterviewRepairCommand(
				["inspect", "--session-id", session, "--selector", "floor", "--json"],
				cwd,
			);

			expect(JSON.parse(floor.stdout!).data).toEqual({
				floor: 0.225,
				disputed_fact_count: 1,
				unscored_active_component_count: 2,
				auto_answer_ratio: 0.5,
				weighted_ambiguity: 0.45,
				effective_ambiguity: 0.5,
			});
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("routes --write before a reserved typed verb", async () => {
		const result = await runNativeDeepInterviewCommand(["initialize-context", "--write"], process.cwd());
		expect(result).toEqual({
			status: 2,
			stderr: "--spec is required for deep-interview --write\n",
		});
	});
	it("lets typed initialization classify a no-trace kickoff as brownfield exactly once", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "no-trace-brownfield";
		try {
			expect(
				(await runNativeDeepInterviewCommand(["--session-id", session, "--json", "inspect repo"], cwd)).status,
			).toBe(0);
			const seeded = JSON.parse(
				await fs.readFile(
					path.join(cwd, ".gjc", `_session-${session}`, "state", "deep-interview-state.json"),
					"utf8",
				),
			);
			expect(seeded.state).toMatchObject({ setup: { status: "unresolved" } });

			const initialize = (type: "greenfield" | "brownfield", revision: number) =>
				runDeepInterviewRepairCommand(
					[
						"initialize-context",
						"--session-id",
						session,
						"--schema-version",
						"1",
						"--expected-revision",
						String(revision),
						"--input-json",
						JSON.stringify({ type, threshold: 0.05 }),
						"--json",
					],
					cwd,
				);
			expect((await initialize("brownfield", 0)).status).toBe(0);
			const initialized = JSON.parse(
				await fs.readFile(
					path.join(cwd, ".gjc", `_session-${session}`, "state", "deep-interview-state.json"),
					"utf8",
				),
			);
			expect(initialized.state).toMatchObject({ type: "brownfield" });
			expect(initialized.state.setup).toBeUndefined();
			const conflictingRepeat = await initialize("greenfield", 1);
			expect(conflictingRepeat.status).toBe(4);
			expect(conflictingRepeat.stderr).toContain("DI_SETUP_CONFLICT");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("finalizes an exact-equal unresolved setup instead of nooping", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "exact-unresolved-setup";
		try {
			expect(
				(await runNativeDeepInterviewCommand(["--session-id", session, "--json", "new project"], cwd)).status,
			).toBe(0);

			const result = await runDeepInterviewRepairCommand(
				[
					"initialize-context",
					"--session-id",
					session,
					"--schema-version",
					"1",
					"--expected-revision",
					"0",
					"--input-json",
					'{"type":"greenfield","threshold":0.05}',
					"--json",
				],
				cwd,
			);

			expect(JSON.parse(result.stdout!)).toMatchObject({ ok: true, written: true, state_revision: 1 });
			const initialized = JSON.parse(
				await fs.readFile(
					path.join(cwd, ".gjc", `_session-${session}`, "state", "deep-interview-state.json"),
					"utf8",
				),
			);
			expect(initialized.state.setup).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("rejects non-unit thresholds and preserves the accepted threshold units", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "precise-threshold";
		const invalidThreshold = "0.05000000000000001";
		const threshold = "0.05";
		try {
			expect(
				(
					await runNativeDeepInterviewCommand(
						["--session-id", session, "--threshold", invalidThreshold, "--json", "new project"],
						cwd,
					)
				).status,
			).toBe(2);
			expect(
				(
					await runNativeDeepInterviewCommand(
						["--session-id", session, "--threshold", threshold, "--json", "new project"],
						cwd,
					)
				).status,
			).toBe(0);

			const result = await runDeepInterviewRepairCommand(
				[
					"initialize-context",
					"--session-id",
					session,
					"--schema-version",
					"1",
					"--expected-revision",
					"0",
					"--input-json",
					`{"type":"greenfield","threshold":${threshold}}`,
					"--json",
				],
				cwd,
			);

			expect(JSON.parse(result.stdout!)).toMatchObject({ ok: true, written: true, state_revision: 1 });
			const initialized = JSON.parse(
				await fs.readFile(
					path.join(cwd, ".gjc", `_session-${session}`, "state", "deep-interview-state.json"),
					"utf8",
				),
			);
			expect(initialized.state).toMatchObject({ threshold: Number(threshold), threshold_units: 500 });
			expect(initialized.state.setup).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects typed invocations without the required JSON mode", async () => {
		const result = await runDeepInterviewRepairCommand(
			["inspect", "--session-id", "repair-test", "--selector", "summary"],
			process.cwd(),
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("DI_JSON_REQUIRED");
	});
	it("rejects duplicate keys at every typed JSON boundary", async () => {
		const result = await runDeepInterviewRepairCommand(
			[
				"initialize-context",
				"--session-id",
				"repair-test",
				"--schema-version",
				"1",
				"--expected-revision",
				"0",
				"--input-json",
				'{"type":"greenfield","threshold":0.05,"threshold":0.1}',
				"--json",
			],
			process.cwd(),
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("DI_INVALID_INPUT_JSON");
	});

	it("rejects duplicate keys anywhere in a typed JSON request", async () => {
		const result = await runDeepInterviewRepairCommand(
			[
				"initialize-context",
				"--session-id",
				"repair-test",
				"--schema-version",
				"1",
				"--expected-revision",
				"0",
				"--input-json",
				'{"type":"greenfield","threshold":0.05,"trace":{"safe":true,"safe":false}}',
				"--json",
			],
			process.cwd(),
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("DI_INVALID_INPUT_JSON");
	});
	it("enforces the 64-element setup trace limit", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const trace = JSON.stringify(Array.from({ length: 65 }, () => "trace"));
		try {
			const result = await runDeepInterviewRepairCommand(
				[
					"initialize-context",
					"--session-id",
					"trace-limit",
					"--schema-version",
					"1",
					"--expected-revision",
					"0",
					"--input-json",
					`{"type":"greenfield","threshold":0.05,"trace":${trace}}`,
					"--json",
				],
				cwd,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("DI_INVALID_INPUT_JSON");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("treats a reserved word after -- as a legacy kickoff idea", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		try {
			const result = await runNativeDeepInterviewCommand(
				["--session-id", "repair-test", "--json", "--", "inspect"],
				cwd,
			);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('"idea":"inspect"');
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("records a v1 answer shell with its canonical answer hash", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		try {
			expect(
				(await runNativeDeepInterviewCommand(["--session-id", "repair-test", "--json", "typed interview"], cwd))
					.status,
			).toBe(0);
			expect(
				(
					await runDeepInterviewRepairCommand(
						[
							"initialize-context",
							"--session-id",
							"repair-test",
							"--schema-version",
							"1",
							"--expected-revision",
							"0",
							"--input-json",
							'{"type":"greenfield","threshold":0.05}',
							"--json",
						],
						cwd,
					)
				).status,
			).toBe(0);
			const answer = await runDeepInterviewRepairCommand(
				[
					"record-answer",
					"--session-id",
					"repair-test",
					"--schema-version",
					"1",
					"--expected-revision",
					"1",
					"--round",
					"1",
					"--question-id",
					"goal",
					"--question-json",
					'"What should this do?"',
					"--answer-json",
					'{"selected_options":["Ship"],"custom_input":null}',
					"--json",
				],
				cwd,
			);
			expect(answer.status).toBe(0);
			const inspect = await runDeepInterviewRepairCommand(
				["inspect", "--session-id", "repair-test", "--selector", "pending", "--limit", "25", "--json"],
				cwd,
			);
			const view = JSON.parse(inspect.stdout!);
			expect(Object.keys(view).sort()).toEqual([
				"bytes_returned",
				"command",
				"content_sha256",
				"data",
				"limits_version",
				"next_cursor",
				"ok",
				"returned_count",
				"schema_version",
				"state_path",
				"state_revision",
				"total_count",
				"truncated",
				"view_sha256",
			]);
			expect(view.data.items[0].question).toEqual({
				value: "What should this do?",
				truncated: false,
				original_bytes: 20,
			});
			const state = JSON.parse(
				await fs.readFile(
					path.join(cwd, ".gjc", "_session-repair-test", "state", "deep-interview-state.json"),
					"utf8",
				),
			);
			expect(state.state.rounds[0].answer_hash).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("executes the published strict-flow kickoff and CAS sequence", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const session = "strict-flow-published";
		const command = (args: string[]) => runDeepInterviewRepairCommand(args, cwd);
		try {
			const kickoff = await runNativeDeepInterviewCommand(
				["--session-id", session, "--threshold", "0.0001", "--json", "strict flow"],
				cwd,
			);
			expect(kickoff.status).toBe(0);

			const baseline = await command(["inspect", "--session-id", session, "--selector", "summary", "--json"]);
			expect(baseline.status).toBe(0);
			expect(JSON.parse(baseline.stdout!).state_revision).toBe(0);

			const initialize = await command([
				"initialize-context",
				"--session-id",
				session,
				"--schema-version",
				"1",
				"--expected-revision",
				"0",
				"--input-json",
				'{"type":"greenfield","threshold":0.0001}',
				"--json",
			]);
			expect(initialize.status).toBe(0);
			expect(JSON.parse(initialize.stdout!).state_revision).toBe(1);

			const topology = await command([
				"confirm-topology",
				"--session-id",
				session,
				"--schema-version",
				"1",
				"--expected-revision",
				"1",
				"--input-json",
				'{"components":[{"id":"core","name":"Core","status":"active","active":true}],"deferred_components":[]}',
				"--json",
			]);
			expect(topology.status).toBe(0);
			expect(JSON.parse(topology.stdout!).state_revision).toBe(2);

			const answer = await command([
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
				"--question-json",
				'"Question"',
				"--answer-json",
				'{"selected_options":["Yes"],"custom_input":null}',
				"--component-id",
				"core",
				"--dimension",
				"goal",
				"--json",
			]);
			expect(answer.status).toBe(0);
			expect(JSON.parse(answer.stdout!).state_revision).toBe(3);

			const result = await command([
				"apply-round-result",
				"--session-id",
				session,
				"--schema-version",
				"1",
				"--expected-revision",
				"3",
				"--round",
				"1",
				"--question-id",
				"q1",
				"--round-id",
				"r1",
				"--result-json",
				'{"global_scores":{"goal":0.5000,"constraints":0.5000,"criteria":0.5000},"component_updates":[{"component_id":"core","scores":{"goal":0.5000,"constraints":0.5000,"criteria":0.5000}}],"targeting":{"target_component_id":"core","target_dimension":"goal","weakest_component_id":"core","weakest_dimension":"goal","last_targeted_component_id":null},"triggers":[],"fact_ops":[],"ontology":{"entities":[],"relationships":[],"reasoning":[]},"bookkeeping":{"resolution":"direct","round_ids":["r1"],"counter_deltas":{"asked":1}}}',
				"--json",
			]);
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout!).state_revision).toBe(4);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("applies a closed expanded round result after initialize, topology, and answer", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-repair-"));
		const command = (args: string[]) => runDeepInterviewRepairCommand(args, cwd);
		try {
			const kickoff = await runNativeDeepInterviewCommand(
				["--session-id", "strict-flow", "--threshold", "0.0001", "--json", "strict flow"],
				cwd,
			);
			expect(kickoff.status).toBe(0);
			const setup = await command([
				"initialize-context",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"0",
				"--input-json",
				'{"type":"greenfield","threshold":0.0001}',
				"--json",
			]);
			expect(setup.status).toBe(0);
			const topology = await command([
				"confirm-topology",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"1",
				"--input-json",
				'{"components":[{"id":"core","name":"Core","status":"active","active":true}],"deferred_components":[]}',
				"--json",
			]);
			expect(topology.status).toBe(0);
			const answer = await command([
				"record-answer",
				"--session-id",
				"strict-flow",
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
				"--question-json",
				'"Question"',
				"--answer-json",
				'{"selected_options":["Yes"],"custom_input":null}',
				"--component-id",
				"core",
				"--dimension",
				"goal",
				"--json",
			]);
			expect(answer.status).toBe(0);
			const changedPendingAnswer = await command([
				"record-answer",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"3",
				"--round",
				"1",
				"--question-id",
				"q1",
				"--round-id",
				"r1",
				"--question-json",
				'"Question"',
				"--answer-json",
				'{"selected_options":["No"],"custom_input":null}',
				"--component-id",
				"core",
				"--dimension",
				"goal",
				"--json",
			]);
			expect(changedPendingAnswer.status).toBe(4);
			expect(changedPendingAnswer.stderr).toContain("DI_ANSWER_CONFLICT");
			const validGreenfieldResult =
				'{"global_scores":{"goal":0.1234,"constraints":0.1234,"criteria":0.1234},"component_updates":[{"component_id":"core","scores":{"goal":0.1234,"constraints":0.1234,"criteria":0.1234}}],"targeting":{"target_component_id":"core","target_dimension":"goal","weakest_component_id":"core","weakest_dimension":"goal","last_targeted_component_id":null},"triggers":[],"fact_ops":[],"ontology":{"entities":[],"relationships":[],"reasoning":[]},"bookkeeping":{"resolution":"direct","round_ids":["r1"],"counter_deltas":{"asked":1}}}';
			const cappedComponentUpdates = JSON.parse(validGreenfieldResult);
			cappedComponentUpdates.component_updates = Array.from({ length: 13 }, (_, index) => ({
				component_id: `component-${index}`,
				scores: cappedComponentUpdates.global_scores,
			}));
			const overComponentCap = await command([
				"apply-round-result",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"3",
				"--round",
				"1",
				"--question-id",
				"q1",
				"--round-id",
				"r1",
				"--result-json",
				JSON.stringify(cappedComponentUpdates),
				"--json",
			]);
			expect(overComponentCap.status).toBe(2);
			expect(overComponentCap.stderr).toContain("DI_INVALID_RESULT_JSON");

			const overAggregateCap = JSON.parse(validGreenfieldResult);
			overAggregateCap.component_updates = Array.from({ length: 12 }, (_, index) => ({
				component_id: `component-${index}`,
				scores: overAggregateCap.global_scores,
			}));
			overAggregateCap.fact_ops = Array.from({ length: 32 }, (_, index) => ({
				op: "add",
				id: `fact-${index}`,
				statement: "Fact",
			}));
			overAggregateCap.triggers = Array.from({ length: 16 }, (_, index) => ({
				kind: "A",
				name: `Trigger ${index}`,
				status: "active",
				component: "core",
				dimension: "goal",
			}));
			overAggregateCap.ontology.reasoning = Array.from({ length: 5 }, () => ({ statement: "Reason" }));
			const aggregateCap = await command([
				"apply-round-result",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"3",
				"--round",
				"1",
				"--question-id",
				"q1",
				"--round-id",
				"r1",
				"--result-json",
				JSON.stringify(overAggregateCap),
				"--json",
			]);
			expect(aggregateCap.status).toBe(2);
			expect(aggregateCap.stderr).toContain("DI_INVALID_RESULT_JSON");
			const applied = await command([
				"apply-round-result",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"3",
				"--round",
				"1",
				"--question-id",
				"q1",
				"--round-id",
				"r1",
				"--result-json",
				validGreenfieldResult,
				"--json",
			]);
			expect(applied.status).toBe(0);
			expect(JSON.parse(applied.stdout!).native_projection.transition.lifecycle).toBe("scored");
			const secondAnswer = await command([
				"record-answer",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"4",
				"--round",
				"2",
				"--question-id",
				"q2",
				"--round-id",
				"r2",
				"--question-json",
				'"Follow-up"',
				"--answer-json",
				'{"selected_options":["No"],"custom_input":null}',
				"--component-id",
				"core",
				"--dimension",
				"goal",
				"--json",
			]);
			expect(secondAnswer.status).toBe(0);
			const triggeredResult =
				'{"global_scores":{"goal":0.1000,"constraints":0.1000,"criteria":0.1000},"component_updates":[{"component_id":"core","scores":{"goal":0.1000,"constraints":0.1000,"criteria":0.1000}}],"targeting":{"target_component_id":"core","target_dimension":"goal","weakest_component_id":"core","weakest_dimension":"goal","last_targeted_component_id":"core"},"triggers":[{"kind":"A","name":"Contradiction","status":"active","component":"core","dimension":"goal"},{"kind":"B","name":"Dispute","status":"disputed","component":"core","dimension":"goal","rationale":"Conflicting evidence"},{"kind":"C","name":"Unresolved","status":"unresolved","component":"core","dimension":"goal","rationale":"Needs clarification"}],"fact_ops":[],"ontology":{"entities":[],"relationships":[],"reasoning":[]},"bookkeeping":{"resolution":"direct","round_ids":["r2"],"counter_deltas":{"asked":1}}}';
			const triggered = await command([
				"apply-round-result",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"5",
				"--round",
				"2",
				"--question-id",
				"q2",
				"--round-id",
				"r2",
				"--result-json",
				triggeredResult,
				"--json",
			]);
			expect(triggered.status, triggered.stderr).toBe(0);
			const triggers = await command(["inspect", "--session-id", "strict-flow", "--selector", "triggers", "--json"]);
			expect(JSON.parse(triggers.stdout!).data.items).toEqual([
				{
					kind: "A",
					name: { value: "Contradiction", truncated: false, original_bytes: 13 },
					status: "active",
					source_round: 2,
					source_round_key: "nointerview::rid:r2",
					component_id: "core",
					dimension: "goal",
					prior_dimension_score: 0.1234,
					new_dimension_score: 0.1,
					prior_effective_ambiguity: 0.8766,
					new_effective_ambiguity: 0.9,
					evidence: null,
					rationale: null,
					contradicted_fact_id: null,
					insertion_index: 0,
				},
				{
					kind: "B",
					name: { value: "Dispute", truncated: false, original_bytes: 7 },
					status: "disputed",
					source_round: 2,
					source_round_key: "nointerview::rid:r2",
					component_id: "core",
					dimension: "goal",
					prior_dimension_score: null,
					new_dimension_score: null,
					prior_effective_ambiguity: null,
					new_effective_ambiguity: null,
					evidence: null,
					rationale: { value: "Conflicting evidence", truncated: false, original_bytes: 20 },
					contradicted_fact_id: null,
					insertion_index: 1,
				},
				{
					kind: "C",
					name: { value: "Unresolved", truncated: false, original_bytes: 10 },
					status: "unresolved",
					source_round: 2,
					source_round_key: "nointerview::rid:r2",
					component_id: "core",
					dimension: "goal",
					prior_dimension_score: null,
					new_dimension_score: null,
					prior_effective_ambiguity: null,
					new_effective_ambiguity: null,
					evidence: null,
					rationale: { value: "Needs clarification", truncated: false, original_bytes: 19 },
					contradicted_fact_id: null,
					insertion_index: 2,
				},
			]);
			const replay = await command([
				"apply-round-result",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"6",
				"--round",
				"1",
				"--question-id",
				"q1",
				"--round-id",
				"r1",
				"--result-json",
				validGreenfieldResult,
				"--json",
			]);
			expect(replay.status).toBe(0);
			const changedScoredAnswer = await command([
				"record-answer",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"6",
				"--round",
				"1",
				"--question-id",
				"q1",
				"--round-id",
				"r1",
				"--question-json",
				'"Question"',
				"--answer-json",
				'{"selected_options":["No"],"custom_input":null}',
				"--component-id",
				"core",
				"--dimension",
				"goal",
				"--json",
			]);
			expect(changedScoredAnswer.status).toBe(4);
			expect(changedScoredAnswer.stderr).toContain("DI_SHELL_CONFLICT");
			const invalidGreenfieldContextResult = await command([
				"apply-round-result",
				"--session-id",
				"strict-flow",
				"--schema-version",
				"1",
				"--expected-revision",
				"6",
				"--round",
				"2",
				"--question-id",
				"q2",
				"--result-json",
				'{"global_scores":{"goal":0.1,"constraints":0.1,"criteria":0.1,"context":0.1}}',
				"--json",
			]);
			expect(invalidGreenfieldContextResult.stderr).toContain("DI_INVALID_RESULT_JSON");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
