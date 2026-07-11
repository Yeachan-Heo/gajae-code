/**
 * End-to-end fixture for the macOS malloc-env launch boundary.
 *
 * Mirrors the runCli() entry sequence: re-exec once when contaminated, then
 * report what a default-env child (no explicit `env`) actually inherits.
 * The parent test launches this with `MallocStackLogging=1` and expects the
 * re-exec'd run to report a clean default-spawn environment.
 */
import { mallocEnvNeedsReexec, reexecWithoutMallocEnv } from "../../src/cli/malloc-env-guard";

if (mallocEnvNeedsReexec()) {
	process.exit(await reexecWithoutMallocEnv());
}

const probe = Bun.spawnSync(["/usr/bin/printenv", "MallocStackLogging"]);
console.log(
	JSON.stringify({
		reexeced: process.env.GJC_MALLOC_ENV_REEXEC === "1",
		mallocVisibleToDefaultSpawn: probe.exitCode === 0 ? probe.stdout.toString().trim() : null,
	}),
);
