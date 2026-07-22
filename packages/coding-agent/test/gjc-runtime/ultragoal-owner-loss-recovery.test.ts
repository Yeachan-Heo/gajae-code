import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	captureUltragoalRecoverySnapshot,
	parseStrictTerminalTranscript,
	persistUltragoalRecoveryDecision,
	planUltragoalOwnerLossRecovery,
	validateOwnerLossBinding,
	validateRecoveryAdmission,
	validateRecoveryPath,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const sessionId = "session-2681";
const binding = {
	sessionId,
	endpointIncarnation: "incarnation-current",
	ownerGeneration: "generation-current",
	cwd: "",
};

function receipt(patch: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema_version: 2,
		session_id: sessionId,
		generation: "generation-current",
		run_id: "run-current",
		endpoint_incarnation: "incarnation-current",
		child_token: "child-current",
		command_sha256: "a".repeat(64),
		supervisor_pid: 1,
		supervisor_start_time: "1",
		child_pid: 2,
		child_start_time: "2",
		signal: "SIGABRT",
		signal_number: 6,
		exit_code: null,
		received_at: "2026-07-19T00:00:00.000Z",
		...patch,
	};
}

function admission(patch: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		session_id: sessionId,
		endpoint_incarnation: "incarnation-current",
		owner_generation: "generation-current",
		admitted: true,
		...patch,
	};
}

async function setup(cwd: string): Promise<string> {
	const ultragoal = sessionUltragoalDir(cwd, sessionId);
	await fs.mkdir(ultragoal, { recursive: true });
	await fs.writeFile(
		path.join(ultragoal, "goals.json"),
		JSON.stringify({
			goals: [
				{ id: "active", status: "active" },
				{ id: "review", status: "review_blocked" },
			],
		}),
	);
	await fs.writeFile(path.join(ultragoal, "ledger.jsonl"), '{"event":"goal_started","goal":"active"}\n');
	const transcript = path.join(cwd, "transcript.jsonl");
	await fs.writeFile(
		transcript,
		'{"id":"one","parentId":null,"type":"message"}\n{"id":"two","parentId":"one","type":"yield","result":{"status":"success"}}\n{"id":"three","parentId":"two","type":"toolResult","toolCallId":"two","content":[]}\n',
	);
	return transcript;
}

describe("Ultragoal owner-loss recovery", () => {
	it("resumes only from exact durable terminal JSONL, preserving dirty product files despite live sidecars", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-loss-"));
		try {
			const transcriptPath = await setup(cwd);
			const product = path.join(cwd, "product.ts");
			await fs.writeFile(product, "export const dirtyProductFile = true;\n");
			await fs.mkdir(path.join(cwd, ".gjc", "projection"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".gjc", "projection", "runtime.json"),
				'{"state":"running","owner":"live"}\n',
			);
			const decision = await planUltragoalOwnerLossRecovery({
				binding: { ...binding, cwd },
				receipt: receipt(),
				admission: admission(),
				transcriptPath,
			});
			expect(decision).toMatchObject({
				disposition: "resume",
				reason: "terminal_transcript_authoritative",
				terminal: { yieldId: "two", result: { status: "success" } },
			});
			expect(await fs.readFile(product, "utf8")).toBe("export const dirtyProductFile = true;\n");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("fails closed for stale identity, unrelated sessions, missing terminal output, corrupt rows, and conflicting yields", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-loss-"));
		try {
			const transcriptPath = await setup(cwd);
			for (const [badReceipt, badAdmission] of [
				[receipt({ generation: "stale-generation" }), admission()],
				[receipt({ session_id: "unrelated" }), admission()],
				[receipt(), admission({ endpoint_incarnation: "stale-incarnation" })],
				[receipt(), admission({ owner_generation: "stale-generation" })],
			] as const) {
				const decision = await planUltragoalOwnerLossRecovery({
					binding: { ...binding, cwd },
					receipt: badReceipt,
					admission: badAdmission,
					transcriptPath,
				});
				expect(decision.disposition).toBe("handoff");
			}
			for (const content of [
				"",
				'{"id":"one","parentId":null,"type":"yield","result":{"status":"aborted"}}',
				"{bad}\n",
				'{"id":"one","parentId":null,"type":"yield","result":{}}\n{"id":"two","parentId":"one","type":"yield","result":{}}\n',
			]) {
				await fs.writeFile(transcriptPath, content);
				const decision = await planUltragoalOwnerLossRecovery({
					binding: { ...binding, cwd },
					receipt: receipt(),
					admission: admission(),
					transcriptPath,
				});
				expect(decision).toMatchObject({
					disposition: "handoff",
					reason: "terminal_transcript_missing_or_invalid",
				});
			}
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("never resumes aborted, errored, unknown, or malformed terminal results", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-loss-"));
		try {
			const transcriptPath = await setup(cwd);
			for (const status of ["aborted", "error", "unknown", "completed", ""] as const) {
				await fs.writeFile(
					transcriptPath,
					`{"id":"one","parentId":null,"type":"message"}\n{"id":"two","parentId":"one","type":"yield","result":{"status":"${status}"}}\n{"id":"three","parentId":"two","type":"toolResult","toolCallId":"two","content":[]}\n`,
				);
				expect(
					await planUltragoalOwnerLossRecovery({
						binding: { ...binding, cwd },
						receipt: receipt(),
						admission: admission(),
						transcriptPath,
					}),
				).toMatchObject({ disposition: "handoff", reason: "terminal_aborted_errored" });
			}
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects reserved-artifact collisions and symlink traversal before snapshot or recovery authority", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-loss-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-loss-outside-"));
		try {
			await setup(cwd);
			expect(
				await captureUltragoalRecoverySnapshot({
					cwd,
					sessionId,
					protectedPaths: ["goals.json"],
					sanctionedDeltas: ["goals.json"],
					absentArtifacts: [],
					transientHistory: [],
				}),
			).toBeNull();
			const linked = path.join(cwd, "escaped.jsonl");
			await fs.symlink(path.join(outside, "outside.jsonl"), linked);
			await fs.writeFile(path.join(outside, "outside.jsonl"), "outside\n");
			expect(await validateRecoveryPath(cwd, linked)).toBeNull();
			expect(
				parseStrictTerminalTranscript(
					'{"id":"one","parentId":null,"type":"yield","result":{"status":"aborted"}}\n',
				),
			).toBeNull();
			expect(
				parseStrictTerminalTranscript(
					'{"id":"y1","parentId":null,"type":"yield","result":{"status":"success"}}\n{"id":"r1","parentId":"y1","type":"toolResult","toolCallId":"y1","content":[]}\n{"id":"y2","parentId":"r1","type":"yield","result":{"status":"success"}}\n{"id":"r2","parentId":"y2","type":"toolResult","toolCallId":"y2","content":[]}\n',
				),
			).toBeNull();
			const decision = await planUltragoalOwnerLossRecovery({
				binding: { ...binding, cwd },
				receipt: receipt(),
				admission: admission(),
				transcriptPath: linked,
			});
			expect(decision).toMatchObject({ disposition: "handoff", reason: "transcript_path_untrusted" });
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("persists a recovery decision idempotently and validates strict receipt/admission boundaries", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-loss-"));
		try {
			const stableBinding = { ...binding, cwd };
			expect(validateOwnerLossBinding(stableBinding, receipt())).toBe(true);
			expect(validateOwnerLossBinding(stableBinding, receipt({ generation: "old" }))).toBe(false);
			expect(validateRecoveryAdmission(stableBinding, admission())).toBe(true);
			expect(validateRecoveryAdmission(stableBinding, admission({ admitted: false }))).toBe(false);
			const decision = { disposition: "handoff" as const, reason: "terminal_transcript_missing_or_invalid" };
			const [first] = await Promise.all([
				persistUltragoalRecoveryDecision({ cwd, sessionId, binding: stableBinding, decision }),
				persistUltragoalRecoveryDecision({ cwd, sessionId, binding: stableBinding, decision }),
			]);
			const journal = await fs.readFile(first.journalPath, "utf8");
			expect(journal.trim().split("\n")).toHaveLength(1);
			expect(JSON.parse(await fs.readFile(first.handoffPath, "utf8"))).toMatchObject({
				disposition: "handoff",
				reason: decision.reason,
			});
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
