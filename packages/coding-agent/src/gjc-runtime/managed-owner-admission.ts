import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as natives from "@gajae-code/natives";
// Its signal handlers must precede the cooperative-shutdown cause recorders.
import "@gajae-code/utils/postmortem";
import { canonicalEnvKey, type ProjectEnvSnapshot, projectEnvSnapshot } from "@gajae-code/utils/env-file";
import {
	isManagedOwnerBinding,
	isManagedOwnerSigabrtReceipt,
	type ManagedOwnerRecoverableBinding,
	type ManagedOwnerSigabrtReceipt,
} from "./managed-owner-binding";
import { assertSafePathComponent } from "./session-layout";
import { trustedCoordinatorEnv } from "./sidecar-bootstrap-env";
import {
	installManagedOwnerCooperativeShutdown,
	lifecyclePaths,
	parseExactOwnerJson,
	readSecureOwnerJson,
} from "./tmux-owner-isolation";
import {
	persistUltragoalRecoveryDecision,
	planUltragoalOwnerLossRecovery,
	type UltragoalRecoveryDecision,
} from "./ultragoal-owner-loss-recovery";

const MANAGED_OWNER_CHILD_TOKEN_ENV = "GJC_MANAGED_OWNER_CHILD_TOKEN";
const MANAGED_OWNER_GENERATION_ENV = "GJC_TMUX_OWNER_GENERATION";
const MANAGED_OWNER_INCARNATION_ENV = "GJC_MANAGED_OWNER_INCARNATION";
const MANAGED_OWNER_RUN_ID_ENV = "GJC_MANAGED_OWNER_RUN_ID";
const MANAGED_OWNER_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";
const MANAGED_OWNER_STATE_DIR_ENV = "GJC_TMUX_OWNER_STATE_DIR";
export const MANAGED_OWNER_PREDECESSOR_TOKEN_ENV = "GJC_MANAGED_OWNER_PREDECESSOR_TOKEN";
export const MANAGED_OWNER_PREDECESSOR_GENERATION_ENV = "GJC_MANAGED_OWNER_PREDECESSOR_GENERATION";
export const MANAGED_OWNER_PREDECESSOR_RUN_ID_ENV = "GJC_MANAGED_OWNER_PREDECESSOR_RUN_ID";
export const MANAGED_OWNER_PREDECESSOR_INCARNATION_ENV = "GJC_MANAGED_OWNER_PREDECESSOR_INCARNATION";
export const MANAGED_OWNER_TRANSCRIPT_PATH_ENV = "GJC_MANAGED_OWNER_TRANSCRIPT_PATH";
const MANAGED_OWNER_SESSION_FILE_ENV = "GJC_SESSION_FILE";

/**
 * Operator environment only. A project dotenv value, including a dynamic
 * declaration, must not choose the recovery transcript. A static
 * `GJC_SESSION_FILE` declaration is the same source: the launcher copies it
 * into the transcript variable. The operator bytes are kept, including
 * surrounding whitespace; provenance is not path normalization.
 */
function operatorOwnedEnvValue(name: string, raw: string | undefined, snapshot: ProjectEnvSnapshot): string {
	if (!raw) return "";
	const key = canonicalEnvKey(name);
	const declared = snapshot.values[key];
	if (declared !== undefined && (snapshot.dynamic.has(key) || declared === raw)) return "";
	const verdict = trustedCoordinatorEnv(name, { [name]: raw }, snapshot);
	if (verdict === undefined && raw.trim().length > 0) return "";
	return raw;
}

export function trustedManagedOwnerTranscriptPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
	const snapshot = projectEnvSnapshot(cwd);
	const raw = operatorOwnedEnvValue(
		MANAGED_OWNER_TRANSCRIPT_PATH_ENV,
		env[MANAGED_OWNER_TRANSCRIPT_PATH_ENV],
		snapshot,
	);
	if (!raw) return "";
	const sessionKey = canonicalEnvKey(MANAGED_OWNER_SESSION_FILE_ENV);
	if (snapshot.dynamic.has(sessionKey)) return raw;
	const declared = snapshot.values[sessionKey];
	if (declared !== undefined && raw === declared) return "";
	return raw;
}

/** Session file forwarded to a replacement child. Same provenance rule. */
export function trustedManagedOwnerLaunchSessionFile(env: NodeJS.ProcessEnv, cwd: string): string {
	return operatorOwnedEnvValue(
		MANAGED_OWNER_SESSION_FILE_ENV,
		env[MANAGED_OWNER_SESSION_FILE_ENV],
		projectEnvSnapshot(cwd),
	);
}
const predecessorKeys = [
	MANAGED_OWNER_PREDECESSOR_TOKEN_ENV,
	MANAGED_OWNER_PREDECESSOR_GENERATION_ENV,
	MANAGED_OWNER_PREDECESSOR_RUN_ID_ENV,
	MANAGED_OWNER_PREDECESSOR_INCARNATION_ENV,
];

export interface ManagedOwnerRecoveryContext {
	root: string;
	binding: ManagedOwnerRecoverableBinding;
	receipt: ManagedOwnerSigabrtReceipt;
	admission: { session_id: string; endpoint_incarnation: string; owner_generation: string; admitted: true };
	decision: UltragoalRecoveryDecision;
}
export type ManagedOwnerAdmission =
	| { kind: "fresh" | "supervised" }
	| { kind: "recovery"; context: ManagedOwnerRecoveryContext }
	| { kind: "blocked" };
interface OwnerEnvironment {
	stateDir: string;
	root: string;
	generation: string;
	sessionId: string;
	runId: string;
	incarnation: string;
}
function ownerEnvironment(): OwnerEnvironment | null {
	const managedKeys = [
		MANAGED_OWNER_STATE_DIR_ENV,
		MANAGED_OWNER_GENERATION_ENV,
		MANAGED_OWNER_RUN_ID_ENV,
		MANAGED_OWNER_INCARNATION_ENV,
		MANAGED_OWNER_CHILD_TOKEN_ENV,
		...predecessorKeys,
	];
	if (!managedKeys.some(key => process.env[key] !== undefined)) return null;
	const stateDir = process.env[MANAGED_OWNER_STATE_DIR_ENV]?.trim();
	const sessionId = process.env[MANAGED_OWNER_SESSION_ID_ENV]?.trim();
	const generation = process.env[MANAGED_OWNER_GENERATION_ENV]?.trim();
	const runId = process.env[MANAGED_OWNER_RUN_ID_ENV]?.trim();
	const incarnation = process.env[MANAGED_OWNER_INCARNATION_ENV]?.trim();
	if (!stateDir || !sessionId || !generation || !runId || !incarnation || !path.isAbsolute(stateDir))
		throw new Error("managed_owner_admission_metadata_invalid");
	for (const [value, label] of [
		[sessionId, "session id"],
		[generation, "generation"],
		[runId, "run id"],
		[incarnation, "incarnation"],
	] as const)
		assertSafePathComponent(value, label);
	if (stateDir.includes("\0") || stateDir.split(path.sep).includes(".."))
		throw new Error("managed_owner_admission_path_unsafe");
	const root = lifecyclePaths(stateDir, sessionId, generation).root;
	if (!root.startsWith(`${path.resolve(stateDir)}${path.sep}`)) throw new Error("managed_owner_admission_path_unsafe");
	return { stateDir, root, generation, sessionId, runId, incarnation };
}
function safeChildToken(value: string): boolean {
	try {
		assertSafePathComponent(value, "managed owner child token");
		return true;
	} catch {
		return false;
	}
}
function readCurrentChildBinding(root: string, token: string): unknown {
	try {
		return readSecureOwnerJson(path.join(root, `child-${token}.binding.json`));
	} catch {
		return null;
	}
}
type ExactJsonRead = { values: unknown[] } | { reader: "unsupported_platform" | "read_failed" };
/** Recovery authority remains Linux-only and separate from ordinary child admission. */
async function readLinuxRecoveryJsons(root: string, files: readonly string[]): Promise<ExactJsonRead> {
	if (process.platform !== "linux") return { reader: "unsupported_platform" };
	try {
		const authority = natives.openRecoveryFsRoot(root);
		try {
			const values: unknown[] = [];
			for (const file of files) {
				const result = authority.read(file, 65536);
				if (!result.ok || !result.data) return { reader: "read_failed" };
				values.push(parseExactOwnerJson(result.data, "managed_owner_json_framing_invalid"));
			}
			return { values };
		} finally {
			authority.close();
		}
	} catch {
		return { reader: "read_failed" };
	}
}

function exactJsonValues(read: ExactJsonRead): unknown[] {
	return "values" in read ? read.values : [];
}

function exactReaderDetails(read: ExactJsonRead): Record<string, unknown> {
	return "values" in read ? {} : { platform: process.platform, evidence_reader: read.reader };
}

function readerExplanation(details: Record<string, unknown>): string {
	switch (details.evidence_reader) {
		case "unsupported_platform":
			return ` (platform ${process.platform}: exact binding reader unsupported)`;
		case "read_failed":
			return ` (platform ${process.platform}: exact binding evidence unreadable)`;
		default:
			return "";
	}
}
function handoffNotPersisted(): void {
	process.exitCode = 75;
	try {
		process.stderr.write("managed_owner_admission_blocked: handoff_not_persisted\n");
	} catch {}
}
/** Never acquire a pathname writer after rejected storage. Only retained, private authority may publish. */
async function durableHandoff(
	root: string,
	generation: string,
	sessionId: string,
	reason: string,
	details: Record<string, unknown> = {},
): Promise<void> {
	process.exitCode = 75;
	try {
		if (process.platform !== "linux") throw new Error("handoff_not_persisted");
		const authority = natives.openRecoveryFsRoot(root);
		try {
			if (!authority.verifyOwnerOnlyDirectory().ok) throw new Error("handoff_not_persisted");
			const file = `admission-handoff-${crypto.randomUUID()}.json`;
			const bytes = Buffer.from(
				`${JSON.stringify({
					schema_version: 2,
					generation,
					session_id: sessionId,
					state: "fail_closed_handoff",
					reason,
					...details,
					created_at: new Date().toISOString(),
				})}\n`,
			);
			if (bytes.length > 4096 || !authority.create(file, bytes).ok || !authority.fsync().ok)
				throw new Error("handoff_not_persisted");
			const persisted = authority.read(file, 4096);
			if (!persisted.ok || !persisted.data || !bytes.equals(Buffer.from(persisted.data)))
				throw new Error("handoff_not_persisted");
		} finally {
			authority.close();
		}
	} catch {
		handoffNotPersisted();
	}
}
async function deny(
	owner: OwnerEnvironment,
	reason: string,
	details: Record<string, unknown> = {},
): Promise<ManagedOwnerAdmission> {
	process.exitCode = 75;
	await durableHandoff(owner.root, owner.generation, owner.sessionId, reason, details);
	process.stderr.write(`child admission blocked: ${reason}${readerExplanation(details)}\n`);
	return { kind: "blocked" };
}
/** Pre-CLI barrier: environment only selects exact evidence; it never grants admission. */
export async function admitManagedOwnerBeforeCli(): Promise<ManagedOwnerAdmission> {
	try {
		return await admitManagedOwner();
	} catch {
		handoffNotPersisted();
		return { kind: "blocked" };
	}
}
async function admitManagedOwner(): Promise<ManagedOwnerAdmission> {
	const owner = ownerEnvironment();
	if (!owner) return { kind: "fresh" };
	const childToken = process.env[MANAGED_OWNER_CHILD_TOKEN_ENV]?.trim();
	const predecessorToken = process.env[MANAGED_OWNER_PREDECESSOR_TOKEN_ENV]?.trim();
	if (childToken && !predecessorKeys.some(key => process.env[key] !== undefined)) {
		if (typeof natives.readOwnerOnlyFile !== "function") {
			handoffNotPersisted();
			return { kind: "blocked" };
		}
		if (!safeChildToken(childToken)) return deny(owner, "exact_child_binding_unavailable");
		const binding = readCurrentChildBinding(owner.root, childToken);
		if (isManagedOwnerBinding(binding, { ...owner, token: childToken })) {
			// Darwin: before the CLI, so the supervisor's cooperative relay can never
			// meet the signal's default action. Without readiness it never relays, and
			// a cooperative close then fails closed.
			installManagedOwnerCooperativeShutdown({
				stateDir: owner.stateDir,
				sessionId: owner.sessionId,
				generation: owner.generation,
				childToken,
			});
			return { kind: "supervised" };
		}
		return deny(owner, "exact_child_binding_unavailable");
	}
	const predecessorGeneration = process.env[MANAGED_OWNER_PREDECESSOR_GENERATION_ENV]?.trim();
	const predecessorRunId = process.env[MANAGED_OWNER_PREDECESSOR_RUN_ID_ENV]?.trim();
	const predecessorIncarnation = process.env[MANAGED_OWNER_PREDECESSOR_INCARNATION_ENV]?.trim();
	if (!predecessorGeneration || !predecessorRunId || !predecessorIncarnation)
		return deny(owner, "replacement_predecessor_identity_missing");
	if (!predecessorToken) return deny(owner, "replacement_predecessor_binding_missing");
	if (!safeChildToken(predecessorToken)) return deny(owner, "replacement_predecessor_binding_untrusted");
	const read = await readLinuxRecoveryJsons(owner.root, [
		`child-${predecessorToken}.binding.json`,
		`sigabrt-${predecessorToken}.receipt.json`,
	]);
	const [binding, receipt] = exactJsonValues(read);
	if (
		!isManagedOwnerBinding(binding, {
			generation: predecessorGeneration,
			sessionId: owner.sessionId,
			runId: predecessorRunId,
			incarnation: predecessorIncarnation,
			token: predecessorToken,
		}) ||
		binding.binding_kind !== "recoverable"
	)
		return deny(owner, "replacement_predecessor_binding_untrusted", exactReaderDetails(read));
	if (!isManagedOwnerSigabrtReceipt(receipt, binding))
		return deny(owner, "exact_sigabrt_receipt_untrusted", exactReaderDetails(read));
	const admission = {
		session_id: owner.sessionId,
		endpoint_incarnation: predecessorIncarnation,
		owner_generation: predecessorGeneration,
		admitted: true,
	} as const;
	const recoveryBinding = {
		sessionId: owner.sessionId,
		endpointIncarnation: predecessorIncarnation,
		ownerGeneration: predecessorGeneration,
		cwd: process.cwd(),
	};
	const decision = await planUltragoalOwnerLossRecovery({
		binding: recoveryBinding,
		receipt,
		admission,
		transcriptPath: trustedManagedOwnerTranscriptPath(),
	});
	await persistUltragoalRecoveryDecision({
		cwd: process.cwd(),
		sessionId: owner.sessionId,
		binding: recoveryBinding,
		decision,
	});
	if (decision.disposition !== "resume") return deny(owner, decision.reason);
	return { kind: "recovery", context: { root: owner.root, binding, receipt, admission, decision } };
}
/** The ordinary CLI does not own the recovery writer lease or exact-child reconciliation seam. */
export async function completeManagedOwnerRecovery(
	context: ManagedOwnerRecoveryContext,
): Promise<{ kind: "handoff"; exitCode: 75 }> {
	process.exitCode = 75;
	try {
		const recoveryBinding = {
			sessionId: context.binding.session_id,
			endpointIncarnation: context.binding.endpoint_incarnation,
			ownerGeneration: context.binding.generation,
			cwd: process.cwd(),
		};
		const revalidated = await planUltragoalOwnerLossRecovery({
			binding: recoveryBinding,
			receipt: context.receipt,
			admission: context.admission,
			transcriptPath: trustedManagedOwnerTranscriptPath(),
			protectedPaths: context.decision.snapshot?.protectedPaths,
			sanctionedDeltas: context.decision.snapshot?.sanctionedDeltas,
			absentArtifacts: context.decision.snapshot?.absentArtifacts,
			transientHistory: context.decision.snapshot?.transientHistory,
		});
		const b0Unchanged =
			context.decision.snapshot !== undefined &&
			revalidated.snapshot !== undefined &&
			context.decision.snapshot.b0.planSha256 === revalidated.snapshot.b0.planSha256 &&
			context.decision.snapshot.b0.ledgerSha256 === revalidated.snapshot.b0.ledgerSha256;
		const transcriptUnchanged =
			context.decision.terminal?.yieldId !== undefined &&
			revalidated.terminal?.yieldId === context.decision.terminal.yieldId;
		const reason =
			revalidated.disposition !== "resume"
				? `recovery_authority_changed:${revalidated.reason}`
				: !b0Unchanged
					? "recovery_b0_changed"
					: !transcriptUnchanged
						? "recovery_transcript_changed"
						: "safe_session_resume_seam_unavailable";
		const decision: UltragoalRecoveryDecision = { disposition: "handoff", reason };
		await persistUltragoalRecoveryDecision({
			cwd: recoveryBinding.cwd,
			sessionId: recoveryBinding.sessionId,
			binding: recoveryBinding,
			decision,
		});
		await durableHandoff(context.root, context.binding.generation, context.binding.session_id, reason, {
			predecessor_child_token: context.binding.child_token,
			predecessor_run_id: context.binding.run_id,
			terminal_reconciliation: "unavailable_without_owning_store_cas",
			b0_preserved: b0Unchanged,
		});
	} catch {
		handoffNotPersisted();
	}
	return { kind: "handoff", exitCode: 75 };
}
