import * as os from "node:os";
import * as path from "node:path";
import { isolateEnvironment } from "./environment-policy";

// This module is the first import of the process entrypoint, before the SDK
// captures discovery roots. It must remain synchronous and SDK-independent.
//
// The desktop app shares the terminal's GJC install by default: same agent
// directory, same credentials, same model profiles and default preset, resolved
// exactly as `gjc` resolves them. Only the app's own catalog, transcripts and
// logs live under the desktop data dir.
//
// `GJC_DESKTOP_ISOLATED=1` opts into a hermetic install (used by tests and QA):
// HOME, agent dir, config and XDG roots all move under the data dir so nothing
// in the user's install is read or written.
const realHome = process.env.HOME;
const realAgentDir = process.env.GJC_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
// Read before isolation strips inherited variables: the desktop connection can
// only be diagnosed by asking the host which requests it actually received.
const traceProtocol = process.env.GJC_DESKTOP_TRACE === "1";
const isolated = process.env.GJC_DESKTOP_ISOLATED === "1";
const explicitAgentDir = process.env.GJC_DESKTOP_AGENT_DIR?.trim();
const dataDir = path.resolve(
	process.env.GJC_DESKTOP_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "Gajae Code Desktop"),
);
isolateEnvironment(process.env);
if (traceProtocol) process.env.GJC_DESKTOP_TRACE = "1";
process.env.GJC_DESKTOP_DATA_DIR = dataDir;

if (isolated) {
	process.env.HOME = path.join(dataDir, "home");
	process.env.USERPROFILE = process.env.HOME;
	process.env.GJC_CODING_AGENT_DIR = path.join(dataDir, "agent");
	process.env.PI_CODING_AGENT_DIR = process.env.GJC_CODING_AGENT_DIR;
	process.env.GJC_CONFIG_DIR = ".gjc-desktop";
	process.env.PI_CONFIG_DIR = ".gjc-desktop";
	process.env.XDG_CONFIG_HOME = path.join(dataDir, "config");
	process.env.XDG_DATA_HOME = path.join(dataDir, "data");
	process.env.XDG_STATE_HOME = path.join(dataDir, "state");
	process.env.XDG_CACHE_HOME = path.join(dataDir, "cache");
} else {
	// Shared mode: keep the install's own HOME, agent dir and config discovery so
	// `modelProfile.default` and every credential resolve as they do in the
	// terminal. An explicit agent dir wins when the caller names one.
	if (realHome) process.env.HOME = realHome;
	process.env.USERPROFILE = process.env.HOME;
	const agentDir = explicitAgentDir
		? path.resolve(explicitAgentDir)
		: realAgentDir
			? path.resolve(realAgentDir)
			: path.join(process.env.HOME ?? os.homedir(), ".gjc", "agent");
	process.env.GJC_CODING_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
}
process.env.GJC_LOG_DIR = path.join(dataDir, "logs");
