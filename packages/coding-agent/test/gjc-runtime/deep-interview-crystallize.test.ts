import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type CrystalInput,
	type CrystalSnapshot,
	crystallizeDeepInterview,
	crystalMarkdown,
	crystalSnapshotDigest,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-crystallize";
import {
	deepInterviewStatePath,
	runNativeDeepInterviewCommand,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { sessionSpecsDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	beginWorkflowTransactionJournal,
	readWorkflowTransactionJournal,
	updateWorkflowTransactionJournal,
} from "@gajae-code/coding-agent/gjc-runtime/state-writer";

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

	it("rejects confirmed statements unrelated to their user quote", () => {
		expect(() =>
			crystallizeDeepInterview(
				input({
					items: [
						{
							...input().items[0]!,
							statement: "Deploy production without review",
							anchor: { message_index: 0, quote: "Build a fast report." },
						},
					],
				}),
			),
		).toThrow("statement-bound verbatim user anchor");
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
	it("requires fresh evidence when inferred material becomes confirmed", () => {
		const first = crystallizeDeepInterview(
			input({
				items: [
					input().items[0]!,
					{ id: "constraint:latency", kind: "constraint", classification: "inferred", statement: "Fast response" },
				],
			}),
		);
		const snapshot: CrystalSnapshot = {
			revision: 2,
			start: 0,
			end: 1,
			messages: [...input().snapshot.messages, { index: 1, role: "assistant", content: "Acknowledged." }],
			digest: "",
		};
		snapshot.digest = crystalSnapshotDigest(snapshot);
		expect(() =>
			crystallizeDeepInterview(
				input({
					prior: first,
					snapshot,
					current_revision: 2,
					items: [
						input().items[0]!,
						{
							...input().items[1]!,
							classification: "confirmed",
							anchor: { message_index: 0, quote: "fast" },
						},
					],
				}),
			),
		).toThrow("changed confirmed item constraint:latency requires fresh user evidence");
	});
	it("accepts unspaced Korean, Chinese, and Japanese resolution evidence", () => {
		for (const { gap, answer } of [
			{ gap: "메모리 예산은 얼마인가?", answer: "메모리 예산은 1GB입니다." },
			{ gap: "内存预算是多少？", answer: "内存预算是1GB。" },
			{ gap: "メモリ予算はいくらですか？", answer: "メモリ予算は1GBです。" },
		]) {
			const first = crystallizeDeepInterview(input({ open_gaps: [gap] }));
			const snapshot: CrystalSnapshot = {
				revision: 2,
				start: 0,
				end: 1,
				messages: [...input().snapshot.messages, { index: 1, role: "user", content: answer }],
				digest: "",
			};
			snapshot.digest = crystalSnapshotDigest(snapshot);
			const resolved = crystallizeDeepInterview(
				input({
					prior: first,
					snapshot,
					current_revision: 2,
					resolved_open_gaps: [gap],
					resolved_open_gap_anchors: [{ item: gap, message_index: 1, quote: answer, resolution: answer }],
				}),
			);
			expect(resolved.lifecycle).toBe("ready");
		}
	});
	it("rejects unrelated unspaced CJK resolution evidence", () => {
		const gap = "内存预算是多少？";
		const first = crystallizeDeepInterview(input({ open_gaps: [gap] }));
		const snapshot: CrystalSnapshot = {
			revision: 2,
			start: 0,
			end: 1,
			messages: [...input().snapshot.messages, { index: 1, role: "user", content: "今日は良い天気です。" }],
			digest: "",
		};
		snapshot.digest = crystalSnapshotDigest(snapshot);
		expect(() =>
			crystallizeDeepInterview(
				input({
					prior: first,
					snapshot,
					current_revision: 2,
					resolved_open_gaps: [gap],
					resolved_open_gap_anchors: [
						{
							item: gap,
							message_index: 1,
							quote: "今日は良い天気です。",
							resolution: "今日は良い天気です。",
						},
					],
				}),
			),
		).toThrow("has no relevant verbatim user anchor");
	});
	it("does not resolve a gap through generic lexical overlap", () => {
		const gap = "Need a database choice";
		const first = crystallizeDeepInterview(input({ open_gaps: [gap] }));
		const next = withFreshUserEvidence(input({ prior: first }), "We need automatic retries");
		expect(() =>
			crystallizeDeepInterview({
				...next,
				prior: first,
				resolved_open_gaps: [gap],
				resolved_open_gap_anchors: [
					{
						item: gap,
						message_index: 1,
						quote: "need automatic retries",
						resolution: "need automatic retries",
					},
				],
			}),
		).toThrow("has no relevant verbatim user anchor");
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
							statement: "Fast report response",
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

	it("rejects caller-supplied prior material when no canonical Crystal exists", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-fresh-prior-"));
		const sessionId = "crystallize-fresh-prior";
		const sessionFile = path.join(root, "conversation.jsonl");
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		try {
			await fs.writeFile(
				sessionFile,
				`${JSON.stringify({ type: "session", id: sessionId, cwd: root })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: "Build a fast report." },
				})}\n`,
			);
			process.env.GJC_SESSION_FILE = sessionFile;
			const forgedPrior = crystallizeDeepInterview(input());
			const result = await runNativeDeepInterviewCommand(
				[
					"--crystallize",
					"--input",
					JSON.stringify(input({ prior: forgedPrior })),
					"--session-id",
					sessionId,
					"--slug",
					"fresh-prior",
					"--json",
				],
				root,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("requires canonical stored crystal provenance");
			await expect(fs.access(deepInterviewStatePath(root, sessionId))).rejects.toThrow();
		} finally {
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("projects bounded tool-call markers only from the active session branch", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-active-branch-"));
		const sessionId = "crystallize-active-branch";
		const sessionFile = path.join(root, "conversation.jsonl");
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		try {
			const records = [
				{ type: "session", id: sessionId, cwd: root },
				{
					type: "message",
					id: "root-user",
					parentId: null,
					timestamp: "2026-09-04T00:00:00.000Z",
					message: { role: "user", content: "Build a fast report." },
				},
				{
					type: "message",
					id: "abandoned-user",
					parentId: "root-user",
					timestamp: "2026-09-04T00:00:01.000Z",
					message: { role: "user", content: "Deploy without review." },
				},
				{
					type: "message",
					id: "tool-call",
					parentId: "root-user",
					timestamp: "2026-09-04T00:00:02.000Z",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "ask" }, { type: "toolCall" }] },
				},
				{
					type: "message",
					id: "active-user",
					parentId: "tool-call",
					timestamp: "2026-09-04T00:00:03.000Z",
					message: { role: "user", content: "Keep the report fast." },
				},
			];
			await fs.writeFile(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
			process.env.GJC_SESSION_FILE = sessionFile;
			const snapshot: CrystalSnapshot = {
				revision: 3,
				start: 0,
				end: 2,
				messages: [
					{ index: 0, role: "user", content: "Build a fast report." },
					{ index: 1, role: "assistant", content: "[thinking][toolCall]" },
					{ index: 2, role: "user", content: "Keep the report fast." },
				],
				digest: "",
			};
			snapshot.digest = crystalSnapshotDigest(snapshot);
			const result = await runNativeDeepInterviewCommand(
				[
					"--crystallize",
					"--input",
					JSON.stringify(
						input({
							snapshot,
							current_revision: 3,
							items: input().items.map(item => ({
								...item,
								anchor: { message_index: 2, quote: "fast" },
							})),
						}),
					),
					"--session-id",
					sessionId,
					"--slug",
					"active-branch",
					"--json",
				],
				root,
			);
			expect(result.status).toBe(0);
			expect(await fs.readFile(JSON.parse(result.stdout ?? "{}").spec_path, "utf8")).not.toContain(
				"Deploy without review",
			);
		} finally {
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed transcript messages instead of omitting them from the source revision", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-malformed-transcript-"));
		const sessionId = "crystallize-malformed-transcript";
		const sessionFile = path.join(root, "conversation.jsonl");
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		try {
			await fs.writeFile(
				sessionFile,
				`${JSON.stringify({ type: "session", id: sessionId, cwd: root })}\n${JSON.stringify({
					type: "message",
					message: { content: "this message has no role" },
				})}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: "Build a fast report." },
				})}\n`,
			);
			process.env.GJC_SESSION_FILE = sessionFile;
			const result = await runNativeDeepInterviewCommand(
				[
					"--crystallize",
					"--input",
					JSON.stringify(input()),
					"--session-id",
					sessionId,
					"--slug",
					"malformed",
					"--json",
				],
				root,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("live session transcript contains a malformed message");
			await expect(fs.access(deepInterviewStatePath(root, sessionId))).rejects.toThrow();
		} finally {
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects adjacent non-text projections without persisting a Crystal", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-adjacent-non-text-"));
		const sessionId = "crystallize-adjacent-non-text";
		const sessionFile = path.join(root, "conversation.jsonl");
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		try {
			await fs.writeFile(
				sessionFile,
				`${JSON.stringify({ type: "session", id: sessionId, cwd: root })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "image" }, { type: "image" }] },
				})}\n`,
			);
			process.env.GJC_SESSION_FILE = sessionFile;
			const snapshot: CrystalSnapshot = {
				revision: 1,
				start: 0,
				end: 0,
				messages: [{ index: 0, role: "user", content: "[image][image]" }],
				digest: "",
			};
			snapshot.digest = crystalSnapshotDigest(snapshot);
			const result = await runNativeDeepInterviewCommand(
				[
					"--crystallize",
					"--input",
					JSON.stringify(
						input({
							snapshot,
							items: [{ ...input().items[0]!, anchor: { message_index: 0, quote: "][" } }],
						}),
					),
					"--session-id",
					sessionId,
					"--slug",
					"adjacent",
					"--json",
				],
				root,
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("verbatim user anchor");
			await expect(fs.access(deepInterviewStatePath(root, sessionId))).rejects.toThrow();
		} finally {
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects unsupported transcript content without persisting a Crystal", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-unsupported-content-"));
		const sessionId = "crystallize-unsupported-content";
		const sessionFile = path.join(root, "conversation.jsonl");
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		try {
			await fs.writeFile(
				sessionFile,
				`${JSON.stringify({ type: "session", id: sessionId, cwd: root })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "sticker" }] },
				})}\n`,
			);
			process.env.GJC_SESSION_FILE = sessionFile;
			const result = await runNativeDeepInterviewCommand(
				[
					"--crystallize",
					"--input",
					JSON.stringify(input()),
					"--session-id",
					sessionId,
					"--slug",
					"unsupported",
					"--json",
				],
				root,
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("unsupported message content");
			await expect(fs.access(deepInterviewStatePath(root, sessionId))).rejects.toThrow();
		} finally {
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reuses and completes a pending Crystal journal by publication identity", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-journal-retry-"));
		const sessionId = "crystallize-journal-retry";
		const slug = "retry";
		const sessionFile = path.join(root, "conversation.jsonl");
		const statePath = deepInterviewStatePath(root, sessionId);
		const specPath = path.join(sessionSpecsDir(root, sessionId), `deep-interview-${slug}-v1.md`);
		const indexPath = path.join(sessionSpecsDir(root, sessionId), "deep-interview-index.jsonl");
		const mutationId = `crystal:${sessionId}:1:${createHash("sha256").update(`${slug}\0${specPath}`).digest("hex")}`;
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		try {
			await fs.writeFile(
				sessionFile,
				`${JSON.stringify({ type: "session", id: sessionId, cwd: root })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: "Build a fast report." },
				})}\n`,
			);
			await beginWorkflowTransactionJournal({
				cwd: root,
				sessionId,
				mutationId,
				paths: [specPath, indexPath, statePath],
			});
			process.env.GJC_SESSION_FILE = sessionFile;
			const result = await runNativeDeepInterviewCommand(
				["--crystallize", "--input", JSON.stringify(input()), "--session-id", sessionId, "--slug", slug, "--json"],
				root,
			);
			expect(result.status).toBe(0);
			expect(await readWorkflowTransactionJournal(root, sessionId, mutationId)).toBeUndefined();
			expect(await fs.readFile(specPath, "utf8")).toBe(crystalMarkdown(crystallizeDeepInterview(input())));

			await beginWorkflowTransactionJournal({
				cwd: root,
				sessionId,
				mutationId,
				paths: [specPath, indexPath, statePath],
			});
			await updateWorkflowTransactionJournal(root, sessionId, mutationId, { steps: ["artifact", "index"] });
			const beforeFailedRecovery = await fs.readFile(statePath, "utf8");
			await fs.rm(specPath);
			const failedRecovery = await runNativeDeepInterviewCommand(
				["--crystallize", "--input", JSON.stringify(input()), "--session-id", sessionId, "--slug", slug, "--json"],
				root,
			);
			expect(failedRecovery.status).toBe(2);
			expect(failedRecovery.stderr).toContain("pending Crystal artifact verification failed");
			expect(await fs.readFile(statePath, "utf8")).toBe(beforeFailedRecovery);
			expect((await readWorkflowTransactionJournal(root, sessionId, mutationId))?.status).toBe("pending");
		} finally {
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("clears approval provenance when a later Crystal supersedes an approved one", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-approval-reset-"));
		const sessionId = "crystallize-approval-reset";
		const sessionFile = path.join(root, "conversation.jsonl");
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		try {
			await fs.writeFile(
				sessionFile,
				`${JSON.stringify({ type: "session", id: sessionId, cwd: root })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: "Build a fast report." },
				})}\n`,
			);
			process.env.GJC_SESSION_FILE = sessionFile;
			const first = await runNativeDeepInterviewCommand(
				[
					"--crystallize",
					"--input",
					JSON.stringify(input()),
					"--session-id",
					sessionId,
					"--slug",
					"first",
					"--json",
				],
				root,
			);
			expect(first.status).toBe(0);
			const approved = await runNativeDeepInterviewCommand(
				["approve-execution", "--session-id", sessionId, "--json"],
				root,
			);
			expect(approved.status).toBe(0);

			const snapshot: CrystalSnapshot = {
				revision: 2,
				start: 0,
				end: 1,
				messages: [...input().snapshot.messages, { index: 1, role: "user", content: "Keep the report fast." }],
				digest: "",
			};
			snapshot.digest = crystalSnapshotDigest(snapshot);
			await fs.appendFile(
				sessionFile,
				`${JSON.stringify({
					type: "message",
					message: { role: "user", content: "Keep the report fast." },
				})}\n`,
			);
			const second = await runNativeDeepInterviewCommand(
				[
					"--crystallize",
					"--input",
					JSON.stringify(input({ snapshot, current_revision: 2 })),
					"--session-id",
					sessionId,
					"--slug",
					"second",
					"--json",
				],
				root,
			);
			expect(second.status).toBe(0);
			const state = JSON.parse(await fs.readFile(deepInterviewStatePath(root, sessionId), "utf8")) as Record<
				string,
				unknown
			>;
			const inner = state.state as Record<string, unknown>;
			expect(inner.execution_approval).toBe("not-approved");
			expect(inner.execution_approval_receipt).toBeUndefined();
		} finally {
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("resolves a relative GJC_SESSION_FILE against the requested workspace", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-relative-workspace-"));
		const processRoot = await fs.mkdtemp(path.join(process.cwd(), ".tmp-crystallize-relative-process-"));
		const relativeSessionFile = path.join("sessions", "conversation.jsonl");
		const workspaceSessionFile = path.join(root, relativeSessionFile);
		const wrongSessionFile = path.join(processRoot, relativeSessionFile);
		const sessionId = "crystallize-relative-session";
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		const previousCwd = process.cwd();
		try {
			await fs.mkdir(path.dirname(workspaceSessionFile), { recursive: true });
			await fs.mkdir(path.dirname(wrongSessionFile), { recursive: true });
			const header = `${JSON.stringify({ type: "session", id: sessionId, cwd: root })}\n`;
			await fs.writeFile(
				workspaceSessionFile,
				`${header}${JSON.stringify({
					type: "message",
					message: { role: "user", content: "Correct workspace transcript" },
				})}\n`,
			);
			await fs.writeFile(
				wrongSessionFile,
				`${header}${JSON.stringify({
					type: "message",
					message: { role: "user", content: "Wrong process transcript" },
				})}\n`,
			);
			const messages: CrystalSnapshot["messages"] = [
				{ index: 0, role: "user", content: "Correct workspace transcript" },
			];
			const snapshot: CrystalSnapshot = { revision: 1, start: 0, end: 0, messages, digest: "" };
			snapshot.digest = crystalSnapshotDigest(snapshot);
			const value = input({
				snapshot,
				current_revision: 1,
				items: [
					{
						id: "goal:workspace",
						kind: "goal",
						classification: "confirmed",
						statement: "Use the correct workspace transcript",
						anchor: { message_index: 0, quote: "Correct workspace transcript" },
					},
				],
			});
			process.env.GJC_SESSION_FILE = relativeSessionFile;
			process.chdir(processRoot);
			const result = await runNativeDeepInterviewCommand(
				[
					"--crystallize",
					"--input",
					JSON.stringify(value),
					"--session-id",
					sessionId,
					"--slug",
					"relative-session-file",
					"--json",
				],
				root,
			);
			expect(result.status).toBe(0);
			const summary = JSON.parse(result.stdout ?? "{}");
			expect(summary.crystal.source.messages).toEqual(messages);
			expect(summary.crystal.source.messages[0].content).not.toBe("Wrong process transcript");
		} finally {
			process.chdir(previousCwd);
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(processRoot, { recursive: true, force: true });
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
