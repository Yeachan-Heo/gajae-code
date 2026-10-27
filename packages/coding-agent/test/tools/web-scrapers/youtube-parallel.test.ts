import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import * as toolsManager from "../../../src/utils/tools-manager";
import { specialHandlers } from "../../../src/web/scrapers";
import { handleYouTube } from "../../../src/web/scrapers/youtube";

function hookParallelExtract() {
	return hookFetch(input => {
		const url = String(input);
		if (url === "https://api.parallel.ai/v1beta/extract") {
			return new Response(
				JSON.stringify({
					extract_id: "extract-youtube-1",
					results: [
						{
							url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
							title: "Video page",
							excerpts: [
								"Parallel summary for the video page that is comfortably longer than one hundred characters. ".repeat(
									2,
								),
							],
							full_content: null,
						},
					],
					errors: [],
					warnings: null,
					usage: null,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("unexpected", { status: 500 });
	});
}

describe("handleYouTube with Parallel extract", () => {
	let settings: Settings;

	beforeEach(async () => {
		resetSettingsForTest();
		process.env.PARALLEL_API_KEY = "test-parallel-key";
		settings = await Settings.init({ inMemory: true, overrides: { "providers.parallelFetch": true } });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		delete process.env.PARALLEL_API_KEY;
	});

	it("returns Parallel extract content before yt-dlp fallback", async () => {
		const ensureToolSpy = vi.spyOn(toolsManager, "ensureTool");
		using _hook = hookParallelExtract();

		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 10, undefined, null, settings);
		expect(result?.method).toBe("parallel");
		expect(result?.finalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Parallel summary for the video page");
		expect(result?.notes).toContain("Used Parallel extract for YouTube");
		expect(ensureToolSpy).not.toHaveBeenCalled();
	});

	it("scrapes from the caller's settings when the global singleton was never initialized", async () => {
		// The SDK/ACP host path runs tools without Settings.init(); a global read
		// there threw "Settings not initialized. Call Settings.init() first."
		// instead of scraping the page.
		resetSettingsForTest();
		using _hook = hookParallelExtract();
		const injected = {
			get: (path: string) => (path === "providers.parallelFetch" ? true : undefined),
		} as unknown as Settings;

		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 10, undefined, null, injected);

		expect(result?.method).toBe("parallel");
	});

	it("registers the real YouTube handler so caller storage and settings reach it", () => {
		// A wrapping adapter that dropped the trailing arguments left the handler
		// with no storage (Parallel extract unreachable) and no settings.
		expect(specialHandlers).toContain(handleYouTube);
	});
});
