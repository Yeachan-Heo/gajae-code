/**
 * Runs one remote command through the ssh tool's executor from the current
 * (project) directory the way the app does: `@gajae-code/utils/env` loads first
 * (copying the project `.env` into the process environment), then the executor
 * starts the ssh control master, probes the host, mounts it with sshfs when
 * available, and runs the command. `ssh`, `sshfs`, and `mountpoint` are shims
 * on PATH that record the environment they received.
 */
import "@gajae-code/utils/env";
import { executeSSH } from "../../src/ssh/ssh-executor";

try {
	await executeSSH({ name: "probe", host: "probe.invalid", username: "probe" }, "true");
} catch {
	// Only what the shims recorded matters.
}
console.log(JSON.stringify({ done: true }));
process.exit(0);
