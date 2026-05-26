import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGjcRuntimeBridge } from "../src/commands/gjc-runtime-bridge";

let cleanupRoot: string | undefined;

afterEach(async () => {
	if (cleanupRoot) {
		await rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("gjc runtime bridge", () => {
	it("delegates private endpoints to the configured omx-compatible runtime", async () => {
		cleanupRoot = await mkdtemp(join(tmpdir(), "gjc-runtime-bridge-"));
		const logPath = join(cleanupRoot, "argv.log");
		const runtimePath = join(cleanupRoot, "omx-runtime.sh");
		await writeFile(
			runtimePath,
			`#!/bin/sh\nprintf '%s\\n' "$GJC_OMX_RUNTIME_BRIDGE_ACTIVE|$1|$2|$3" > ${JSON.stringify(logPath)}\n`,
			{ mode: 0o755 },
		);

		const result = runGjcRuntimeBridge("ultragoal", ["status", "--json"], {
			GJC_OMX_RUNTIME_BINARY: runtimePath,
			PATH: "",
		});

		expect(result).toEqual({ status: 0 });
		expect(await readFile(logPath, "utf-8")).toBe("1|ultragoal|status|--json\n");
	});

	it("returns an actionable error when no runtime is available", () => {
		const result = runGjcRuntimeBridge("ralplan", ["status"], { PATH: "" });

		expect(result.status).toBe(1);
		expect(result.error).toContain("gjc ralplan requires the private OMX runtime endpoint implementation");
		expect(result.error).toContain("GJC_OMX_RUNTIME_BINARY");
	});
});
