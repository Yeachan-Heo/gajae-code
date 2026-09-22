import * as path from "node:path";

interface ProjectEnvSnapshotLike {
	values: Record<string, string>;
	dynamic: Set<string>;
}

interface CanonicalLogDirInput {
	home: string;
	env: Record<string, string | undefined>;
	projectEnv: ProjectEnvSnapshotLike;
	xdgEligible: boolean;
	pathExists?: (target: string) => boolean;
}

const APP_NAME = "gjc";
const DEFAULT_CONFIG_DIR_NAME = ".gjc";

function canonicalEnvKey(name: string): string {
	return process.platform === "win32" ? name.toUpperCase() : name;
}

function sanitizeConfigDirName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || path.normalize(trimmed).split(/[\\/]/).includes("..")) return undefined;
	return trimmed;
}

/** Resolve a caller environment value only when its dotenv provenance is trusted. */
function trustedValue(name: string, input: CanonicalLogDirInput): string | undefined {
	const value = input.env[name];
	if (!value) return undefined;
	const key = canonicalEnvKey(name);
	if (input.projectEnv.dynamic.has(key) || input.projectEnv.values[key] === value) return undefined;
	return value;
}

/**
 * Resolve the canonical user log directory without mutating the environment.
 *
 * The caller supplies filesystem existence checks so this leaf stays free of
 * filesystem and resolver side effects. Both the production directory resolver
 * and the test preload use this exact path selection logic.
 */
export function resolveCanonicalLogsDir(input: CanonicalLogDirInput): string {
	const configDirName =
		sanitizeConfigDirName(trustedValue("GJC_CONFIG_DIR", input)) ??
		sanitizeConfigDirName(trustedValue("PI_CONFIG_DIR", input)) ??
		DEFAULT_CONFIG_DIR_NAME;
	const xdgStateHome =
		input.xdgEligible && (process.platform === "linux" || process.platform === "darwin")
			? trustedValue("XDG_STATE_HOME", input)?.trim()
			: undefined;
	if (xdgStateHome) {
		const xdgRoot = path.join(xdgStateHome, APP_NAME);
		if (input.pathExists?.(xdgRoot) === true) return path.join(xdgRoot, "logs");
	}
	return path.join(input.home, configDirName, "logs");
}
