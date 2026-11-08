/**
 * Validate the exact current ralplan final that an execution approval may target.
 *
 * The Ultragoal ask guard blocks every `ask` while a goal is incomplete or
 * review-blocked, which is correct for ordinary questions but also deadlocks the
 * one question that can legitimately unblock the work: the execution approval for
 * an already-reviewed ralplan final (issue #6578). Granting that route needs proof
 * that the final being approved is the current one and that its reviewers really
 * passed it — never a caller-declared tag.
 *
 * The proof is reconstructed from what ralplan already persists:
 *
 *   - `<session plans>/ralplan/<run-id>/index.jsonl` rows `{stage, stage_n, path, sha256}`
 *   - the artifact files those rows name, re-hashed here
 *   - the run state (`<session state>/ralplan-state.json`) for run id and phase
 *   - the resolved `autoHandoff` target, which must be `off`
 *
 * Anything missing, stale, rewritten, out of order, or outside this session's run
 * directory is a typed refusal. This module only reads and hashes; it never
 * mutates state and never grants anything by itself.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { resolveRalplanAutoHandoff } from "./ralplan-runtime";
import { modeStatePath, sessionPlansDir } from "./session-layout";

/** Stages that open a consensus iteration; a final is only valid after one. */
const ITERATION_OPENER_STAGES: ReadonlySet<string> = new Set(["planner", "revision"]);

/** Reviewer stages whose verdicts must join the same iteration as the final. */
const REVIEW_LANE_STAGES: readonly string[] = ["architect", "critic"];

export interface RalplanIndexRow {
	stage: string;
	stageN: number;
	path: string;
	sha256: string;
}

export interface RalplanCurrentFinalDescriptor {
	/** Run id the final belongs to. */
	runId: string;
	/** Absolute path of the final artifact. */
	finalPath: string;
	/** sha256 recorded for the final and re-verified against its bytes. */
	finalSha256: string;
	/** sha256 of the iteration-opening planner (or revision) artifact. */
	plannerSha256: string;
	/** Reviewer verdict hashes that joined this iteration. */
	reviewerSha256: Record<string, string>;
	/** Session that owns the run; a foreign session can never be granted. */
	sessionId: string;
}

export type RalplanCurrentFinalRefusalCode =
	| "missing_state"
	| "run_not_final"
	| "auto_handoff_enabled"
	| "missing_index"
	| "malformed_index"
	| "no_iteration_opener"
	| "final_not_last"
	| "missing_reviewers"
	| "artifact_missing"
	| "artifact_outside_run"
	| "hash_mismatch";

export interface RalplanCurrentFinalRefusal {
	code: RalplanCurrentFinalRefusalCode;
	/** Human-readable reason suitable for a guard error message. */
	reason: string;
}

export type RalplanCurrentFinalResolution =
	| { ok: true; descriptor: RalplanCurrentFinalDescriptor }
	| { ok: false; refusal: RalplanCurrentFinalRefusal };

export interface RalplanCurrentFinalInput {
	cwd: string;
	/** Caller session id; the run must belong to it. */
	sessionId: string;
	/** Optional agent dir for settings resolution. */
	agentDir?: string;
}

/**
 * Whether the pending `ask` payload selects the ralplan execution-approval gate.
 *
 * This is a selector, not authority: it only decides which validation runs. The
 * descriptor it leads to is the proof.
 */
export function selectsRalplanApprovalGate(pendingQuestions: unknown): boolean {
	const questions = (pendingQuestions as { questions?: unknown } | undefined)?.questions;
	if (!Array.isArray(questions)) return false;
	return questions.some(question => {
		if (!question || typeof question !== "object" || Array.isArray(question)) return false;
		const gate = (question as { workflowGate?: unknown }).workflowGate;
		if (!gate || typeof gate !== "object" || Array.isArray(gate)) return false;
		const record = gate as { stage?: unknown; kind?: unknown };
		return record.stage === "ralplan" && record.kind === "approval";
	});
}

function refusal(code: RalplanCurrentFinalRefusalCode, reason: string): RalplanCurrentFinalRefusal {
	return { code, reason };
}

function parseIndexRow(line: string): RalplanIndexRow | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	const { stage, path: artifactPath, sha256 } = record;
	const stageN = record.stage_n;
	if (typeof stage !== "string" || !stage.trim()) return undefined;
	if (typeof stageN !== "number" || !Number.isInteger(stageN) || stageN <= 0) return undefined;
	if (typeof artifactPath !== "string" || !artifactPath.trim()) return undefined;
	if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) return undefined;
	return { stage: stage.trim(), stageN, path: artifactPath.trim(), sha256: sha256.toLowerCase() };
}

async function readRunState(statePath: string): Promise<{ runId: string; phase: string } | RalplanCurrentFinalRefusal> {
	let text: string;
	try {
		text = await fs.readFile(statePath, "utf-8");
	} catch (error) {
		if (isEnoent(error)) return refusal("missing_state", `no ralplan run state at ${statePath}`);
		return refusal("missing_state", `failed to read ralplan run state at ${statePath}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return refusal("malformed_index", `ralplan run state at ${statePath} is not valid JSON`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return refusal("malformed_index", `ralplan run state at ${statePath} is not an object`);
	}
	const record = parsed as Record<string, unknown>;
	const runId = typeof record.run_id === "string" ? record.run_id.trim() : "";
	const phase = typeof record.current_phase === "string" ? record.current_phase.trim().toLowerCase() : "";
	if (!runId) return refusal("malformed_index", `ralplan run state at ${statePath} has no run_id`);
	return { runId, phase };
}

/**
 * Resolve and verify the current ralplan final for `sessionId`.
 *
 * Fails closed: every check returns a refusal instead of degrading to a weaker
 * proof, because the caller uses a success to lift the Ultragoal ask guard.
 */
export async function resolveRalplanCurrentFinal(
	input: RalplanCurrentFinalInput,
): Promise<RalplanCurrentFinalResolution> {
	const sessionId = input.sessionId.trim();
	if (!sessionId) return { ok: false, refusal: refusal("missing_state", "no caller session id") };

	const state = await readRunState(modeStatePath(input.cwd, sessionId, "ralplan"));
	if (!("runId" in state)) return { ok: false, refusal: state };
	if (state.phase !== "final" && state.phase !== "handoff") {
		return {
			ok: false,
			refusal: refusal("run_not_final", `ralplan run ${state.runId} is in phase "${state.phase}", not final`),
		};
	}

	// A final that would hand off automatically is not waiting for approval.
	const autoHandoff = await resolveRalplanAutoHandoff(input.cwd, { agentDir: input.agentDir });
	if (autoHandoff.effectiveTarget !== "off") {
		return {
			ok: false,
			refusal: refusal(
				"auto_handoff_enabled",
				`ralplan autoHandoff is "${autoHandoff.effectiveTarget}"; a current final is only approvable while handoff is off`,
			),
		};
	}

	const runDir = path.join(sessionPlansDir(input.cwd, sessionId), "ralplan", state.runId);
	const indexPath = path.join(runDir, "index.jsonl");
	let indexText: string;
	try {
		indexText = await fs.readFile(indexPath, "utf-8");
	} catch (error) {
		if (isEnoent(error)) return { ok: false, refusal: refusal("missing_index", `no ralplan index at ${indexPath}`) };
		return { ok: false, refusal: refusal("missing_index", `failed to read ralplan index at ${indexPath}`) };
	}

	const rows: RalplanIndexRow[] = [];
	for (const line of indexText.split("\n")) {
		if (!line.trim()) continue;
		const row = parseIndexRow(line);
		if (!row) {
			return { ok: false, refusal: refusal("malformed_index", `malformed ralplan index row in ${indexPath}`) };
		}
		rows.push(row);
	}
	if (rows.length === 0)
		return { ok: false, refusal: refusal("missing_index", `ralplan index ${indexPath} is empty`) };

	// The current final is the last row in (stageN, index) order, which equals the
	// last row in file order because index.jsonl is append-only within a run and
	// stageN never decreases across passes. Within one pass all rows share the same
	// stageN, so file position is the only tie-breaker there.
	const finalIndex = rows.length - 1;
	const finalRow = rows[finalIndex];
	if (finalRow.stage !== "final") {
		return {
			ok: false,
			refusal: refusal("final_not_last", `the newest ralplan stage is "${finalRow.stage}", not "final"`),
		};
	}
	// Reject if any row has a stageN strictly greater than the final's, which
	// would mean a newer consensus pass started after this final was recorded.
	for (const row of rows) {
		if (row.stageN > finalRow.stageN) {
			return {
				ok: false,
				refusal: refusal(
					"final_not_last",
					`the ralplan index has a stage newer than the final (stage_n ${row.stageN})`,
				),
			};
		}
	}

	// The opener is the latest planner/revision row that appears before the final
	// in file order (identical stageN rows are resolved by position).
	let openerIndex = -1;
	for (let i = finalIndex - 1; i >= 0; i--) {
		if (ITERATION_OPENER_STAGES.has(rows[i].stage)) {
			openerIndex = i;
			break;
		}
	}
	if (openerIndex === -1) {
		return {
			ok: false,
			refusal: refusal("no_iteration_opener", "the final has no planner or revision stage before it"),
		};
	}
	const opener = rows[openerIndex];

	const reviewers: Record<string, string> = {};
	for (const lane of REVIEW_LANE_STAGES) {
		// The reviewer row must appear after the opener and before the final in file order.
		let laneRow: RalplanIndexRow | undefined;
		for (let i = openerIndex + 1; i < finalIndex; i++) {
			if (rows[i].stage === lane) laneRow = rows[i];
		}
		if (!laneRow) {
			return {
				ok: false,
				refusal: refusal(
					"missing_reviewers",
					`no ${lane} verdict between the ${opener.stage} stage and the final; the final is not reviewed`,
				),
			};
		}
		reviewers[lane] = laneRow.sha256;
	}

	// Hash every referenced artifact and require it to live inside this run.
	for (const row of rows) {
		const resolved = path.resolve(row.path);
		const relative = path.relative(runDir, resolved);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			return {
				ok: false,
				refusal: refusal("artifact_outside_run", `ralplan stage artifact ${row.path} is outside ${runDir}`),
			};
		}
		let bytes: Buffer;
		try {
			bytes = await Bun.file(resolved)
				.arrayBuffer()
				.then(buffer => Buffer.from(buffer));
		} catch (error) {
			if (isEnoent(error)) {
				return { ok: false, refusal: refusal("artifact_missing", `ralplan stage artifact ${row.path} is missing`) };
			}
			return { ok: false, refusal: refusal("artifact_missing", `cannot read ralplan stage artifact ${row.path}`) };
		}
		const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		if (actual !== row.sha256) {
			return {
				ok: false,
				refusal: refusal(
					"hash_mismatch",
					`ralplan stage artifact ${path.basename(row.path)} does not match its recorded hash`,
				),
			};
		}
	}

	return {
		ok: true,
		descriptor: {
			runId: state.runId,
			finalPath: path.resolve(finalRow.path),
			finalSha256: finalRow.sha256,
			plannerSha256: opener.sha256,
			reviewerSha256: reviewers,
			sessionId,
		},
	};
}
