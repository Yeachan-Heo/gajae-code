import * as path from "node:path";

/**
 * Owner heartbeat freshness window. A daemon ownership record older than this
 * (without a live pid) is considered stale. Lives here, in the lightweight
 * paths module, so secret-safe consumers (e.g. the notification service) can
 * reuse it without importing the heavy daemon runtime.
 */
export const HEARTBEAT_TTL_MS = 20_000;

export interface DaemonPaths {
	dir: string;
	lock: string;
	state: string;
	roots: string;
	steal: string;
	aliases: string;
	seenUpdates: string;
}

export function daemonPaths(agentDir: string): DaemonPaths {
	const dir = path.join(agentDir, "notifications");
	return {
		dir,
		lock: path.join(dir, "telegram-daemon.lock"),
		state: path.join(dir, "telegram-daemon.state.json"),
		roots: path.join(dir, "telegram-daemon.roots.json"),
		steal: path.join(dir, "telegram-daemon.steal"),
		aliases: path.join(dir, "telegram-callback-aliases.json"),
		seenUpdates: path.join(dir, "telegram-seen-updates.json"),
	};
}
