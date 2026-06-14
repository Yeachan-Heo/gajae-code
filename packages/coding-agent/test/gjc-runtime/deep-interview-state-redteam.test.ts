import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendOrMergeDeepInterviewRound,
	enrichDeepInterviewRoundScoring,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-recorder";
import { deepInterviewStatePath } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import {
	mergeDeepInterviewEnvelope,
	mergeDeepInterviewRounds,
	normalizeDeepInterviewEnvelope,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-state";
import { reconcileWorkflowSkillState, runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import { deriveDeepInterviewHud } from "@gajae-code/coding-agent/skill-state/workflow-hud";

const tempRoots: string[] = [];

beforeAll(() => {
	delete process.env.GJC_SESSION_ID;
});

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-di-redteam-"));
	tempRoots.push(dir);
	return dir;
}

function inner(envelope: { state?: Record<string, unknown> }): Record<string, unknown> {
	return (envelope.state ?? {}) as Record<string, unknown>;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}

async function activeChips(cwd: string): Promise<Record<string, string | undefined>> {
	const raw = JSON.parse(await fs.readFile(path.join(cwd, ".gjc", "state", "skill-active-state.json"), "utf-8")) as {
		active_skills?: Array<{ skill: string; hud?: { chips?: Array<{ label: string; value?: string }> } }>;
	};
	const entry = (raw.active_skills ?? []).find(skill => skill.skill === "deep-interview");
	return Object.fromEntries((entry?.hud?.chips ?? []).map(chip => [chip.label, chip.value]));
}

function hudChips(payload: Record<string, unknown>): Record<string, string | undefined> {
	return Object.fromEntries((deriveDeepInterviewHud(payload).chips ?? []).map(chip => [chip.label, chip.value]));
}

describe("deep-interview redteam: idempotency and lossless shape normalization", () => {
	it("keeps normalize and merge stable after repeated passes without growing or reordering rounds", () => {
		const initial = {
			skill: "deep-interview",
			current_phase: "interviewing",
			rounds: [
				{ round_key: "iv::r:1::q:q1", round: 1, lifecycle: "answered", question_hash: "qh1", answer_hash: "ah1" },
				{ round: 1, note: "opaque-a" },
				{ round: 1, note: "opaque-b" },
			],
			state: {
				rounds: [
					{ round_key: "iv::r:2::q:q2", round: 2, lifecycle: "scored", ambiguity: 0.44 },
					{ round: 3, question_id: "q3", lifecycle: "answered" },
				],
				established_facts: [{ id: "f1", statement: "fact", round: 1, disputed: false }],
			},
		};

		const normalizedPasses = [initial];
		for (let index = 0; index < 4; index++) {
			normalizedPasses.push(normalizeDeepInterviewEnvelope(normalizedPasses.at(-1)) as typeof initial);
		}
		expect(normalizedPasses[4]).toEqual(normalizedPasses[3]);
		expect(inner(normalizedPasses[4]).rounds).toEqual(inner(normalizedPasses[1]).rounds);
		expect(Object.hasOwn(normalizedPasses[4], "rounds")).toBe(false);

		let merged = normalizeDeepInterviewEnvelope(initial);
		const incoming = {
			state: {
				rounds: [
					{ round_key: "iv::r:2::q:q2", round: 2, lifecycle: "scored", ambiguity: 0.44 },
					{ round: 4, question_id: "q4", lifecycle: "answered" },
				],
				current_ambiguity: 0.31,
			},
		};
		const orders: unknown[][] = [];
		for (let index = 0; index < 4; index++) {
			merged = mergeDeepInterviewEnvelope(merged, incoming);
			orders.push(clone(inner(merged).rounds as unknown[]));
		}
		expect(orders[1]).toEqual(orders[0]);
		expect(orders[2]).toEqual(orders[0]);
		expect(orders[3]).toEqual(orders[0]);
		expect(orders[0]).toHaveLength(3);
		expect((orders[0][0] as Record<string, unknown>).round_key).toBe("iv::r:2::q:q2");
		expect((orders[0][1] as Record<string, unknown>).round_key).toBe("nointerview::r:3::q:q3");
		expect((orders[0][2] as Record<string, unknown>).round_key).toBe("nointerview::r:4::q:q4");
	});

	it("merges mixed top-level and nested rounds without loss, duplicate top-level keys, or legacy collapse", () => {
		const mixed = {
			skill: "deep-interview",
			rounds: [
				{ round_key: "legacy-key", round: 1, lifecycle: "answered", question_hash: "qh", answer_hash: "ah" },
				{ round: 7, note: "same number first" },
			],
			topology: { last_targeted_component_id: "legacy" },
			state: {
				rounds: [
					{ round_key: "nested-key", round: 2, lifecycle: "scored", ambiguity: 0.2 },
					{ round: 7, note: "same number second" },
				],
				topology: { last_targeted_component_id: "nested" },
			},
		};
		const normalized = normalizeDeepInterviewEnvelope(mixed);
		const merged = mergeDeepInterviewEnvelope(mixed, { state: { rounds: mixed.rounds } });

		expect(Object.hasOwn(normalized, "rounds")).toBe(false);
		expect(Object.hasOwn(normalized, "topology")).toBe(false);
		expect(inner(normalized).rounds).toHaveLength(2);
		expect(inner(merged).rounds).toHaveLength(4);
		expect(inner(merged).topology).toEqual({ last_targeted_component_id: "nested" });
		expect((inner(merged).rounds as Array<Record<string, unknown>>).map(round => round.note).filter(Boolean)).toEqual(
			["same number second", "same number first"],
		);
	});

	it("preserves legacy rounds that collide on round number when no durable identity exists", () => {
		const rounds = mergeDeepInterviewRounds(
			[{ round: 3, transcript: "first answer", lifecycle: "answered" }],
			[
				{ round: 3, transcript: "second answer", lifecycle: "answered" },
				{ round: 3, transcript: "first answer", lifecycle: "answered" },
			],
		);
		expect(rounds).toHaveLength(2);
		expect(rounds.map(round => round.transcript)).toEqual(["first answer", "second answer"]);
	});

	it("merges answered to scored by durable key into one record while preserving shell hashes", () => {
		const rounds = mergeDeepInterviewRounds(
			[
				{
					round_key: "iv::r:1::q:q1",
					round: 1,
					question_id: "q1",
					question_hash: "question-shell-hash",
					answer_hash: "answer-shell-hash",
					lifecycle: "answered",
				},
			],
			[
				{
					round_key: "iv::r:1::q:q1",
					round: 1,
					question_id: "q1",
					question_hash: "",
					answer_hash: "",
					lifecycle: "scored",
					ambiguity: 0.27,
					scores: { goal: 0.7 },
				},
			],
		);
		expect(rounds).toHaveLength(1);
		expect(rounds[0]).toMatchObject({
			lifecycle: "scored",
			ambiguity: 0.27,
			question_hash: "question-shell-hash",
			answer_hash: "answer-shell-hash",
		});
	});
});

describe("deep-interview redteam: writer and recorder integration", () => {
	it("preserves all recorder rounds across multiple sequential partial state writes", async () => {
		const cwd = await tempDir();
		const statePath = deepInterviewStatePath(cwd, undefined);
		await appendOrMergeDeepInterviewRound(cwd, statePath, { round: 1, questionId: "q1", questionText: "Q1?" });
		await appendOrMergeDeepInterviewRound(cwd, statePath, { round: 2, questionId: "q2", questionText: "Q2?" });
		await enrichDeepInterviewRoundScoring(cwd, statePath, {
			round: 1,
			questionId: "q1",
			scores: { goal: 0.4 },
			ambiguity: 0.61,
		});

		const writes = [
			{ state: { current_ambiguity: 0.51, topology: { last_targeted_component_id: "api" } } },
			{
				state: {
					current_ambiguity: 0.41,
					topology: {
						last_targeted_component_id: "cli",
						components: [{ id: "cli", status: "active", weakest_dimension: "goal" }],
					},
				},
			},
			{ state: { current_ambiguity: 0.31, topology: { status: "legacy_missing" } } },
		];

		for (const payload of writes) {
			const result = await runNativeStateCommand(
				["write", "--mode", "deep-interview", "--input", JSON.stringify(payload)],
				cwd,
			);
			expect(result.status).toBe(0);
			const onDisk = await readJson(statePath);
			expect(Object.hasOwn(onDisk, "rounds")).toBe(false);
			expect((inner(onDisk).rounds as unknown[]).map(round => (round as Record<string, unknown>).round)).toEqual([
				1, 2,
			]);
		}

		const final = await readJson(statePath);
		expect(inner(final).current_ambiguity).toBe(0.31);
		expect(inner(final).topology).toEqual({ status: "legacy_missing" });
		expect(inner(final).rounds).toHaveLength(2);
	});

	it("fails closed on corrupt or tampered on-disk state for state write and recorder mutation", async () => {
		const cwd = await tempDir();
		const statePath = deepInterviewStatePath(cwd, undefined);
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		const corruptBytes = "{ definitely-not-json";
		await fs.writeFile(statePath, corruptBytes, "utf-8");

		const write = await runNativeStateCommand(
			["write", "--mode", "deep-interview", "--input", JSON.stringify({ state: { current_ambiguity: 0.2 } })],
			cwd,
		);
		expect(write.status).not.toBe(0);
		expect(await fs.readFile(statePath, "utf-8")).toBe(corruptBytes);

		await expect(
			appendOrMergeDeepInterviewRound(cwd, statePath, {
				round: 1,
				questionId: "q1",
				questionText: "Should not migrate",
			}),
		).rejects.toThrow(/corrupt|tampered|refusing to overwrite/);
		expect(await fs.readFile(statePath, "utf-8")).toBe(corruptBytes);
	});
});

describe("deep-interview redteam: HUD derivation edge cases", () => {
	it("handles empty state without synthetic target or weakest chips", () => {
		const chips = hudChips({ state: {} });
		expect(chips.round).toBeUndefined();
		expect(chips.target).toBeUndefined();
		expect(chips.weakest).toBeUndefined();
	});

	it("omits target and weakest when topology is missing", () => {
		const chips = hudChips({
			current_phase: "interviewing",
			state: { rounds: [{ round_key: "k1" }], current_ambiguity: 0.5 },
		});
		expect(chips.round).toBe("1");
		expect(chips.ambiguity).toBe("50%");
		expect(chips.target).toBeUndefined();
		expect(chips.weakest).toBeUndefined();
	});

	it("does not invent an active target for deferred-only topology but can show the known weakest dimension", () => {
		const chips = hudChips({
			state: {
				rounds: [],
				topology: {
					components: [
						{ id: "api", status: "deferred", weakest_dimension: "goal" },
						{ id: "cli", status: "deferred", weakest_dimension: "constraints" },
					],
				},
			},
		});
		expect(chips.target).toBeUndefined();
		expect(chips.weakest).toBe("goal");
	});

	it("falls back to first active weakest dimension when targeted component has no weakest dimension", () => {
		const chips = hudChips({
			state: {
				topology: {
					last_targeted_component_id: "api",
					components: [
						{ id: "api", status: "active" },
						{ id: "cli", status: "active", weakest_dimension: "interface" },
						{ id: "docs", status: "deferred", weakest_dimension: "goal" },
					],
				},
			},
		});
		expect(chips.target).toBe("api");
		expect(chips.weakest).toBe("interface");
	});

	it("falls back to ambiguity from latest scored round when current ambiguity is absent", () => {
		const chips = hudChips({
			state: {
				rounds: [
					{ round_key: "k1", lifecycle: "scored", ambiguity: 0.25 },
					{ round_key: "k2", lifecycle: "answered" },
					{ round_key: "k3", lifecycle: "scored", ambiguity: 0.73 },
				],
			},
		});
		expect(chips.ambiguity).toBe("73%");
	});
});

describe("deep-interview redteam: reconcile and state write HUD parity", () => {
	const payloads = [
		{
			current_phase: "interviewing",
			state: {
				rounds: [{ round_key: "k1", round: 1, lifecycle: "scored", ambiguity: 0.64 }],
				threshold: 0.05,
				topology: {
					last_targeted_component_id: "api",
					components: [{ id: "api", status: "active", weakest_dimension: "goal" }],
				},
			},
		},
		{
			current_phase: "interviewing",
			state: {
				rounds: [
					{ round_key: "k1", round: 1, lifecycle: "scored", ambiguity: 0.4 },
					{ round_key: "k2", round: 2, lifecycle: "answered" },
				],
				topology: { status: "legacy_missing" },
			},
		},
		{
			current_phase: "interviewing",
			state: {
				rounds: [],
				current_ambiguity: 0.12,
				topology: { components: [{ id: "only", status: "deferred", weakest_dimension: "risk" }] },
			},
		},
	];

	it("produces identical active-state HUD chips through reconcile and gjc state write", async () => {
		for (const payload of payloads) {
			const writeCwd = await tempDir();
			const write = await runNativeStateCommand(
				["write", "--mode", "deep-interview", "--input", JSON.stringify(payload)],
				writeCwd,
			);
			expect(write.status).toBe(0);
			const writeHud = await activeChips(writeCwd);

			const reconcileCwd = await tempDir();
			await reconcileWorkflowSkillState({
				cwd: reconcileCwd,
				mode: "deep-interview",
				sessionId: undefined,
				active: payload.current_phase !== "complete",
				phase: payload.current_phase,
				payload,
			});
			const reconcileHud = await activeChips(reconcileCwd);
			expect(reconcileHud).toEqual(writeHud);
		}
	});
});
