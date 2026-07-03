/**
 * Cursor adapter: reads `~/.cursor/mcp.json` (mcpServers).
 *
 * Cursor has no home-level skill/prompt store, so only MCP candidates are
 * produced. Project `.cursor/mcp.json` is out of scope by the adapter contract
 * (home-only, see adapters/index.ts).
 */
import * as path from "node:path";
import type { AdapterResult, McpCandidate } from "../types";
import { type Adapter, type AdapterOptions, parseSourceJson, readSourceText } from "./index";

const SOURCE = "cursor" as const;

export const cursorAdapter: Adapter = {
	source: SOURCE,
	async collect({ homeDir }: AdapterOptions): Promise<AdapterResult> {
		const result: AdapterResult = { mcpCandidates: [], skillCandidates: [], diagnostics: [] };

		const configPath = path.join(homeDir, ".cursor", "mcp.json");
		const read = await readSourceText(configPath, SOURCE, "mcp");
		if ("diagnostic" in read) {
			result.diagnostics.push(read.diagnostic);
			return result;
		}

		const parsed = parseSourceJson(read.text, configPath, SOURCE, "mcp");
		if ("diagnostic" in parsed) {
			result.diagnostics.push(parsed.diagnostic);
			return result;
		}

		const servers = parsed.data.mcpServers;
		if (servers && typeof servers === "object" && !Array.isArray(servers)) {
			for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
				result.mcpCandidates.push({ source: SOURCE, name, raw } satisfies McpCandidate);
			}
		}

		return result;
	},
};
