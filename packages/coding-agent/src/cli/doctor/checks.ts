import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, VERSION } from "@gajae-code/utils/dirs";
import { JSONC, YAML } from "bun";
import { computeAutoloadStatus } from "../../runtime-mcp/startup-policy";
import type { DoctorConfigSource, DoctorContext } from "./context";
import { type DoctorFileObservation, doctorErrno, doctorMapping, readDoctorFile } from "./files";
import { binaryTargetId, configTargetId, mcpTargetId, permissionTargetId, resolveDoctorRoot } from "./ids";
import { describeInstallRestore, type InstallRestoreDescriptorV1 } from "./install-repairs";
import { describeManagedLink } from "./managed-link";
import type { CheckEvidence, DoctorCheck } from "./types";

export interface DoctorCollector {
	readonly id: string;
	readonly dependsOn: readonly string[];
	readonly timeoutMs: number;
	collect(context: DoctorContext): Promise<DoctorCheck[]>;
}

export function doctorCheck(
	id: string,
	targetId: string,
	result: Pick<DoctorCheck, "execution" | "health" | "evidenceLevel"> & Partial<DoctorCheck>,
): DoctorCheck {
	return {
		id,
		targetId,
		dependsOn: [],
		remediationIds: [],
		evidence: {},
		observedAt: new Date().toISOString(),
		...result,
	};
}

function fileCheck(
	id: string,
	targetId: string,
	observation: DoctorFileObservation,
	source: DoctorConfigSource,
): DoctorCheck | undefined {
	if (source.root.resolution !== "resolved")
		return doctorCheck(id, targetId, {
			scope: source.scope,
			execution: "blocked",
			health: "unknown",
			evidenceLevel: "observed",
			reasonCode: "root_resolution_unknown",
		});
	if (observation.status === "read") return undefined;
	return doctorCheck(id, targetId, {
		scope: source.scope,
		execution: observation.status === "missing" ? "completed" : "blocked",
		health: observation.status === "missing" ? "not_applicable" : "unknown",
		evidenceLevel: "observed",
		reasonCode: `file_${observation.status}`,
		evidence: observation.errno ? { errno: observation.errno } : {},
	});
}

function parseConfig(
	observation: DoctorFileObservation,
	format: "yaml" | "json",
): { document?: Record<string, unknown>; reasonCode?: string } {
	if (observation.status !== "read") return {};
	try {
		const parsed: unknown = format === "yaml" ? YAML.parse(observation.text) : JSONC.parse(observation.text);
		const document = doctorMapping(parsed);
		return document ? { document } : { reasonCode: "config_root_not_mapping" };
	} catch {
		// Parser errors may include source snippets containing credentials.
		return { reasonCode: "config_parse_error" };
	}
}

export async function collectRuntime(context: DoctorContext): Promise<DoctorCheck[]> {
	return [
		doctorCheck("runtime.identity", `t1:runtime:${context.installRoot.rootId}`, {
			execution: "completed",
			health: "ok",
			evidenceLevel: "observed",
			reasonCode: "runtime_available",
			evidence: {
				version: VERSION,
				runtimeVersion: Bun.version,
				platform: process.platform,
				arch: process.arch,
				channel: context.compiled ? "standalone" : "source",
			},
		}),
	];
}

export async function collectConfig(context: DoctorContext): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	for (const source of context.sources) {
		const observation = await readDoctorFile(source.configPath);
		const parsed = parseConfig(observation, "yaml");
		const skills = doctorMapping(parsed.document?.skills);
		for (const schemaKey of ["skills.enabled", "skills.enableSkillCommands"] as const) {
			const field = schemaKey.slice("skills.".length);
			const beforeValue = skills?.[field];
			const targetId = configTargetId(source.root.rootId, source.scope, schemaKey);
			context.targets.set(targetId, { kind: "config", targetId, source, schemaKey, observation, beforeValue });
			const id = `config.${source.scope}.${schemaKey}`;
			const failure = fileCheck(id, targetId, observation, source);
			if (failure) {
				checks.push(failure);
				continue;
			}
			const reasonCode =
				parsed.reasonCode ??
				(parsed.document?.skills !== undefined && !skills
					? "config_skills_not_mapping"
					: beforeValue !== undefined && typeof beforeValue !== "boolean"
						? "config_invalid_boolean"
						: "config_field_valid");
			checks.push(
				doctorCheck(id, targetId, {
					scope: source.scope,
					execution: "completed",
					health: reasonCode === "config_field_valid" ? "ok" : "error",
					evidenceLevel: "observed",
					reasonCode,
					evidence: {
						schemaLocation: schemaKey,
						present: beforeValue !== undefined,
						...(typeof beforeValue === "boolean" ? { enabled: beforeValue } : {}),
						schemaCoverage: "selected_fields",
					},
					remediationIds: ["config.set-validated"],
				}),
			);
		}
	}
	return checks;
}

export async function collectPermissions(context: DoctorContext): Promise<DoctorCheck[]> {
	const source = context.sources.find(candidate => candidate.scope === "user");
	if (!source) return [];
	const observation = await readDoctorFile(source.configPath);
	const targetId = permissionTargetId(source.root.rootId);
	context.targets.set(targetId, { kind: "permission", targetId, source, observation });
	const failure = fileCheck("permissions.user.config", targetId, observation, source);
	if (failure) return [failure];
	if (observation.status !== "read") return [];
	const exposed = (observation.identity.mode & 0o077) !== 0;
	return [
		doctorCheck("permissions.user.config", targetId, {
			scope: "user",
			execution: "completed",
			health: process.platform === "win32" ? "unknown" : exposed ? "warning" : "ok",
			evidenceLevel: "observed",
			reasonCode: process.platform === "win32" ? "acl_not_probed" : exposed ? "mode_exposes_config" : "mode_private",
			evidence: {
				mode: observation.identity.mode & 0o777,
				ownerMatches: process.getuid ? observation.identity.owner === process.getuid() : false,
				aclCoverage: "not_probed",
			},
			remediationIds: ["permissions.restrict-owned-config"],
		}),
	];
}

export async function collectMcp(context: DoctorContext): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	for (const source of context.sources) {
		const observation = await readDoctorFile(source.mcpPath);
		const id = `mcp.${source.scope}.configuration`;
		const rootTarget = `t1:mcp-config:${source.root.rootId}:${source.scope}`;
		const failure = fileCheck(id, rootTarget, observation, source);
		if (failure) {
			checks.push(failure);
			continue;
		}
		const parsed = parseConfig(observation, source.mcpPath.endsWith(".json") ? "json" : "yaml");
		const servers = doctorMapping(parsed.document?.mcpServers);
		if (parsed.reasonCode || (parsed.document?.mcpServers !== undefined && !servers)) {
			checks.push(
				doctorCheck(id, rootTarget, {
					scope: source.scope,
					execution: "completed",
					health: "error",
					evidenceLevel: "observed",
					reasonCode: parsed.reasonCode ?? "mcp_servers_not_mapping",
				}),
			);
			continue;
		}
		const names = Object.keys(servers ?? {}).sort();
		const disabled = parsed.document?.disabledServers;
		const disabledNames = new Set<string>(
			Array.isArray(disabled) ? disabled.filter((name): name is string => typeof name === "string") : [],
		);
		if (names.length > 1000) {
			checks.push(
				doctorCheck(id, rootTarget, {
					scope: source.scope,
					execution: "blocked",
					health: "unknown",
					evidenceLevel: "observed",
					reasonCode: "limit_exceeded",
				}),
			);
		}
		for (const name of names.slice(0, 1000)) {
			const server = doctorMapping(servers?.[name]);
			for (const field of ["autoload", "enabled"] as const) {
				const targetId = mcpTargetId(source.root.rootId, source.scope, name, field);
				context.targets.set(targetId, {
					kind: "mcp",
					targetId,
					source,
					serverName: name,
					field,
					definitionIsMapping: server !== undefined,
					observation,
					beforeValue: server?.[field],
				});
				const valid =
					server !== undefined &&
					(server.enabled === undefined || typeof server.enabled === "boolean") &&
					(server.autoload === undefined || typeof server.autoload === "boolean");
				const evidence: CheckEvidence = {
					present: server?.[field] !== undefined,
					runtimeProbed: false,
					...(typeof server?.enabled === "boolean" ? { enabled: server.enabled } : {}),
					...(typeof server?.autoload === "boolean" ? { autoload: server.autoload } : {}),
					...(valid
						? {
								startupStatus: computeAutoloadStatus(
									name,
									{
										enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
										autoload: typeof server.autoload === "boolean" ? server.autoload : undefined,
									},
									disabledNames,
								),
							}
						: {}),
				};
				checks.push(
					doctorCheck(`mcp.${source.scope}.${targetId.split(":").at(-2)}.${field}`, targetId, {
						scope: source.scope,
						execution: "completed",
						health: valid ? "ok" : "error",
						evidenceLevel: "observed",
						reasonCode: valid ? "mcp_static_policy_valid" : "mcp_invalid_policy",
						evidence,
						remediationIds: ["mcp.set-startup-policy"],
					}),
				);
			}
		}
		if (names.length === 0) {
			checks.push(
				doctorCheck(id, rootTarget, {
					scope: source.scope,
					execution: "completed",
					health: "not_applicable",
					evidenceLevel: "observed",
					reasonCode: "mcp_no_servers",
				}),
			);
		}
	}
	return checks;
}

export async function collectCredentials(context: DoctorContext): Promise<DoctorCheck[]> {
	const targetId = `t1:credentials:${context.agentRoot.rootId}`;
	try {
		const stat = await fs.lstat(getAgentDbPath(context.agentRoot.locator));
		return [
			doctorCheck("credentials.storage", targetId, {
				execution: "completed",
				health: stat.isSymbolicLink() || !stat.isFile() ? "warning" : "ok",
				evidenceLevel: "observed",
				reasonCode:
					stat.isSymbolicLink() || !stat.isFile()
						? "credential_storage_not_regular"
						: "credential_storage_present",
				evidence: { present: true, contentsRead: false, authenticationProbed: false },
			}),
		];
	} catch (error) {
		const errno = doctorErrno(error);
		return [
			doctorCheck("credentials.storage", targetId, {
				execution: errno === "ENOENT" ? "completed" : "blocked",
				health: errno === "ENOENT" ? "not_applicable" : "unknown",
				evidenceLevel: "observed",
				reasonCode: errno === "ENOENT" ? "credential_storage_absent" : "credential_storage_unreadable",
				evidence: { errno, contentsRead: false, authenticationProbed: false },
			}),
		];
	}
}

export async function collectInstallation(context: DoctorContext): Promise<DoctorCheck[]> {
	const targetId = context.compiled
		? binaryTargetId(context.installRoot.rootId, path.basename(context.executable))
		: `t1:installation:${context.installRoot.rootId}:source`;
	if (context.compiled)
		context.targets.set(targetId, {
			kind: "binary",
			targetId,
			filePath: context.executable,
			root: context.installRoot,
		});
	try {
		const stat = await fs.lstat(context.executable);
		let descriptor: InstallRestoreDescriptorV1 | undefined;
		if (
			context.compiled &&
			context.options.repair === "install.restore-binary" &&
			context.options.targetId === targetId
		) {
			const channel = VERSION.includes("nightly")
				? "nightly"
				: /^\d+\.\d+\.\d+$/.test(VERSION)
					? "stable"
					: "unknown";
			descriptor = await describeInstallRestore(context.executable, undefined, channel, `v${VERSION}`);
			context.targets.set(targetId, {
				kind: "binary",
				targetId,
				filePath: context.executable,
				root: context.installRoot,
				installDescriptor: descriptor,
			});
		}
		return [
			doctorCheck("installation.current", targetId, {
				execution: "completed",
				health: stat.isFile() ? "ok" : "error",
				evidenceLevel: "observed",
				reasonCode: stat.isFile() ? "installation_entry_present" : "installation_entry_not_regular",
				evidence: {
					channel: context.compiled ? "standalone" : "source",
					version: VERSION,
					present: true,
					...(descriptor && context.options.sha256
						? { integrityResult: descriptor.targetDigest === context.options.sha256 ? "matches_pin" : "mismatch" }
						: {}),
				},
				remediationIds: context.compiled ? ["install.restore-binary"] : [],
			}),
		];
	} catch (error) {
		return [
			doctorCheck("installation.current", targetId, {
				execution: "blocked",
				health: "unknown",
				evidenceLevel: "observed",
				reasonCode: "installation_entry_unreadable",
				evidence: { errno: doctorErrno(error) },
			}),
		];
	}
}

/** Managed alias observation only: nothing on PATH is executed or resolved through the shell. */
export async function collectManagedLinks(context: DoctorContext): Promise<DoctorCheck[]> {
	// The group must always answer. Returning nothing makes the check vanish from
	// the report entirely, which reads as "nothing to say" rather than the truth,
	// and the plan requires an inapplicable scope be stated, not hidden.
	// `completed` + `not_applicable`, never `unsupported`: this is a fully
	// determined answer, so it must not inflate the incomplete coverage that
	// drives exit 3.
	const inapplicable = (reasonCode: string): DoctorCheck[] => [
		doctorCheck("link.managed", `t1:link:${context.installRoot.rootId}:not-applicable`, {
			execution: "completed",
			health: "not_applicable",
			evidenceLevel: "not_probed",
			reasonCode,
			evidence: { present: false },
		}),
	];
	// `cliPath` is set exactly for a source checkout; a standalone binary has no
	// managed alias to inspect.
	if (!context.cliPath) return inapplicable("managed_link_standalone_install");
	const workspace = path.resolve(path.dirname(context.cliPath), "..", "..", "..");
	const checks: DoctorCheck[] = [];
	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!entry || !path.isAbsolute(entry)) continue;
		for (const alias of ["gjc", "가재씨"]) {
			const targetPath = path.join(entry, alias);
			const stat = await fs.lstat(targetPath).catch(() => undefined);
			if (!stat) continue;
			const descriptor = await describeManagedLink(targetPath, workspace, alias);
			if (context.targets.has(descriptor.targetId)) continue;
			context.targets.set(descriptor.targetId, {
				kind: "link",
				targetId: descriptor.targetId,
				filePath: targetPath,
				root: resolveDoctorRoot("install", descriptor.parentPath),
				linkDescriptor: descriptor,
			});
			checks.push(
				doctorCheck(`installation.link.${descriptor.targetId.split(":").at(-1)}`, descriptor.targetId, {
					execution: "completed",
					health: descriptor.status === "healthy" ? "ok" : descriptor.status === "broken" ? "error" : "warning",
					evidenceLevel: "observed",
					reasonCode: descriptor.reasonCode ?? `managed_link_${descriptor.status}`,
					evidence: {
						present: true,
						status: descriptor.status,
						runtimeProbed: false,
						candidateCount: descriptor.candidates.length,
					},
					remediationIds: descriptor.receiptTrusted ? ["install.repair-managed-link"] : [],
				}),
			);
		}
	}
	// A source checkout with no alias installed anywhere on PATH is a real,
	// observed answer — not an empty group.
	return checks.length > 0 ? checks : inapplicable("managed_link_absent");
}

export const BASIC_DOCTOR_COLLECTORS: readonly DoctorCollector[] = [
	{ id: "runtime", dependsOn: [], timeoutMs: 2_000, collect: collectRuntime },
	{ id: "config", dependsOn: [], timeoutMs: 2_000, collect: collectConfig },
	{ id: "permissions", dependsOn: [], timeoutMs: 2_000, collect: collectPermissions },
	{ id: "installation", dependsOn: [], timeoutMs: 2_000, collect: collectInstallation },
	{ id: "link", dependsOn: [], timeoutMs: 3_000, collect: collectManagedLinks },
	{ id: "credentials", dependsOn: [], timeoutMs: 2_000, collect: collectCredentials },
	{ id: "mcp", dependsOn: [], timeoutMs: 2_000, collect: collectMcp },
];
