import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchHeadlessBrowser } from "../../src/tools/browser/launch";

describe("browser headless launch failure with EBUSY cleanup (#8076)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates userDataDir and passes it to puppeteer so puppy doesn't try to remove it", async () => {
		// When profileWarmupDir is not provided, launchHeadlessBrowser should:
		// 1. Create a temp userDataDir
		// 2. Pass it to puppeteer.launch() as the userDataDir option
		// 3. Return both the browser and the createdUserDataDir
		// This prevents puppeteer from trying to remove it, avoiding EBUSY errors (#8076)

		// We can't easily mock loadPuppeteer in this test without deeper refactoring,
		// so we'll just verify that launchHeadlessBrowser creates the dir when called.
		// The actual puppeteer integration is tested in integration tests.
		const result = await launchHeadlessBrowser({
			headless: true,
		});

		// Verify that a createdUserDataDir was returned
		expect(result.createdUserDataDir).toBeTruthy();
		expect(result.browser).toBeTruthy();

		// Verify that the created dir exists
		if (result.createdUserDataDir) {
			expect(fs.existsSync(result.createdUserDataDir)).toBe(true);

			// Clean up
			try {
				fs.rmSync(result.createdUserDataDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors in test
			}
		}
	});

	it("uses profileWarmupDir when provided instead of creating a temp dir", async () => {
		// When profileWarmupDir is provided, we should use it and not create a temp dir
		const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-test-profile-"));

		try {
			const result = await launchHeadlessBrowser({
				headless: true,
				profileWarmupDir: profileDir,
			});

			// Should NOT create a new dir when profileWarmupDir is provided
			expect(result.createdUserDataDir).toBeUndefined();
			expect(result.browser).toBeTruthy();
		} finally {
			try {
				fs.rmSync(profileDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors in test
			}
		}
	});
});
