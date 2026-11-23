import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { ReadTool } from "../../src/tools/read";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async (toolType: string) => ({
			id: `special-${toolType}`,
			path: path.join(cwd, `special-${toolType}.log`),
		}),
		settings: Settings.isolated({ "read.summarize.enabled": false, readHashLines: false }),
	} as unknown as ToolSession;
}

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-special-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("read tool special files", () => {
	test.skipIf(process.platform === "win32")("refuses a FIFO instead of blocking on it", async () => {
		const fifo = path.join(tempDir, "pipe");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		const tool = new ReadTool(createSession(tempDir));
		const reading = tool.execute("read-fifo", { path: fifo }).then(
			() => "READ" as const,
			(error: unknown) => error,
		);
		const outcome = await Promise.race([reading, Bun.sleep(1_500).then(() => "HUNG" as const)]);
		if (outcome === "HUNG") {
			// Release the blocked reader so the test process can exit.
			try {
				fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
			} catch {}
			await reading;
		}
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toContain("it is a FIFO, not a regular file or directory.");
	});
});
