// Evidence for inventory row B-FILE-LOCK (plan decision D1): the pinned upstream
// file lock cannot interlock with gjc's `${path}.lock` directory protocol.
//
// Upstream (can1357/oh-my-pi@a85bd522 packages/utils/src/file-lock.ts +
// crates/pi-natives/src/file_lock) locks `${path}.lock` through an abstract
// Unix socket on Linux, a named mutex on Windows, and on other Unix platforms
// flock(2) on `${path}.lock` opened as a regular file (O_CREAT, 0600). gjc
// holds the lock by creating `${path}.lock` as a directory. On Linux and
// Windows the upstream lock has no filesystem name, so an old and a new gjc
// never see each other. On the flock platforms (exercised here) the protocols
// collide on one path with incompatible file types: each side errors instead
// of waiting, and upstream's persistent sidecar wedges gjc after release.
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "../src/config/file-lock";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/** Upstream's non-Linux Unix acquire: open(O_RDWR|O_CREAT, 0600) + flock(LOCK_EX|LOCK_NB), held until stdin closes. */
async function upstreamFlockAcquire(lockPath: string): Promise<{ outcome: string; release: () => Promise<void> }> {
	const script = [
		"import fcntl, os, sys",
		"try:",
		"    fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)",
		"    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
		"    print('held', flush=True)",
		"except OSError as error:",
		"    print('error:' + (os.strerror(error.errno) if error.errno else str(error)), flush=True)",
		"    sys.exit(0)",
		"sys.stdin.read()",
	].join("\n");
	const child = Bun.spawn(["python3", "-c", script, lockPath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	return {
		outcome: new TextDecoder().decode(value).trim(),
		release: async () => {
			child.stdin.end();
			await child.exited;
		},
	};
}

describe.skipIf(process.platform === "win32" || process.platform === "linux")(
	"file lock cross-version interlock (D1)",
	() => {
		it("an upstream flock holder and a gjc directory holder do not share one coherent lock", async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lock-interlock-"));
			roots.push(root);
			const target = path.join(root, "state.json");
			await Bun.write(target, "{}");
			const lockPath = `${target}.lock`;

			// gjc holds the lock: upstream cannot open the directory as a file, so it
			// fails with an I/O error instead of observing contention and waiting.
			const releaseGjc = await acquireFileLock(target, { retries: 2, retryDelayMs: 20 });
			const blockedUpstream = await upstreamFlockAcquire(lockPath);
			await blockedUpstream.release();
			await releaseGjc();
			expect(blockedUpstream.outcome).toBe("error:Is a directory");

			// Upstream holds the lock: it creates a regular file at the path, which
			// gjc reads as an unreadable owner record rather than a live holder.
			const upstream = await upstreamFlockAcquire(lockPath);
			expect(upstream.outcome).toBe("held");
			const whileHeld = await acquireFileLock(target, { retries: 2, retryDelayMs: 20 }).then(
				async release => {
					await release();
					return "acquired";
				},
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			await upstream.release();
			expect(whileHeld).toContain("unreadable");

			// Upstream never removes its sidecar, so gjc stays wedged after release.
			expect((await fs.lstat(lockPath)).isFile()).toBe(true);
			const afterRelease = await acquireFileLock(target, { retries: 2, retryDelayMs: 20 }).then(
				async release => {
					await release();
					return "acquired";
				},
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			expect(afterRelease).toContain("unreadable");
		});
	},
);
