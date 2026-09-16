import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, getMCPConfigPath, getProjectAgentDir } from "@gajae-code/utils/dirs";
import type { LocalRestorePlanV1 } from "../../extensibility/gjc-plugins/types";
import type { MarketplaceRestorePlanV1 } from "../../extensibility/plugins/marketplace/manager";
import type { DoctorOptions } from "./args";
import type { DoctorFileObservation } from "./files";
import { type ResolvedRoot, resolveDoctorRoot } from "./ids";
import type { InstallRestoreDescriptorV1 } from "./install-repairs";
import type { ManagedLinkDescriptor } from "./managed-link";
import type { PluginQuarantinePlan } from "./plugin-quarantine";
import type { DoctorServiceObservation } from "./service-targets";
import type { DoctorScope } from "./types";

export interface DoctorConfigSource {
	readonly scope: DoctorScope;
	readonly root: ResolvedRoot;
	readonly configPath: string;
	readonly mcpPath: string;
}

export interface DoctorSettingTarget {
	readonly kind: "config";
	readonly targetId: string;
	readonly source: DoctorConfigSource;
	readonly schemaKey: "skills.enabled" | "skills.enableSkillCommands";
	readonly observation: DoctorFileObservation;
	readonly beforeValue: unknown;
}

export interface DoctorMcpTarget {
	readonly kind: "mcp";
	readonly targetId: string;
	readonly source: DoctorConfigSource;
	readonly serverName: string;
	readonly field: "autoload" | "enabled";
	readonly definitionIsMapping: boolean;
	readonly observation: DoctorFileObservation;
	readonly beforeValue: unknown;
}

export interface DoctorPermissionTarget {
	readonly kind: "permission";
	readonly targetId: string;
	readonly source: DoctorConfigSource;
	readonly observation: DoctorFileObservation;
}

export interface DoctorInstallTarget {
	readonly kind: "binary" | "link";
	readonly targetId: string;
	readonly filePath: string;
	readonly root: ResolvedRoot;
	readonly installDescriptor?: InstallRestoreDescriptorV1;
	readonly linkDescriptor?: ManagedLinkDescriptor;
}

export interface DoctorPluginTarget {
	readonly kind: "plugin";
	readonly targetId: string;
	readonly family: "gjc" | "npm" | "marketplace";
	readonly scope: DoctorScope;
	readonly name: string;
	readonly root: ResolvedRoot;
	readonly quarantinePlan?: PluginQuarantinePlan;
	/** Original read-only restore observation; apply is authorized against this exact plan, never a fresh one. */
	readonly restorePlan?: LocalRestorePlanV1;
	/** Original read-only private-marketplace restore observation; apply authorizes against this exact plan. */
	readonly marketplaceRestorePlan?: MarketplaceRestorePlanV1;
	/** Immutable stored-source identity a restore `--ref` must equal; absent means the source is unpinnable. */
	readonly restoreRef?: string;
	/** Stable artifact-tree digest the restore `--sha256` must equal; recomputed by the lifecycle from the resolved source. */
	readonly restoreArtifactDigest?: string;
	readonly registryPath?: string;
}

export interface DoctorServiceTarget {
	readonly kind: "service" | "artifact";
	readonly targetId: string;
	readonly service: "broker" | "telegram" | "discord" | "slack";
	readonly root: ResolvedRoot;
	readonly slot?: "discovery" | "owner-lock" | "startup-marker";
	readonly observation: DoctorServiceObservation;
}

export type DoctorTarget =
	| DoctorSettingTarget
	| DoctorMcpTarget
	| DoctorPermissionTarget
	| DoctorInstallTarget
	| DoctorPluginTarget
	| DoctorServiceTarget;

export interface DoctorContext {
	readonly options: DoctorOptions;
	readonly cwd: string;
	readonly agentRoot: ResolvedRoot;
	readonly installRoot: ResolvedRoot;
	readonly sources: readonly DoctorConfigSource[];
	readonly targets: Map<string, DoctorTarget>;
	readonly compiled: boolean;
	readonly executable: string;
	readonly cliPath?: string;
	readonly deadline: number;
}

/** Resolve only existing product directory conventions; this never initializes settings. */
export function createDoctorContext(options: DoctorOptions): DoctorContext {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const agentDirectory = getAgentDir();
	const userRoot = resolveDoctorRoot("config-user", agentDirectory);
	const projectRoot = resolveDoctorRoot("config-project", getProjectAgentDir(cwd));
	const sources: DoctorConfigSource[] = [
		{
			scope: "user",
			root: userRoot,
			configPath: path.join(userRoot.locator, "config.yml"),
			mcpPath: getMCPConfigPath("user", cwd, agentDirectory),
		},
		{
			scope: "project",
			root: projectRoot,
			configPath: path.join(projectRoot.locator, "config.yml"),
			mcpPath: getMCPConfigPath("project", cwd, agentDirectory),
		},
	];
	// A source caller cannot turn itself into a compiled installation by setting an environment flag.
	const compiled = /(?:\/\$bunfs\/|\/~BUN\/|\/%7EBUN\/)/i.test(import.meta.url);
	const cliPath = compiled ? undefined : fileURLToPath(new URL("../../cli.ts", import.meta.url));
	const executable = compiled ? process.execPath : (cliPath ?? process.execPath);
	const installDirectory = compiled
		? path.dirname(process.execPath)
		: path.resolve(path.dirname(cliPath ?? process.execPath), "..");
	return {
		options,
		cwd,
		agentRoot: resolveDoctorRoot("agent", agentDirectory),
		installRoot: resolveDoctorRoot("install", installDirectory),
		sources: options.scope ? sources.filter(source => source.scope === options.scope) : sources,
		targets: new Map(),
		compiled,
		executable,
		cliPath,
		deadline: Math.min(
			options.deadline ?? Number.POSITIVE_INFINITY,
			performance.now() + (options.timeoutMs ?? 15_000),
		),
	};
}
