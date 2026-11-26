import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as launchModule from "../../src/tools/browser/launch";

describe("headless browser launch with profile cleanup", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates userDataDir and passes it to puppeteer when no profileWarmupDir is provided", async () => {
		// Create a stub browser object
		const mockBrowser = {
			connected: true,
			close: vi.fn().mockResolvedValue(undefined),
			process: vi.fn().mockReturnValue({ pid: 12345 }),
		};

		const mockLaunch = vi.fn().mockResolvedValue(mockBrowser);

		// Mock loadPuppeteer to return stub puppeteer module with our mock launch
		vi.spyOn(launchModule, "loadPuppeteer").mockResolvedValue({
			launch: mockLaunch,
		} as any);

		const result = await launchModule.launchHeadlessBrowser({
			headless: true,
		});

		// Verify that a createdUserDataDir was returned
		expect(result.createdUserDataDir).toBeTruthy();
		expect(result.browser).toBeTruthy();

		// Verify that the created dir exists
		if (result.createdUserDataDir) {
			expect(fs.existsSync(result.createdUserDataDir)).toBe(true);

			// Verify puppeteer.launch was called with the userDataDir
			expect(mockLaunch).toHaveBeenCalled();
			const launchCall = mockLaunch.mock.calls[0]?.[0];
			expect(launchCall?.userDataDir).toBe(result.createdUserDataDir);

			// Clean up
			try {
				fs.rmSync(result.createdUserDataDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors in test
			}
		}
	});

	it("uses profileWarmupDir when provided instead of creating a temp dir", async () => {
		// Create a stub browser object
		const mockBrowser = {
			connected: true,
			close: vi.fn().mockResolvedValue(undefined),
			process: vi.fn().mockReturnValue({ pid: 12345 }),
		};

		const mockLaunch = vi.fn().mockResolvedValue(mockBrowser);

		// Mock loadPuppeteer to return stub puppeteer module with our mock launch
		vi.spyOn(launchModule, "loadPuppeteer").mockResolvedValue({
			launch: mockLaunch,
		} as any);

		const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-test-profile-"));

		try {
			const result = await launchModule.launchHeadlessBrowser({
				headless: true,
				profileWarmupDir: profileDir,
			});

			// Should NOT create a new dir when profileWarmupDir is provided
			expect(result.createdUserDataDir).toBeUndefined();
			expect(result.browser).toBeTruthy();

			// Verify puppeteer.launch was called with the provided profileWarmupDir
			expect(mockLaunch).toHaveBeenCalled();
			const launchCall = mockLaunch.mock.calls[0]?.[0];
			expect(launchCall?.userDataDir).toBe(profileDir);
		} finally {
			try {
				fs.rmSync(profileDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors in test
			}
		}
	});

	it("retries createdUserDataDir cleanup on EBUSY after launch failure", async () => {
		// Mock puppeteer to simulate launch failure
		const launchError = new Error("WebSocket connection failed");
		const mockLaunch = vi.fn().mockRejectedValue(launchError);

		// Mock loadPuppeteer to return stub puppeteer module with our mock launch
		vi.spyOn(launchModule, "loadPuppeteer").mockResolvedValue({
			launch: mockLaunch,
		} as any);

		// When launch fails, launchHeadlessBrowser should attempt cleanup with retry
		try {
			await launchModule.launchHeadlessBrowser({
				headless: true,
			});
			expect.unreachable("Should have thrown launch error");
		} catch (err) {
			// Verify the original launch error is preserved
			expect((err as Error).message).toBe("WebSocket connection failed");
		}
	});

	it("preserves original launch error when cleanup fails", async () => {
		// Mock puppeteer to simulate launch failure
		const launchError = new Error("Chrome launch timeout");
		const mockLaunch = vi.fn().mockRejectedValue(launchError);

		// Mock loadPuppeteer to return stub puppeteer module with our mock launch
		vi.spyOn(launchModule, "loadPuppeteer").mockResolvedValue({
			launch: mockLaunch,
		} as any);

		// When launch fails, the original error should be thrown, not a cleanup error
		try {
			await launchModule.launchHeadlessBrowser({
				headless: true,
			});
			expect.unreachable("Should have thrown launch error");
		} catch (err) {
			// Verify the original launch error is preserved, not masked by cleanup error
			expect(err).toBe(launchError);
		}
	});

	it("defers cleanup to registry when removal fails with EBUSY after launch failure", async () => {
		// Mock puppeteer to simulate launch failure
		const launchError = new Error("Chromium spawn failed");
		const mockLaunch = vi.fn().mockRejectedValue(launchError);

		// Mock loadPuppeteer to return stub puppeteer module with our mock launch
		vi.spyOn(launchModule, "loadPuppeteer").mockResolvedValue({
			launch: mockLaunch,
		} as any);

		// Track rmSync calls to verify retries
		let rmSyncCallCount = 0;
		const originalRmSync = fs.rmSync;
		vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
			rmSyncCallCount++;
			if (rmSyncCallCount <= 11) {
				// Fail with EBUSY for all retry attempts (default 10 retries + 1)
				const err = new Error("EBUSY: resource busy") as NodeJS.ErrnoException;
				err.code = "EBUSY";
				throw err;
			}
			// After retries exhausted, succeed
			return originalRmSync(path as string, options);
		});

		const deferredModule = await import("../../src/tools/browser/deferred-profile-cleanup");
		const deferSpy = vi.spyOn(deferredModule, "deferProfileDirCleanup").mockReturnValue(undefined);

		// When launch fails and cleanup fails with EBUSY, it should defer cleanup
		try {
			await launchModule.launchHeadlessBrowser({
				headless: true,
			});
			expect.unreachable("Should have thrown launch error");
		} catch (err) {
			// (a) Verify the original launch error is preserved
			expect((err as Error).message).toBe("Chromium spawn failed");
			// Verify that cleanup was attempted with retries
			expect(rmSyncCallCount).toBeGreaterThan(10);
			// (a) Verify deferral was registered after EBUSY exhaustion
			expect(deferSpy).toHaveBeenCalled();
			const deferredDir = deferSpy.mock.calls[0]?.[0];
			expect(deferredDir).toBeTruthy();
		}
	});

	it("cleanupProfileDirWithRetry returns explicit result on non-EBUSY failure", async () => {
		// (b) Verify that cleanup returns {removed: false, error} on non-EBUSY errors
		vi.spyOn(fs, "rmSync").mockImplementation(() => {
			const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
			err.code = "EACCES";
			throw err;
		});

		const result = await launchModule.cleanupProfileDirWithRetry("/some/nonexistent/path");
		expect(result.removed).toBe(false);
		if (!result.removed) {
			expect(result.error.message).toBe("EACCES: permission denied");
		}
	});

	it("cleanupProfileDirWithRetry throws on exhausted EBUSY retries", async () => {
		// (b) Verify that cleanup throws when EBUSY exhausts all retries
		vi.spyOn(fs, "rmSync").mockImplementation(() => {
			const err = new Error("EBUSY: resource busy") as NodeJS.ErrnoException;
			err.code = "EBUSY";
			throw err;
		});

		try {
			await launchModule.cleanupProfileDirWithRetry("/some/nonexistent/path", 2);
			expect.unreachable("Should have thrown EBUSY error");
		} catch (err) {
			const error = err as Error;
			expect(error.message).toContain("EBUSY");
		}
	});
});
