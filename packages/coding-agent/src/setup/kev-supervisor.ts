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
export const SERVICE_SHIM_FILE = "kev-service.py";
export const CONTROL_FILE = "control.sock";
/** Names the inherited pipe the service watches; kept out of argv so ownership text stays fixed. */
export const WATCH_FD_ENV = "GJC_KEV_WATCH_FD";
/** macOS `sun_path` is 104 bytes including the terminator; bind must never silently truncate. */
export const CONTROL_SOCKET_PATH_MAX = 103;
/** Longer than the supervisor's terminate grace so a legitimate slow shutdown is still observed. */
const CONTROL_TIMEOUT_MS = 20_000;
/** Inference replies are the largest thing this channel carries; matches the provider's body cap. */
const CONTROL_REPLY_MAX = 64 * 1024;

export const controlReplySchema = z
	.object({
		ok: z.boolean(),
		error: z.string().max(200).optional(),
		pid: z.number().int().min(2).optional(),
		exit: z.number().int().nullable().optional(),
		state: z.enum(["running", "exited"]).optional(),
		/** HTTP status the supervisor's own child returned for an `infer` request. */
		status: z.number().int().min(100).max(599).optional(),
		/** Verbatim response body from that child, bounded by the supervisor. */
		body: z.string().optional(),
	})
	.strict();
export type KevControlReply = z.infer<typeof controlReplySchema>;

/** A control request carries the operation and the start-time token, never a pid. */
export function controlRequest(op: "stop" | "status", token: string): string {
	return `${JSON.stringify({ op, token })}\n`;
}

/**
 * Ask the supervisor to run one inference against the server it owns.
 *
 * The body never leaves this machine's socket: the supervisor forwards it to its
 * own child on loopback, so task text cannot reach whatever else might be
 * listening on that port.
 */
export function controlInferRequest(token: string, body: string): string {
	return `${JSON.stringify({ op: "infer", token, body })}\n`;
}

/**
 * Did the supervisor actually reap the service?
 *
 * Only a numeric exit status says so. `ok` alone does not: the supervisor
 * replies `exit_unconfirmed` when its own `wait()` timed out, and a caller that
 * treated that as success would retire the ownership record while the service
 * may still be holding its port.
 */
export function isConfirmedStop(reply: KevControlReply | undefined): boolean {
	return reply?.ok === true && typeof reply.exit === "number";
}

export function controlSocketPathIsBindable(socketPath: string): boolean {
	return Buffer.byteLength(socketPath, "utf8") <= CONTROL_SOCKET_PATH_MAX;
}

/**
 * Send one newline-delimited request and read one newline-delimited reply.
 * Every failure resolves `undefined`: an unreachable or silent supervisor must
 * leave the caller with no outcome to act on, never a fallback signal.
 */
export function kevControl(
	socketPath: string,
	message: string,
	timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<KevControlReply | undefined> {
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
		socket.setTimeout(timeoutMs, () => finish(undefined));
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
 * Service shim source, written beside the supervisor as a 0600 file at start.
 *
 * Invoked as `python kev-service.py -- <module> [args...]`. It runs the server
 * module in its own process through runpy — so the supervisor's child pid *is*
 * the server, with no extra process in between — after arming a watchdog on the
 * pipe the supervisor passes down. Losing that pipe means the supervisor died,
 * including by SIGKILL, and the server takes itself down rather than outliving
 * the only thing that could have stopped it.
 */
export const KEV_SERVICE_SHIM_SOURCE = `"""GJC-managed Kev service shim.

Written by \`gjc setup kev start\`. Runs the server module in this process and
exits with the supervisor: a supervisor that dies for any reason closes the
write end of an inherited pipe, and the read below returns EOF.
"""

import os
import runpy
import signal
import sys
import threading
import time

WATCH_FD_ENV = "${WATCH_FD_ENV}"
GRACE_SECONDS = 10.0
EXIT_SUPERVISOR_LOST = 71


def fail(message):
    sys.stderr.write("gjc-kev-service: %s\\n" % message)
    sys.stderr.flush()
    raise SystemExit(2)


def shutdown_when_supervisor_is_lost(fd):
    try:
        while os.read(fd, 1):
            pass
    except OSError:
        pass
    # EOF: the supervisor holds the only write end and never writes to it, so
    # this can only mean the supervisor is gone. Ask this process to stop, then
    # leave unconditionally so a server ignoring SIGTERM cannot outlive it.
    try:
        os.kill(os.getpid(), signal.SIGTERM)
    except OSError:
        pass
    time.sleep(GRACE_SECONDS)
    os._exit(EXIT_SUPERVISOR_LOST)


def main(argv):
    if len(argv) < 2 or argv[0] != "--":
        fail("usage: kev-service.py -- <module> [args...]")
    module = argv[1]
    descriptor = os.environ.get(WATCH_FD_ENV, "")
    if not descriptor.isdigit():
        fail("supervisor watch descriptor was not provided")
    watcher = threading.Thread(
        target=shutdown_when_supervisor_is_lost, args=(int(descriptor),), daemon=True
    )
    watcher.start()
    sys.argv = [module] + list(argv[2:])
    runpy.run_module(module, run_name="__main__", alter_sys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
`;

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
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import time

GRACE_SECONDS = 10.0
MAX_REQUEST = 256 * 1024
MAX_RESPONSE = 64 * 1024
SUN_PATH_MAX = 103
TOKEN_LENGTH = 64
INFER_TIMEOUT_SECONDS = 60.0
# Fixed: callers choose neither host, port nor path, so this channel can only ever
# reach the server this supervisor started.
SERVICE_PATH = "/v1/systemone"


def fail(message):
    sys.stderr.write("gjc-kev-supervisor: %s\\n" % message)
    sys.stderr.flush()
    raise SystemExit(2)


def reply(connection, payload):
    try:
        connection.sendall((json.dumps(payload) + "\\n").encode("utf-8"))
    except OSError:
        pass


def cleanup(listener, socket_path, watch_write=None):
    try:
        listener.close()
    except OSError:
        pass
    try:
        os.unlink(socket_path)
    except OSError:
        pass
    if watch_write is not None:
        try:
            os.close(watch_write)
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


def infer(port, body):
    # The destination is this supervisor's own child on loopback. Nothing in the
    # request chooses it, so an unrelated listener that grabbed the port cannot
    # be handed task text by a caller.
    if not isinstance(body, str) or len(body.encode("utf-8")) > MAX_REQUEST:
        return {"ok": False, "error": "invalid_request"}
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=INFER_TIMEOUT_SECONDS)
    try:
        payload = body.encode("utf-8")
        connection.request(
            "POST",
            SERVICE_PATH,
            body=payload,
            headers={"Content-Type": "application/json", "Content-Length": str(len(payload))},
        )
        response = connection.getresponse()
        received = response.read(MAX_RESPONSE + 1)
        if len(received) > MAX_RESPONSE:
            return {"ok": False, "error": "response_too_large"}
        return {"ok": True, "status": response.status, "body": received.decode("utf-8", "replace")}
    except Exception:
        return {"ok": False, "error": "transport"}
    finally:
        try:
            connection.close()
        except Exception:
            pass


def serve(connection, child, token, port):
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
    # Refuse before touching the child: an unauthenticated request signals nothing
    # and reaches no server.
    if not isinstance(presented, str) or not hmac.compare_digest(presented, token):
        reply(connection, {"ok": False, "error": "refused"})
        return False
    if op == "status":
        alive = child.poll() is None
        reply(connection, {"ok": True, "pid": child.pid, "state": "running" if alive else "exited"})
        return False
    if op == "infer":
        if child.poll() is not None:
            reply(connection, {"ok": False, "error": "exited"})
            return False
        reply(connection, infer(port, request.get("body")))
        return False
    if op != "stop":
        reply(connection, {"ok": False, "error": "unsupported"})
        return False
    code = terminate(child)
    if not isinstance(code, int):
        # wait() never returned a status, so this process cannot say the child is
        # gone. Keep the handle, the control socket and the watch pipe alive so a
        # later stop can retry; acknowledging here would retire the record while
        # something may still be holding the port.
        reply(connection, {"ok": False, "error": "exit_unconfirmed"})
        return False
    reply(connection, {"ok": True, "exit": code})
    return True


def main(argv):
    if len(argv) < 6 or argv[0] != "--socket" or argv[2] != "--port" or argv[4] != "--":
        fail("usage: supervisor.py --socket <path> --port <port> -- <command> [args...]")
    socket_path = argv[1]
    if not argv[3].isdigit():
        fail("supervised port must be a number")
    port = int(argv[3])
    command = argv[5:]
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

    # The child inherits the read end and this process keeps the write end open
    # without ever writing to it. Whatever ends this process — clean exit, crash,
    # SIGKILL — closes that write end, and the child's watchdog sees EOF. Without
    # it a SIGKILLed supervisor would leave the server running and unstoppable.
    watch_read, watch_write = os.pipe()
    os.set_inheritable(watch_read, True)
    child_environment = dict(os.environ)
    child_environment["${WATCH_FD_ENV}"] = str(watch_read)
    child = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        env=child_environment,
        pass_fds=(watch_read,),
    )
    # Only the child needs the read end; only this process may hold the write end.
    os.close(watch_read)

    def shutdown(_signum, _frame):
        terminate(child)
        cleanup(listener, socket_path, watch_write)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    while True:
        if child.poll() is not None:
            cleanup(listener, socket_path, watch_write)
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
            if serve(connection, child, token, port):
                cleanup(listener, socket_path, watch_write)
                return 0
        finally:
            try:
                connection.close()
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
`;
