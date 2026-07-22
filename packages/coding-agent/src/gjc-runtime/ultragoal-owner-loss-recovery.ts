import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openRecoveryFsRoot } from "@gajae-code/natives";
import type { ManagedOwnerSigabrtReceipt } from "./managed-owner-supervisor";
import { sessionStateDir, sessionUltragoalDir } from "./session-layout";
import { appendJsonlIdempotent, writeJsonAtomic } from "./state-writer";

/** Immutable identity supplied by the owner-loss monitor and coordinator admission. */
export interface UltragoalRecoveryBinding {
	sessionId: string;
	endpointIncarnation: string;
	ownerGeneration: string;
	cwd: string;
}

export interface UltragoalOwnerLossReceipt {
	schema_version: 1;
	session_id: string;
	generation: string;
	classification: "unexpected_owner_loss";
	result: "signal" | "exit" | "unknown_terminal";
	observed_at: string;
}

export type AuthoritativeOwnerLossReceipt = UltragoalOwnerLossReceipt | ManagedOwnerSigabrtReceipt;

export interface UltragoalRecoverySnapshot {
	/** B0 is captured once before recovery writes. P is protected and never rewritten. */
	b0: { planSha256: string; ledgerSha256: string; capturedAt: string };
	protectedPaths: string[];
	/** Exact sanctioned deltas, never inferred from a worktree scan. */
	sanctionedDeltas: string[];
	/** Durable baseline-absent artifacts. */
	absentArtifacts: string[];
	/** Transient paths deliberately excluded from provenance. */
	transientHistory: string[];
}

export type UltragoalRecoveryDisposition = "resume" | "handoff";
export interface UltragoalRecoveryDecision {
	disposition: UltragoalRecoveryDisposition;
	reason: string;
	snapshot?: UltragoalRecoverySnapshot;
	terminal?: { yieldId: string; result: Record<string, unknown> };
}

interface TranscriptYield {
	type: "yield";
	id: string;
	parentId: string | null;
	result: Record<string, unknown>;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactChild(
	entry: Record<string, unknown>,
	parentId: string | null,
): entry is Record<string, unknown> & { id: string } {
	return entry.parentId === parentId && nonEmpty(entry.id);
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function safeRelativePath(root: string, candidate: string): string | null {
	const relative = path.relative(root, candidate);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
	return relative;
}

async function bytesOrAbsent(filePath: string): Promise<Uint8Array | null> {
	try {
		return await fs.readFile(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/**
 * Parse the complete transcript; partial rows, alternate terminal spellings, and
 * duplicate/conflicting yields are intentionally invalid authority.
 */
export function parseStrictTerminalTranscript(content: string): TranscriptYield | null {
	if (!content?.endsWith("\n")) return null;
	const entries: Array<Record<string, unknown> & { id: string }> = [];
	let parentId: string | null = null;
	for (const line of content.slice(0, -1).split("\n")) {
		if (!line) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return null;
		}
		if (!isRecord(parsed) || !nonEmpty(parsed.type) || !exactChild(parsed, parentId)) return null;
		if (
			parsed.type !== "yield" &&
			parsed.type !== "toolResult" &&
			parsed.type !== "tool_call" &&
			parsed.type !== "message" &&
			parsed.type !== "mode_change"
		)
			return null;
		entries.push(parsed);
		parentId = parsed.id;
	}
	if (entries.length < 2) return null;
	if (entries.filter(entry => entry.type === "yield").length !== 1) return null;
	const yieldEntry = entries[entries.length - 2]!;
	const resultEntry = entries[entries.length - 1]!;
	if (yieldEntry.type !== "yield" || !isRecord(yieldEntry.result) || resultEntry.type !== "toolResult") return null;
	if (resultEntry.toolCallId !== yieldEntry.id || !Array.isArray(resultEntry.content)) return null;
	return {
		type: "yield",
		id: yieldEntry.id,
		parentId: yieldEntry.parentId as string | null,
		result: yieldEntry.result,
	};
}

/** Read through a retained root descriptor; pathname resolution never authorizes recovery input. */
async function readRecoveryFile(root: string, candidate: string): Promise<string | null> {
	if (process.platform !== "linux") return null;
	const relative = safeRelativePath(path.resolve(root), path.resolve(candidate));
	if (!relative) return null;
	try {
		const authority = openRecoveryFsRoot(root);
		try {
			const result = authority.read(relative, 4 * 1024 * 1024);
			return result.ok && result.data ? new TextDecoder().decode(result.data) : null;
		} finally {
			authority.close();
		}
	} catch {
		return null;
	}
}

/** Validate a path through a retained native root descriptor; path strings alone are never authority. */
export async function validateRecoveryPath(root: string, candidate: string): Promise<string | null> {
	return (await readRecoveryFile(root, candidate)) === null ? null : candidate;
}

export function validateOwnerLossBinding(
	binding: UltragoalRecoveryBinding,
	receipt: unknown,
): receipt is AuthoritativeOwnerLossReceipt {
	if (!isRecord(receipt) || receipt.session_id !== binding.sessionId || receipt.generation !== binding.ownerGeneration)
		return false;
	if (receipt.schema_version === 2)
		return (
			receipt.signal === "SIGABRT" &&
			receipt.signal_number === 6 &&
			nonEmpty(receipt.run_id) &&
			receipt.endpoint_incarnation === binding.endpointIncarnation &&
			nonEmpty(receipt.child_token) &&
			nonEmpty(receipt.command_sha256) &&
			typeof receipt.supervisor_pid === "number" &&
			Number.isSafeInteger(receipt.supervisor_pid) &&
			receipt.supervisor_pid > 0 &&
			typeof receipt.child_pid === "number" &&
			Number.isSafeInteger(receipt.child_pid) &&
			receipt.child_pid > 0 &&
			nonEmpty(receipt.supervisor_start_time) &&
			nonEmpty(receipt.child_start_time) &&
			(receipt.exit_code === null || Number.isSafeInteger(receipt.exit_code)) &&
			nonEmpty(receipt.received_at) &&
			Number.isFinite(Date.parse(receipt.received_at))
		);
	return false;
}

/** Admission is valid only for this immutable coordinator endpoint incarnation. */
export function validateRecoveryAdmission(binding: UltragoalRecoveryBinding, admission: unknown): boolean {
	if (!isRecord(admission)) return false;
	return (
		admission.session_id === binding.sessionId &&
		admission.endpoint_incarnation === binding.endpointIncarnation &&
		admission.owner_generation === binding.ownerGeneration &&
		admission.admitted === true
	);
}

/** Raw plan and ledger evidence must be complete before their B0 hashes are trusted. */
export function validateRawUltragoalEvidence(plan: Uint8Array, ledger: Uint8Array): boolean {
	try {
		const parsedPlan: unknown = JSON.parse(new TextDecoder().decode(plan));
		if (!isRecord(parsedPlan) || !Array.isArray(parsedPlan.goals)) return false;
		const content = new TextDecoder().decode(ledger);
		if (!content.endsWith("\n")) return false;
		for (const line of content.slice(0, -1).split("\n")) {
			if (!line || !isRecord(JSON.parse(line))) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Build a B0 snapshot without consulting unrelated paths or mutable sidecars. */
export async function captureUltragoalRecoverySnapshot(input: {
	cwd: string;
	sessionId: string;
	protectedPaths: readonly string[];
	sanctionedDeltas: readonly string[];
	absentArtifacts: readonly string[];
	transientHistory: readonly string[];
}): Promise<UltragoalRecoverySnapshot | null> {
	const root = sessionUltragoalDir(input.cwd, input.sessionId);
	const [plan, ledger] = await Promise.all([
		bytesOrAbsent(path.join(root, "goals.json")),
		bytesOrAbsent(path.join(root, "ledger.jsonl")),
	]);
	if (!plan || !ledger || !validateRawUltragoalEvidence(plan, ledger)) return null;
	const allPaths = [
		...input.protectedPaths,
		...input.sanctionedDeltas,
		...input.absentArtifacts,
		...input.transientHistory,
	];
	if (allPaths.some(value => !nonEmpty(value) || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")))
		return null;
	const sets = [input.protectedPaths, input.sanctionedDeltas, input.absentArtifacts, input.transientHistory].map(
		values => new Set(values),
	);
	if (
		sets.some((set, index) =>
			sets.some((other, otherIndex) => otherIndex > index && [...set].some(value => other.has(value))),
		)
	)
		return null;
	return {
		b0: { planSha256: digest(plan), ledgerSha256: digest(ledger), capturedAt: new Date().toISOString() },
		protectedPaths: [...input.protectedPaths],
		sanctionedDeltas: [...input.sanctionedDeltas],
		absentArtifacts: [...input.absentArtifacts],
		transientHistory: [...input.transientHistory],
	};
}

/**
 * Decide only from direct owner evidence plus a complete terminal transcript.
 * All ambiguity maps to durable handoff; callers never guess a resume.
 */
export async function planUltragoalOwnerLossRecovery(input: {
	binding: UltragoalRecoveryBinding;
	receipt: unknown;
	admission: unknown;

	transcriptPath: string;
	protectedPaths?: readonly string[];
	sanctionedDeltas?: readonly string[];
	absentArtifacts?: readonly string[];
	transientHistory?: readonly string[];
}): Promise<UltragoalRecoveryDecision> {
	if (!validateOwnerLossBinding(input.binding, input.receipt))
		return { disposition: "handoff", reason: "owner_receipt_untrusted" };
	const content = await readRecoveryFile(input.binding.cwd, input.transcriptPath);
	if (!validateRecoveryAdmission(input.binding, input.admission))
		return { disposition: "handoff", reason: "coordinator_admission_untrusted" };
	if (content === null) return { disposition: "handoff", reason: "transcript_path_untrusted" };
	const terminal = parseStrictTerminalTranscript(content);
	if (!terminal) return { disposition: "handoff", reason: "terminal_transcript_missing_or_invalid" };
	if (terminal.result.status !== "success") return { disposition: "handoff", reason: "terminal_aborted_errored" };
	const snapshot = await captureUltragoalRecoverySnapshot({
		cwd: input.binding.cwd,
		sessionId: input.binding.sessionId,
		protectedPaths: input.protectedPaths ?? ["goals.json", "ledger.jsonl"],
		sanctionedDeltas: input.sanctionedDeltas ?? [],
		absentArtifacts: input.absentArtifacts ?? [],
		transientHistory: input.transientHistory ?? [],
	});
	if (!snapshot) return { disposition: "handoff", reason: "baseline_or_path_invariant_failed" };
	return {
		disposition: "resume",
		reason: "terminal_transcript_authoritative",
		snapshot,
		terminal: { yieldId: terminal.id, result: terminal.result },
	};
}

/** Persist a monotonic replay journal and fail-closed handoff through sanctioned state writers. */
export async function persistUltragoalRecoveryDecision(input: {
	cwd: string;
	sessionId: string;
	binding: UltragoalRecoveryBinding;
	decision: UltragoalRecoveryDecision;
}): Promise<{ handoffPath: string; journalPath: string }> {
	const stateDir = sessionStateDir(input.cwd, input.sessionId);
	const handoffPath = path.join(stateDir, "ultragoal-owner-loss-recovery.json");
	const journalPath = path.join(stateDir, "ultragoal-owner-loss-recovery.jsonl");
	const record = {
		schema_version: 1,
		binding: input.binding,
		disposition: input.decision.disposition,
		reason: input.decision.reason,
		snapshot: input.decision.snapshot ?? null,
		terminal: input.decision.terminal ?? null,
		created_at: new Date().toISOString(),
	};
	await writeJsonAtomic(handoffPath, record, {
		cwd: input.cwd,
		audit: { category: "state", verb: "write", owner: "gjc-runtime", sessionId: input.sessionId },
	});
	await appendJsonlIdempotent(
		journalPath,
		{ ...record, event: "owner_loss_recovery_decision" },
		{
			cwd: input.cwd,
			audit: { category: "state", verb: "write", owner: "gjc-runtime", sessionId: input.sessionId },
			key: entry => {
				if (!isRecord(entry) || entry.event !== "owner_loss_recovery_decision") return undefined;
				return `${entry.binding === undefined ? "" : JSON.stringify(entry.binding)}:${String(entry.disposition)}:${String(entry.reason)}`;
			},
		},
	);
	return { handoffPath, journalPath };
}
