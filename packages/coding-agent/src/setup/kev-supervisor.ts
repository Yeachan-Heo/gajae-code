/**
 * Process-bound control channel for the owned local Kev server.
 *
 * `gjc setup kev start` never launches `kev.serve` directly. It launches this
 * supervisor, which owns the server as its own `subprocess.Popen` child and
 * answers an authenticated AF_UNIX control socket. Stopping therefore never
 * resolves a bare numeric pid: the supervisor signals a handle to an un-reaped
 * child of its own, a pid the kernel cannot recycle while that handle is held.
 * A caller that only knows a pid — including this process after the recorded
 * supervisor has exited — can signal nothing at all.
 */

import * as net from "node:net";
import { z } from "zod";

export const SUPERVISOR_FILE = "supervisor.py";
export const CONTROL_FILE = "control.sock";
/** macOS `sun_path` is 104 bytes including the terminator; bind must never silently truncate. */
export const CONTROL_SOCKET_PATH_MAX = 103;
/** Longer than the supervisor's terminate grace so a legitimate slow shutdown is still observed. */
const CONTROL_TIMEOUT_MS = 20_000;
const CONTROL_REPLY_MAX = 4096;

export const controlReplySchema = z
	.object({
		ok: z.boolean(),
		error: z.string().max(200).optional(),
		pid: z.number().int().min(2).optional(),
		exit: z.number().int().nullable().optional(),
		state: z.enum(["running", "exited"]).optional(),
	})
	.strict();
export type KevControlReply = z.infer<typeof controlReplySchema>;

/** A control request carries the operation and the start-time token, never a pid. */
export function controlRequest(op: "stop" | "status", token: string): string {
	return `${JSON.stringify({ op, token })}\n`;
}

export function controlSocketPathIsBindable(socketPath: string): boolean {
	return Buffer.byteLength(socketPath, "utf8") <= CONTROL_SOCKET_PATH_MAX;
}

/**
 * Send one newline-delimited request and read one newline-delimited reply.
 * Every failure resolves `undefined`: an unreachable or silent supervisor must
 * leave the caller with no outcome to act on, never a fallback signal.
 */
export function kevControl(socketPath: string, message: string): Promise<KevControlReply | undefined> {
	return new Promise(resolve => {
		let settled = false;
		let buffer = "";
		const socket = net.createConnection({ path: socketPath });
		const finish = (reply?: KevControlReply) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(reply);
		};
		socket.setTimeout(CONTROL_TIMEOUT_MS, () => finish(undefined));
		socket.on("connect", () => socket.write(message));
		socket.on("data", chunk => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return buffer.length > CONTROL_REPLY_MAX ? finish(undefined) : undefined;
			const parsed = controlReplySchema.safeParse(
				((): unknown => {
					try {
						return JSON.parse(buffer.slice(0, newline));
					} catch {
						return undefined;
					}
				})(),
			);
			finish(parsed.success ? parsed.data : undefined);
		});
		socket.on("error", () => finish(undefined));
		socket.on("close", () => finish(undefined));
	});
}

/**
 * Supervisor source, written into the private Kev root as a 0600 file at start.
 *
 * Invoked as `python supervisor.py --socket <path> -- <command> [args...]`.
 * The 32-byte hex control token arrives as the first line on stdin so it never
 * reaches argv or the environment, where any local user could read it.
 */
export const KEV_SUPERVISOR_SOURCE = `"""GJC-managed supervisor for the owned local Kev server.

Written by \`gjc setup kev start\`. Owns \`kev.serve\` as its own child and answers
an authenticated AF_UNIX control socket so that stopping the server never
depends on resolving a bare, recyclable pid.
"""

import errno
import hmac
import json
import os
import signal
import socket
import subprocess
import sys
import time

GRACE_SECONDS = 10.0
MAX_REQUEST = 4096
SUN_PATH_MAX = 103
TOKEN_LENGTH = 64


def fail(message):
    sys.stderr.write("gjc-kev-supervisor: %s\\n" % message)
    sys.stderr.flush()
    raise SystemExit(2)


def reply(connection, payload):
    try:
        connection.sendall((json.dumps(payload) + "\\n").encode("utf-8"))
    except OSError:
        pass


def cleanup(listener, socket_path):
    try:
        listener.close()
    except OSError:
        pass
    try:
        os.unlink(socket_path)
    except OSError:
        pass


def terminate(child):
    # send_signal/kill target this process's own un-reaped child handle. The
    # kernel cannot recycle that pid before wait() reaps it, so there is no
    # check-to-signal window here of the kind a bare pid signal would have.
    if child.poll() is None:
        try:
            child.send_signal(signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + GRACE_SECONDS
    while child.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)
    if child.poll() is None:
        try:
            child.kill()
        except OSError:
            pass
    try:
        return child.wait(timeout=5)
    except Exception:
        return None


def serve(connection, child, token):
    connection.settimeout(5.0)
    data = b""
    try:
        while b"\\n" not in data and len(data) <= MAX_REQUEST:
            chunk = connection.recv(MAX_REQUEST)
            if not chunk:
                break
            data += chunk
    except (socket.timeout, OSError):
        return False
    try:
        request = json.loads(data.split(b"\\n", 1)[0].decode("utf-8"))
        op = request["op"]
        presented = request.get("token", "")
    except (ValueError, KeyError, TypeError, AttributeError, UnicodeDecodeError):
        reply(connection, {"ok": False, "error": "malformed"})
        return False
    # Refuse before touching the child: an unauthenticated request signals nothing.
    if not isinstance(presented, str) or not hmac.compare_digest(presented, token):
        reply(connection, {"ok": False, "error": "refused"})
        return False
    if op == "status":
        alive = child.poll() is None
        reply(connection, {"ok": True, "pid": child.pid, "state": "running" if alive else "exited"})
        return False
    if op != "stop":
        reply(connection, {"ok": False, "error": "unsupported"})
        return False
    code = terminate(child)
    reply(connection, {"ok": True, "exit": code})
    return True


def main(argv):
    if len(argv) < 4 or argv[0] != "--socket" or argv[2] != "--":
        fail("usage: supervisor.py --socket <path> -- <command> [args...]")
    socket_path = argv[1]
    command = argv[3:]
    if not command:
        fail("no supervised command")
    if len(socket_path.encode("utf-8")) > SUN_PATH_MAX:
        fail("control socket path is too long for AF_UNIX")
    token = sys.stdin.readline().strip()
    try:
        sys.stdin.close()
    except OSError:
        pass
    if len(token) != TOKEN_LENGTH:
        fail("control token was not delivered on stdin")

    previous_umask = os.umask(0o077)
    try:
        try:
            os.unlink(socket_path)
        except OSError as error:
            if error.errno != errno.ENOENT:
                fail("control socket path is occupied")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(socket_path)
        os.chmod(socket_path, 0o600)
        listener.listen(4)
        listener.settimeout(0.25)
    finally:
        os.umask(previous_umask)

    child = subprocess.Popen(command, stdin=subprocess.DEVNULL)

    def shutdown(_signum, _frame):
        terminate(child)
        cleanup(listener, socket_path)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    while True:
        if child.poll() is not None:
            cleanup(listener, socket_path)
            return 0
        try:
            connection, _ = listener.accept()
        except socket.timeout:
            continue
        except OSError as error:
            if error.errno == errno.EINTR:
                continue
            raise
        try:
            if serve(connection, child, token):
                cleanup(listener, socket_path)
                return 0
        finally:
            try:
                connection.close()
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
`;
