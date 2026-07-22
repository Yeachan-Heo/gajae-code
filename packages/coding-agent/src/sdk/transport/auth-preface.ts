import { createHash, timingSafeEqual } from "node:crypto";
import type * as net from "node:net";

const PREFACE_LIMIT_BYTES = 4 * 1024;
const PREFACE_TIMEOUT_MS = 1_000;
const VERSION = "gjc-sdk-transport/1";

type AuthFailureCode =
	| "auth_missing"
	| "auth_malformed"
	| "auth_invalid"
	| "auth_oversize"
	| "auth_timeout"
	| "unsupported_version";

export class AuthPrefaceError extends Error {
	constructor(readonly code: AuthFailureCode) {
		super(code);
		this.name = "AuthPrefaceError";
	}
}

function digest(token: string): Buffer {
	return createHash("sha256").update(token).digest();
}

function validToken(received: string, expected: string): boolean {
	return timingSafeEqual(digest(received), digest(expected));
}

function failureFrame(): string {
	return `${JSON.stringify({ type: "transport_error", code: "auth_failed" })}\n`;
}

/** Consumes the one-shot socket authentication preface and leaves later bytes readable. */
export async function authenticatePreface(socket: net.Socket, token: string): Promise<Buffer> {
	return await new Promise<Buffer>((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		let settled = false;
		const finish = (error?: AuthPrefaceError, remainder = Buffer.alloc(0)): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.removeListener("data", onData);
			socket.removeListener("end", onEnd);
			socket.removeListener("error", onSocketError);
			if (error) {
				socket.end(failureFrame(), () => reject(error));
				return;
			}
			socket.pause();
			resolve(remainder);
		};
		const fail = (code: AuthFailureCode): void => finish(new AuthPrefaceError(code));
		const onSocketError = (): void => fail("auth_missing");
		const onEnd = (): void => fail(buffer.length === 0 ? "auth_missing" : "auth_malformed");
		const onData = (chunk: Buffer): void => {
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(0x0a);
			if (newline < 0) {
				if (buffer.length > PREFACE_LIMIT_BYTES) fail("auth_oversize");
				return;
			}
			if (newline > PREFACE_LIMIT_BYTES) return fail("auth_oversize");
			const line = buffer.subarray(0, newline).toString("utf8");
			const remainder = buffer.subarray(newline + 1);
			const prefix = `${VERSION} token=`;
			if (!line.startsWith(prefix)) {
				return fail(line.startsWith("gjc-sdk-transport/") ? "unsupported_version" : "auth_malformed");
			}
			const received = line.slice(prefix.length);
			if (received.length === 0 || /\s/.test(received)) return fail("auth_malformed");
			if (!validToken(received, token)) return fail("auth_invalid");
			finish(undefined, remainder);
		};
		const timeout = setTimeout(() => fail("auth_timeout"), PREFACE_TIMEOUT_MS);
		socket.on("data", onData);
		socket.once("end", onEnd);
		socket.once("error", onSocketError);
		socket.resume();
	});
}
