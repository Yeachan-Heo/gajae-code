import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTextFromDisk } from "@gajae-code/coding-agent/tools/path-utils";

describe("readTextFromDisk", () => {
	it("reads regular files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-text-"));
		try {
			const file = path.join(dir, "a.txt");
			fs.writeFileSync(file, "hello");
			expect(await readTextFromDisk(file)).toBe("hello");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("refuses a FIFO instead of blocking on it", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-text-"));
		const fifo = path.join(dir, "pipe");
		try {
			Bun.spawnSync(["mkfifo", fifo]);
			const outcome = await Promise.race([
				readTextFromDisk(fifo).then(
					() => "READ" as const,
					(error: unknown) => error,
				),
				Bun.sleep(1_500).then(() => "HUNG" as const),
			]);
			if (outcome === "HUNG") {
				// Release the blocked reader so the test process can exit.
				try {
					fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
				} catch {}
			}
			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).message).toBe(
				`Cannot open '${fifo}': it is a FIFO, not a regular file or directory.`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!fs.existsSync("/dev/zero"))("refuses character devices", async () => {
		await expect(readTextFromDisk("/dev/zero")).rejects.toThrow("character device");
	});
});
