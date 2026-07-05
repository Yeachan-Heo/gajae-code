import * as path from "node:path";

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
