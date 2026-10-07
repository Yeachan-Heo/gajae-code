// A/B adapter for ProcessTerminal's real stdout-to-PTY write path.
//
// The Python bridge owns a private raw PTY and drains its master continuously.
// A sample starts when the bridge receives the child's start marker and records
// time.monotonic_ns(), immediately before replying with that timestamp. It ends
// when the master reader has consumed the expected UTF-8 byte count. This uses
// one clock for both endpoints and measures through actual PTY delivery without
// writing benchmark bytes to the invoking terminal.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { runAbSuite } from "./ab-adapter";

const bridgeSource = String.raw`
import errno
import fcntl
import json
import os
import select
import struct
import subprocess
import sys
import termios
import threading
import time
import tty

bun_path, child_path, tree_root = sys.argv[1:4]
master_fd = slave_fd = command_read = command_write = reply_read = reply_write = None
child = None
child_stopped = False
condition = threading.Condition()
state = {"bytes": 0, "events": [], "error": None, "eof": False}


def send_parent(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def write_line(fd, value):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        view = view[count:]


def read_child_line(timeout_seconds=20):
    if not hasattr(read_child_line, "buffer"):
        read_child_line.buffer = bytearray()
    buffer = read_child_line.buffer
    deadline = time.monotonic() + timeout_seconds
    while b"\n" not in buffer:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("timed out waiting for tty-write child control message")
        readable, _, _ = select.select([reply_read], [], [], remaining)
        if not readable:
            raise TimeoutError("timed out waiting for tty-write child control message")
        chunk = os.read(reply_read, 4096)
        if not chunk:
            raise RuntimeError("tty-write child closed its control pipe")
        buffer.extend(chunk)
    end = buffer.index(b"\n")
    line = bytes(buffer[:end])
    del buffer[:end + 1]
    return json.loads(line)


def drain_master():
    try:
        while True:
            try:
                data = os.read(master_fd, 65536)
            except OSError as error:
                if error.errno in (errno.EIO, errno.EBADF):
                    break
                raise
            if not data:
                break
            observed_ns = time.monotonic_ns()
            with condition:
                state["bytes"] += len(data)
                state["events"].append((state["bytes"], observed_ns))
                condition.notify_all()
    except BaseException as error:
        with condition:
            state["error"] = str(error)
            condition.notify_all()
    finally:
        with condition:
            state["eof"] = True
            condition.notify_all()


try:
    master_fd, slave_fd = os.openpty()
    tty.setraw(slave_fd, when=termios.TCSANOW)
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    command_read, command_write = os.pipe()
    reply_read, reply_write = os.pipe()
    child_env = os.environ.copy()
    # Keep the child outside Bun's test-runtime fallback.
    child_env.pop("BUN_ENV", None)
    child_env.pop("NODE_ENV", None)
    child_env["TTY_WRITE_COMMAND_FD"] = str(command_read)
    child_env["TTY_WRITE_REPLY_FD"] = str(reply_write)
    child = subprocess.Popen(
        [bun_path, child_path],
        cwd=tree_root,
        env=child_env,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        pass_fds=(command_read, reply_write),
    )
    os.close(slave_fd)
    slave_fd = None
    os.close(command_read)
    command_read = None
    os.close(reply_write)
    reply_write = None
    master_thread = threading.Thread(target=drain_master, name="tty-write-pty-drain", daemon=True)
    master_thread.start()

    child_ready = read_child_line()
    if child_ready.get("type") != "ready":
        raise RuntimeError("tty-write child failed to initialize: " + str(child_ready))
    send_parent({"ready": True})

    for input_line in sys.stdin:
        request = json.loads(input_line)
        if request.get("type") == "stop":
            write_line(command_write, {"type": "stop"})
            stopped = read_child_line()
            if stopped.get("type") != "stopped":
                raise RuntimeError("tty-write child did not stop cleanly: " + str(stopped))
            child_stopped = True
            break

        request_id = request.get("id")
        write_line(command_write, {"type": "run", "id": request_id, "caseId": request.get("caseId")})
        start_message = read_child_line()
        if start_message.get("type") == "error":
            raise RuntimeError(start_message.get("error", "tty-write child failed"))
        if start_message.get("type") != "start" or start_message.get("id") != request_id:
            raise RuntimeError("unexpected tty-write child start message: " + str(start_message))

        with condition:
            baseline = state["bytes"]
        started_ns = time.monotonic_ns()
        write_line(command_write, {"type": "go", "id": request_id, "startedNs": str(started_ns)})
        done_message = read_child_line()
        if done_message.get("type") == "error":
            raise RuntimeError(done_message.get("error", "tty-write child failed"))
        if done_message.get("type") != "done" or done_message.get("id") != request_id:
            raise RuntimeError("unexpected tty-write child completion: " + str(done_message))
        if done_message.get("startedNs") != str(started_ns):
            raise RuntimeError("tty-write child returned a mismatched start timestamp")
        expected_bytes = done_message.get("expectedBytes")
        if not isinstance(expected_bytes, int) or expected_bytes <= 0:
            raise RuntimeError("tty-write child returned an invalid expected byte count")

        target = baseline + expected_bytes
        deadline = time.monotonic() + 20
        with condition:
            while state["bytes"] < target and state["error"] is None and not state["eof"]:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("timed out draining tty-write PTY output")
                condition.wait(remaining)
            if state["error"] is not None:
                raise RuntimeError("PTY drain failed: " + state["error"])
            if state["bytes"] < target:
                raise RuntimeError("PTY closed before all expected tty-write bytes were read")
            ended_ns = next(timestamp for count, timestamp in state["events"] if count >= target)
        send_parent({
            "id": request_id,
            "measuredMs": (ended_ns - started_ns) / 1_000_000,
            "bytesRead": expected_bytes,
        })
except BaseException as error:
    try:
        send_parent({"error": str(error)})
    except BaseException:
        pass
    sys.exit(1)
finally:
    if child is not None and child.poll() is None:
        try:
            if command_write is not None and not child_stopped:
                write_line(command_write, {"type": "stop"})
            child.wait(timeout=2)
        except BaseException:
            child.terminate()
            try:
                child.wait(timeout=2)
            except BaseException:
                child.kill()
                child.wait()
    for fd in (slave_fd, command_read, command_write, reply_read, reply_write, master_fd):
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
`;

const treeRoot = resolve(import.meta.dir, "../../..");
const childPath = join(import.meta.dir, "tty-write-child.ts");
const bridge = spawn("python3", ["-u", "-c", bridgeSource, process.execPath, childPath, treeRoot], {
	cwd: treeRoot,
	stdio: ["pipe", "pipe", "pipe"],
});
const bridgeLines = createInterface({ input: bridge.stdout, crlfDelay: Infinity });
const bridgeLineIterator = bridgeLines[Symbol.asyncIterator]();
let bridgeStderr = "";
bridge.stderr.setEncoding("utf8");
bridge.stderr.on("data", (chunk: string) => {
	bridgeStderr += chunk;
});

async function nextBridgeMessage(): Promise<Record<string, unknown>> {
	const next = await bridgeLineIterator.next();
	if (next.done) {
		throw new Error(`PTY bridge exited before responding${bridgeStderr ? `: ${bridgeStderr.trim()}` : ""}`);
	}
	let message: unknown;
	try {
		message = JSON.parse(next.value);
	} catch {
		throw new Error(`PTY bridge returned invalid JSON: ${next.value}`);
	}
	if (typeof message !== "object" || message === null) throw new Error("PTY bridge returned a non-object response");
	if (typeof (message as { error?: unknown }).error === "string") {
		throw new Error(`PTY bridge failed: ${(message as { error: string }).error}`);
	}
	return message as Record<string, unknown>;
}

async function writeBridgeMessage(value: Record<string, unknown>): Promise<void> {
	const line = `${JSON.stringify(value)}\n`;
	if (!bridge.stdin.write(line)) await once(bridge.stdin, "drain");
}

async function closeBridge(): Promise<void> {
	if (bridge.exitCode !== null) return;
	try {
		await writeBridgeMessage({ type: "stop" });
		bridge.stdin.end();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				once(bridge, "exit"),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("PTY bridge shutdown timed out")), 3000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	} catch {
		bridge.kill("SIGTERM");
	}
	bridgeLines.close();
}

const ready = await nextBridgeMessage();
if (ready.ready !== true) {
	await closeBridge();
	throw new Error("PTY bridge did not report readiness");
}

let nextRequestId = 0;
async function sample(caseId: string): Promise<{ measuredMs: number }> {
	const id = ++nextRequestId;
	await writeBridgeMessage({ type: "run", id, caseId });
	const response = await nextBridgeMessage();
	if (response.id !== id || typeof response.measuredMs !== "number" || !Number.isFinite(response.measuredMs)) {
		throw new Error(`PTY bridge returned an invalid measurement for ${caseId}`);
	}
	return { measuredMs: response.measuredMs };
}

await runAbSuite(
	"tty-write",
	[
		{ id: "W01", run: () => sample("W01") },
		{ id: "W02", run: () => sample("W02") },
	],
	50,
).finally(closeBridge);
