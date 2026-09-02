import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type CrystalInput,
	type CrystalSnapshot,
	crystallizeDeepInterview,
	crystalSnapshotDigest,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-crystallize";
import {
	deepInterviewStatePath,
	runNativeDeepInterviewCommand,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";

function input(overrides: Partial<CrystalInput> = {}): CrystalInput {
	const messages = [{ index: 0, role: "user" as const, content: "Build a fast report." }];
	const snapshot: CrystalSnapshot = { revision: 1, start: 0, end: 0, messages, digest: "" };
	snapshot.digest = crystalSnapshotDigest(snapshot);
	return {
		snapshot,
		current_revision: 1,
		items: [
			{
				id: "goal:report",
				kind: "goal",
				classification: "confirmed",
				statement: "Build a fast report",
				anchor: { message_index: 0, quote: "Build a fast report." },
			},
			{
				id: "constraint:latency",
				kind: "constraint",
				classification: "confirmed",
				statement: "Fast response",
				anchor: { message_index: 0, quote: "fast" },
			},
		],
		...overrides,
	};
}

function later(value: CrystalInput, revision: number): CrystalInput {
	const snapshot = { ...value.snapshot, revision };
	snapshot.digest = crystalSnapshotDigest(snapshot);
	return { ...value, snapshot, current_revision: revision };
}

function withFreshUserEvidence(value: CrystalInput, content: string): CrystalInput {
	const index = value.snapshot.end + 1;
	const snapshot: CrystalSnapshot = {
		revision: value.snapshot.revision + 1,
		start: value.snapshot.start,
		end: index,
		messages: [...value.snapshot.messages, { index, role: "user", content }],
		digest: "",
	};
	snapshot.digest = crystalSnapshotDigest(snapshot);
	return { ...value, snapshot, current_revision: snapshot.revision };
}

describe("deep-interview crystallize contract", () => {
	it("creates a ready version with anchored confirmed material and no approval", () => {
		const crystal = crystallizeDeepInterview(input());
		expect(crystal.lifecycle).toBe("ready");
		expect(crystal.spec_version).toBe(1);
		expect(crystal.execution_approval).toBe("not-approved");
		expect(crystal.items[0]?.anchor?.quote).toBe("Build a fast report.");
	});

	it("accepts developer and toolResult transcript roles", () => {
		const snapshot: CrystalSnapshot = {
			revision: 3,
			start: 0,
			end: 2,
			messages: [
				{ index: 0, role: "developer", content: "System guidance" },
				{ index: 1, role: "toolResult", content: "Tool output" },
				{ index: 2, role: "user", content: "Build a fast report." },
			],
			digest: "",
		};
		snapshot.digest = crystalSnapshotDigest(snapshot);
		const crystal = crystallizeDeepInterview(
			input({
				snapshot,
				current_revision: 3,
				items: input().items.map(item => ({ ...item, anchor: { message_index: 2, quote: "fast" } })),
			}),
		);
		expect(crystal.lifecycle).toBe("ready");
	});
	it("rejects synthetic non-text markers as confirmed user anchors", () => {
		const snapshot: CrystalSnapshot = {
			revision: 1,
			start: 0,
			end: 0,
			messages: [{ index: 0, role: "user", content: "[image]" }],
			digest: "",
		};
		snapshot.digest = crystalSnapshotDigest(snapshot);
		expect(() =>
			crystallizeDeepInterview(
				input({
					snapshot,
					current_revision: 1,
					items: [{ ...input().items[0], anchor: { message_index: 0, quote: "[image]" } }],
				}),
			),
		).toThrow("verbatim user anchor");
	});
	it("rejects marker substrings in mixed text anchors", () => {
		const snapshot: CrystalSnapshot = {
			revision: 1,
			start: 0,
			end: 0,
			messages: [{ index: 0, role: "user", content: "Need [image] support" }],
			digest: "",
		};
		snapshot.digest = crystalSnapshotDigest(snapshot);
		expect(() =>
			crystallizeDeepInterview(
				input({
					snapshot,
					current_revision: 1,
					items: [{ ...input().items[0], anchor: { message_index: 0, quote: "Need [image] support" } }],
				}),
			),
		).toThrow("verbatim user anchor");
	});
	it("rejects incomplete or bare marker fragments", () => {
		for (const quote of ["image", "[image", "image]"]) {
			const snapshot: CrystalSnapshot = {
				revision: 1,
				start: 0,
				end: 0,
				messages: [{ index: 0, role: "user", content: `Need ${quote} support` }],
				digest: "",
			};
			snapshot.digest = crystalSnapshotDigest(snapshot);
			expect(() =>
				crystallizeDeepInterview(
					input({
						snapshot,
						current_revision: 1,
						items: [{ ...input().items[0], anchor: { message_index: 0, quote } }],
					}),
				),
			).toThrow("verbatim user anchor");
		}
	});
	it("does not preserve a confirmed-to-inferred downgrade", () => {
		const prior = crystallizeDeepInterview(input());
		const downgraded = later(
			input({
				prior,
				items: [
					{ id: "goal:report", kind: "goal", classification: "inferred", statement: "Build a fast report" },
					input().items[1]!,
				],
			}),
			2,
		);
		const crystal = crystallizeDeepInterview(downgraded);
		expect(crystal.delta.kind).toBe("goal-replaced");
		expect(crystal.lifecycle).toBe("superseded");
	});

	it("represents bounded gaps as needs-questions", () => {
		const crystal = crystallizeDeepInterview(input({ open_gaps: ["What is the memory budget?"] }));
		expect(crystal.lifecycle).toBe("needs-questions");
	});

	it("allows explicit resolution of prior gaps and conflicts", () => {
		const first = crystallizeDeepInterview(
			input({ open_gaps: ["What is the memory budget?"], conflicts: ["The target is disputed."] }),
		);
		const second = crystallizeDeepInterview(
			later(
				input({
					prior: first,
					resolved_open_gaps: ["What is the memory budget?"],
					resolved_conflicts: ["The target is disputed."],
					resolved_open_gap_anchors: [
						{
							item: "What is the memory budget?",
							message_index: 1,
							quote: "budget is 1GB",
							resolution: "budget is 1GB",
						},
					],
					resolved_conflict_anchors: [
						{
							item: "The target is disputed.",
							message_index: 1,
							quote: "target follows the selected scope",
							resolution: "target follows the selected scope",
						},
					],
					snapshot: (() => {
						const snapshot: CrystalSnapshot = {
							revision: 2,
							start: 0,
							end: 1,
							messages: [
								{ index: 0, role: "user", content: "Build a fast report." },
								{
									index: 1,
									role: "user",
									content: "The budget is 1GB; the target follows the selected scope.",
								},
							],
							digest: "",
						};
						snapshot.digest = crystalSnapshotDigest(snapshot);
						return snapshot;
					})(),
				}),
				2,
			),
		);
		expect(second.lifecycle).toBe("ready");
		expect(second.open_gaps).toEqual([]);
		expect(second.conflicts).toEqual([]);
		expect(() =>
			crystallizeDeepInterview(
				later(input({ prior: first, resolved_open_gaps: ["What is the memory budget?"] }), 2),
			),
		).toThrow("resolved_open_gap_anchors must contain one anchor per resolution");
		expect(() =>
			crystallizeDeepInterview(
				later(
					input({
						prior: first,
						resolved_open_gaps: ["What is the memory budget?"],
						resolved_open_gap_anchors: [
							{
								item: "What is the memory budget?",
								message_index: 1,
								quote: "memory budget",
								resolution: "memory budget",
							},
						],
					}),
					2,
				),
			),
		).toThrow("has no fresh verbatim user anchor");
		expect(() =>
			crystallizeDeepInterview(
				later(
					input({
						prior: first,
						resolved_open_gaps: ["What is the memory budget?"],
						resolved_open_gap_anchors: [
							{
								item: "What is the memory budget?",
								message_index: 1,
								quote: "memory budget xy",
								resolution: "memory budget xy",
							},
						],
						snapshot: (() => {
							const snapshot: CrystalSnapshot = {
								revision: 2,
								start: 0,
								end: 1,
								messages: [
									{ index: 0, role: "user", content: "Build a fast report." },
									{ index: 1, role: "user", content: "The memory budget xy." },
								],
								digest: "",
							};
							snapshot.digest = crystalSnapshotDigest(snapshot);
							return snapshot;
						})(),
					}),
					2,
				),
			),
		).toThrow("has no fresh verbatim user anchor");
	});

	it("rejects unrelated user text as resolution evidence for a blocking gap", () => {
		const first = crystallizeDeepInterview(input({ open_gaps: ["What is the maximum memory budget?"] }));
		const messages: CrystalSnapshot["messages"] = [
			{ index: 0, role: "user", content: "Build a fast report." },
			{ index: 1, role: "user", content: "Blue sky today" },
		];
		const snapshot: CrystalSnapshot = { revision: 2, start: 0, end: 1, messages, digest: "" };
		snapshot.digest = crystalSnapshotDigest(snapshot);
		expect(() =>
			crystallizeDeepInterview(
				input({
					prior: first,
					snapshot,
					current_revision: 2,
					resolved_open_gaps: ["What is the maximum memory budget?"],
					resolved_open_gap_anchors: [
						{
							item: "What is the maximum memory budget?",
							message_index: 1,
							quote: "Blue sky today",
							resolution: "Blue sky today",
						},
					],
				}),
			),
		).toThrow("has no relevant verbatim user anchor");
	});

	it("marks conflicting evidence stale", () => {
		const crystal = crystallizeDeepInterview(input({ conflicts: ["Later message contradicts the goal."] }));
		expect(crystal.lifecycle).toBe("stale");
		expect(crystal.delta.approval_invalidated).toBe(true);
	});

	it("records additive changes while preserving unchanged items", () => {
		const first = crystallizeDeepInterview(input());
		const second = crystallizeDeepInterview(
			withFreshUserEvidence(
				input({
					prior: first,
					items: [
						...first.items,
						{
							id: "acceptance_criterion:fast",
							kind: "acceptance_criterion",
							classification: "confirmed",
							statement: "Respond quickly",
							anchor: { message_index: 1, quote: "respond quickly" },
						},
					],
				}),
				"The report must respond quickly.",
			),
		);
		expect(second.spec_version).toBe(2);
		expect(second.delta.kind).toBe("additive");
		expect(second.delta.preserved_ids).toContain("goal:report");
	});

	it("replaces a changed goal", () => {
		const first = crystallizeDeepInterview(input());
		const second = crystallizeDeepInterview(
			withFreshUserEvidence(
				input({
					prior: first,
					items: [
						{
							...first.items[0]!,
							statement: "Build a dashboard",
							anchor: { message_index: 1, quote: "Build a dashboard" },
						},
						first.items[1]!,
					],
				}),
				"Build a dashboard instead.",
			),
		);
		expect(second.delta.kind).toBe("goal-replaced");
		expect(second.lifecycle).toBe("superseded");
	});

	it("invalidates approval when a constraint changes", () => {
		const first = crystallizeDeepInterview(input());
		const second = crystallizeDeepInterview(
			withFreshUserEvidence(
				input({
					prior: first,
					items: [
						first.items[0]!,
						{
							...first.items[1]!,
							statement: "Respond within 50 ms",
							anchor: { message_index: 1, quote: "within 50 ms" },
						},
					],
				}),
				"The report must respond within 50 ms.",
			),
		);
		expect(second.delta.kind).toBe("intent-changed");
		expect(second.delta.approval_invalidated).toBe(true);
	});

	it("rejects changed confirmed intent anchored only before the prior Crystal boundary", () => {
		const first = crystallizeDeepInterview(input());
		const messages: CrystalSnapshot["messages"] = [
			{ index: 0, role: "user", content: "Build a fast report." },
			{ index: 1, role: "assistant", content: "Acknowledged." },
		];
		const snapshot: CrystalSnapshot = { revision: 2, start: 0, end: 1, messages, digest: "" };
		snapshot.digest = crystalSnapshotDigest(snapshot);
		expect(() =>
			crystallizeDeepInterview(
				input({
					prior: first,
					snapshot,
					current_revision: 2,
					items: [
						first.items[0]!,
						{
							...first.items[1]!,
							statement: "Respond within 50 ms",
							anchor: { message_index: 0, quote: "fast" },
						},
					],
				}),
			),
		).toThrow("changed confirmed item constraint:latency requires fresh user evidence");
	});

	it("rejects a stale or tampered snapshot", () => {
		const value = input();
		value.current_revision = 2;
		expect(() => crystallizeDeepInterview(value)).toThrow("snapshot is stale");
		value.current_revision = 1;
		value.snapshot.digest = "0".repeat(64);
		expect(() => crystallizeDeepInterview(value)).toThrow("digest mismatch");
	});

	it("rejects fabricated confirmed anchors and missing current revisions", () => {
		const value = input({ items: [{ ...input().items[0]!, anchor: { message_index: 0, quote: "not present" } }] });
		expect(() => crystallizeDeepInterview(value)).toThrow("verbatim user anchor");
		const missingRevision = input();
		delete (missingRevision as unknown as Record<string, unknown>).current_revision;
		expect(() => crystallizeDeepInterview(missingRevision)).toThrow("authoritative current revision");
	});

	it("rejects empty evidence and broad ambiguity", () => {
		const empty = input({ items: [] });
		expect(() => crystallizeDeepInterview(empty)).toThrow("material conversation evidence");
		const broad = input({ open_gaps: ["one", "two", "three"] });
		expect(() => crystallizeDeepInterview(broad)).toThrow("full deep-interview flow");
	});

	it("carries omitted prior material forward", () => {
		const first = crystallizeDeepInterview(input());
		const second = crystallizeDeepInterview(later(input({ prior: first, items: [first.items[0]!] }), 2));
		expect(second.items.map(item => item.id)).toContain("constraint:latency");
		expect(second.delta.approval_invalidated).toBe(false);
	});

	it("requires explicit removals and invalidates their prior approval", () => {
		const first = crystallizeDeepInterview(input());
		const second = crystallizeDeepInterview(
			later(input({ prior: first, items: [first.items[0]!], removed_ids: ["constraint:latency"] }), 2),
		);
		expect(second.items.map(item => item.id)).not.toContain("constraint:latency");
		expect(second.delta.approval_invalidated).toBe(true);
	});

	it("rejects removal IDs that remain submitted", () => {
		const first = crystallizeDeepInterview(input());
		expect(() =>
			crystallizeDeepInterview(later(input({ prior: first, removed_ids: ["constraint:latency"] }), 2)),
		).toThrow("disjoint");
	});

	it("promotes through the existing state/spec shape without approval", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-runtime-"));
		const value = input();
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		try {
			const sessionFile = path.join(root, "conversation.jsonl");
			const runtimeValue = {
				...value,
				current_revision: 2,
				items: value.items.map(item => ({ ...item, anchor: { message_index: 1, quote: item.anchor?.quote } })),
				snapshot: {
					...value.snapshot,
					revision: 2,
					end: 1,
					messages: [
						{ index: 0, role: "assistant" as const, content: "[image]" },
						{ ...value.snapshot.messages[0]!, index: 1 },
					],
				},
			};
			runtimeValue.snapshot.digest = crystalSnapshotDigest(runtimeValue.snapshot);
			await fs.writeFile(
				sessionFile,
				`${JSON.stringify({ type: "session", id: "crystallize-test", cwd: root })}\n${JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "image", source: { type: "url", url: "data:image/png;base64,x" } }],
					},
				})}\n${JSON.stringify({
					type: "message",
					message: {
						...value.snapshot.messages[0],
						content: [{ type: "text", text: value.snapshot.messages[0]!.content }],
					},
				})}\n`,
			);
			process.env.GJC_SESSION_FILE = sessionFile;
			const result = await runNativeDeepInterviewCommand(
				[
					"--crystallize",
					"--input",
					JSON.stringify(runtimeValue),
					"--session-id",
					"crystallize-test",
					"--slug",
					"runtime",
					"--json",
				],
				root,
			);
			expect(result.status).toBe(0);
			const summary = JSON.parse(result.stdout ?? "{}");
			expect(summary.mode).toBe("crystallize");
			expect(summary.crystal.execution_approval).toBe("not-approved");
			expect(await fs.readFile(summary.spec_path, "utf8")).toContain("Execution approval: not-approved");
		} finally {
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not reactivate an inactive deep-interview state through crystallization", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-inactive-"));
		const sessionId = "crystallize-inactive";
		const statePath = deepInterviewStatePath(root, sessionId);
		const sessionFile = path.join(root, "conversation.jsonl");
		const value = input();
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		try {
			await fs.mkdir(path.dirname(statePath), { recursive: true });
			const inactiveState = {
				skill: "deep-interview",
				session_id: sessionId,
				active: false,
				current_phase: "handoff",
				state: {},
			};
			const before = `${JSON.stringify(inactiveState)}\n`;
			await fs.writeFile(statePath, before);
			await fs.writeFile(
				sessionFile,
				`${JSON.stringify({ type: "session", id: sessionId, cwd: root })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: value.snapshot.messages[0]!.content },
				})}\n`,
			);
			process.env.GJC_SESSION_FILE = sessionFile;
			const result = await runNativeDeepInterviewCommand(
				[
					"--crystallize",
					"--input",
					JSON.stringify(value),
					"--session-id",
					sessionId,
					"--slug",
					"must-not-revive",
					"--json",
				],
				root,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("cannot crystallize an inactive deep-interview state");
			expect(await fs.readFile(statePath, "utf8")).toBe(before);
			await expect(fs.access(path.join(path.dirname(statePath), "..", "specs"))).rejects.toThrow();
		} finally {
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
