import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `RevisionStore` spills large snapshots to a `mkdtemp` directory under the
 * system temp dir. `close()` removes it, but an abnormal exit never reaches
 * `close()`, and unlike the two sibling temp-artifact caches
 * (`shell-snapshot`, `python-runner-artifact`) this one registered no postmortem
 * sweep — so a terminated process left the spilled data behind.
 *
 * The probe runs in its own process because the behaviour under test is what
 * happens when that process is signalled.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "revision-store-spill-probe.ts");

async function runProbe(mode: "close" | "abort"): Promise<{ dirs: string[]; afterClose?: string[] }> {
	const proc = Bun.spawn([process.execPath, PROBE, mode], { stdout: "pipe", stderr: "pipe" });

	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	const lines: string[] = [];
	const want = mode === "close" ? 2 : 1;

	while (lines.length < want) {
		const { value, done } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		const parts = buffered.split("\n");
		buffered = parts.pop() ?? "";
		for (const part of parts) if (part.trim()) lines.push(part.trim());
	}

	const parsed = Object.assign({}, ...lines.map(l => JSON.parse(l))) as { dirs: string[]; afterClose?: string[] };

	if (mode === "abort") {
		proc.kill("SIGTERM");
		await proc.exited;
		// Give the postmortem callback a moment to finish its removal.
		await Bun.sleep(2000);
	} else {
		await proc.exited;
	}
	reader.releaseLock();
	return parsed;
}

describe("revision store spill cleanup", () => {
	it("removes the spill directory and stops tracking it on close", async () => {
		const { dirs, afterClose } = await runProbe("close");
		expect(dirs).toHaveLength(1);
		expect(afterClose).toEqual([]);
		expect(fs.existsSync(dirs[0])).toBe(false);
	}, 120_000);

	it("removes the spill directory when the process is terminated", async () => {
		const { dirs } = await runProbe("abort");
		expect(dirs).toHaveLength(1);
		// Without the postmortem registration this directory survives with its
		// spilled payload still on disk.
		expect(fs.existsSync(dirs[0])).toBe(false);
	}, 120_000);
});
