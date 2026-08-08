import type { Subprocess } from "bun";
import { nativeProcessBindings } from "./native-process";

// Shell configuration lives in the natives-free ./shell-config module so
// consumers that only need shell resolution (e.g. Settings.getShellConfig)
// can import it without materializing @gajae-code/natives (W5b S1/idle
// module-trace gate). Re-exported here for compatibility with existing
// procmgr consumers, which already depend on natives for process control.
export {
	getShellConfig,
	resetShellConfigCache,
	resolveBasicShell,
	type ShellConfig,
	scrubProcessEnv,
} from "./shell-config";

/**
 * Check if a process is running.
 */
export function isPidRunning(pid: number | Subprocess): boolean {
	if (typeof pid !== "number") {
		if (pid.killed) return false;
		if (pid.exitCode !== null) return false;
		return true;
	}

	const { Process, ProcessStatus } = nativeProcessBindings();
	return Process.fromPid(pid)?.status() === ProcessStatus.Running;
}

export async function onProcessExit(proc: Subprocess | number, abortSignal?: AbortSignal): Promise<boolean> {
	if (typeof proc !== "number") {
		return proc.exited.then(
			() => true,
			() => true,
		);
	}

	const { Process } = nativeProcessBindings();
	return (await Process.fromPid(proc)?.waitForExit({ signal: abortSignal })) ?? true;
}
