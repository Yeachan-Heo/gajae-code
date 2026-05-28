import { afterEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getLatestReleaseForTest, replaceBinaryForUpdate, resolveUpdateMethodForTest } from "../src/cli/update-cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
describe("update-cli install target detection", () => {
	it("checks the public wrapper package published in the documented install path", async () => {
		const originalFetch = globalThis.fetch;
		const fetchMock = mock(async () =>
			Response.json({
				version: "0.1.2",
				dist: { tarball: "https://registry.npmjs.org/gajae-code/-/gajae-code-0.1.2.tgz" },
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			await getLatestReleaseForTest();

			expect(fetchMock).toHaveBeenCalledWith("https://registry.npmjs.org/gajae-code/latest");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("uses bun update when prioritized gjc is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/gjc", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses binary update when prioritized gjc is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/gjc", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/gjc", undefined);

		expect(method).toBe("binary");
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "gjc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous gjc binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "gjc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});
