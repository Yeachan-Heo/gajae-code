import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `EphemeralBlobStore` backs the session resident-text cache at
 * `<sessionDir>/resident-cache/<sessionId>-<pid>-<n>`. Only `dispose()` removed it,
 * and a terminated process never reaches `dispose()`.
 *
 * The pid in the name is what makes this permanent: a later run picks a different
 * name, and the constructor's wipe only clears its own path, so nothing can ever
 * collect an earlier run's directory. A developer machine held seven of them from
 * dead pids, up to 26 days old, totalling 13.4 MB.
 *
 * The behaviour under test is what happens when the owning process is signalled,
 * so these drive a real child process.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "resident-cache-probe.ts");
const roots: string[] = [];

function probeDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resident-cache-test-"));
	roots.push(root);
	return path.join(root, "session", "resident-cache", "s-1234-1");
}

async function waitForDir(dir: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(dir)) return;
		await Bun.sleep(50);
	}
	throw new Error(`probe never created ${dir}`);
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("session resident-cache cleanup", () => {
	it("removes the cache directory on a clean dispose", async () => {
		const dir = probeDir();
		const proc = Bun.spawn(["bun", "run", PROBE, dir, "close"], { stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("sweeps the cache directory when the process is terminated", async () => {
		const dir = probeDir();
		const proc = Bun.spawn(["bun", "run", PROBE, dir, "abort"], { stdout: "pipe", stderr: "pipe" });
		await waitForDir(dir);
		// The payload is on disk before the signal, so survival would be a real leak.
		expect(fs.existsSync(dir)).toBe(true);

		proc.kill("SIGTERM");
		await proc.exited;
		await Bun.sleep(500);

		expect(fs.existsSync(dir)).toBe(false);
	});
});
