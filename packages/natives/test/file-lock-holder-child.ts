/**
 * Holds a native file lock for `file-lock.test.ts`.
 *
 * Acquires `FILE_LOCK_PATH`, optionally starts a grandchild through the native
 * shell (whose spawner, unlike `Bun.spawn`, passes every descriptor without
 * close-on-exec to the child), prints one JSON ready line, then releases on a
 * `release` line from stdin.
 */
import * as fs from "node:fs/promises";
import { executeShell, type FileLock, FileLockAcquireStatus, tryAcquireFileLock } from "../native/index.js";

const lockPath = process.env.FILE_LOCK_PATH;
if (!lockPath) throw new Error("missing FILE_LOCK_PATH");
const grandchildPidFile = process.env.FILE_LOCK_GRANDCHILD_PID_FILE;

const result = await tryAcquireFileLock(lockPath);
if (result.status !== FileLockAcquireStatus.Acquired || !result.lock) {
	process.stdout.write(`${JSON.stringify({ status: result.status, code: result.code ?? null })}\n`);
	process.exit(3);
}
const lock: FileLock = result.lock;

let grandchild: number | null = null;
if (grandchildPidFile) {
	void executeShell({
		command: `/bin/sh -c 'echo $$ > "$FILE_LOCK_GRANDCHILD_PID_FILE"; exec sleep 60'`,
		env: { FILE_LOCK_GRANDCHILD_PID_FILE: grandchildPidFile },
	});
	const deadline = Date.now() + 10_000;
	while (grandchild === null) {
		const text = await fs.readFile(grandchildPidFile, "utf8").catch(() => "");
		if (text.endsWith("\n")) grandchild = Number(text.trim());
		else if (Date.now() > deadline) throw new Error("grandchild never wrote its pid");
		else await Bun.sleep(10);
	}
}

process.stdout.write(`${JSON.stringify({ status: result.status, grandchild })}\n`);

for await (const chunk of process.stdin) {
	if (Buffer.from(chunk).toString("utf8").includes("release")) {
		lock.release();
		process.stdout.write("released\n");
	}
}
