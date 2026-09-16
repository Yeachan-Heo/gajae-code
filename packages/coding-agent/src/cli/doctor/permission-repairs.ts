import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	inspectConfigFilePermissionRepair,
	type NativeExactFileIdentity,
	type NativePermissionRepairResult,
	repairConfigFilePermissions,
} from "@gajae-code/natives";
import { DoctorJournal, DoctorJournalCreateError } from "./journal";
import type { DoctorCheck, DoctorRepair, DoctorScope } from "./types";

export interface DoctorPermissionRepairRequest {
	readonly filePath: string;
	readonly rootPath: string;
	readonly scope: DoctorScope;
	readonly targetId: string;
	readonly repairId: string;
	readonly runId: string;
	readonly mode: "dry-run" | "fix";
	readonly authorization?: readonly string[];
	readonly journalRoot: string;
	readonly expected: { readonly identity: NativeExactFileIdentity; readonly mode: number };
	readonly collectAfterChecks: () => Promise<readonly DoctorCheck[]>;
}
export interface DoctorPermissionRepairResult {
	readonly repair: DoctorRepair;
	readonly native: NativePermissionRepairResult;
	readonly journalPath?: string;
	readonly afterChecks?: readonly DoctorCheck[];
}
function base(r: DoctorPermissionRepairRequest, state: DoctorRepair["state"]): DoctorRepair {
	return {
		id: r.repairId,
		targetId: r.targetId,
		riskClasses: ["permission-change"],
		authorization: r.authorization ?? [],
		readiness: [],
		candidates: [],
		preconditions: ["native exact identity", "owner-preserving mode reduction", "ACL absence"],
		state,
		sideEffectStarted: false,
		beforeCheckIds: [],
		afterCheckIds: [],
		restartRequired: false,
		nonrollbackableEffects: [],
	};
}
function refused(code: string): NativePermissionRepairResult {
	return { status: "refused", changed: false, verified: false, code };
}
function failureCode(error: unknown): string {
	return error instanceof Error ? error.name : "repair_failed";
}
function sameIdentity(
	stat: BigIntStats,
	parent: BigIntStats,
	identity: NativeExactFileIdentity,
	mode: number,
): boolean {
	return (
		stat.isFile() &&
		!stat.isSymbolicLink() &&
		stat.dev === identity.dev &&
		stat.ino === identity.ino &&
		stat.nlink === (identity.nlink ?? 1n) &&
		stat.size === identity.size &&
		stat.mtimeNs === identity.mtimeNs &&
		parent.dev === identity.parentDev &&
		parent.ino === identity.parentIno &&
		Number(stat.mode) === mode
	);
}
async function collectVerifiedChecks(request: DoctorPermissionRepairRequest): Promise<readonly DoctorCheck[]> {
	const checks = await request.collectAfterChecks();
	const desiredMode = request.expected.mode & 0o700;
	if (
		!checks.some(
			check =>
				check.targetId === request.targetId &&
				check.execution === "completed" &&
				check.evidenceLevel === "observed" &&
				check.evidence.mode === desiredMode &&
				check.evidence.ownerMatches === true,
		)
	)
		throw new Error("permission_postcheck_failed");
	const security = inspectConfigFilePermissionRepair(
		request.filePath,
		request.expected.identity,
		request.expected.mode & ~0o077,
	);
	if (security.status !== "verified" || !security.verified) throw new Error("permission_security_postcheck_failed");
	return checks.map(check =>
		check.targetId === request.targetId
			? { ...check, evidence: { ...check.evidence, aclCoverage: "verified" as const } }
			: check,
	);
}
export async function applyDoctorPermissionRepair(
	r: DoctorPermissionRepairRequest,
): Promise<DoctorPermissionRepairResult> {
	const preparing = base(r, "preparing");
	if (!r.authorization?.includes("permission-change"))
		return {
			repair: { ...preparing, state: "blocked", reasonCode: "authorization_missing" },
			native: refused("authorization_missing"),
		};
	if (
		r.scope !== "user" ||
		r.repairId !== "permissions.restrict-owned-config" ||
		typeof r.collectAfterChecks !== "function"
	)
		return {
			repair: { ...preparing, state: "blocked", reasonCode: "invalid_permission_request" },
			native: refused("invalid_permission_request"),
		};
	const absolute = path.resolve(r.filePath);
	const root = path.resolve(r.rootPath);
	if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))
		return {
			repair: { ...preparing, state: "blocked", reasonCode: "target_resolution_incomplete" },
			native: refused("root_escape"),
		};
	if (r.mode === "dry-run") return { repair: { ...preparing, state: "planned" }, native: refused("preview_only") };
	let stat: BigIntStats;
	try {
		stat = (await fs.lstat(absolute, { bigint: true })) as BigIntStats;
		const parent = (await fs.lstat(path.dirname(absolute), { bigint: true })) as BigIntStats;
		if (!sameIdentity(stat, parent, r.expected.identity, r.expected.mode))
			return {
				repair: { ...preparing, state: "blocked", reasonCode: "identity_recheck_required" },
				native: refused("identity_recheck_required"),
			};
	} catch (error) {
		return {
			repair: { ...preparing, state: "blocked", reasonCode: failureCode(error) },
			native: refused("preflight_failed"),
		};
	}
	let native: NativePermissionRepairResult;
	try {
		native = inspectConfigFilePermissionRepair(absolute, r.expected.identity, r.expected.mode);
		if (native.status === "verified" && !native.changed) {
			const afterChecks = await collectVerifiedChecks(r);
			return {
				repair: { ...preparing, state: "not_needed", outcome: { mutationVerified: true } },
				native,
				afterChecks,
			};
		}
		if (native.status !== "ready")
			return {
				repair: { ...preparing, state: "blocked", reasonCode: native.code ?? "permission_preflight_failed" },
				native,
			};
	} catch {
		return {
			repair: { ...preparing, state: "blocked", reasonCode: "permission_preflight_failed" },
			native: refused("permission_preflight_failed"),
		};
	}
	let journal: DoctorJournal;
	try {
		journal = await DoctorJournal.create(r.journalRoot, r.runId);
	} catch (error) {
		const started = error instanceof DoctorJournalCreateError ? error.sideEffectStarted : true;
		return {
			repair: {
				...preparing,
				state: started ? "uncertain" : "failed",
				sideEffectStarted: started,
				reasonCode: failureCode(error),
			},
			native: refused("journal_create_failed"),
		};
	}
	try {
		await journal.append({
			repairId: r.repairId,
			targetId: r.targetId,
			phase: "before",
			before: { mode: r.expected.mode },
		});
		await journal.append({ repairId: r.repairId, targetId: r.targetId, phase: "applying" });
		const result = repairConfigFilePermissions(absolute, r.expected.identity, r.expected.mode);
		if (result.status === "uncertain" || result.status === "refused") {
			await journal.append({
				repairId: r.repairId,
				targetId: r.targetId,
				phase: "failed",
				outcome: result.code ?? result.status,
			});
			return {
				repair: {
					...preparing,
					state: result.status === "uncertain" ? "uncertain" : "failed",
					sideEffectStarted: true,
					reasonCode: result.code ?? result.status,
				},
				native: result,
				journalPath: journal.path,
			};
		}
		if (!result.verified) throw new Error("permission_mutation_unverified");
		const afterChecks = await collectVerifiedChecks(r);
		await journal.append({
			repairId: r.repairId,
			targetId: r.targetId,
			phase: "verified",
			after: { mode: r.expected.mode & ~0o077 },
			outcome: "verified",
		});
		return {
			repair: {
				...preparing,
				state: result.changed ? "verified" : "not_needed",
				sideEffectStarted: true,
				outcome: { mutationVerified: result.verified },
			},
			native: result,
			journalPath: journal.path,
			afterChecks,
		};
	} catch (error) {
		try {
			await journal.append({
				repairId: r.repairId,
				targetId: r.targetId,
				phase: "failed",
				outcome: failureCode(error),
			});
		} catch {}
		return {
			repair: { ...preparing, state: "uncertain", sideEffectStarted: true, reasonCode: failureCode(error) },
			native: refused(failureCode(error)),
			journalPath: journal.path,
		};
	} finally {
		journal.close();
	}
}
