import { describe, expect, it } from "bun:test";
import { parseSearchArgs } from "../../../src/cli/web-search-cli";
import Search from "../../../src/commands/web-search";

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

	it("parses separate, repeated, singular, and plural xAI list flags", () => {
		expect(
			parseSearchArgs([
				"web-search",
				"--allowed-domain",
				" docs.x.ai, ",
				"--allowed-domains=api.x.ai,console.x.ai",
				"--excluded-x-handle",
				" @spam ",
				"--excluded-x-handles=bot, ",
				"--image-search",
				"filtered search",
			]),
		).toMatchObject({
			query: "filtered search",
			allowedDomains: ["docs.x.ai", "api.x.ai", "console.x.ai"],
			excludedXHandles: ["@spam", "bot"],
			enableImageSearch: true,
		});
	});

	it("registers repeatable singular and plural xAI list flags on the command path", () => {
		expect(Search.flags["allowed-domain"]?.multiple).toBe(true);
		expect(Search.flags["allowed-domains"]?.multiple).toBe(true);
		expect(Search.flags["excluded-domain"]?.multiple).toBe(true);
		expect(Search.flags["excluded-domains"]?.multiple).toBe(true);
		expect(Search.flags["allowed-x-handle"]?.multiple).toBe(true);
		expect(Search.flags["allowed-x-handles"]?.multiple).toBe(true);
		expect(Search.flags["excluded-x-handle"]?.multiple).toBe(true);
		expect(Search.flags["excluded-x-handles"]?.multiple).toBe(true);
	});
});
