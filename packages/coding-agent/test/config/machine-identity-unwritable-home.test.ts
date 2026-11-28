import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadInstallationHostId } from "../../src/config/machine-identity";

const supported = process.getuid?.() !== 0;

describe.if(supported)("machine identity with unwritable home", () => {
	let tempHome: string;

	beforeEach(async () => {
		tempHome = path.join(tmpdir(), `gjc-test-${randomUUID()}`);
		await fs.mkdir(tempHome, { mode: 0o700 });
	});

	afterEach(async () => {
		try {
			await fs.chmod(tempHome, 0o700);
			await fs.rm(tempHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("fails gracefully with clear error when config root is not writable", async () => {
		// Create a subdirectory that will be our config root
		const configRoot = path.join(tempHome, "config");
		// Don't create it yet - let the function try to create it

		// Make the parent unwritable BEFORE trying to create configRoot
		await fs.chmod(tempHome, 0o500);

		// Verify that the directory is indeed unwritable by trying to create a dir in it
		const testDir = path.join(tempHome, "test-dir");
		const mkdirTest = await fs.mkdir(testDir).catch((e: unknown) => e);

		if (!(mkdirTest instanceof Error)) {
			// If we can create dirs, skip test - running as root
			return;
		}

		const error = await loadInstallationHostId({
			configRootDir: configRoot,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		// Check that it's a ConfigDirectoryError with operatorMessage
		const configError = error as any;
		expect(configError.name).toBe("ConfigDirectoryError");
		expect(configError.errno).toBe("EACCES");
		// Verify the operator message is helpful and path-free
		expect(configError.operatorMessage).toContain("GJC_CONFIG_DIR");
		expect(configError.operatorMessage).toContain("home directory");
		expect(configError.operatorMessage).not.toContain(configRoot);
	});
});
