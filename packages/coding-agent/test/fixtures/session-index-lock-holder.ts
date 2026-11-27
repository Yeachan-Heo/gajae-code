import * as path from "node:path";
import { acquireFileLock } from "../../src/config/file-lock";
import { brokerLockHostIdentity } from "../../src/sdk/broker/lock-host-identity";

const agentDir = process.argv[2];
const mode = process.argv[3];
if (!agentDir || (mode !== "same-host" && mode !== "foreign")) {
	throw new Error("usage: session-index-lock-holder.ts <agentDir> <same-host|foreign>");
}

const indexPath = path.join(agentDir, "sdk", "sessions", "index.jsonl");
const identity =
	mode === "same-host"
		? await brokerLockHostIdentity(agentDir)
		: { ownerHostId: "foreign-session-index-host", previousOwnerHostIds: [] as const };
// Exit is SIGKILL from the parent. Releasing here would hide the dead-owner residue.
const release = await acquireFileLock(indexPath, { retries: 5, retryDelayMs: 10, ...identity });
await Bun.write(path.join(agentDir, "holder-ready"), await Bun.file(`${indexPath}.lock/info`).text());
void release;
const held = Promise.withResolvers<void>();
await held.promise;
