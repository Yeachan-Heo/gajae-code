import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot } from "../../src/memories";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-instructions-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("buildMemoryToolDeveloperInstructions", () => {
	it("injects summary without exposing memory tool or raw root paths", async () => {
		await withTempDir(async agentDir => {
			const settings = Settings.isolated({ "memories.enabled": true });
			const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
			await fs.mkdir(memoryRoot, { recursive: true });
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "Use structured retries for flaky network calls.");

			const instructions = await buildMemoryToolDeveloperInstructions(agentDir, settings);
			expect(instructions).toBeDefined();
			expect(instructions).toContain("Use structured retries for flaky network calls.");
			expect(instructions).toContain("do not try to call or invent a `memory` tool");
			expect(instructions).not.toContain("memory://");
			expect(instructions).not.toContain(memoryRoot);
		});
	});
});
