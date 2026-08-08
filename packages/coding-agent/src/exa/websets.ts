/**
 * Exa Websets Tools
 *
 * CRUD operations for websets, items, searches, enrichments, and monitoring.
 */
import type { TSchema } from "@gajae-code/ai/core";
import * as z from "zod/v4";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { callWebsetsTool, findApiKey } from "./mcp-client";
import type { ExaRenderDetails } from "./types";

/** Helper to create a websets tool with proper execute signature */
function createWebsetTool(
	name: string,
	label: string,
	description: string,
	parameters: TSchema,
	mcpToolName: string,
): CustomTool<TSchema, ExaRenderDetails> {
	return {
		name,
		label,
		description,
		parameters,
		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			try {
				const apiKey = findApiKey();
				if (!apiKey) {
					return {
						content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
						details: { error: "EXA_API_KEY not found", toolName: name },
					};
				}
				const result = await callWebsetsTool(apiKey, mcpToolName, params as Record<string, unknown>);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
					details: { raw: result, toolName: name },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					details: { error: message, toolName: name },
				};
			}
		},
	};
}

// CRUD Operations
const websetCreateTool = createWebsetTool(
	"webset_create",
	"Create Webset",
	"Create a new webset collection for organizing web content.",
	z.object({
		name: z.string().describe("webset name"),
		description: z.string().describe("description").optional(),
	}),
	"create_webset",
);

const websetListTool = createWebsetTool(
	"webset_list",
	"List Websets",
	"List all websets in your account.",
	z.object({}),
	"list_websets",
);

const websetGetTool = createWebsetTool(
	"webset_get",
	"Get Webset",
	"Get details of a specific webset by ID.",
	z.object({
		id: z.string().describe("webset id"),
	}),
	"get_webset",
);

const websetUpdateTool = createWebsetTool(
	"webset_update",
	"Update Webset",
	"Update a webset's name or description.",
	z.object({
		id: z.string().describe("webset id"),
		name: z.string().describe("new name").optional(),
		description: z.string().describe("new description").optional(),
	}),
	"update_webset",
);

const websetDeleteTool = createWebsetTool(
	"webset_delete",
	"Delete Webset",
	"Delete a webset and all its contents.",
	z.object({
		id: z.string().describe("webset id"),
	}),
	"delete_webset",
);

// Item Management
const websetItemsListTool = createWebsetTool(
	"webset_items_list",
	"List Webset Items",
	"List items in a webset with optional pagination.",
	z.object({
		webset_id: z.string().describe("webset id"),
		limit: z.number().describe("max items").optional(),
		offset: z.number().describe("offset").optional(),
	}),
	"list_webset_items",
);

const websetItemGetTool = createWebsetTool(
	"webset_item_get",
	"Get Webset Item",
	"Get a specific item from a webset.",
	z.object({
		webset_id: z.string().describe("webset id"),
		item_id: z.string().describe("item id"),
	}),
	"get_item",
);

// Search Operations
const websetSearchCreateTool = createWebsetTool(
	"webset_search_create",
	"Create Webset Search",
	"Create a new search within a webset.",
	z.object({
		webset_id: z.string().describe("webset id"),
		query: z.string().describe("search query"),
	}),
	"create_search",
);

const websetSearchGetTool = createWebsetTool(
	"webset_search_get",
	"Get Webset Search",
	"Get the status and results of a webset search.",
	z.object({
		webset_id: z.string().describe("webset id"),
		search_id: z.string().describe("search id"),
	}),
	"get_search",
);

const websetSearchCancelTool = createWebsetTool(
	"webset_search_cancel",
	"Cancel Webset Search",
	"Cancel a running webset search.",
	z.object({
		webset_id: z.string().describe("webset id"),
		search_id: z.string().describe("search id"),
	}),
	"cancel_search",
);

// Enrichment Operations
const websetEnrichmentCreateTool = createWebsetTool(
	"webset_enrichment_create",
	"Create Enrichment",
	"Create a new enrichment task for a webset.",
	z.object({
		webset_id: z.string().describe("webset id"),
		name: z.string().describe("enrichment name"),
		prompt: z.string().describe("enrichment prompt"),
	}),
	"create_enrichment",
);

const websetEnrichmentGetTool = createWebsetTool(
	"webset_enrichment_get",
	"Get Enrichment",
	"Get the status and results of an enrichment task.",
	z.object({
		webset_id: z.string().describe("webset id"),
		enrichment_id: z.string().describe("enrichment id"),
	}),
	"get_enrichment",
);

const websetEnrichmentUpdateTool = createWebsetTool(
	"webset_enrichment_update",
	"Update Enrichment",
	"Update an enrichment's name or prompt.",
	z.object({
		webset_id: z.string().describe("webset id"),
		enrichment_id: z.string().describe("enrichment id"),
		name: z.string().describe("new name").optional(),
		prompt: z.string().describe("new prompt").optional(),
	}),
	"update_enrichment",
);

const websetEnrichmentDeleteTool = createWebsetTool(
	"webset_enrichment_delete",
	"Delete Enrichment",
	"Delete an enrichment task.",
	z.object({
		webset_id: z.string().describe("webset id"),
		enrichment_id: z.string().describe("enrichment id"),
	}),
	"delete_enrichment",
);

const websetEnrichmentCancelTool = createWebsetTool(
	"webset_enrichment_cancel",
	"Cancel Enrichment",
	"Cancel a running enrichment task.",
	z.object({
		webset_id: z.string().describe("webset id"),
		enrichment_id: z.string().describe("enrichment id"),
	}),
	"cancel_enrichment",
);

// Monitoring
const websetMonitorCreateTool = createWebsetTool(
	"webset_monitor_create",
	"Create Monitor",
	"Create a monitoring task for a webset with optional webhook notifications.",
	z.object({
		webset_id: z.string().describe("webset id"),
		webhook_url: z.string().describe("webhook url").optional(),
	}),
	"create_monitor",
);

export const websetsTools: CustomTool<TSchema, ExaRenderDetails>[] = [
	websetCreateTool,
	websetListTool,
	websetGetTool,
	websetUpdateTool,
	websetDeleteTool,
	websetItemsListTool,
	websetItemGetTool,
	websetSearchCreateTool,
	websetSearchGetTool,
	websetSearchCancelTool,
	websetEnrichmentCreateTool,
	websetEnrichmentGetTool,
	websetEnrichmentUpdateTool,
	websetEnrichmentDeleteTool,
	websetEnrichmentCancelTool,
	websetMonitorCreateTool,
];
