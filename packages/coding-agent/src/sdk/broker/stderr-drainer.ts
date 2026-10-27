import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_DRAIN_BYTES = 64 * 1024;

function parseMaxBytes(value: string): number {
	if (!/^[0-9]+$/u.test(value)) throw new Error("Invalid lifecycle stderr drainer byte limit.");
	const maxBytes = Number(value);
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_DRAIN_BYTES)
		throw new Error("Invalid lifecycle stderr drainer byte limit.");
	return maxBytes;
}

/** Parse and run the private source/compiled CLI drainer route. */
export async function runSdkStderrDrainerFromArgv(argv: readonly string[]): Promise<void> {
	if (argv.length !== 4 || argv[0] !== "--path" || argv[1] === undefined || argv[2] !== "--max-bytes")
		throw new Error("Invalid lifecycle stderr drainer invocation.");
	if (!path.isAbsolute(argv[1])) throw new Error("Invalid lifecycle stderr drainer path.");
	await runSdkStderrDrainer(argv[1], parseMaxBytes(argv[3] ?? ""));
}

/**
 * Drain a detached lifecycle host's stderr without letting a noisy child grow
 * its diagnostic artifact. The drainer owns the read side of the pipe, so the
 * host remains attached to a process that outlives the broker itself.
 *
 * The artifact is written through one descriptor opened up front: once the
 * broker has finished reading the startup diagnostic it unlinks the path, and
 * the remaining output lands on an unlinked inode that disappears with this
 * process instead of accumulating under the agent directory.
 */
export async function runSdkStderrDrainer(logPath: string, maxBytes: number): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(logPath, "w", 0o600);
	} catch {
		// Diagnostics are best effort; keep draining so the host never blocks.
	}
	let tail = Buffer.alloc(0);
	try {
		for await (const chunk of process.stdin) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
			if (bytes.length >= maxBytes) tail = Buffer.from(bytes.subarray(bytes.length - maxBytes));
			else {
				const combined = Buffer.concat([tail, bytes]);
				tail = combined.length > maxBytes ? Buffer.from(combined.subarray(combined.length - maxBytes)) : combined;
			}
			if (!handle) continue;
			try {
				await handle.truncate(0);
				await handle.write(tail, 0, tail.length, 0);
			} catch {
				// Diagnostics are best effort; continue draining so the host never blocks.
			}
		}
	} finally {
		await handle?.close().catch(() => undefined);
	}
}
