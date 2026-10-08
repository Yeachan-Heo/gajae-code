import { beforeEach, describe, expect, it } from "bun:test";
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

		it("rejects malformed version numbers", () => {
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version x.y.z or later";
			const version = parseMinimumVersionFrom426(errorBody);
			expect(version).toBeNull();
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
		it("does not learn a minimum below the active fallback", () => {
			const errorBody = "Your Grok CLI version (0.2.33) is outdated. Please update to version 1.0.12 or later";

			expect(updateVersionFromError(errorBody)).toBe(getFallbackVersion());
			expect(getGrokCliVersion()).toBe(getFallbackVersion());
		});

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
});
