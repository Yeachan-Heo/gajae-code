import { runCustomizeDoctor } from "../customize-doctor";
import { createDoctorContext } from "./context";
import { canonicalDigest, pluginTargetId } from "./ids";
import type { DoctorProbeReceipt } from "./probe-types";
import type { DoctorCheck } from "./types";

export async function collectProjectionProbe(): Promise<DoctorProbeReceipt> {
	const context = createDoctorContext({
		mode: "diagnose",
		json: true,
		help: false,
		checks: [],
		allowRisks: [],
		yes: false,
	});
	const projection = await runCustomizeDoctor(context.cwd);
	const checks: DoctorCheck[] = [];
	let limited = false;
	for (const surface of projection.surfaces) {
		if (surface.items.length > 1000) limited = true;
		for (const item of surface.items.slice(0, 1000)) {
			const source = context.sources.find(candidate => candidate.scope === item.scope);
			const rootId = source?.root.rootId ?? context.agentRoot.rootId;
			const isPlugin = item.kind === "plugin-bundle";
			const family = item.provider === "gjc-bundle" ? "gjc" : "npm";
			const targetId =
				isPlugin && source
					? pluginTargetId(rootId, family, source.scope, item.name)
					: `t1:projection:${rootId}:${surface.kind}:n${canonicalDigest([item.name])}`;
			checks.push({
				id: `projection.${surface.kind}.${rootId}.${canonicalDigest([item.name, item.provider])}`,
				targetId,
				...(source ? { scope: source.scope } : {}),
				execution: "completed",
				health:
					item.status === "rejected" || item.status === "quarantined"
						? "warning"
						: item.reason === "load-error" || item.reason === "invalid-config"
							? "error"
							: "ok",
				evidenceLevel: "observed",
				reasonCode: item.reason.replaceAll("-", "_"),
				dependsOn: ["config"],
				evidence: {
					status: item.status,
					sourceClass: item.sourceClass,
					...(item.mcp
						? {
								transport: item.mcp.transport ?? "unknown",
								enabled: item.mcp.enabled ?? true,
								autoload: item.mcp.autoload ?? true,
								hasAuth: item.mcp.hasAuth,
								runtimeProbed: false,
							}
						: {}),
				},
				remediationIds: isPlugin ? ["plugin.restore-known-artifact", "plugin.quarantine-selected"] : [],
			});
		}
		checks.push({
			id: `projection.${surface.kind}.coverage`,
			targetId: `t1:projection:${context.agentRoot.rootId}:${surface.kind}`,
			execution: surface.warnings?.length || surface.items.length > 1000 ? "blocked" : "completed",
			health: surface.warnings?.length || surface.items.length > 1000 ? "unknown" : "ok",
			evidenceLevel: "observed",
			reasonCode: surface.warnings?.length ? "projection_incomplete" : "projection_collected",
			dependsOn: ["config"],
			evidence: { count: surface.items.length, warningCount: surface.warnings?.length ?? 0 },
			remediationIds: [],
		});
	}
	if (projection.warnings.length || limited)
		checks.push({
			id: "projection.coverage",
			targetId: `t1:projection:${context.agentRoot.rootId}`,
			execution: "blocked",
			health: "unknown",
			evidenceLevel: "observed",
			reasonCode: limited ? "limit_exceeded" : "projection_incomplete",
			dependsOn: ["config"],
			evidence: { warningCount: projection.warnings.length },
			remediationIds: [],
		});
	return { schemaVersion: 1, kind: "projection", status: "completed", reasonCode: "projection_collected", checks };
}
