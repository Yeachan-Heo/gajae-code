/**
 * Exa Search Tools
 *
 * Basic neural/keyword search, deep research, code search, and URL crawling.
 */
import type { TSchema } from "@gajae-code/ai/core";
import * as z from "zod/v4";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { createExaTool } from "./factory";
import type { ExaRenderDetails } from "./types";

/** exa_search - Basic neural/keyword search */
const exaSearchTool = createExaTool(
	"exa_search",
	"Exa Search",
	`Search the web using Exa's neural or keyword search.

Returns structured search results with optional text content and highlights.

Parameters:
- query: Search query (required)
- type: Search type - "neural" (semantic), "keyword" (exact), or "auto" (default: auto)
- include_domains: Array of domains to include in results
- exclude_domains: Array of domains to exclude from results
- start_published_date: Filter results published after this date (ISO 8601)
- end_published_date: Filter results published before this date (ISO 8601)
- use_autoprompt: Let Exa optimize your query automatically (default: true)
- text: Include page text content in results (default: false, costs more)
- highlights: Include highlighted relevant snippets (default: false)
- num_results: Maximum number of results to return (default: 10, max: 100)`,

	z.object({
		query: z.string().describe("search query"),
		type: z.enum(["keyword", "neural", "auto"]).describe("search type").optional(),
		include_domains: z.array(z.string()).describe("include domains").optional(),
		exclude_domains: z.array(z.string()).describe("exclude domains").optional(),
		start_published_date: z.string().describe("published after (iso 8601)").optional(),
		end_published_date: z.string().describe("published before (iso 8601)").optional(),
		use_autoprompt: z.boolean().describe("autoprompt").optional(),
		text: z.boolean().describe("include page text").optional(),
		highlights: z.boolean().describe("include highlights").optional(),
		num_results: z.number().int().min(1).max(100).describe("max results (1-100)").optional(),
	}),
	"web_search_exa",
);

export const searchTools: CustomTool<TSchema, ExaRenderDetails>[] = [exaSearchTool];
