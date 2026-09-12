import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Shared path names; importing this module never initializes a service. */
export const BROKER_ARTIFACT_PATHS = {
	discovery: "sdk/broker.json",
	ownerLock: "sdk/broker.lock",
	ownerRecord: "sdk/broker.lock/owner.json",
	restartIntent: "sdk/broker.restart.json",
} as const;

/** Existing-root identity only; never creates a directory or identity file. */
export async function canonicalServiceRootDigest(agentDir: string): Promise<string> {
	const canonical = await fs.realpath(path.resolve(agentDir));
	const normalized = process.platform === "win32" ? canonical.replaceAll("\\", "/").toLowerCase() : canonical;
	return crypto.createHash("sha256").update(normalized).digest("hex");
}

export const DOCTOR_RESTART_CONTROL_FILE = "doctor-restart.control.json";
export const CHAT_DAEMON_DIRECTORY = "sdk/daemons";
export const CHAT_DAEMON_FILES = {
	ownerLock: "owner.lock",
	state: "state.json",
	control: "control.json",
} as const;
