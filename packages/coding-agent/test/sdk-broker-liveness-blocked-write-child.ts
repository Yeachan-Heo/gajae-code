/**
 * Child for the blocked-write liveness regression. Spawned as a plain bun
 * process so the watchdog's SIGKILL cannot take down the test runner.
 *
 * Usage: bun sdk-broker-liveness-blocked-write-child.ts <agentDir> <graceMs> <blockMs> [block-stderr]
 */
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Broker, setHeartbeatMainThreadBlockForTest, setLivenessGraceForTest } from "../src/sdk/broker/broker";

const agentDir = process.argv[2];
const graceMs = Number(process.argv[3]);
const blockMs = Number(process.argv[4]);
const blockStderr = process.argv[5] === "block-stderr";
if (!agentDir || !Number.isFinite(graceMs) || graceMs <= 0 || !Number.isFinite(blockMs) || blockMs <= 0) {
	fs.writeSync(2, "usage: publication-liveness-blocked-write-child <agentDir> <graceMs> <blockMs> [block-stderr]\n");
	process.exit(2);
}

/** Prepare a full private pipe before starting the watchdog. */
function prepareFullStderrPipe(): () => void {
	const library = process.platform === "linux" ? "libc.so.6" : "libSystem.B.dylib";
	const libc = dlopen(library, {
		mkfifo: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
		dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64_fast], returns: FFIType.i64_fast },
	});
	const errno =
		process.platform === "linux"
			? dlopen(library, { __errno_location: { args: [], returns: FFIType.ptr } }).symbols.__errno_location
			: dlopen(library, { __error: { args: [], returns: FFIType.ptr } }).symbols.__error;
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-liveness-pipe-"));
	const fifo = path.join(directory, "stderr");
	if (libc.symbols.mkfifo(Buffer.from(`${fifo}\0`), 0o600) !== 0) throw new Error("mkfifo failed");
	const readFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	const writeFd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
	const blockingWriteFd = fs.openSync(fifo, fs.constants.O_WRONLY);
	fs.unlinkSync(fifo);
	fs.rmdirSync(directory);
	const chunk = Buffer.alloc(65_536, 0x2e);
	let filled = false;
	let size = chunk.byteLength;
	for (let attempt = 0; attempt < 65_600; attempt += 1) {
		const written = libc.symbols.write(writeFd, ptr(chunk), size);
		if (written < 0) {
			const errnoPtr = errno();
			if (!errnoPtr) throw new Error("could not read errno");
			const code = new Int32Array(toArrayBuffer(errnoPtr, 0, 4))[0];
			if (code !== (process.platform === "linux" ? 11 : 35)) throw new Error(`pipe write failed: errno ${code}`);
			if (size !== 1) {
				size = 1;
				continue;
			}
			filled = true;
			break;
		}
	}
	if (!filled) throw new Error("stderr stand-in did not fill");
	fs.closeSync(writeFd);
	// Keep the read end open so writes block rather than fail with EPIPE.
	void readFd;
	return () => {
		if (libc.symbols.dup2(blockingWriteFd, 2) < 0) throw new Error("dup2 failed");
		if (blockingWriteFd !== 2) fs.closeSync(blockingWriteFd);
	};
}

const installBlockedStderr = blockStderr ? prepareFullStderrPipe() : undefined;
const broker = new Broker({ agentDir, heartbeatTtlMs: 300 });
try {
	await broker.start();
} catch (error) {
	fs.writeSync(2, `start failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(2);
}
if (installBlockedStderr) {
	installBlockedStderr();
	fs.writeSync(1, "stderr-blocked\n");
}
setLivenessGraceForTest(broker, graceMs);
setHeartbeatMainThreadBlockForTest(broker, blockMs);
fs.writeSync(1, "hooks-installed\n");
await broker.completion;
fs.writeSync(1, "graceful\n");
process.exit(0);
