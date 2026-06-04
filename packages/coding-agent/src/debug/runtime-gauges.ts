/**
 * Runtime resource owner gauges (Stage 2 observability).
 *
 * Reports counts of long-lived runtime owners as plain data so memory/CPU leak
 * work can see whether owner maps grow without bound across a session. This is
 * framework-agnostic on purpose: it does not depend on the TUI metrics surface,
 * so any consumer (debug report, a metrics bridge, a test) can sample it.
 */
import { getShellSessionCount } from "../exec/bash-executor";

/**
 * Current runtime owner counts, keyed by `<owner>.<resource>`. Extend as more
 * owners (Python kernels, LSP clients, browser tabs, async jobs, streaming
 * queues) expose count getters.
 */
export function getRuntimeResourceCounts(): Record<string, number> {
	return {
		"bash.shellSessions": getShellSessionCount(),
	};
}
