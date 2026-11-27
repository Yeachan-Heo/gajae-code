import { exactRemoveDirectoryTree, renameDirectoryNoReplacePath, snapshotDirectoryTree } from "@gajae-code/natives";
import { acquireFileLock, FileLockTestHooks } from "../../src/config/file-lock";

// A lock owner from a build that predates host-id stamping: it acquires and
// releases without `ownerHostId`, and is SIGKILLed partway through the release's
// removal, leaving `<lock>.removing` and a hostless `<lock>.removing.owner`.
const file = process.argv[2];
const phase = process.argv[3];
if (!file || (phase !== "after-rename" && phase !== "after-scrub")) {
	throw new Error("usage: hostless-lock-remover.ts <file> <after-rename|after-scrub>");
}

const lock = `${file}.lock`;
FileLockTestHooks.nativeQuarantineBindings = () => ({
	snapshotDirectoryTree,
	exactRemoveDirectoryTree(target, snapshot, ...rest) {
		if (target !== lock) return exactRemoveDirectoryTree(target, snapshot, ...rest);
		if (phase === "after-rename") {
			if (!renameDirectoryNoReplacePath(lock, `${lock}.removing`).ok) throw new Error("rename refused");
		} else {
			const removed = exactRemoveDirectoryTree(target, snapshot, ...rest);
			if (removed.code !== "cleanup_pending" || !removed.payloadDurable) throw new Error("scrub refused");
		}
		process.kill(process.pid, "SIGKILL");
		throw new Error("SIGKILL did not terminate remover");
	},
});

const release = await acquireFileLock(file, { retries: 5, retryDelayMs: 10 });
await release();
throw new Error("release completed without reaching the removal hook");
