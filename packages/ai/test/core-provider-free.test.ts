import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type TraceRecord = {
	kind?: string;
	resolved: string;
};

const repoRoot = path.resolve(import.meta.dir, "../../..");
const traceLoader = path.join(repoRoot, "scripts", "trace-loader.ts");

function decode(value: Uint8Array): string {
	return new TextDecoder().decode(value);
}

async function runCoreTrace(tracePath: string): Promise<TraceRecord[]> {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "--preload", traceLoader, "-e", 'await import("@gajae-code/ai/core")'],
		cwd: repoRoot,
		env: {
			HOME: Bun.env.HOME ?? "",
			PATH: Bun.env.PATH ?? "",
			GJC_TRACE_OUT: tracePath,
		},
		stderr: "pipe",
		stdout: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			[`core trace exited with ${result.exitCode}`, decode(result.stdout), decode(result.stderr)]
				.filter(Boolean)
				.join("\n"),
		);
	}
	const raw = JSON.parse(await Bun.file(tracePath).text()) as unknown;
	const records = Array.isArray(raw) ? raw : (raw as { records?: unknown }).records;
	if (!Array.isArray(records)) throw new Error("core trace did not contain a records array");
	return records as TraceRecord[];
}

describe("core provider-free loaded edge", () => {
	test("importing @gajae-code/ai/core loads no provider implementation modules", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "gajae-ai-core-trace-"));
		const tracePath = path.join(tempDir, "trace.json");
		try {
			const records = await runCoreTrace(tracePath);
			const loadedRecords = records.filter(record => record.kind !== "source-scan");
			const loadedCore = loadedRecords.some(record =>
				record.resolved.replaceAll(path.sep, "/").endsWith("/packages/ai/src/core.ts"),
			);
			const loadedProviders = loadedRecords.filter(record =>
				record.resolved.replaceAll(path.sep, "/").includes("/packages/ai/src/providers/"),
			);

			expect(loadedCore).toBe(true);
			expect(loadedProviders).toEqual([]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
