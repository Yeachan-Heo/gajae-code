import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The inactive-autorouting diagnostic is internal. It previously rode on
 * `SessionSdkHostOptions`, which `sdk/index.ts` re-exports and `./sdk` publishes,
 * so any consumer could inject it. These guard the boundary that replaced it.
 */
const repoRoot = path.resolve(import.meta.dir, "../../..");
const packageRoot = path.resolve(import.meta.dir, "..");

async function readSource(relativePath: string): Promise<string> {
	return await Bun.file(path.join(packageRoot, relativePath)).text();
}

describe("autorouting private seam boundary", () => {
	test("the internal state module is blocked from the published export map", async () => {
		const manifest = JSON.parse(await Bun.file(path.join(packageRoot, "package.json")).text()) as {
			exports: Record<string, unknown>;
		};
		// A null entry is what prevents `import "@gajae-code/coding-agent/sdk/host/internal-autorouting-state"`.
		expect(manifest.exports["./sdk/host/internal-autorouting-state"]).toBeNull();
		expect(manifest.exports["./sdk/host/internal-autorouting-state.js"]).toBeNull();
	});

	test("the internal state module is not re-exported from the host barrel", async () => {
		const barrel = await readSource("src/sdk/host/index.ts");
		expect(barrel).not.toContain("internal-autorouting-state");
	});

	test("no published option type accepts the diagnostic flag", async () => {
		// Declaration sites only: a consumer must not be able to set this.
		for (const relativePath of ["src/sdk/host/host.ts", "src/sdk/host/session-runtime.ts", "src/sdk/bus/index.ts"]) {
			const source = await readSource(relativePath);
			expect(source).not.toContain("autoroutingInactive?:");
			expect(source).not.toContain("autoroutingInactive:");
		}
	});

	test("the internal module exists and stays inside the package", async () => {
		const modulePath = path.join(packageRoot, "src/sdk/host/internal-autorouting-state.ts");
		expect(await fs.exists(modulePath)).toBe(true);
		expect(modulePath.startsWith(repoRoot)).toBe(true);
	});
});
