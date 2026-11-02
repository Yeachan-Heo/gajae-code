import * as path from "node:path";
import { getAgentDbPath, getAgentDir, getConfigRootDir, getTrustedHomeDir } from "@gajae-code/utils";
import { Settings } from "../../src/config/settings";

const ownedRoot = process.argv[2];
if (!ownedRoot) throw new Error("An owned disposable root is required");

const home = getTrustedHomeDir();
const configRoot = getConfigRootDir();
const agentDir = getAgentDir();
const agentDbPath = getAgentDbPath();
const userProfile = process.env.USERPROFILE;
const xdgHomes = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map(
	name => process.env[name] ?? null,
);
for (const candidate of [process.env.HOME, userProfile, home, configRoot, agentDir, agentDbPath]) {
	if (!candidate) throw new Error("A profile root is missing");
	const relative = path.relative(ownedRoot, candidate);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Profile probe refuses settings outside its owned disposable root: ${candidate}`);
	}
}

const settings = await Settings.init({ cwd: process.cwd() });
process.stdout.write(
	`${JSON.stringify({
		userProfile,
		home,
		configRoot,
		agentDir,
		agentDbPath,
		legacyConfigDir: process.env.PI_CONFIG_DIR ?? null,
		xdgHomes,
		maxIterations: settings.get("gjc.ralplan.maxIterations"),
	})}\n`,
);
