import * as path from "node:path";
import type { NativeExactFileIdentity } from "@gajae-code/natives";
import { YAML } from "bun";
import { applyAtomicYamlPatchesWithCurrent, atomicYamlPathHash, type CasReceipt } from "../../config/atomic-yaml-patch";
import {
	type RestoreMCPBooleanResult,
	readMCPConfigFile,
	restoreMCPBooleanExact,
	updateMCPBooleanExact,
} from "../../runtime-mcp/config-writer";
import { readMcpBooleanField } from "../../runtime-mcp/policy-json-edit";
import { computeAutoloadStatus } from "../../runtime-mcp/startup-policy";
import { type DoctorFileObservation, readDoctorFile } from "./files";
import { DoctorJournal, DoctorJournalCreateError } from "./journal";
import { authorizePosixConfigPermission } from "./safety";
import type { DoctorCheck, DoctorRepair, DoctorScope } from "./types";

export interface DoctorConfigRepairRequest {
	readonly filePath: string;
	readonly rootPath: string;
	readonly scope: DoctorScope;
	readonly targetId: string;
	readonly repairId: string;
	readonly runId: string;
	readonly mode: "dry-run" | "fix";
	readonly authorization?: readonly string[];
	readonly journalRoot: string;
	readonly expected: {
		readonly raw: string;
		readonly observedValue?: unknown;
		readonly identity: NativeExactFileIdentity;
	};
	readonly kind: "skill" | "mcp";
	readonly schemaKey?: "skills.enabled" | "skills.enableSkillCommands";
	readonly serverName?: string;
	readonly field?: "autoload" | "enabled";
	readonly value: boolean;
	readonly collectAfterChecks: (input: {
		readonly filePath: string;
		readonly kind: "skill" | "mcp";
		readonly value: boolean;
	}) => Promise<readonly DoctorCheck[]>;
}

export interface DoctorConfigRepairResult {
	readonly repair: DoctorRepair;
	readonly receipt?: CasReceipt;
	readonly before?: unknown;
	readonly after?: unknown;
	readonly journalPath?: string;
	readonly afterChecks?: readonly DoctorCheck[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function getAt(root: Record<string, unknown>, dotted: string): unknown {
	let current: unknown = root;
	for (const segment of dotted.split(".")) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function sameIdentity(left: NativeExactFileIdentity, right: NativeExactFileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.parentDev === right.parentDev &&
		left.parentIno === right.parentIno &&
		left.nlink === right.nlink
	);
}

function boundedJournalValue(value: unknown): Record<string, unknown> {
	if (typeof value === "boolean") return { type: "boolean", value };
	if (value === null || value === undefined) return { type: "null" };
	return { type: Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value };
}

function repairBase(request: DoctorConfigRepairRequest, state: DoctorRepair["state"]): DoctorRepair {
	return {
		id: request.repairId,
		targetId: request.targetId,
		riskClasses: ["config-change"],
		authorization: request.authorization ?? [],
		readiness: [],
		candidates: [],
		preconditions: ["captured file and parent identity", "compare-and-swap", "independent post-read"],
		state,
		sideEffectStarted: false,
		beforeCheckIds: [],
		afterCheckIds: [],
		restartRequired: true,
		nonrollbackableEffects: [],
	};
}

function observationError(observation: DoctorFileObservation): string | undefined {
	return observation.status === "read" ? undefined : `file_${observation.status}`;
}

function selectedCheck(checks: readonly DoctorCheck[], request: DoctorConfigRepairRequest): DoctorCheck | undefined {
	const field = request.kind === "skill" ? "enabled" : request.field!;
	return checks.find(
		check =>
			check.targetId === request.targetId &&
			check.execution === "completed" &&
			check.evidenceLevel === "observed" &&
			(check.evidence as Record<string, unknown>)[field] === request.value,
	);
}

function startupBlockerCheck(request: DoctorConfigRepairRequest): DoctorCheck {
	return {
		id: `${request.targetId}:startup-blocker`,
		targetId: request.targetId,
		execution: "completed",
		health: "error",
		reasonCode: "mcp_startup_blocker",
		evidenceLevel: "observed",
		dependsOn: [],
		evidence: { schemaLocation: request.field, readiness: ["unsupported"] },
		remediationIds: [],
	};
}

export async function applyDoctorConfigRepair(request: DoctorConfigRepairRequest): Promise<DoctorConfigRepairResult> {
	const base = repairBase(request, "preparing");
	if (!request.authorization?.includes("config-change")) {
		return { repair: { ...base, state: "blocked", reasonCode: "authorization_missing" } };
	}
	if (
		typeof request.value !== "boolean" ||
		(request.kind === "skill" &&
			(request.repairId !== "config.set-validated" ||
				(request.schemaKey !== "skills.enabled" && request.schemaKey !== "skills.enableSkillCommands"))) ||
		(request.kind === "mcp" &&
			(request.repairId !== "mcp.set-startup-policy" ||
				!request.serverName ||
				(request.field !== "enabled" && request.field !== "autoload")))
	)
		return { repair: { ...base, state: "blocked", reasonCode: "invalid_config_request" } };
	if (!request.collectAfterChecks)
		return { repair: { ...base, state: "blocked", reasonCode: "after_checks_missing" } };
	const resolved = path.resolve(request.filePath);
	const root = path.resolve(request.rootPath);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		return { repair: { ...base, state: "blocked", reasonCode: "target_outside_root" } };
	}
	if (request.mode === "dry-run") return { repair: { ...base, state: "planned" } };

	let observation: DoctorFileObservation;
	try {
		observation = await readDoctorFile(request.filePath);
		if (observation.status !== "read")
			return { repair: { ...base, state: "blocked", reasonCode: observationError(observation) } };
		if (
			!sameIdentity(observation.exactIdentity, request.expected.identity) ||
			observation.text !== request.expected.raw
		) {
			return { repair: { ...base, state: "blocked", reasonCode: "identity_recheck_required" } };
		}
		const safe = await authorizePosixConfigPermission(request.filePath, request.expected.identity);
		if (!safe.safe) return { repair: { ...base, state: "blocked", reasonCode: safe.reasonCode ?? "unsafe_target" } };
	} catch (error) {
		return {
			repair: { ...base, state: "blocked", reasonCode: error instanceof Error ? error.name : "preflight_failed" },
		};
	}
	let parsed: unknown;
	let before: unknown;
	if (request.kind === "skill") {
		try {
			parsed = YAML.parse(observation.text);
		} catch {
			return { repair: { ...base, state: "blocked", reasonCode: "malformed_config" } };
		}
		if (!isRecord(parsed) || (parsed.skills !== undefined && !isRecord(parsed.skills)))
			return { repair: { ...base, state: "blocked", reasonCode: "unsupported_target_shape" } };
		before = getAt(parsed, request.schemaKey!);
	} else {
		// Lossless JSON DOM read: rejects duplicate keys along the selected
		// server/field path instead of silently resolving them (JSON.parse would
		// pick "last one wins", hiding a real authoring bug).
		const read = readMcpBooleanField(observation.text, request.serverName!, request.field!);
		if (read.status === "malformed") return { repair: { ...base, state: "blocked", reasonCode: "malformed_config" } };
		if (read.status === "duplicate_key")
			return { repair: { ...base, state: "blocked", reasonCode: `duplicate_key_${read.path}` } };
		if (read.status === "not_found")
			return { repair: { ...base, state: "blocked", reasonCode: "unsupported_target_shape" } };
		before = read.value;
	}
	if (before === request.value) {
		let afterChecks: readonly DoctorCheck[];
		try {
			afterChecks = await request.collectAfterChecks({
				filePath: request.filePath,
				kind: request.kind,
				value: request.value,
			});
		} catch {
			return { repair: { ...base, state: "blocked", reasonCode: "after_checks_failed" }, before };
		}
		if (!selectedCheck(afterChecks, request))
			return {
				repair: { ...base, state: "blocked", reasonCode: "target_after_check_missing" },
				before,
				afterChecks,
			};
		let desiredStartupStateAchieved: boolean | undefined;
		if (request.kind === "mcp") {
			const config = await readMCPConfigFile(request.filePath);
			const server = config.mcpServers?.[request.serverName!];
			if (server) {
				const status = computeAutoloadStatus(request.serverName!, server, new Set(config.disabledServers ?? []));
				desiredStartupStateAchieved = request.value ? status === "autoload" : status !== "autoload";
			}
		}
		const finalChecks =
			desiredStartupStateAchieved === false && request.kind === "mcp"
				? [...afterChecks, startupBlockerCheck(request)]
				: afterChecks;
		return {
			repair: {
				...base,
				state: "not_needed",
				reasonCode: desiredStartupStateAchieved === false ? "startup_blocker" : undefined,
				outcome: { mutationVerified: true, desiredStartupStateAchieved },
			},
			before,
			after: request.value,
			afterChecks: finalChecks,
		};
	}

	let journal: DoctorJournal;
	try {
		journal = await DoctorJournal.create(request.journalRoot, request.runId);
	} catch (error) {
		const started = error instanceof DoctorJournalCreateError ? error.sideEffectStarted : true;
		return {
			repair: {
				...base,
				state: started ? "uncertain" : "blocked",
				sideEffectStarted: started,
				reasonCode: error instanceof DoctorJournalCreateError ? error.reasonCode : "journal_unavailable",
			},
		};
	}
	let receipt: CasReceipt | undefined;
	let mcpAfterIdentity: NativeExactFileIdentity | undefined;
	let journalClosed = false;
	const closeJournal = () => {
		if (journalClosed) return;
		journal.close();
		journalClosed = true;
	};
	try {
		await journal.append({
			repairId: request.repairId,
			targetId: request.targetId,
			phase: "before",
			before: boundedJournalValue(before),
		});
		await journal.append({ repairId: request.repairId, targetId: request.targetId, phase: "applying" });
		if (request.kind === "mcp") {
			let result: Awaited<ReturnType<typeof updateMCPBooleanExact>>;
			try {
				result = await updateMCPBooleanExact(request.filePath, request.serverName!, request.field!, request.value, {
					raw: request.expected.raw,
					identity: request.expected.identity,
				});
			} catch (error) {
				// A duplicate-key/malformed/not-found shape error is detected before
				// updateMCPBooleanExact ever opens a temp file or replaces the
				// destination, so nothing was written: report it as a non-mutating
				// blocked outcome, not an uncertain rollback candidate.
				const message = error instanceof Error ? error.message : "";
				const duplicateMatch = message.match(/duplicate key at (.+)$/);
				const preWrite =
					duplicateMatch !== null || message.includes("not valid JSON") || message.includes("server not found");
				if (preWrite) {
					await journal.append({
						repairId: request.repairId,
						targetId: request.targetId,
						phase: "failed",
						outcome: "blocked_no_write",
					});
					const reasonCode = duplicateMatch
						? `duplicate_key_${duplicateMatch[1]}`
						: message.includes("not valid JSON")
							? "malformed_config"
							: "unsupported_target_shape";
					return {
						repair: { ...base, state: "blocked", sideEffectStarted: false, reasonCode },
						before,
						journalPath: journal.path,
					};
				}
				throw error;
			}
			mcpAfterIdentity = result.afterIdentity;
			if (!result.changed)
				return {
					repair: { ...base, state: "not_needed", sideEffectStarted: true },
					before: result.beforeValue,
					after: result.afterValue,
					journalPath: journal.path,
				};
		} else {
			const expectedRoot = YAML.parse(request.expected.raw);
			if (!isRecord(expectedRoot)) throw new Error("malformed YAML root");
			const expectedHash = atomicYamlPathHash(expectedRoot, request.schemaKey!);
			// The supplied root is deliberately ignored: only a bounded no-follow
			// re-read carries the exact-identity evidence this CAS is bound to.
			receipt = await applyAtomicYamlPatchesWithCurrent(request.filePath, async () => {
				const reread = await readDoctorFile(request.filePath);
				if (
					reread.status !== "read" ||
					!sameIdentity(reread.exactIdentity, request.expected.identity) ||
					reread.text !== request.expected.raw
				)
					throw new Error("config compare-and-swap conflict");
				return [
					{
						path: request.schemaKey!,
						op: "set",
						value: request.value,
						expected: { path: request.schemaKey!, hash: expectedHash },
					},
				];
			});
		}
		const afterRead = await readDoctorFile(request.filePath);
		if (afterRead.status !== "read") throw new Error("postcheck_read_failed");
		let after: unknown;
		if (request.kind === "skill") {
			const afterParsed = YAML.parse(afterRead.text);
			after = getAt(isRecord(afterParsed) ? afterParsed : {}, request.schemaKey!);
		} else {
			const afterFieldRead = readMcpBooleanField(afterRead.text, request.serverName!, request.field!);
			if (afterFieldRead.status !== "ok") throw new Error(`postcheck_${afterFieldRead.status}`);
			after = afterFieldRead.value;
		}
		if (after !== request.value) throw new Error("postcheck failed");
		let desiredStartupStateAchieved: boolean | undefined;
		if (request.kind === "mcp") {
			const config = await readMCPConfigFile(request.filePath);
			const status = computeAutoloadStatus(
				request.serverName!,
				config.mcpServers![request.serverName!]!,
				new Set(config.disabledServers ?? []),
			);
			desiredStartupStateAchieved = request.value ? status === "autoload" : status !== "autoload";
		}
		const collectedAfterChecks = await request.collectAfterChecks({
			filePath: request.filePath,
			kind: request.kind,
			value: request.value,
		});
		const afterChecks =
			desiredStartupStateAchieved === false && request.kind === "mcp"
				? [...collectedAfterChecks, startupBlockerCheck(request)]
				: collectedAfterChecks;
		if (!selectedCheck(afterChecks, request)) throw new Error("target_after_check_missing");
		await journal.append({
			repairId: request.repairId,
			targetId: request.targetId,
			phase: "verified",
			after: boundedJournalValue(after),
			outcome: desiredStartupStateAchieved === false ? "verified_with_blocker" : "verified",
		});
		try {
			closeJournal();
		} catch {
			return {
				repair: { ...base, state: "uncertain", sideEffectStarted: true, reasonCode: "journal_close_failed" },
				before,
				after,
				journalPath: journal.path,
				afterChecks,
			};
		}
		return {
			repair: {
				...base,
				state: "verified",
				sideEffectStarted: true,
				reasonCode: desiredStartupStateAchieved === false ? "startup_blocker" : undefined,
				outcome: { mutationVerified: true, desiredStartupStateAchieved },
			},
			receipt,
			before,
			after,
			journalPath: journal.path,
			afterChecks,
		};
	} catch (error) {
		if (receipt) {
			const restored = await receipt.restore().catch(() => ({ status: "not-restorable" as const }));
			const state: DoctorRepair["state"] =
				restored.status === "restored"
					? "rolled_back"
					: restored.status === "conflict"
						? "rollback_conflict"
						: "uncertain";
			try {
				await journal.append({
					repairId: request.repairId,
					targetId: request.targetId,
					phase: state === "rolled_back" ? "failed" : "uncertain",
					outcome: state,
				});
			} catch {
				return {
					repair: { ...base, state: "uncertain", sideEffectStarted: true, reasonCode: "journal_failure" },
					before,
					journalPath: journal.path,
				};
			}
			return {
				repair: {
					...base,
					state,
					sideEffectStarted: true,
					reasonCode: error instanceof Error ? error.name : "repair_failed",
				},
				before,
				journalPath: journal.path,
			};
		}
		if (mcpAfterIdentity) {
			// A thrown error here is a genuine unknown failure, distinct from the
			// typed "conflict" outcome (an independent editor already resolved the
			// field). Folding both into "conflict" would misreport an unresolved
			// rollback as already-handled, so unknown throws map to "uncertain".
			let rollback: RestoreMCPBooleanResult;
			try {
				rollback = await restoreMCPBooleanExact(
					request.filePath,
					request.serverName!,
					request.field!,
					request.expected.raw,
					{ identity: mcpAfterIdentity, currentValue: request.value },
				);
			} catch {
				rollback = { status: "failed", reason: "unknown_rollback_error" };
			}
			const state: DoctorRepair["state"] =
				rollback.status === "restored"
					? "rolled_back"
					: rollback.status === "conflict"
						? "rollback_conflict"
						: "uncertain";
			try {
				await journal.append({
					repairId: request.repairId,
					targetId: request.targetId,
					phase: state === "rolled_back" ? "failed" : "uncertain",
					outcome: state,
				});
			} catch {
				return {
					repair: { ...base, state: "uncertain", sideEffectStarted: true, reasonCode: "journal_failure" },
					before,
					journalPath: journal.path,
				};
			}
			return {
				repair: {
					...base,
					state,
					sideEffectStarted: true,
					reasonCode: error instanceof Error ? error.name : "repair_failed",
				},
				before,
				journalPath: journal.path,
			};
		}
		try {
			await journal.append({
				repairId: request.repairId,
				targetId: request.targetId,
				phase: "uncertain",
				outcome: "uncertain",
			});
		} catch {
			return {
				repair: { ...base, state: "uncertain", sideEffectStarted: true, reasonCode: "journal_failure" },
				before,
				journalPath: journal.path,
			};
		}
		return {
			repair: {
				...base,
				state: "uncertain",
				sideEffectStarted: true,
				reasonCode: error instanceof Error ? error.name : "repair_failed",
			},
			before,
			journalPath: journal.path,
		};
	} finally {
		try {
			closeJournal();
		} catch {
			// A terminal result has already been selected; preserve it while
			// ensuring the worker is not allowed to throw from finally.
		}
	}
}
