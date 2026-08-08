/**
 * Shared factory for creating Exa tools with consistent error handling and response formatting.
 */
import type { TSchema } from "@gajae-code/ai/core";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { callExaTool, findApiKey, formatGenericResponse, formatSearchResults, isSearchResponse } from "./mcp-client";
import type { ExaRenderDetails } from "./types";

/** Creates an Exa tool with standardized API key handling, error wrapping, and optional search response formatting. */
export function createExaTool(
	name: string,
	label: string,
	description: string,
	parameters: TSchema,
	mcpToolName: string,
	options?: {
		/** When true, checks isSearchResponse and formats with formatSearchResults. Default: true */
		formatResponse?: boolean;
		/** Transform params before passing to callExaTool */
		transformParams?: (params: Record<string, unknown>) => Record<string, unknown>;
	},
): CustomTool<TSchema, ExaRenderDetails> {
	const formatResponse = options?.formatResponse ?? true;
	const transformParams = options?.transformParams;

	return {
		name,
		label,
		description,
		parameters,
		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			try {
				const apiKey = findApiKey();
				// Exa MCP endpoint is publicly accessible; API key is optional
				const rawArgs = params as Record<string, unknown>;
				const args = transformParams ? transformParams(rawArgs) : rawArgs;
				const response = await callExaTool(mcpToolName, args, apiKey);

				if (formatResponse && isSearchResponse(response)) {
					const formatted = formatSearchResults(response);
					return {
						content: [{ type: "text" as const, text: formatted }],
						details: { response, toolName: name },
					};
				}

				return {
					content: [{ type: "text" as const, text: formatGenericResponse(response) }],
					details: { raw: response, toolName: name },
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
