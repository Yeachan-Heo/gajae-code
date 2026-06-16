import { describe, expect, it } from "bun:test";
import { parseSearchArgs } from "../../../src/cli/web-search-cli";

describe("web search CLI args", () => {
	it("parses inline xAI search flags", () => {
		expect(
			parseSearchArgs([
				"q",
				"--provider=xai",
				"--xai-mode=x",
				"--allowed-x-handles=@xai,elonmusk",
				"--from-date=2025-10-01",
				"--to-date=2025-10-10",
				"--image-understanding",
				"--video-understanding",
				"latest Grok posts",
			]),
		).toMatchObject({
			query: "latest Grok posts",
			provider: "xai",
			xaiSearchMode: "x",
			allowedXHandles: ["@xai", "elonmusk"],
			fromDate: "2025-10-01",
			toDate: "2025-10-10",
			enableImageUnderstanding: true,
			enableVideoUnderstanding: true,
		});
	});
});
