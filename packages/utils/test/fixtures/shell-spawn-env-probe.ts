// Prints the hook-capable variables in the bash tool spawn env. Spawned with a
// controlled cwd so the caller can plant a project `.env`, which is parsed at
// module load from `process.cwd()`.
import { getShellConfig } from "../../src/procmgr";

const env = getShellConfig().env;
const keys = [
	"BASH_ENV",
	"ENV",
	"GIT_EXTERNAL_DIFF",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"GIT_CONFIG_PARAMETERS",
	"UNRELATED_PROJECT_VAR",
];
console.log(JSON.stringify(Object.fromEntries(keys.map(key => [key, env[key] ?? null]))));
