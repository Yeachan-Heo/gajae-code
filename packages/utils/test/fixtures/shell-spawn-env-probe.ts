// Prints the hook-capable variables in the bash tool spawn env, plus what the
// shared shell-config env (also consumed by Python kernels) still carries.
// Spawned with a controlled cwd so the caller can plant a project `.env`, which
// is parsed at module load from `process.cwd()`.
import { getTrustedHomeDir } from "../../src/dirs";
import { startupProjectEnvSnapshot } from "../../src/env";
import { getShellConfig } from "../../src/procmgr";
import { projectSafeHomeOverride, projectSafeSpawnEnv } from "../../src/shell-config";

const env = projectSafeSpawnEnv();
const shared = getShellConfig().env;
const projectEnv = startupProjectEnvSnapshot();
let trustedHome: string | null = null;
try {
	trustedHome = getTrustedHomeDir();
} catch {
	// A missing independently verifiable account home leaves HOME unset.
}
const keys = [
	"BASH_ENV",
	"BUN_OPTIONS",
	"PERLLIB",
	"_JAVA_OPTIONS",
	"NPM_CONFIG_NODE_OPTIONS",
	"RIPGREP_CONFIG_PATH",
	"TAR_OPTIONS",
	"RSYNC_RSH",
	"MAKEFLAGS",
	"MAKEFILES",
	"SHELLOPTS",
	"PS4",
	"NODE_OPTIONS",
	"PYTHONPATH",
	"PYTHONUSERBASE",
	"PYTHONSTARTUP",
	"JAVA_TOOL_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"LD_PRELOAD",
	"LD_AUDIT",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
	"GIT_ASKPASS",
	"GIT_EXEC_PATH",
	"GIT_PROXY_COMMAND",
	"GIT_SEQUENCE_EDITOR",
	"GIT_TEMPLATE_DIR",
	"ZDOTDIR",
	"ENV",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"XDG_CONFIG_HOME",
	"GIT_DIR",
	"GIT_COMMON_DIR",
	"GIT_SSH_COMMAND",
	"GIT_EXTERNAL_DIFF",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"GIT_CONFIG_PARAMETERS",
	"HOME",
	"UNRELATED_PROJECT_VAR",
];
console.log(
	JSON.stringify({
		...Object.fromEntries(keys.map(key => [key, env[key] ?? null])),
		NPM_NODE_OPTIONS_NAMES: Object.keys(env).filter(key =>
			/^npm_config_(?:node[_-]options|script[_-]shell)$/i.test(key),
		),
		LIVE_BASH_ENV: Bun.env.BASH_ENV ?? null,
		PROJECT_DYNAMIC_BASH_ENV: projectEnv.dynamic.has("BASH_ENV"),
		PROJECT_HAS_BASH_ENV_VALUE: Object.hasOwn(projectEnv.values, "BASH_ENV"),
		HOME_OVERRIDE: projectSafeHomeOverride().HOME ?? null,
		TRUSTED_HOME: trustedHome,
		SHARED_XDG_CONFIG_HOME: shared.XDG_CONFIG_HOME ?? null,
	}),
);
