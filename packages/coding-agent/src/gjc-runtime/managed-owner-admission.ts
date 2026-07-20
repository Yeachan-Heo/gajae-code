import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openRecoveryFsRoot } from "@gajae-code/natives";
import {
	MANAGED_OWNER_CHILD_TOKEN_ENV,
	MANAGED_OWNER_GENERATION_ENV,
	MANAGED_OWNER_INCARNATION_ENV,
	MANAGED_OWNER_RUN_ID_ENV,
	MANAGED_OWNER_SESSION_ID_ENV,
	MANAGED_OWNER_STATE_DIR_ENV,
	type ManagedOwnerBinding,
	type ManagedOwnerSigabrtReceipt,
} from "./managed-owner-supervisor";
import { assertSafePathComponent } from "./session-layout";
import { lifecyclePaths } from "./tmux-owner-isolation";
import {
	persistUltragoalRecoveryDecision,
	planUltragoalOwnerLossRecovery,
	type UltragoalRecoveryDecision,
} from "./ultragoal-owner-loss-recovery";

export const MANAGED_OWNER_PREDECESSOR_TOKEN_ENV = "GJC_MANAGED_OWNER_PREDECESSOR_TOKEN";
export const MANAGED_OWNER_PREDECESSOR_GENERATION_ENV = "GJC_MANAGED_OWNER_PREDECESSOR_GENERATION";
export const MANAGED_OWNER_PREDECESSOR_RUN_ID_ENV = "GJC_MANAGED_OWNER_PREDECESSOR_RUN_ID";
export const MANAGED_OWNER_PREDECESSOR_INCARNATION_ENV = "GJC_MANAGED_OWNER_PREDECESSOR_INCARNATION";
export const MANAGED_OWNER_TRANSCRIPT_PATH_ENV = "GJC_MANAGED_OWNER_TRANSCRIPT_PATH";

export interface ManagedOwnerRecoveryContext {
	root: string;
	binding: ManagedOwnerBinding;
	receipt: ManagedOwnerSigabrtReceipt;
	admission: { session_id: string; endpoint_incarnation: string; owner_generation: string; admitted: true };
	decision: UltragoalRecoveryDecision;
}
export type ManagedOwnerAdmission =
	| { kind: "fresh" | "supervised" }
	| { kind: "recovery"; context: ManagedOwnerRecoveryContext }
	| { kind: "blocked" };

function ownerEnvironment(): {
	root: string;
	generation: string;
	sessionId: string;
	runId: string;
	incarnation: string;
} | null {
	const stateDir = process.env[MANAGED_OWNER_STATE_DIR_ENV]?.trim();
	const sessionId = process.env[MANAGED_OWNER_SESSION_ID_ENV]?.trim();
	const generation = process.env[MANAGED_OWNER_GENERATION_ENV]?.trim();
	const runId = process.env[MANAGED_OWNER_RUN_ID_ENV]?.trim();
	const incarnation = process.env[MANAGED_OWNER_INCARNATION_ENV]?.trim();
	if (!stateDir && !sessionId && !generation && !runId && !incarnation) return null;
	if (!stateDir || !sessionId || !generation || !runId || !incarnation || !path.isAbsolute(stateDir))
		throw new Error("managed_owner_admission_metadata_invalid");
	for (const [value, label] of [
		[sessionId, "managed owner session id"],
		[generation, "managed owner generation"],
		[runId, "managed owner run id"],
		[incarnation, "managed owner incarnation"],
	] as const)
		assertSafePathComponent(value, label);
	const root = lifecyclePaths(stateDir, sessionId, generation).root;
	if (!root.startsWith(`${path.resolve(stateDir)}${path.sep}`)) throw new Error("managed_owner_admission_path_unsafe");
	return { root, generation, sessionId, runId, incarnation };
}

function isCommand(command: unknown): command is string[] {
	return (
		Array.isArray(command) &&
		command.length > 0 &&
		command.every(value => typeof value === "string" && value.length > 0)
	);
}

function isBinding(
	value: unknown,
	expected: { generation: string; sessionId: string; runId: string; incarnation: string; token: string },
): value is ManagedOwnerBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const binding = value as Partial<ManagedOwnerBinding>;
	return (
		binding.schema_version === 2 &&
		binding.generation === expected.generation &&
		binding.session_id === expected.sessionId &&
		binding.run_id === expected.runId &&
		binding.endpoint_incarnation === expected.incarnation &&
		binding.child_token === expected.token &&
		isCommand(binding.command) &&
		typeof binding.command_sha256 === "string" &&
		binding.command_sha256 === crypto.createHash("sha256").update(JSON.stringify(binding.command)).digest("hex") &&
		typeof binding.supervisor_pid === "number" &&
		Number.isSafeInteger(binding.supervisor_pid) &&
		binding.supervisor_pid > 0 &&
		typeof binding.supervisor_start_time === "string" &&
		typeof binding.created_at === "string"
	);
}

function isReceipt(value: unknown, binding: ManagedOwnerBinding): value is ManagedOwnerSigabrtReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const receipt = value as Partial<ManagedOwnerSigabrtReceipt>;
	return (
		receipt.schema_version === 2 &&
		receipt.generation === binding.generation &&
		receipt.session_id === binding.session_id &&
		receipt.run_id === binding.run_id &&
		receipt.endpoint_incarnation === binding.endpoint_incarnation &&
		receipt.child_token === binding.child_token &&
		receipt.command_sha256 === binding.command_sha256 &&
		receipt.supervisor_pid === binding.supervisor_pid &&
		receipt.supervisor_start_time === binding.supervisor_start_time &&
		typeof receipt.child_pid === "number" &&
		Number.isSafeInteger(receipt.child_pid) &&
		receipt.child_pid > 0 &&
		typeof receipt.child_start_time === "string" &&
		receipt.signal === "SIGABRT" &&
		receipt.signal_number === 6 &&
		(receipt.exit_code === null || Number.isSafeInteger(receipt.exit_code)) &&
		typeof receipt.received_at === "string"
	);
}

function safeChildToken(value: string): boolean {
	try {
		assertSafePathComponent(value, "managed owner child token");
		return true;
	} catch {
		return false;
	}
}

async function readExactJsons(root: string, files: readonly string[]): Promise<unknown[] | null> {
	if (process.platform !== "linux") return null;
	try {
		const authority = openRecoveryFsRoot(root);
		try {
			const values: unknown[] = [];
			for (const file of files) {
				const result = authority.read(file, 64 * 1024);
				if (!result.ok || !result.data) return null;
				const content = Buffer.from(result.data).toString("utf8");
				if (!content.endsWith("\n") || content.indexOf("\n") !== content.length - 1) return null;
				values.push(JSON.parse(content));
			}
			return values;
		} finally {
			authority.close();
		}
	} catch {
		return null;
	}
}

async function durableHandoff(
	root: string,
	generation: string,
	sessionId: string,
	reason: string,
	details: Record<string, unknown> = {},
): Promise<void> {
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const file = path.join(root, `admission-handoff-${crypto.randomUUID()}.json`);
	const record = {
		schema_version: 2,
		generation,
		session_id: sessionId,
		state: "fail_closed_handoff",
		reason,
		...details,
		created_at: new Date().toISOString(),
	};
	const handle = await fs.open(file, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(record)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	const directory = await fs.open(root, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/**
 * This is the pre-CLI barrier. A replacement is identified only by the exact
 * predecessor token supplied by its launch binding; directory enumeration is
 * deliberately never an authority source.
 */
export async function admitManagedOwnerBeforeCli(): Promise<ManagedOwnerAdmission> {
	const owner = ownerEnvironment();
	if (!owner) return { kind: "fresh" };
	const childToken = process.env[MANAGED_OWNER_CHILD_TOKEN_ENV]?.trim();
	const predecessorToken = process.env[MANAGED_OWNER_PREDECESSOR_TOKEN_ENV]?.trim();
	if (childToken && !predecessorToken) {
		if (!safeChildToken(childToken)) {
			await durableHandoff(owner.root, owner.generation, owner.sessionId, "exact_child_binding_unavailable");
			process.exitCode = 75;
			return { kind: "blocked" };
		}
		const [binding] = (await readExactJsons(owner.root, [`child-${childToken}.binding.json`])) ?? [];
		if (
			isBinding(binding, {
				generation: owner.generation,
				sessionId: owner.sessionId,
				runId: owner.runId,
				incarnation: owner.incarnation,
				token: childToken,
			})
		)
			return { kind: "supervised" };
		await durableHandoff(owner.root, owner.generation, owner.sessionId, "exact_child_binding_unavailable");
		process.exitCode = 75;
		return { kind: "blocked" };
	}
	const predecessorGeneration = process.env[MANAGED_OWNER_PREDECESSOR_GENERATION_ENV]?.trim();
	const predecessorRunId = process.env[MANAGED_OWNER_PREDECESSOR_RUN_ID_ENV]?.trim();
	const predecessorIncarnation = process.env[MANAGED_OWNER_PREDECESSOR_INCARNATION_ENV]?.trim();
	if (!predecessorGeneration || !predecessorRunId || !predecessorIncarnation) {
		await durableHandoff(owner.root, owner.generation, owner.sessionId, "replacement_predecessor_identity_missing");
		process.exitCode = 75;
		return { kind: "blocked" };
	}
	if (!predecessorToken) {
		await durableHandoff(owner.root, owner.generation, owner.sessionId, "replacement_predecessor_binding_missing");
		process.exitCode = 75;
		return { kind: "blocked" };
	}
	if (!safeChildToken(predecessorToken)) {
		await durableHandoff(owner.root, owner.generation, owner.sessionId, "replacement_predecessor_binding_untrusted");
		process.exitCode = 75;
		return { kind: "blocked" };
	}
	const [binding, receipt] =
		(await readExactJsons(owner.root, [
			`child-${predecessorToken}.binding.json`,
			`sigabrt-${predecessorToken}.receipt.json`,
		])) ?? [];
	if (
		!isBinding(binding, {
			generation: predecessorGeneration,
			sessionId: owner.sessionId,
			runId: predecessorRunId,
			incarnation: predecessorIncarnation,
			token: predecessorToken,
		})
	) {
		await durableHandoff(owner.root, owner.generation, owner.sessionId, "replacement_predecessor_binding_untrusted");
		process.exitCode = 75;
		return { kind: "blocked" };
	}
	if (!isReceipt(receipt, binding)) {
		await durableHandoff(owner.root, owner.generation, owner.sessionId, "exact_sigabrt_receipt_untrusted");
		process.exitCode = 75;
		return { kind: "blocked" };
	}
	const admission = {
		session_id: owner.sessionId,
		endpoint_incarnation: predecessorIncarnation,
		owner_generation: predecessorGeneration,
		admitted: true,
	} as const;
	const decision = await planUltragoalOwnerLossRecovery({
		binding: {
			sessionId: owner.sessionId,
			endpointIncarnation: predecessorIncarnation,
			ownerGeneration: predecessorGeneration,
			cwd: process.cwd(),
		},
		receipt,
		admission,
		transcriptPath: process.env[MANAGED_OWNER_TRANSCRIPT_PATH_ENV] ?? "",
	});
	await persistUltragoalRecoveryDecision({
		cwd: process.cwd(),
		sessionId: owner.sessionId,
		binding: {
			sessionId: owner.sessionId,
			endpointIncarnation: predecessorIncarnation,
			ownerGeneration: predecessorGeneration,
			cwd: process.cwd(),
		},
		decision,
	});
	if (decision.disposition !== "resume") {
		await durableHandoff(owner.root, owner.generation, owner.sessionId, decision.reason);
		process.exitCode = 75;
		return { kind: "blocked" };
	}
	return { kind: "recovery", context: { root: owner.root, binding, receipt, admission, decision } };
}

/**
 * The ordinary CLI factory has no recovery-owned writer-lease or exact-child
 * reconciliation capability.  Do not route a recovered owner through it: first
 * revalidate the immutable evidence and B0, then publish a terminal handoff.
 */
export async function completeManagedOwnerRecovery(
	context: ManagedOwnerRecoveryContext,
): Promise<{ kind: "handoff"; exitCode: 75 }> {
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
		transcriptPath: process.env[MANAGED_OWNER_TRANSCRIPT_PATH_ENV] ?? "",
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
	process.exitCode = 75;
	return { kind: "handoff", exitCode: 75 };
}
