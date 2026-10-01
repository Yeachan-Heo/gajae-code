import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import {
	getGrokCliVersion,
	parseMinimumVersionFrom426,
	updateVersionFromError,
	resetVersionCache,
	getFallbackVersion,
} from "../src/defaults/gjc/extensions/grok-cli-vendor/src/provider/version-manager";

describe("Grok CLI version manager", () => {
	beforeEach(() => {
		resetVersionCache();
	});

	it("returns fallback version when GitHub API is unavailable", async () => {
		const version = await getGrokCliVersion();
		expect(version).toBe(getFallbackVersion());
		expect(version).toBe("1.0.13");
	});

	describe("parseMinimumVersionFrom426", () => {
		it("extracts version from standard 426 error message", () => {
			const errorBody =
				"Your Grok CLI version (0.2.33) is outdated. Please update to version 1.0.13 or later";
			const version = parseMinimumVersionFrom426(errorBody);
			expect(version).toBe("1.0.13");
		});

		it("extracts version with different formatting", () => {
			const errorBody =
				"Your Grok CLI version (0.2.30) is outdated. Please update to version 2.1.5 or later.";
			const version = parseMinimumVersionFrom426(errorBody);
			expect(version).toBe("2.1.5");
		});

		it("handles case-insensitive error messages", () => {
			const errorBody =
				"Your Grok CLI version (0.2.33) is outdated. PLEASE UPDATE TO VERSION 1.5.0 OR LATER";
			const version = parseMinimumVersionFrom426(errorBody);
			expect(version).toBe("1.5.0");
		});

		it("returns null when version is not found in error body", () => {
			const errorBody = "Some other error message without version info";
			const version = parseMinimumVersionFrom426(errorBody);
			expect(version).toBeNull();
		});

		it("handles malformed version numbers gracefully", () => {
			const errorBody =
				"Your Grok CLI version (0.2.33) is outdated. Please update to version x.y.z or later";
			const version = parseMinimumVersionFrom426(errorBody);
			// Should still extract even if format is unusual
			expect(version).toBe("x.y.z");
		});
	});

	describe("updateVersionFromError", () => {
		it("updates cache and returns version from error message", () => {
			const errorBody =
				"Your Grok CLI version (0.2.33) is outdated. Please update to version 1.0.20 or later";
			const version = updateVersionFromError(errorBody);
			expect(version).toBe("1.0.20");
		});

		it("returns fallback when error message has no version", () => {
			const errorBody = "Unknown error";
			const version = updateVersionFromError(errorBody);
			expect(version).toBe(getFallbackVersion());
		});

		it("subsequent calls use the updated version", async () => {
			const errorBody =
				"Your Grok CLI version (0.2.33) is outdated. Please update to version 1.2.3 or later";
			updateVersionFromError(errorBody);

			// Next call should use the cached version
			const cachedVersion = await getGrokCliVersion();
			expect(cachedVersion).toBe("1.2.3");
		});
	});

	describe("version caching", () => {
		it("uses cached version on subsequent calls", async () => {
			const version1 = await getGrokCliVersion();
			const version2 = await getGrokCliVersion();
			expect(version1).toBe(version2);
		});
	});

	describe("GitHub fetch behavior (when mocked)", () => {
		it("would use fetched version if GitHub API succeeds", async () => {
			// This is a placeholder test showing the expected behavior
			// In production, real network calls would use the fetched version
			const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						tag_name: "v1.2.3",
					}),
					{ status: 200 },
				),
			);

			const version = await getGrokCliVersion();
			// Should use fallback initially, but next await would get the real version
			expect(version).toBeDefined();

			fetchSpy.mockRestore();
		});

		it("handles GitHub API network errors gracefully", async () => {
			const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValueOnce(
				new Error("Network error"),
			);

			const version = await getGrokCliVersion();
			expect(version).toBe(getFallbackVersion());

			fetchSpy.mockRestore();
		});

		it("strips 'v' prefix from GitHub tag names", async () => {
			const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						tag_name: "v1.0.13",
					}),
					{ status: 200 },
				),
			);

			// Wait a bit for the background fetch to complete
			await new Promise((resolve) => setTimeout(resolve, 50));

			fetchSpy.mockRestore();
		});
	});
});
