import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { runSessionHostSelfExitFixture } from "./sdk-session-host-self-exit-entry";

const MAX_FRAME_BYTES = 4096;
const SESSION_FIXTURE_BASENAME = `sdk-session-host-self-exit-fixture${process.platform === "win32" ? ".exe" : ""}`;
const SOURCE_SESSION_FIXTURE = "sdk-session-host-self-exit-entry.ts";
type Bootstrap = { requestId: string; port: number; token: string; markerPath: string };

function fail(message: string): never {
	throw new Error(`sdk broker fixture: ${message}`);
}
function closeFd3(): void {
	try {
		fsSync.closeSync(3);
	} catch {}
}

function readOneFrame(magic: string): Buffer {
	const header = Buffer.alloc(8);
	if (
		fsSync.readSync(3, header, 0, header.length, null) !== header.length ||
		header.subarray(0, 4).toString("ascii") !== magic
	)
		fail("invalid bootstrap frame");
	const size = header.readUInt32BE(4);
	if (size === 0 || size > MAX_FRAME_BYTES) fail("invalid bootstrap frame length");
	const body = Buffer.alloc(size);
	if (fsSync.readSync(3, body, 0, size, null) !== size) fail("truncated bootstrap frame");
	return body;
}
function parseBootstrap(frame: Buffer): Bootstrap {
	try {
		const value: unknown = JSON.parse(frame.toString("utf8"));
		if (!value || typeof value !== "object") fail("invalid bootstrap payload");
		const { requestId, port, token, markerPath } = value as Record<string, unknown>;
		if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(requestId)) fail("invalid request id");
		if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) fail("invalid port");
		if (typeof token !== "string" || Buffer.from(token, "base64").length !== 32) fail("invalid token");
		if (typeof markerPath !== "string" || markerPath.length === 0 || markerPath.length > 512)
			fail("invalid marker path");
		return { requestId, port, token, markerPath };
	} finally {
		frame.fill(0);
	}
}
async function sessionCommand(): Promise<{ file: string; args: string[] }> {
	const sourceEntrypoint = process.argv[1];
	const own = await fs.realpath(
		sourceEntrypoint && path.basename(sourceEntrypoint) === "sdk-broker-self-reap-entry.ts"
			? sourceEntrypoint
			: process.execPath,
	);
	if (sourceEntrypoint && path.basename(own) === "sdk-broker-self-reap-entry.ts") {
		const source = path.join(path.dirname(own), SOURCE_SESSION_FIXTURE);
		const stat = await fs.lstat(source);
		if (stat.isSymbolicLink() || !stat.isFile()) fail("source session fixture unavailable");
		return { file: process.execPath, args: [source] };
	}
	const sibling = path.join(path.dirname(own), SESSION_FIXTURE_BASENAME);
	const stat = await fs.lstat(sibling);
	if (path.basename(sibling) !== SESSION_FIXTURE_BASENAME || stat.isSymbolicLink() || !stat.isFile())
		fail("compiled session fixture unavailable");
	fsSync.accessSync(sibling, fsSync.constants.X_OK);
	return { file: sibling, args: [] };
}
async function main(): Promise<void> {
	const bootstrap = parseBootstrap(readOneFrame("GSF1"));
	const command = await sessionCommand();
	const payload = Buffer.from(
		JSON.stringify({
			...bootstrap,
			nonce: randomUUID(),
			digest: createHash("sha256").update(bootstrap.requestId).digest("hex"),
		}),
	);
	try {
		const child = spawn(command.file, command.args, {
			detached: true,
			stdio: ["ignore", "ignore", "ignore", "pipe"],
		});
		const control = child.stdio[3] as Writable | null;
		if (!control) fail("session fixture fd 3 unavailable");
		const frame = Buffer.alloc(8 + payload.length);
		frame.write("SSH1", 0, "ascii");
		frame.writeUInt32BE(payload.length, 4);
		payload.copy(frame, 8);
		await new Promise<void>((resolve, reject) => control.write(frame, error => (error ? reject(error) : resolve())));
		control.end();
		child.unref();
		frame.fill(0);
	} finally {
		payload.fill(0);
		closeFd3();
	}
}
if (path.basename(process.execPath) === SESSION_FIXTURE_BASENAME) {
	void runSessionHostSelfExitFixture().catch(() => process.exit(1));
} else {
	void main().catch(() => {
		closeFd3();
		process.exitCode = 1;
	});
}
