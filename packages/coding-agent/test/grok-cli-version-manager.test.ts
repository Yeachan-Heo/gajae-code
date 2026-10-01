import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	getFallbackVersion,
	getGrokCliVersion,
	parseMinimumVersionFrom426,
	resetVersionCache,
	updateVersionFromError,
} from "../src/defaults/gjc/extensions/grok-cli-vendor/src/provider/version-manager";

describe("Grok CLI version manager", () => {
	beforeEach(() => {
		resetVersionCache();
	});

	it("returns fallback version when GitHub API is unavailable", () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));
		try {
			const version = getGrokCliVersion();
			expect(version).toBe(getFallbackVersion());
			expect(version).toBe("1.0.13");
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

	describe("version caching", () => {
		it("uses cached version on subsequent calls", () => {
			// Set a version via 426 error handling
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version 1.2.3 or later";
			const version1 = updateVersionFromError(errorBody);
			expect(version1).toBe("1.2.3");

			// Subsequent call should return the cached version
			const version2 = getGrokCliVersion();
			expect(version2).toBe("1.2.3");
		});
	});

	describe("version retrieval behavior", () => {
		it("preserves cached version during failure backoff", () => {
			// Cache a working version via 426 error
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version 1.0.20 or later";
			updateVersionFromError(errorBody);

			// Verify cached version is returned
			const cachedVersion = getGrokCliVersion();
			expect(cachedVersion).toBe("1.0.20");
		});

		it("returns fallback when no version is cached", () => {
			const version = getGrokCliVersion();
			expect(version).toBe(getFallbackVersion());
		});
	});
});
