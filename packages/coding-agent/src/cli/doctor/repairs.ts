import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Settings } from "../../config/settings";
import { GJC_BUNDLE_KIND, type ReviewedRestoreTokenV1 } from "../../extensibility/gjc-plugins/types";
import {
	type MarketplaceManager,
	type MarketplaceRestoreApplyResult,
	MarketplaceRestoreError,
	type MarketplaceReviewedRestoreTokenV1,
} from "../../extensibility/plugins/marketplace/manager";
import { restartBrokerForDoctor } from "../../sdk/broker/doctor-restart";
import { restartDaemonForDoctor } from "../../sdk/bus/doctor-daemon-restart-client";
import type { DoctorAction, DoctorConfirmationResult } from "./args";
import type { DoctorConfigRepairRequest, DoctorConfigRepairResult } from "./config-repairs";
import type { DoctorContext, DoctorPluginTarget } from "./context";
import { repairStandaloneBinary } from "./install-repairs";
import { repairManagedLink } from "./managed-link";
import { applyPluginQuarantine } from "./plugin-quarantine";
import { runPluginRestoreAction } from "./plugin-restore";
import { createDoctorMarketplaceManager } from "./plugin-targets";
import { parseServiceRecord, readDoctorService, serviceArtifactObservation } from "./service-targets";
import type { DoctorCheck, DoctorRepair, DoctorRiskClass, ReadinessFactCode, RepairCandidate } from "./types";

const loadConfigRepair = () => import("./config-repairs");
const loadPermissionRepair = () => import("./permission-repairs");
const loadServiceRepair = () => import("./service-repairs");

export interface DoctorSelectedRepairResult {
	readonly repair: DoctorRepair;
	readonly invocationError?: string;
	readonly afterChecks?: readonly DoctorCheck[];
}

function risksForAction(action: DoctorAction): DoctorRiskClass[] {
	switch (action) {
		case "config.set-validated":
		case "mcp.set-startup-policy":
			return ["config-change"];
		case "permissions.restrict-owned-config":
			return ["permission-change"];
		case "install.restore-binary":
			return ["install-replace", "network", "external-execution"];
		case "install.repair-managed-link":
			return ["install-replace"];
		case "plugin.restore-known-artifact":
			// The lifecycle authorizer itself requires both; the plan must demand what it
			// enforces. The marketplace family resolves a git source and therefore needs
			// `network` too, which planSelectedDoctorRepair appends once the target is
			// known — this base set alone is not the full enforced set for that family.
			return ["plugin-change", "install-replace"];
		case "plugin.quarantine-selected":
			return ["plugin-change"];
		case "service.restart-owned":
			return ["service-interruption"];
		case "service.detach-owned-stale-artifact":
			return ["artifact-detach"];
	}
}

/** Plan data is descriptive only; no domain module, lock, journal, or candidate is materialized here. */
export function planSelectedDoctorRepair(
	context: DoctorContext,
	before: readonly DoctorCheck[],
): DoctorRepair | undefined {
	const { repair: action, targetId } = context.options;
	if (!action || !targetId) return undefined;
	const riskClasses = [...risksForAction(action)];
	const readiness: ReadinessFactCode[] = ["identity_recheck_required"];
	let reasonCode: string | undefined;
	if (
		action === "config.set-validated" ||
		action === "mcp.set-startup-policy" ||
		action === "permissions.restrict-owned-config"
	) {
		const expectedKind =
			action === "config.set-validated" ? "config" : action === "mcp.set-startup-policy" ? "mcp" : "permission";
		const target = context.targets.get(targetId);
		if (target && target.kind !== expectedKind) reasonCode = "action_target_mismatch";
		if (
			(target?.kind === "mcp" && !target.definitionIsMapping) ||
			before.some(
				check =>
					check.targetId === targetId &&
					["config_parse_error", "config_root_not_mapping", "config_skills_not_mapping"].includes(
						check.reasonCode ?? "",
					),
			)
		) {
			reasonCode = "unsupported_target_shape";
			readiness.push("unsupported");
		}
		if (target && !before.some(check => check.targetId === targetId && check.execution === "completed")) {
			reasonCode = "target_resolution_incomplete";
			readiness.push("target_resolution_incomplete");
		}
		if (!target) {
			const source = context.sources.find(item => item.root.rootId === targetId.split(":")[2]);
			const domainChecks = before.filter(
				check => check.id.startsWith(`${action.split(".")[0]}.`) && (!source || check.scope === source.scope),
			);
			const incomplete =
				source?.root.resolution !== "resolved" ||
				domainChecks.some(
					check =>
						check.execution !== "completed" ||
						check.reasonCode === "config_parse_error" ||
						check.reasonCode === "config_root_not_mapping" ||
						check.reasonCode === "mcp_servers_not_mapping",
				);
			reasonCode = incomplete ? "target_resolution_incomplete" : "unknown_target";
			if (incomplete) readiness.push("target_resolution_incomplete");
		}
	}
	if (action === "service.restart-owned" || action === "service.detach-owned-stale-artifact") {
		const target = context.targets.get(targetId);
		const kind = action === "service.restart-owned" ? "service" : "artifact";
		if (!target) {
			const serviceChecks = before.filter(check => check.id.startsWith("service."));
			const complete =
				targetId.split(":")[2] === context.agentRoot.rootId &&
				context.agentRoot.resolution === "resolved" &&
				serviceChecks.length > 0 &&
				serviceChecks.every(check => check.execution === "completed");
			reasonCode = complete ? "unknown_target" : "target_resolution_incomplete";
			if (!complete) readiness.push("target_resolution_incomplete");
		} else if (target.kind !== kind) reasonCode = "action_target_mismatch";
		else if (
			target.kind === "artifact" &&
			target.slot &&
			!serviceArtifactObservation(target.observation, target.slot)
		) {
			reasonCode = "unsupported_slot";
			readiness.push("unsupported");
		} else if (!before.some(check => check.targetId === targetId && check.execution === "completed")) {
			reasonCode = "target_resolution_incomplete";
			readiness.push("target_resolution_incomplete");
		}
	}
	if (action === "plugin.quarantine-selected" || action === "plugin.restore-known-artifact") {
		const target = context.targets.get(targetId);
		if (!target) {
			const domain = before.filter(check => check.id.startsWith("plugin."));
			const complete =
				context.sources.some(
					source => source.root.rootId === targetId.split(":")[2] && source.root.resolution === "resolved",
				) &&
				domain.length > 0 &&
				domain.every(check => check.execution === "completed" && check.reasonCode !== "plugin_registry_invalid");
			reasonCode = complete ? "unknown_target" : "target_resolution_incomplete";
			if (!complete) readiness.push("target_resolution_incomplete");
		} else if (target.kind !== "plugin") reasonCode = "action_target_mismatch";
		else if (
			action === "plugin.quarantine-selected" &&
			(!target.quarantinePlan || target.quarantinePlan.status === "blocked")
		) {
			reasonCode = target.quarantinePlan?.reason ?? "target_resolution_incomplete";
			readiness.push("target_resolution_incomplete");
		}
	}
	if (action === "install.repair-managed-link") {
		const target = context.targets.get(targetId);
		if (!target) {
			const complete = before.some(
				check => check.id.startsWith("installation.link.") && check.execution === "completed",
			);
			reasonCode = complete ? "unknown_target" : "target_resolution_incomplete";
			if (!complete) readiness.push("target_resolution_incomplete");
		} else if (target.kind !== "link") reasonCode = "action_target_mismatch";
		else if (!target.linkDescriptor?.receiptTrusted) {
			reasonCode = target.linkDescriptor?.reasonCode ?? "ownership_receipt_untrusted";
			readiness.push("unsupported");
		} else if (
			context.options.ref &&
			!target.linkDescriptor.candidates.some(candidate => candidate.id === context.options.ref)
		)
			readiness.push("candidate_unresolved");
	}
	const restoreCandidates: RepairCandidate[] = [];
	if (action === "plugin.restore-known-artifact") {
		const target = context.targets.get(targetId);
		// The marketplace lane resolves a git source, so its authorizer requires
		// `network` on top of the shared classes. Declaring it here surfaces
		// `authorization_missing` pre-effect instead of a mid-action refusal.
		if (target?.kind === "plugin" && target.family === "marketplace") riskClasses.push("network");
		if (!target) {
			const complete = before.some(check => check.id.startsWith("plugin.") && check.execution === "completed");
			reasonCode = complete ? "unknown_target" : "target_resolution_incomplete";
			if (!complete) readiness.push("target_resolution_incomplete");
		} else if (target.kind !== "plugin") reasonCode = "action_target_mismatch";
		else if (target.family === "npm") {
			// One flat shared node_modules layout cannot bound a per-plugin artifact restore.
			reasonCode = "unsupported_shared_layout";
			readiness.push("unsupported");
		} else if (!target.restoreRef) {
			reasonCode = "source_unpinnable";
			readiness.push("unsupported");
		} else if (target.restoreArtifactDigest)
			// What `sha256` names depends on the channel, and an operator pastes it
			// verbatim into `--sha256`. For "stored-source" it is the artifact-tree digest
			// of the stored source; for "catalog" it is the marketplace catalog
			// fingerprint, because the artifact being repaired cannot pin itself — there
			// the installed BYTES are bound instead by the apply path recomputing the
			// staged digest. Either way the registry's baseline fingerprint is deliberately
			// NOT used: it mixes in `source.resolvedAt`, so it changes per install and can
			// never be authorized ahead of time.
			restoreCandidates.push({
				id: target.restoreRef,
				sourceChannel: target.family === "marketplace" ? "catalog" : "stored-source",
				ref: target.restoreRef,
				sha256: target.restoreArtifactDigest,
				evidence: {
					artifactStatus:
						target.restorePlan?.artifact.status ?? target.marketplaceRestorePlan?.artifact.status ?? "absent",
					sourceClass: target.family,
				},
			});
	}
	if (action === "install.restore-binary") {
		const target = context.targets.get(targetId);
		if (!target) {
			reasonCode =
				context.installRoot.resolution === "resolved" &&
				before.some(check => check.id === "installation.current" && check.execution === "completed")
					? "unknown_target"
					: "target_resolution_incomplete";
			if (reasonCode === "target_resolution_incomplete") readiness.push("target_resolution_incomplete");
		} else if (target.kind !== "binary") reasonCode = "action_target_mismatch";
		else if (!target.installDescriptor?.owned) {
			reasonCode = "source_not_owned_standalone";
			readiness.push("unsupported");
		}
	}
	if (riskClasses.some(risk => !context.options.allowRisks.includes(risk))) readiness.push("authorization_missing");
	if (!context.options.yes && !context.options.tty) readiness.push("confirmation_required");
	if (
		(action === "install.restore-binary" || action === "plugin.restore-known-artifact") &&
		(!context.options.ref || !context.options.sha256)
	)
		readiness.push("pin_missing");
	if (action === "install.repair-managed-link" && !context.options.ref) readiness.push("candidate_selection_missing");
	return {
		id: action,
		targetId,
		riskClasses,
		authorization: [...context.options.allowRisks],
		readiness,
		candidates: restoreCandidates,
		preconditions: ["exact current target", "explicit action risk authorization", "fresh independent postcheck"],
		state: reasonCode ? "blocked" : "planned",
		reasonCode,
		sideEffectStarted: false,
		beforeCheckIds: before.filter(check => check.targetId === targetId).map(check => check.id),
		afterCheckIds: [],
		restartRequired: action === "config.set-validated" || action === "mcp.set-startup-policy",
		restartScope: action === "config.set-validated" || action === "mcp.set-startup-policy" ? "new-session" : "none",
		nonrollbackableEffects: [],
	};
}

function admitSelectedRepair(context: DoctorContext, plan: DoctorRepair): DoctorSelectedRepairResult | undefined {
	if (context.options.signal?.aborted) return { repair: { ...plan, state: "blocked", reasonCode: "cancelled" } };
	if (performance.now() >= context.deadline)
		return { repair: { ...plan, state: "blocked", reasonCode: "deadline_exceeded" } };
	try {
		context.options.onRepairAdmitted?.();
	} catch {
		return { repair: { ...plan, state: "blocked", reasonCode: "repair_admission_unavailable" } };
	}
	return undefined;
}

/**
 * Private-marketplace D6 lane. Same gate as every other action: explicit pins
 * matched against the recorded provenance, confirmation, risk authorization,
 * admission, then an independent post-check. Authorization is the first
 * effect-capable step because it resolves and stages the pinned source.
 */
async function executeMarketplaceRestore(
	context: DoctorContext,
	plan: DoctorRepair,
	target: DoctorPluginTarget,
	collectAfterChecks: () => Promise<readonly DoctorCheck[]>,
): Promise<DoctorSelectedRepairResult> {
	if (!target.restoreRef)
		return { repair: { ...plan, state: "blocked", reasonCode: "source_unpinnable", readiness: ["unsupported"] } };
	if (context.options.ref !== target.restoreRef)
		return { repair: { ...plan, state: "blocked", reasonCode: "candidate_provenance_mismatch" } };
	const original = target.marketplaceRestorePlan;
	if (!original) return { repair: { ...plan, state: "blocked", reasonCode: "original_target_missing" } };
	// The pin binds the catalog entry the operator authorized, which is defined
	// even when the artifact is absent. The candidate BYTES are bound separately
	// and more strongly: the apply path recomputes the resolved source digest
	// itself, so this gate can never be the only thing standing between an
	// operator and unintended content.
	if (
		!target.restoreArtifactDigest ||
		context.options.sha256?.toLowerCase() !== target.restoreArtifactDigest.toLowerCase()
	)
		return { repair: { ...plan, state: "blocked", reasonCode: "candidate_digest_mismatch" } };
	// `artifact.status === "present"` only means a readable tree exists; a corrupt
	// artifact is still present. The lane's own apply performs the authoritative
	// digest comparison and returns a true zero-effect `not_needed`, so no
	// short-circuit is taken here.
	if (!context.options.yes) {
		const confirmation = await confirmSelectedRepair(context, plan);
		if (confirmation !== "confirmed")
			return {
				repair: { ...plan, state: "blocked", reasonCode: confirmation, readiness: ["confirmation_required"] },
			};
	}
	const admissionFailure = admitSelectedRepair(context, plan);
	if (admissionFailure) return admissionFailure;
	// Authorization resolves the catalog and stages a candidate; `apply` is the
	// first call that can touch installed state. Anything that throws before it —
	// including plain errors from catalog reads or source resolution — is a
	// pre-effect refusal and must never be reported as an uncertain mutation.
	let manager: MarketplaceManager;
	let token: MarketplaceReviewedRestoreTokenV1;
	try {
		manager = await createDoctorMarketplaceManager(context.cwd);
		token = (await runPluginRestoreAction({
			kind: "marketplace-authorize",
			manager,
			plan: original,
			authorizations: context.options.allowRisks,
		})) as MarketplaceReviewedRestoreTokenV1;
	} catch (error) {
		return {
			repair: {
				...plan,
				state: "blocked",
				sideEffectStarted: false,
				reasonCode: error instanceof MarketplaceRestoreError ? error.reasonCode : "restore_authorization_failed",
			},
		};
	}
	try {
		// The token must still describe the exact plan the operator authorized.
		if (
			token.purpose !== "restore-artifact" ||
			token.pluginId !== target.name ||
			token.scope !== target.scope ||
			token.baselineFingerprint !== original.baselineFingerprint ||
			token.catalogFingerprint !== original.catalogFingerprint
		)
			return { repair: { ...plan, state: "blocked", reasonCode: "stale_baseline" } };
		const applied = (await runPluginRestoreAction({
			kind: "marketplace-apply",
			manager,
			token,
		})) as MarketplaceRestoreApplyResult;
		const afterChecks = await collectAfterChecks();
		const restored = afterChecks.some(
			check =>
				check.targetId === target.targetId &&
				check.execution === "completed" &&
				check.evidence.artifactStatus === "present",
		);
		const success = (applied.status === "verified" || applied.status === "not_needed") && restored;
		return {
			repair: {
				...plan,
				state: success ? (applied.status === "not_needed" ? "not_needed" : "verified") : "uncertain",
				readiness: [],
				sideEffectStarted: applied.sideEffectStarted,
				reasonCode: success ? undefined : "restore_postcheck_unverified",
				...(success ? { outcome: { mutationVerified: true } } : {}),
			},
			afterChecks,
		};
	} catch (error) {
		// The lane's typed error distinguishes a pre-effect refusal from an
		// effect-started outcome; never collapse the two.
		if (error instanceof MarketplaceRestoreError)
			return {
				repair: {
					...plan,
					state: error.sideEffectStarted
						? error.outcome === "conflict"
							? "rollback_conflict"
							: "uncertain"
						: "blocked",
					sideEffectStarted: error.sideEffectStarted,
					reasonCode: error.reasonCode,
				},
			};
		return {
			repair: { ...plan, state: "uncertain", sideEffectStarted: true, reasonCode: "repair_execution_unverified" },
		};
	} finally {
		// Authorization already copied the whole plugin tree into a temp staging dir,
		// and the lane deliberately never deletes it: that would be a write inside a
		// branch which must stay zero-effect, so disposal is the caller's contract.
		// It must happen on EVERY exit, not just the zero-effect one — a refusal
		// leaks just as much as a no-op. On the success path the directory was
		// renamed away, which `force` makes a no-op.
		await fsp.rm(token.stagedArtifactPath, { recursive: true, force: true }).catch(() => {});
	}
}

export async function executeSelectedDoctorRepair(
	context: DoctorContext,
	runId: string,
	plan: DoctorRepair,
	collectAfterChecks: () => Promise<readonly DoctorCheck[]>,
): Promise<DoctorSelectedRepairResult> {
	if (context.options.mode !== "fix") return { repair: plan };
	if (plan.state === "blocked")
		return {
			repair: plan,
			...(plan.reasonCode === "unknown_target" || plan.reasonCode === "action_target_mismatch"
				? { invocationError: plan.reasonCode }
				: {}),
		};
	if (context.options.signal?.aborted) return { repair: { ...plan, state: "blocked", reasonCode: "cancelled" } };
	if (performance.now() >= context.deadline)
		return { repair: { ...plan, state: "blocked", reasonCode: "deadline_exceeded" } };
	if (
		plan.readiness.includes("authorization_missing") ||
		plan.readiness.includes("confirmation_required") ||
		plan.readiness.includes("pin_missing") ||
		plan.readiness.includes("candidate_selection_missing")
	)
		return { repair: { ...plan, state: "blocked", reasonCode: "repair_preflight_incomplete" } };
	if (
		plan.id !== "config.set-validated" &&
		plan.id !== "mcp.set-startup-policy" &&
		plan.id !== "permissions.restrict-owned-config" &&
		plan.id !== "service.detach-owned-stale-artifact" &&
		plan.id !== "plugin.quarantine-selected" &&
		plan.id !== "install.restore-binary" &&
		plan.id !== "install.repair-managed-link" &&
		plan.id !== "service.restart-owned" &&
		plan.id !== "plugin.restore-known-artifact"
	)
		return {
			repair: { ...plan, state: "blocked", reasonCode: "repair_dispatch_unavailable", readiness: ["unsupported"] },
		};
	const target = context.targets.get(plan.targetId);
	if (!target) {
		const knownRoot = context.sources.some(source => plan.targetId.split(":")[2] === source.root.rootId);
		return {
			repair: {
				...plan,
				state: "blocked",
				reasonCode: "target_resolution_incomplete",
				readiness: ["target_resolution_incomplete"],
			},
			...(knownRoot ? { invocationError: "unknown_target" } : {}),
		};
	}
	if (plan.id === "install.repair-managed-link") {
		if (target.kind !== "link" || !target.linkDescriptor || !context.options.ref)
			return { repair: { ...plan, state: "blocked", reasonCode: "candidate_selection_missing" } };
		if (!context.options.yes) {
			const confirmation = await confirmSelectedRepair(context, plan);
			if (confirmation !== "confirmed")
				return {
					repair: { ...plan, state: "blocked", reasonCode: confirmation, readiness: ["confirmation_required"] },
				};
		}
		const admissionFailure = admitSelectedRepair(context, plan);
		if (admissionFailure) return admissionFailure;
		try {
			const descriptor = target.linkDescriptor;
			const result = await repairManagedLink(
				{
					targetPath: target.filePath,
					alias: descriptor.alias,
					root: path.resolve(path.dirname(context.cliPath ?? ""), "..", "..", ".."),
					ref: context.options.ref,
					mode: "fix",
					allowRisks: context.options.allowRisks,
					yes: true,
					journalRoot: context.agentRoot.locator,
					runId,
				},
				descriptor,
			);
			const afterChecks = await collectAfterChecks();
			const healthy = afterChecks.some(
				check =>
					check.targetId === target.targetId &&
					check.execution === "completed" &&
					check.evidence.status === "healthy",
			);
			const success = (result.state === "verified" || result.state === "not_needed") && healthy;
			const state: DoctorRepair["state"] = success
				? result.state === "not_needed"
					? "not_needed"
					: "verified"
				: result.state === "rolled_back" || result.state === "rollback_conflict"
					? result.state
					: result.sideEffectStarted
						? "uncertain"
						: "blocked";
			return {
				repair: {
					...plan,
					state,
					readiness: [],
					reasonCode: result.reasonCode ?? (success ? undefined : "managed_link_postcheck_unverified"),
					sideEffectStarted: result.sideEffectStarted,
					...(success ? { outcome: { mutationVerified: true } } : {}),
				},
				afterChecks,
			};
		} catch {
			return {
				repair: { ...plan, state: "uncertain", sideEffectStarted: true, reasonCode: "repair_execution_unverified" },
			};
		}
	}
	if (plan.id === "install.restore-binary") {
		if (target.kind !== "binary" || !target.installDescriptor || !context.options.ref || !context.options.sha256)
			return { repair: { ...plan, state: "blocked", reasonCode: "original_snapshot_incomplete" } };
		if (!context.options.yes) {
			const confirmation = await confirmSelectedRepair(context, plan);
			if (confirmation !== "confirmed")
				return {
					repair: { ...plan, state: "blocked", reasonCode: confirmation, readiness: ["confirmation_required"] },
				};
		}
		const admissionFailure = admitSelectedRepair(context, plan);
		if (admissionFailure) return admissionFailure;
		try {
			const descriptor = target.installDescriptor;
			const result = await repairStandaloneBinary(
				target.filePath,
				descriptor,
				{
					ref: context.options.ref,
					sha256: context.options.sha256,
					channel: descriptor.channel,
					version: descriptor.version,
					os: process.platform,
					arch: process.arch,
				},
				context.options.allowRisks,
			);
			const afterChecks = await collectAfterChecks();
			const checked = afterChecks.some(
				check =>
					check.targetId === target.targetId &&
					check.execution === "completed" &&
					check.evidence.integrityResult === "matches_pin",
			);
			const success = (result.state === "verified" || result.state === "not_needed") && checked;
			const state: DoctorRepair["state"] =
				result.state === "pending_activation"
					? "pending_activation"
					: success
						? result.state === "not_needed"
							? "not_needed"
							: "verified"
						: result.sideEffectStarted
							? "uncertain"
							: "blocked";
			return {
				repair: {
					...plan,
					state,
					readiness: [],
					reasonCode: result.reason ?? (success ? undefined : "installation_postcheck_unverified"),
					sideEffectStarted: result.sideEffectStarted,
					...(success ? { outcome: { mutationVerified: true } } : {}),
					restartRequired: result.state === "pending_activation",
					restartScope: result.state === "pending_activation" ? "new-session" : "none",
				},
				afterChecks,
			};
		} catch {
			return {
				repair: { ...plan, state: "uncertain", sideEffectStarted: true, reasonCode: "repair_execution_unverified" },
			};
		}
	}
	if (plan.id === "plugin.quarantine-selected") {
		if (target.kind !== "plugin" || !target.quarantinePlan)
			return { repair: { ...plan, state: "blocked", reasonCode: "target_resolution_incomplete" } };
		if (!context.options.yes) {
			const confirmation = await confirmSelectedRepair(context, plan);
			if (confirmation !== "confirmed")
				return {
					repair: { ...plan, state: "blocked", reasonCode: confirmation, readiness: ["confirmation_required"] },
				};
		}
		const admissionFailure = admitSelectedRepair(context, plan);
		if (admissionFailure) return admissionFailure;
		try {
			const result = await applyPluginQuarantine(
				{
					family: target.family,
					scope: target.scope,
					name: target.name,
					cwd: context.cwd,
					home: os.homedir(),
					rootId: target.root.rootId,
					registryPath: target.registryPath,
					journalRoot: context.agentRoot.locator,
					runId,
				},
				context.options.allowRisks,
				target.quarantinePlan,
			);
			const afterChecks = await collectAfterChecks();
			const verified =
				result.targetExcludedFromStartup === true &&
				afterChecks.some(
					check =>
						check.targetId === target.targetId &&
						check.execution === "completed" &&
						check.evidence.enabled === false,
				);
			const success = (result.status === "verified" || result.status === "not_needed") && verified;
			const state: DoctorRepair["state"] = success
				? result.status === "not_needed"
					? "not_needed"
					: "verified"
				: result.sideEffectStarted
					? "uncertain"
					: "blocked";
			const reasonCode =
				result.reason && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(result.reason)
					? result.reason
					: success
						? undefined
						: "plugin_quarantine_unverified";
			return {
				repair: {
					...plan,
					state,
					readiness: [],
					reasonCode,
					sideEffectStarted: result.sideEffectStarted,
					...(success ? { outcome: { mutationVerified: true } } : {}),
				},
				afterChecks,
			};
		} catch {
			return {
				repair: { ...plan, state: "uncertain", sideEffectStarted: true, reasonCode: "repair_execution_unverified" },
			};
		}
	}
	if (plan.id === "plugin.restore-known-artifact" && target.kind === "plugin" && target.family === "marketplace") {
		return await executeMarketplaceRestore(context, plan, target, collectAfterChecks);
	}
	if (plan.id === "plugin.restore-known-artifact") {
		if (target.kind !== "plugin")
			return { repair: { ...plan, state: "blocked" }, invocationError: "action_target_mismatch" };
		// npm plugins share one flat node_modules layout, so a per-plugin artifact
		// restore cannot be bounded to the selected target. That is the plan's own
		// distinct refusal, not a general family gap.
		if (target.family === "npm")
			return {
				repair: { ...plan, state: "blocked", reasonCode: "unsupported_shared_layout", readiness: ["unsupported"] },
			};
		if (!target.restoreRef)
			return { repair: { ...plan, state: "blocked", reasonCode: "source_unpinnable", readiness: ["unsupported"] } };
		if (context.options.ref !== target.restoreRef)
			return { repair: { ...plan, state: "blocked", reasonCode: "candidate_provenance_mismatch" } };
		const original = target.restorePlan;
		if (!original) return { repair: { ...plan, state: "blocked", reasonCode: "original_target_missing" } };
		// The digest pin binds the exact artifact bytes the operator authorized.
		if (
			!target.restoreArtifactDigest ||
			context.options.sha256?.toLowerCase() !== target.restoreArtifactDigest.toLowerCase()
		)
			return { repair: { ...plan, state: "blocked", reasonCode: "candidate_digest_mismatch" } };
		if (original.artifact.status === "present")
			return { repair: { ...plan, state: "not_needed", reasonCode: "plugin_artifact_present" } };
		if (!context.options.yes) {
			const confirmation = await confirmSelectedRepair(context, plan);
			if (confirmation !== "confirmed")
				return {
					repair: { ...plan, state: "blocked", reasonCode: confirmation, readiness: ["confirmation_required"] },
				};
		}
		const admissionFailure = admitSelectedRepair(context, plan);
		if (admissionFailure) return admissionFailure;
		const identity = { kind: GJC_BUNDLE_KIND, scope: target.scope, name: target.name } as const;
		try {
			// Authorization resolves the stored source; it is the first effect-capable step.
			const authorized = await runPluginRestoreAction({
				kind: "authorize",
				target: { identity, cwd: context.cwd },
				plan: original,
				authorizations: context.options.allowRisks,
			});
			if (!("ok" in authorized) || !authorized.ok || !("value" in authorized))
				return {
					repair: {
						...plan,
						state: "blocked",
						reasonCode:
							"ok" in authorized && !authorized.ok ? authorized.error.code : "restore_authorization_refused",
					},
				};
			const token = authorized.value as ReviewedRestoreTokenV1;
			if (
				token.purpose !== "restore-artifact" ||
				token.identity.name !== target.name ||
				token.identity.scope !== target.scope ||
				token.baselineFingerprint !== original.baselineFingerprint ||
				token.decisionContextFingerprint !== original.decisionContextFingerprint
			)
				return { repair: { ...plan, state: "blocked", reasonCode: "stale_baseline" } };
			const applied = await runPluginRestoreAction({ kind: "apply", target: { identity, cwd: context.cwd }, token });
			if (!("ok" in applied) || !applied.ok)
				return {
					repair: {
						...plan,
						state: "uncertain",
						sideEffectStarted: true,
						reasonCode: "ok" in applied && !applied.ok ? applied.error.code : "restore_apply_unverified",
					},
				};
			const afterChecks = await collectAfterChecks();
			const restored = afterChecks.some(
				check =>
					check.targetId === target.targetId &&
					check.execution === "completed" &&
					check.evidence.artifactStatus === "present",
			);
			return {
				repair: {
					...plan,
					state: restored ? "verified" : "uncertain",
					readiness: [],
					sideEffectStarted: true,
					reasonCode: restored ? undefined : "restore_postcheck_unverified",
					...(restored ? { outcome: { mutationVerified: true } } : {}),
				},
				afterChecks,
			};
		} catch {
			return {
				repair: { ...plan, state: "uncertain", sideEffectStarted: true, reasonCode: "repair_execution_unverified" },
			};
		}
	}
	if (plan.id === "service.restart-owned") {
		if (target.kind !== "service")
			return { repair: { ...plan, state: "blocked" }, invocationError: "action_target_mismatch" };
		const before = parseServiceRecord(target.observation.state);
		if (!before) return { repair: { ...plan, state: "blocked", reasonCode: "service_owner_absent" } };
		if (!context.options.yes) {
			const confirmation = await confirmSelectedRepair(context, plan);
			if (confirmation !== "confirmed")
				return {
					repair: { ...plan, state: "blocked", reasonCode: confirmation, readiness: ["confirmation_required"] },
				};
		}
		const admissionFailure = admitSelectedRepair(context, plan);
		if (admissionFailure) return admissionFailure;
		let settings: Settings | undefined;
		try {
			const drainSeconds = context.options.drainSeconds;
			const deadlineMs = Math.max(
				1_000,
				// `context.deadline` is monotonic (performance.now); mixing it with Date.now
				// yields a large negative remainder that silently clamps every restart to the
				// 1s floor and defeats --drain.
				Math.min(context.deadline - performance.now(), 15_000 + (drainSeconds ?? 0) * 1_000),
			);
			// The owner's own refusal reason is kept alongside the coarse stage: an
			// operator needs to tell "nothing is running" apart from "this daemon
			// predates the restart protocol and needs the manual transition".
			let outcome: { readonly kind: string; readonly reason?: string; readonly successorIncarnation?: string };
			if (target.service === "broker") {
				const result = await restartBrokerForDoctor({
					agentDir: context.agentRoot.locator,
					requestId: runId,
					deadlineMs,
					drain: drainSeconds !== undefined,
				});
				outcome =
					result.kind === "restarted"
						? { kind: result.kind, successorIncarnation: result.successor.incarnation }
						: { kind: result.kind, ...("reason" in result ? { reason: result.reason } : {}) };
			} else {
				settings = await Settings.loadForScope({ cwd: context.cwd, agentDir: context.agentRoot.locator });
				const result = await restartDaemonForDoctor({
					agentDir: context.agentRoot.locator,
					owner: target.service,
					settings,
					requestId: runId,
					deadlineMs,
					...(drainSeconds === undefined ? {} : { drainSeconds }),
				});
				outcome =
					result.kind === "restarted"
						? { kind: result.kind, successorIncarnation: result.successor.incarnation }
						: { kind: result.kind, ...("reason" in result ? { reason: result.reason } : {}) };
			}
			const afterChecks = await collectAfterChecks();
			const republished = afterChecks.some(
				check =>
					check.targetId === target.targetId && check.execution === "completed" && check.evidence.present === true,
			);
			// A restart is only verified when the published owner is a DIFFERENT incarnation
			// than the one observed before; a surviving incumbent is never success. The
			// successor identity is re-read from the refreshed target rather than taken
			// from the mutation's own return value, so the claim rests on this pass's
			// independent observation.
			// `collectAfterChecks` runs in a fresh context, so re-observe the published
			// record here rather than reading the pre-restart snapshot still held in
			// `context.targets`.
			// A daemon rewrites its heartbeat by rename, so a read can legitimately land
			// mid-swap and report `changed`. That is a torn read, not evidence, and it
			// would downgrade a real restart to uncertain; retry it exactly once.
			let observed = (await readDoctorService(context.agentRoot.locator, target.service)).state;
			if (observed.status === "changed")
				observed = (await readDoctorService(context.agentRoot.locator, target.service)).state;
			const published = parseServiceRecord(observed)?.incarnation;
			const replaced =
				typeof before.incarnation === "string" &&
				typeof published === "string" &&
				published !== before.incarnation &&
				outcome.successorIncarnation === published;
			if (outcome.kind === "restarted" && republished && replaced)
				return {
					repair: {
						...plan,
						state: "verified",
						readiness: [],
						sideEffectStarted: true,
						outcome: { mutationVerified: true },
						restartRequired: false,
						restartScope: "none",
					},
					afterChecks,
				};
			const preEffect = outcome.kind === "owner_unavailable" || outcome.kind === "prepare_refused";
			return {
				repair: {
					...plan,
					state: preEffect ? "blocked" : "uncertain",
					readiness: [],
					sideEffectStarted: !preEffect,
					reasonCode:
						outcome.kind === "restarted"
							? "service_restart_postcheck_unverified"
							: outcome.reason === undefined
								? outcome.kind
								: `${outcome.kind}:${outcome.reason}`,
				},
				afterChecks,
			};
		} catch {
			return {
				repair: { ...plan, state: "uncertain", sideEffectStarted: true, reasonCode: "repair_execution_unverified" },
			};
		} finally {
			await settings?.close();
		}
	}
	if (plan.id === "service.detach-owned-stale-artifact") {
		if (target.kind !== "artifact" || !target.slot)
			return { repair: { ...plan, state: "blocked" }, invocationError: "action_target_mismatch" };
		if (serviceArtifactObservation(target.observation, target.slot)?.status === "missing") {
			const afterChecks = await collectAfterChecks();
			if (
				!afterChecks.some(
					check =>
						check.targetId === target.targetId &&
						check.execution === "completed" &&
						check.evidenceLevel === "observed" &&
						check.evidence.present === false,
				)
			)
				return { repair: { ...plan, state: "blocked", reasonCode: "artifact_absence_unverified" }, afterChecks };
			return {
				repair: { ...plan, state: "not_needed", readiness: [], outcome: { mutationVerified: true } },
				afterChecks,
			};
		}
		if (!context.options.yes) {
			const confirmation = await confirmSelectedRepair(context, plan);
			if (confirmation !== "confirmed")
				return {
					repair: { ...plan, state: "blocked", reasonCode: confirmation, readiness: ["confirmation_required"] },
				};
		}
		const module = await loadServiceRepair().catch(() => undefined);
		if (!module)
			return {
				repair: { ...plan, state: "blocked", reasonCode: "repair_module_unavailable", readiness: ["unsupported"] },
			};
		const admissionFailure = admitSelectedRepair(context, plan);
		if (admissionFailure) return admissionFailure;
		try {
			return await module.applyDoctorStaleArtifact(context, runId, target, collectAfterChecks);
		} catch {
			return {
				repair: { ...plan, state: "uncertain", sideEffectStarted: true, reasonCode: "repair_execution_unverified" },
			};
		}
	}
	if (plan.id === "permissions.restrict-owned-config") {
		if (target.kind !== "permission")
			return { repair: { ...plan, state: "blocked" }, invocationError: "action_target_mismatch" };
		if (target.observation.status !== "read" || target.source.root.resolution !== "resolved")
			return {
				repair: {
					...plan,
					state: "blocked",
					reasonCode: "target_resolution_incomplete",
					readiness: ["target_resolution_incomplete"],
				},
			};
		if (!context.options.yes) {
			const confirmation = await confirmSelectedRepair(context, plan);
			if (confirmation !== "confirmed")
				return {
					repair: { ...plan, state: "blocked", reasonCode: confirmation, readiness: ["confirmation_required"] },
				};
		}
		const module = await loadPermissionRepair().catch(() => undefined);
		if (!module)
			return {
				repair: { ...plan, state: "blocked", reasonCode: "repair_module_unavailable", readiness: ["unsupported"] },
			};
		const admissionFailure = admitSelectedRepair(context, plan);
		if (admissionFailure) return admissionFailure;
		try {
			const result = await module.applyDoctorPermissionRepair({
				filePath: target.source.configPath,
				rootPath: target.source.root.locator,
				scope: target.source.scope,
				targetId: target.targetId,
				repairId: plan.id,
				runId,
				mode: "fix",
				authorization: context.options.allowRisks,
				journalRoot: context.agentRoot.locator,
				expected: { identity: target.observation.exactIdentity, mode: target.observation.identity.mode },
				collectAfterChecks,
			});
			return { repair: result.repair, afterChecks: result.afterChecks };
		} catch {
			return {
				repair: { ...plan, state: "uncertain", sideEffectStarted: true, reasonCode: "repair_execution_unverified" },
			};
		}
	}
	if (
		(plan.id === "config.set-validated" && target.kind !== "config") ||
		(plan.id === "mcp.set-startup-policy" && target.kind !== "mcp")
	)
		return { repair: { ...plan, state: "blocked" }, invocationError: "action_target_mismatch" };
	if (target.kind !== "config" && target.kind !== "mcp")
		return { repair: { ...plan, state: "blocked" }, invocationError: "action_target_mismatch" };
	if (target.observation.status !== "read" || target.source.root.resolution !== "resolved")
		return {
			repair: {
				...plan,
				state: "blocked",
				reasonCode: "target_resolution_incomplete",
				readiness: ["target_resolution_incomplete"],
			},
		};
	if (typeof context.options.setValue !== "boolean")
		return { repair: { ...plan, state: "blocked" }, invocationError: "value_required" };
	if (!context.options.yes) {
		const confirmation = await confirmSelectedRepair(context, plan);
		if (confirmation !== "confirmed")
			return {
				repair: { ...plan, state: "blocked", reasonCode: confirmation, readiness: ["confirmation_required"] },
			};
	}
	const request: DoctorConfigRepairRequest = {
		filePath: target.kind === "config" ? target.source.configPath : target.source.mcpPath,
		rootPath: target.source.root.locator,
		scope: target.source.scope,
		targetId: target.targetId,
		repairId: plan.id,
		runId,
		mode: "fix",
		authorization: context.options.allowRisks,
		journalRoot: context.agentRoot.locator,
		expected: {
			raw: target.observation.text,
			observedValue: target.beforeValue,
			identity: target.observation.exactIdentity,
		},
		kind: target.kind === "config" ? "skill" : "mcp",
		...(target.kind === "config"
			? { schemaKey: target.schemaKey }
			: { serverName: target.serverName, field: target.field }),
		value: context.options.setValue,
		collectAfterChecks,
	};
	const module = await loadConfigRepair().catch(() => undefined);
	if (!module)
		return {
			repair: { ...plan, state: "blocked", reasonCode: "repair_module_unavailable", readiness: ["unsupported"] },
		};
	const admissionFailure = admitSelectedRepair(context, plan);
	if (admissionFailure) return admissionFailure;
	let result: DoctorConfigRepairResult;
	try {
		result = await module.applyDoctorConfigRepair(request);
	} catch {
		return {
			repair: { ...plan, state: "uncertain", sideEffectStarted: true, reasonCode: "repair_execution_unverified" },
		};
	}
	return {
		repair: {
			...result.repair,
			restartScope: "new-session",
			beforeCheckIds: plan.beforeCheckIds,
		},
		afterChecks: result.afterChecks,
	};
}

async function confirmSelectedRepair(context: DoctorContext, plan: DoctorRepair): Promise<DoctorConfirmationResult> {
	if (context.options.confirmRepair) return context.options.confirmRepair(plan);
	const terminal = createInterface({ input: process.stdin, output: process.stderr });
	const interrupt = new AbortController();
	const onInterrupt = () => interrupt.abort();
	terminal.once("SIGINT", onInterrupt);
	const remaining = Math.max(1, Math.floor(context.deadline - performance.now()));
	const signals = [interrupt.signal, AbortSignal.timeout(remaining)];
	if (context.options.signal) signals.push(context.options.signal);
	try {
		const answer = await terminal.question(
			`Apply ${plan.id} to ${plan.targetId}${context.options.setValue === undefined ? "" : `, value ${context.options.setValue}`}? [y/N] `,
			{ signal: AbortSignal.any(signals) },
		);
		return /^(y|yes)$/i.test(answer.trim()) ? "confirmed" : "confirmation_declined";
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError")
			return interrupt.signal.aborted || context.options.signal?.aborted ? "cancelled" : "confirmation_timeout";
		throw error;
	} finally {
		terminal.off("SIGINT", onInterrupt);
		terminal.close();
	}
}
