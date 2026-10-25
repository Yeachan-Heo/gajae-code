import * as path from "node:path";
import { getAgentDir, getConfigRootDir, getTrustedHomeDir } from "@gajae-code/utils";
import { Settings } from "../../src/config/settings";

const ownedRoot = process.argv[2];
if (!ownedRoot) throw new Error("An owned disposable root is required");

const home = getTrustedHomeDir();
const configRoot = getConfigRootDir();
const agentDir = getAgentDir();
const userProfile = process.env.USERPROFILE;
for (const candidate of [process.env.HOME, userProfile, home, configRoot, agentDir]) {
	if (!candidate) throw new Error("A profile root is missing");
	const relative = path.relative(ownedRoot, candidate);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Profile probe refuses settings outside its owned disposable root");
	}
}

const settings = await Settings.init({ cwd: process.cwd() });
process.stdout.write(
	`${JSON.stringify({
		userProfile,
		home,
		configRoot,
		agentDir,
		maxIterations: settings.get("gjc.ralplan.maxIterations"),
	})}\n`,
);
