/**
 * Child-process probe for the config-root workflow-settings migration.
 * Runs `Settings.loadForScope` against the current working directory with an
 * optional `--agent-dir` override, then reports the resulting file state so
 * tests can assert pairing-gate, marker, backup, and migrated-value behavior
 * without depending on host directory state.
 *
 * HOME / GJC_CONFIG_DIR / GJC_CODING_AGENT_DIR are read at module load, so this
 * must run as a child process with the environment set before spawn.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { Settings } from "../../src/config/settings";

const cwd = process.cwd();
const agentDirIndex = process.argv.indexOf("--agent-dir");
const agentDirOverride = agentDirIndex >= 0 ? process.argv[agentDirIndex + 1] : undefined;

await Settings.loadForScope({ cwd, ...(agentDirOverride ? { agentDir: agentDirOverride } : {}) });

const configRoot = getConfigRootDir();
const source = path.resolve(configRoot, "settings.json");
const backup = `${source}.bak`;
const markerPath = `${source}.migrated`;
const effectiveAgentDir = agentDirOverride ? path.resolve(agentDirOverride) : getAgentDir();
const targetConfig = path.resolve(effectiveAgentDir, "config.yml");

const exists = async (target: string): Promise<boolean> => {
	try {
		await fs.lstat(target);
		return true;
	} catch {
		return false;
	}
};

let markerStatus: string | null = null;
if (await exists(markerPath)) {
	try {
		const status = (JSON.parse(await fs.readFile(markerPath, "utf8")) as { status?: unknown }).status;
		markerStatus = typeof status === "string" ? status : null;
	} catch {
		markerStatus = "invalid";
	}
}

let targetValue: unknown = null;
if (await exists(targetConfig)) {
	try {
		const root = YAML.parse(await fs.readFile(targetConfig, "utf8")) as Record<string, unknown> | null | undefined;
		const gjc = root?.gjc as Record<string, unknown> | undefined;
		const ralplan = gjc?.ralplan as Record<string, unknown> | undefined;
		if (ralplan && Object.hasOwn(ralplan, "maxIterations")) targetValue = ralplan.maxIterations;
	} catch {
		// Malformed target YAML: report null; the load itself must have survived.
	}
}

console.log(
	JSON.stringify({
		sourceExists: await exists(source),
		backupExists: await exists(backup),
		markerExists: await exists(markerPath),
		markerStatus,
		targetValue,
	}),
);
