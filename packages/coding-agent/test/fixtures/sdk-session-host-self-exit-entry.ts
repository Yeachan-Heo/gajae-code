import { createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import net from "node:net";
import path from "node:path";

const MAX_FRAME_BYTES = 4096;
const CONTROL_TTL_MS = 10_000;
type Bootstrap = { requestId: string; port: number; token: string; markerPath: string; nonce: string };

function closeFd3(): void {
	try {
		fs.closeSync(3);
	} catch {}
}
function readFrame(): Buffer {
	const header = Buffer.alloc(8);
	if (fs.readSync(3, header, 0, 8, null) !== 8 || header.subarray(0, 4).toString("ascii") !== "SSH1")
		throw new Error("invalid SSH1 frame");
	const length = header.readUInt32BE(4);
	if (length === 0 || length > MAX_FRAME_BYTES) throw new Error("invalid SSH1 length");
	const body = Buffer.alloc(length);
	if (fs.readSync(3, body, 0, length, null) !== length) throw new Error("truncated SSH1 frame");
	return body;
}
function proof(token: Buffer, domain: string, requestId: string): Buffer {
	return createHmac("sha256", token).update(`${domain}:${requestId}`).digest();
}
function parse(frame: Buffer): Bootstrap {
	try {
		const value: unknown = JSON.parse(frame.toString("utf8"));
		if (!value || typeof value !== "object") throw new Error("invalid SSH1 payload");
		const { requestId, port, token, markerPath, nonce } = value as Record<string, unknown>;
		if (
			typeof requestId !== "string" ||
			typeof port !== "number" ||
			typeof token !== "string" ||
			typeof markerPath !== "string" ||
			typeof nonce !== "string" ||
			!Number.isSafeInteger(port) ||
			port < 1 ||
			port > 65535
		)
			throw new Error("invalid SSH1 fields");
		const raw = Buffer.from(token, "base64");
		if (raw.length !== 32) throw new Error("invalid SSH1 token");
		return { requestId, port, token, markerPath, nonce };
	} finally {
		frame.fill(0);
	}
}
export async function runSessionHostSelfExitFixture(): Promise<void> {
	const bootstrap = parse(readFrame());
	closeFd3();
	const token = Buffer.from(bootstrap.token, "base64");
	let timer = setTimeout(() => process.exit(1), CONTROL_TTL_MS);
	const socket = net.connect({ host: "127.0.0.1", port: bootstrap.port });
	socket.once("error", () => process.exit(1));
	socket.once("connect", () => {
		const hello = proof(token, "SSH1-hello", bootstrap.requestId);
		socket.write(Buffer.concat([Buffer.from("HEL1"), hello]));
		hello.fill(0);
	});
	let received = Buffer.alloc(0);
	let exitAuthorized = false;
	const onHandshakeData = (data: Buffer): void => {
		received = Buffer.concat([received, data]);
		if (received.length < 36) return;
		const expected = proof(token, "SSH1-accept", bootstrap.requestId);
		const accepted =
			received.subarray(0, 4).toString("ascii") === "ACK1" && timingSafeEqual(received.subarray(4, 36), expected);
		const trailing = Buffer.from(received.subarray(36));
		expected.fill(0);
		received.fill(0);
		received = Buffer.alloc(0);
		if (!accepted) {
			trailing.fill(0);
			process.exit(1);
		}
		socket.off("data", onHandshakeData);
		clearTimeout(timer);
		timer = setTimeout(() => process.exit(1), CONTROL_TTL_MS);
		// The parent sends one authenticated self-exit capability after broker exit.
		let exitReceived = Buffer.alloc(0);
		const onExitData = (command: Buffer): void => {
			exitReceived = Buffer.concat([exitReceived, command]);
			command.fill(0);
			if (exitReceived.length < 36) return;
			socket.off("data", onExitData);
			const exit = proof(token, "SSH1-exit", bootstrap.requestId);
			const valid =
				exitReceived.length === 36 &&
				exitReceived.subarray(0, 4).toString("ascii") === "EXT1" &&
				timingSafeEqual(exitReceived.subarray(4), exit);
			exit.fill(0);
			exitReceived.fill(0);
			exitReceived = Buffer.alloc(0);
			token.fill(0);
			if (!valid) process.exit(1);
			exitAuthorized = true;
			socket.once("close", () => {
				clearTimeout(timer);
				process.exit(0);
			});
			socket.end("BYE1");
		};
		socket.on("data", onExitData);
		if (trailing.length > 0) onExitData(trailing);
	};
	socket.on("data", onHandshakeData);
	socket.once("end", () => {
		if (!exitAuthorized) process.exit(1);
	});
}
if (path.basename(process.argv[1] ?? "") === "sdk-session-host-self-exit-entry.ts")
	void runSessionHostSelfExitFixture().catch(() => process.exit(1));
