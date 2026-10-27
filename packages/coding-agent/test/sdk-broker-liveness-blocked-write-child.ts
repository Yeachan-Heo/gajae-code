/**
 * Child for the blocked-write liveness regression. Spawned as a plain bun
 * process so the watchdog's SIGKILL cannot take down the test runner.
 *
 * Usage: bun sdk-broker-liveness-blocked-write-child.ts <agentDir> <graceMs> <blockMs> [block-stderr]
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { Broker, setHeartbeatMainThreadBlockForTest, setLivenessGraceForTest } from "../src/sdk/broker/broker";

const agentDir = process.argv[2];
const graceMs = Number(process.argv[3]);
const blockMs = Number(process.argv[4]);
const blockStderr = process.argv[5] === "block-stderr";
if (!agentDir || !Number.isFinite(graceMs) || graceMs <= 0 || !Number.isFinite(blockMs) || blockMs <= 0) {
	fs.writeSync(2, "usage: publication-liveness-blocked-write-child <agentDir> <graceMs> <blockMs> [block-stderr]\n");
	process.exit(2);
}

function isEagain(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EAGAIN";
}

/** Point fd 2 at a private pipe that is already full and left in blocking mode. */
function blockStderrWithFullPipe(): void {
	const library = process.platform === "linux" ? "libc.so.6" : "libSystem.B.dylib";
	const nonblock = process.platform === "linux" ? 0o4000 : 0x4;
	const libc = dlopen(library, {
		pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
		dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});
	const fds = new Int32Array(2);
	if (libc.symbols.pipe(ptr(fds)) !== 0) throw new Error("pipe failed");
	const readFd = fds[0] ?? -1;
	const writeFd = fds[1] ?? -1;
	const flags = libc.symbols.fcntl(writeFd, 3, 0);
	if (flags < 0 || libc.symbols.fcntl(writeFd, 4, flags | nonblock) < 0) throw new Error("fcntl failed");
	const chunk = Buffer.alloc(65_536, 0x2e);
	let filled = false;
	for (let attempt = 0; attempt < 64; attempt += 1) {
		try {
			fs.writeSync(writeFd, chunk);
		} catch (error) {
			if (!isEagain(error)) throw error;
			filled = true;
			break;
		}
	}
	if (!filled) throw new Error("stderr stand-in did not fill");
	if (libc.symbols.fcntl(writeFd, 4, flags) < 0) throw new Error("fcntl restore failed");
	if (libc.symbols.dup2(writeFd, 2) < 0) throw new Error("dup2 failed");
	if (writeFd !== 2) fs.closeSync(writeFd);
	// `readFd` stays open so a later write gets EAGAIN/blocks instead of EPIPE.
	void readFd;
}

const broker = new Broker({ agentDir, heartbeatTtlMs: 300 });
try {
	await broker.start();
} catch (error) {
	fs.writeSync(2, `start failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(2);
}
setLivenessGraceForTest(broker, graceMs);
setHeartbeatMainThreadBlockForTest(broker, blockMs);
fs.writeSync(1, "hooks-installed\n");
if (blockStderr) {
	blockStderrWithFullPipe();
	fs.writeSync(1, "stderr-blocked\n");
}
await broker.completion;
fs.writeSync(1, "graceful\n");
process.exit(0);
