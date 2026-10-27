import { SessionStateLockUnavailableError, withSessionStateFileLock } from "../../src/gjc-runtime/session-state-lock";

/**
 * One cross-process writer against a shared session-state file.
 *
 * The contention this reproduces is between SEPARATE gjc processes: the Coordinator MCP
 * writer and every runtime sidecar take `<file>.lock` directly, so in-process
 * serialization proves nothing about them. Each writer performs a real read-modify-write
 * that appends its own marks, so a lost update is observable as a missing mark rather than
 * only as a thrown error.
 *
 * `holdMs` widens the critical section to the scale of a real state-file write, which is
 * what makes cross-process starvation reproducible instead of merely possible.
 *
 * argv: <stateFile> <writerId> <writes> <holdMs>
 */
const stateFile = process.argv[2];
const writerId = process.argv[3];
const writes = Number(process.argv[4] ?? "1");
const holdMs = Number(process.argv[5] ?? "1");
const readyFile = process.argv[6];
if (!stateFile || !writerId || !Number.isSafeInteger(writes) || writes <= 0 || !Number.isFinite(holdMs))
	throw new Error("usage: <stateFile> <writerId> <writes> <holdMs>");

interface ProbeFailure {
	reason: string | null;
	lockPath: string | null;
	message: string;
}

const failures: ProbeFailure[] = [];
let committed = 0;

for (let index = 0; index < writes; index++) {
	try {
		await withSessionStateFileLock(stateFile, async () => {
			if (readyFile) await Bun.write(readyFile, "ready");
			const file = Bun.file(stateFile);
			const marks =
				((await file.exists()) ? (JSON.parse(await file.text()) as { marks?: string[] }).marks : []) ?? [];
			// A real read-modify-write window: without mutual exclusion two writers read
			// the same array and one of the two appends is lost.
			await Bun.sleep(holdMs);
			marks.push(`${writerId}:${index}`);
			await Bun.write(stateFile, JSON.stringify({ marks }));
		});
		committed++;
	} catch (error) {
		failures.push({
			reason: error instanceof SessionStateLockUnavailableError ? (error.reason ?? null) : null,
			lockPath: error instanceof SessionStateLockUnavailableError ? (error.lockPath ?? null) : null,
			message: String(error),
		});
	}
}

process.stdout.write(`${JSON.stringify({ writerId, committed, failures })}\n`);
