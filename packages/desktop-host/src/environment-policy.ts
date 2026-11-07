import * as os from "node:os";
import * as path from "node:path";

const runtimeVariables = new Set([
	"PATH",
	"HOME",
	"USERPROFILE",
	"USER",
	"USERNAME",
	"LOGNAME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"TZ",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"GJC_DESKTOP_DATA_DIR",
]);

/** Keep OS launch essentials, not inherited provider credentials or routing overrides. */
export function isolateEnvironment(environment: Record<string, string | undefined>): void {
	for (const key of Object.keys(environment)) {
		if (!runtimeVariables.has(key.toUpperCase()) && !key.toUpperCase().startsWith("LC_")) delete environment[key];
	}
}

const sharedRoots = [
	"GJC_CONFIG_DIR",
	"PI_CONFIG_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;

/** SDK-independent and idempotent: entrypoint and host initialization use the same policy. */
export function prepareDesktopEnvironment(environment: Record<string, string | undefined>, dataDir: string): string {
	const isolated = environment.GJC_DESKTOP_ISOLATED === "1";
	const home = environment.HOME || os.homedir();
	const explicitAgent = environment.GJC_DESKTOP_AGENT_DIR?.trim();
	const inheritedAgent = environment.GJC_CODING_AGENT_DIR?.trim() || environment.PI_CODING_AGENT_DIR?.trim();
	const trace = environment.GJC_DESKTOP_TRACE === "1";
	const roots = sharedRoots.map(key => [key, environment[key]] as const);
	const root = path.resolve(dataDir);
	isolateEnvironment(environment);
	environment.GJC_DESKTOP_DATA_DIR = root;
	environment.GJC_DESKTOP_ISOLATED = isolated ? "1" : "0";
	if (trace) environment.GJC_DESKTOP_TRACE = "1";
	let agentDir: string;
	if (isolated) {
		environment.HOME = path.join(root, "home");
		agentDir = path.join(root, "agent");
		environment.GJC_CONFIG_DIR = ".gjc-desktop";
		environment.PI_CONFIG_DIR = ".gjc-desktop";
		environment.XDG_CONFIG_HOME = path.join(root, "config");
		environment.XDG_DATA_HOME = path.join(root, "data");
		environment.XDG_STATE_HOME = path.join(root, "state");
		environment.XDG_CACHE_HOME = path.join(root, "cache");
	} else {
		environment.HOME = home;
		agentDir = path.resolve(explicitAgent || inheritedAgent || path.join(home, ".gjc", "agent"));
		for (const [key, value] of roots) if (value !== undefined) environment[key] = value;
	}
	environment.USERPROFILE = environment.HOME;
	environment.GJC_CODING_AGENT_DIR = agentDir;
	environment.PI_CODING_AGENT_DIR = agentDir;
	environment.GJC_LOG_DIR = path.join(root, "logs");
	return agentDir;
}
