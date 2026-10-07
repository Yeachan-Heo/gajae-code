import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	getFallbackVersion,
	getGrokCliVersion,
	parseMinimumVersionFrom426,
	resetVersionCacheAndWaitForPending,
	updateVersionFromError,
} from "../src/defaults/gjc/extensions/grok-cli-vendor/src/provider/version-manager";

describe("Grok CLI version manager", () => {
	beforeEach(async () => {
		await resetVersionCacheAndWaitForPending();
	});

	it("returns fallback version when GitHub API is unavailable", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));
		try {
			const version = getGrokCliVersion();
			// First call returns fallback while background fetch fails
			expect(version).toBe(getFallbackVersion());
			expect(version).toBe("1.0.13");
			// Wait for background fetch to complete
			await resetVersionCacheAndWaitForPending();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	describe("parseMinimumVersionFrom426", () => {
		it("extracts version from standard 426 error message", () => {
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version 1.0.13 or later";
			const version = parseMinimumVersionFrom426(errorBody);
			expect(version).toBe("1.0.13");
		});

		it("extracts version with different formatting", () => {
			const errorBody = "Your Grok CLI version (0.2.30) is outdated. Please update to version 2.1.5 or later.";
			const version = parseMinimumVersionFrom426(errorBody);
			expect(version).toBe("2.1.5");
		});

		it("handles case-insensitive error messages", () => {
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. PLEASE UPDATE TO VERSION 1.5.0 OR LATER";
			const version = parseMinimumVersionFrom426(errorBody);
			expect(version).toBe("1.5.0");
		});

		it("returns null when version is not found in error body", () => {
			const errorBody = "Some other error message without version info";
			const version = parseMinimumVersionFrom426(errorBody);
			expect(version).toBeNull();
		});

		it("handles malformed version numbers gracefully", () => {
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version x.y.z or later";
			const version = parseMinimumVersionFrom426(errorBody);
			// Should still extract even if format is unusual
			expect(version).toBe("x.y.z");
		});
	});

	describe("updateVersionFromError", () => {
		it("updates cache and returns version from error message", () => {
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version 1.0.20 or later";
			const version = updateVersionFromError(errorBody);
			expect(version).toBe("1.0.20");
		});

		it("returns fallback when error message has no version", () => {
			const errorBody = "Unknown error";
			const version = updateVersionFromError(errorBody);
			expect(version).toBe(getFallbackVersion());
		});

		it("subsequent calls use the updated version", () => {
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version 1.2.3 or later";
			updateVersionFromError(errorBody);

			// Next call should use the cached version
			const cachedVersion = getGrokCliVersion();
			expect(cachedVersion).toBe("1.2.3");
		});
	});

	describe("version caching and monotonic updates", () => {
		it("uses cached version on subsequent calls", () => {
			// Set a version via 426 error handling
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version 1.2.3 or later";
			const version1 = updateVersionFromError(errorBody);
			expect(version1).toBe("1.2.3");

			// Subsequent call should return the cached version
			const version2 = getGrokCliVersion();
			expect(version2).toBe("1.2.3");
		});

		it("prevents downgrade from out-of-order 426 responses", () => {
			// First, learn a newer version
			const newError = "Your Grok CLI version (1.2.3) is outdated. Please update to version 2.0.0 or later";
			updateVersionFromError(newError);
			expect(getGrokCliVersion()).toBe("2.0.0");

			// Then, simulate an out-of-order older response
			const oldError = "Your Grok CLI version (0.2.33) is outdated. Please update to version 1.5.0 or later";
			updateVersionFromError(oldError);

			// Version should not downgrade
			expect(getGrokCliVersion()).toBe("2.0.0");
		});
	});

	describe("version retrieval behavior", () => {
		it("preserves cached version and learned version takes priority", () => {
			// First, learn a version from 426 error
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version 1.0.20 or later";
			updateVersionFromError(errorBody);

			// Verify learned version is returned
			const learnedVersion = getGrokCliVersion();
			expect(learnedVersion).toBe("1.0.20");
		});

		it("returns fallback when no version is cached or learned", () => {
			const version = getGrokCliVersion();
			expect(version).toBe(getFallbackVersion());
		});
	});

	describe("GitHub release fetching", () => {
		it("triggers background fetch on first call when no version is cached", async () => {
			const fetchSpy = spyOn(globalThis, "fetch").mockResponseOnce(JSON.stringify({ tag_name: "v1.2.3" }));

			try {
				// First call should return fallback and start background fetch
				const version1 = getGrokCliVersion();
				expect(version1).toBe(getFallbackVersion());

				// Wait for background fetch to complete
				await resetVersionCacheAndWaitForPending();

				// Next call should use the fetched version
				const version2 = getGrokCliVersion();
				expect(version2).toBe("1.2.3");

				// Verify fetch was called
				expect(fetchSpy).toHaveBeenCalledWith(
					"https://api.github.com/repos/xai-org/grok-cli/releases/latest",
					expect.any(Object),
				);
			} finally {
				fetchSpy.mockRestore();
			}
		});

		it("learned version takes priority over GitHub-fetched version", async () => {
			const fetchSpy = spyOn(globalThis, "fetch").mockResponseOnce(JSON.stringify({ tag_name: "v1.0.10" }));

			try {
				// First, learn a newer version from 426 error
				const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version 2.0.0 or later";
				updateVersionFromError(errorBody);

				// Learned version should be returned (higher priority)
				const version1 = getGrokCliVersion();
				expect(version1).toBe("2.0.0");

				// Wait for any background fetch
				await resetVersionCacheAndWaitForPending();

				// Still returns the learned version since it's higher priority
				const version2 = getGrokCliVersion();
				expect(version2).toBe("2.0.0");
			} finally {
				fetchSpy.mockRestore();
			}
		});
	});
});
