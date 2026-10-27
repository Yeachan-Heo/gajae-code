import * as os from "node:os";
import * as path from "node:path";
import { isolateEnvironment } from "./environment-policy";

// This module is the first import of the process entrypoint, before the SDK
// captures discovery roots. It must remain synchronous and SDK-independent.
const dataDir = path.resolve(
	process.env.GJC_DESKTOP_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "Gajae Code Desktop"),
);
isolateEnvironment(process.env);
process.env.GJC_DESKTOP_DATA_DIR = dataDir;
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
process.env.GJC_LOG_DIR = path.join(dataDir, "logs");
