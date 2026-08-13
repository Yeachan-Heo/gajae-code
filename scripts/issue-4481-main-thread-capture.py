#!/usr/bin/env python3
"""Bounded Linux PTY harness for issue #4481.

Launches a real interactive PTY, injects a Bun preload heartbeat, samples per-thread
CPU and transcript/log progress, and captures diagnostic evidence when the main
thread is hot while the event-loop heartbeat is stale.
"""

import argparse
import errno
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HZ = os.sysconf("SC_CLK_TCK")


def proc_exists(pid: int) -> bool:
    return pathlib.Path(f"/proc/{pid}").exists()


def reap_nonblocking(pid: int) -> bool:
    try:
        waited, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return True
    return waited == pid


def proc_stat(pid: int) -> dict[str, int]:
    raw = pathlib.Path(f"/proc/{pid}/stat").read_bytes()
    fields = raw.rsplit(b") ", 1)[1].split()
    return {
        "ppid": int(fields[1]),
        "utime": int(fields[11]),
        "stime": int(fields[12]),
        "starttime": int(fields[19]),
    }


def thread_ticks(pid: int) -> dict[str, tuple[str, int]]:
    result: dict[str, tuple[str, int]] = {}
    for entry in pathlib.Path(f"/proc/{pid}/task").iterdir():
        try:
            raw = (entry / "stat").read_bytes()
        except OSError:
            continue
        fields = raw.rsplit(b") ", 1)[1].split()
        name = raw.split(b"(", 1)[1].rsplit(b")", 1)[0].decode("utf-8", "replace")
        result[entry.name] = (name, int(fields[11]) + int(fields[12]))
    return result


def heartbeat(path: pathlib.Path, pid: int) -> tuple[int, int] | None:
    try:
        fields = path.read_text().split()
        if int(fields[0]) != pid:
            return None
        return int(fields[1]), int(fields[2])
    except (OSError, ValueError, IndexError):
        return None


def file_state(path: pathlib.Path | None) -> dict[str, int] | None:
    if path is None:
        return None
    try:
        stat = path.stat()
        return {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    except OSError:
        return None


def run_capture(command: list[str], output: pathlib.Path, timeout: int) -> None:
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
        output.write_text(
            f"command={json.dumps(command)}\nexit={completed.returncode}\n--- stdout ---\n{completed.stdout}\n--- stderr ---\n{completed.stderr}\n"
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        output.write_text(f"command={json.dumps(command)}\nerror={error!r}\n")


def capture_native_stack(pid: int, artifact_dir: pathlib.Path) -> None:
    gdb = shutil.which("gdb")
    if gdb:
        run_capture(
            [gdb, "-batch", "-ex", "set pagination off", "-ex", "thread apply all bt 40", "-p", str(pid)],
            artifact_dir / "gdb.txt",
            30,
        )
        return
    perf = shutil.which("perf")
    if perf:
        run_capture([perf, "record", "-g", "-p", str(pid), "-o", str(artifact_dir / "perf.data"), "--", "sleep", "3"], artifact_dir / "perf-record.txt", 10)
        run_capture([perf, "report", "--stdio", "-i", str(artifact_dir / "perf.data")], artifact_dir / "perf-report.txt", 30)
        return
    (artifact_dir / "native-stack-unavailable.txt").write_text("Neither gdb nor perf is available on PATH.\n")


def terminate(pid: int, grace: float) -> dict[str, object]:
    result: dict[str, object] = {"sigterm_sent": False, "sigterm_exited": False, "sigkill_sent": False}
    if not proc_exists(pid):
        result["sigterm_exited"] = True
        return result
    os.kill(pid, signal.SIGTERM)
    result["sigterm_sent"] = True
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        if reap_nonblocking(pid) or not proc_exists(pid):
            result["sigterm_exited"] = True
            return result
        time.sleep(0.05)
    os.kill(pid, signal.SIGKILL)
    result["sigkill_sent"] = True
    return result


def instrumented_command(command: list[str], preload: pathlib.Path, repo: pathlib.Path) -> list[str]:
    executable_name = pathlib.Path(command[0]).name
    if executable_name != "bun":
        return command
    if executable_name == "bun" and command[1:3] == ["run", "dev"]:
        remaining = command[3:]
        if remaining[:1] == ["--"]:
            remaining = remaining[1:]
        return [
            command[0],
            f"--preload={preload}",
            "--cwd=packages/coding-agent",
            "src/cli.ts",
            *remaining,
        ]
    return [command[0], f"--preload={preload}", *command[1:]]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=float, default=120.0)
    parser.add_argument("--sample-seconds", type=float, default=2.0)
    parser.add_argument("--hot-percent", type=float, default=70.0)
    parser.add_argument("--stale-seconds", type=float, default=3.0)
    parser.add_argument("--consecutive", type=int, default=3)
    parser.add_argument("--pty-loss-after", type=float)
    parser.add_argument("--term-grace", type=float, default=5.0)
    parser.add_argument("--transcript", type=pathlib.Path)
    parser.add_argument("--log", type=pathlib.Path)
    parser.add_argument("--artifact-dir", type=pathlib.Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if not args.command:
        parser.error("command required after --")
    if sys.platform != "linux":
        parser.error("this capture harness requires Linux /proc")

    repo = pathlib.Path(__file__).resolve().parent.parent
    artifact_dir = args.artifact_dir or pathlib.Path(tempfile.mkdtemp(prefix="issue-4481-capture-"))
    artifact_dir.mkdir(parents=True, exist_ok=True)
    heartbeat_path = artifact_dir / "heartbeat.txt"
    samples_path = artifact_dir / "samples.jsonl"
    pty_path = artifact_dir / "pty.bin"
    summary_path = artifact_dir / "summary.json"
    preload = repo / "scripts/issue-4481-event-loop-heartbeat.ts"
    heartbeat_path.unlink(missing_ok=True)

    env = os.environ.copy()
    env.update(
        {
            "TERM": env.get("TERM", "xterm-256color"),
            "GJC_ISSUE4481_HEARTBEAT_PATH": str(heartbeat_path),
        }
    )
    command = instrumented_command(args.command, preload, repo)
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(repo)
        os.execvpe(command[0], command, env)
        os._exit(127)

    start = time.monotonic()
    previous = thread_ticks(pid)
    hot_stale_samples = 0
    wedge_detected = False
    pty_closed = False
    summary: dict[str, object] = {"pid": pid, "command": command, "artifact_dir": str(artifact_dir)}
    with pty_path.open("wb") as pty_out, samples_path.open("w") as samples:
        try:
            while proc_exists(pid) and time.monotonic() - start < args.duration:
                if reap_nonblocking(pid):
                    break
                interval_start = time.monotonic()
                deadline = interval_start + args.sample_seconds
                while not pty_closed and time.monotonic() < deadline:
                    ready, _, _ = select.select([master], [], [], min(0.1, max(0.0, deadline - time.monotonic())))
                    if not ready:
                        continue
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        chunk = b""
                    if not chunk:
                        pty_closed = True
                        break
                    pty_out.write(chunk)
                remaining = deadline - time.monotonic()
                if remaining > 0:
                    time.sleep(remaining)
                elapsed = max(time.monotonic() - interval_start, 0.001)
                if reap_nonblocking(pid) or not proc_exists(pid):
                    break
                current = thread_ticks(pid)
                deltas = sorted(
                    ((tid, name, ticks - previous.get(tid, (name, ticks))[1]) for tid, (name, ticks) in current.items()),
                    key=lambda row: row[2],
                    reverse=True,
                )
                previous = current
                main_delta = current.get(str(pid), ("bun", 0))[1] - previous.get(str(pid), ("bun", 0))[1]
                for tid, _name, delta in deltas:
                    if tid == str(pid):
                        main_delta = delta
                        break
                main_percent = main_delta / HZ / elapsed * 100.0
                hb = heartbeat(heartbeat_path, pid)
                heartbeat_age = None if hb is None else max(0.0, time.time() - hb[1] / 1000.0)
                record = {
                    "elapsed": time.monotonic() - start,
                    "main_percent": main_percent,
                    "heartbeat": hb,
                    "heartbeat_age": heartbeat_age,
                    "threads": [{"tid": tid, "name": name, "percent": delta / HZ / elapsed * 100.0} for tid, name, delta in deltas[:5]],
                    "process": proc_stat(pid),
                    "transcript": file_state(args.transcript),
                    "log": file_state(args.log),
                }
                samples.write(json.dumps(record) + "\n")
                samples.flush()
                stale = heartbeat_age is not None and heartbeat_age >= args.stale_seconds
                hot_stale_samples = hot_stale_samples + 1 if main_percent >= args.hot_percent and stale else 0
                if hot_stale_samples >= args.consecutive:
                    wedge_detected = True
                    break
                if args.pty_loss_after is not None and not pty_closed and time.monotonic() - start >= args.pty_loss_after:
                    os.close(master)
                    pty_closed = True
        finally:
            if wedge_detected:
                capture_native_stack(pid, artifact_dir)
                strace = shutil.which("strace")
                if strace:
                    run_capture([strace, "-c", "-f", "-p", str(pid), "-o", str(artifact_dir / "strace-summary.txt")], artifact_dir / "strace-launch.txt", 8)
                else:
                    (artifact_dir / "strace-unavailable.txt").write_text("strace is not available on PATH.\n")
                (artifact_dir / "proc-status.txt").write_text(pathlib.Path(f"/proc/{pid}/status").read_text())
                (artifact_dir / "proc-wchan.txt").write_text(pathlib.Path(f"/proc/{pid}/wchan").read_text())
            summary.update({"wedge_detected": wedge_detected, "pty_closed": pty_closed})
            summary["termination"] = terminate(pid, args.term_grace)
            if not pty_closed:
                os.close(master)
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
            summary["alive_after_cleanup"] = proc_exists(pid)
            summary_path.write_text(json.dumps(summary, indent=2) + "\n")

    print(json.dumps(summary, indent=2))
    return 2 if wedge_detected else 0


if __name__ == "__main__":
    raise SystemExit(main())
