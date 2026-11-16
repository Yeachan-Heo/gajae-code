import * as crypto from "node:crypto";
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
	heartbeat: string;
	ownership: string;
	roots: string;
	steal: string;
	diagnostic: string;
	aliases: string;
	seenUpdates: string;
	ownerRegistry: string;
	recoveryReceipt: string;
}

export function agentDirDigest(agentDir: string): string {
	return crypto.createHash("sha256").update(path.resolve(agentDir)).digest("hex");
}

export function telegramDaemonOwnerMarkerPath(agentDir: string, acquisitionId: string): string {
	const safe =
		/^[A-Za-z0-9_.-]+$/.test(acquisitionId) && acquisitionId.length > 0 && acquisitionId.length <= 128
			? acquisitionId
			: crypto.createHash("sha256").update(acquisitionId).digest("hex");
	return path.join(daemonPaths(agentDir).ownerRegistry, `${safe}.json`);
}

export function daemonPaths(agentDir: string): DaemonPaths {
	const dir = path.join(agentDir, "notifications");
	return {
		dir,
		lock: path.join(dir, "telegram-daemon.lock"),
		state: path.join(dir, "telegram-daemon.state.json"),
		ownership: path.join(dir, "telegram-daemon.ownership"),
		heartbeat: path.join(dir, "telegram-daemon.heartbeat.json"),
		roots: path.join(dir, "telegram-daemon.roots.json"),
		steal: path.join(dir, "telegram-daemon.steal"),
		aliases: path.join(dir, "telegram-callback-aliases.json"),
		diagnostic: path.join(dir, "telegram-daemon.diagnostics.json"),
		seenUpdates: path.join(dir, "telegram-seen-updates.json"),
		ownerRegistry: path.join(dir, "telegram-daemon-owners"),
		recoveryReceipt: path.join(dir, "telegram-daemon.recovery.json"),
	};
}
