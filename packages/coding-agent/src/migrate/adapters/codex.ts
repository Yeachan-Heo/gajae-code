/**
 * Codex adapter: reads `~/.codex/config.toml` ([mcp_servers]), `~/.codex/prompts`,
 * and user-level `~/.codex/AGENTS.md` instructions. Project AGENTS.md is native GJC input.
 */

import * as path from "node:path";
import { TOML } from "bun";
import type { AdapterResult, McpCandidate, SourceDiagnostic } from "../types";
import {
	type Adapter,
	type AdapterOptions,
	collectInstructionFile,
	collectMarkdownPrompts,
	readSourceText,
} from "./index";

const SOURCE = "codex" as const;

function parseToml(
	text: string,
	filePath: string,
): { data: Record<string, unknown> } | { diagnostic: SourceDiagnostic } {
	try {
		const data = TOML.parse(text) as unknown;
		if (typeof data !== "object" || data === null) {
			return {
				diagnostic: {
					source: SOURCE,
					type: "mcp",
					status: "failed_invalid_source",
					message: `${filePath} is not a TOML table`,
				},
			};
		}
		return { data: data as Record<string, unknown> };
	} catch (error) {
		return {
			diagnostic: {
				source: SOURCE,
				type: "mcp",
				status: "failed_invalid_source",
				message: `invalid TOML in ${filePath}: ${(error as Error).message}`,
			},
		};
	}
}

export const codexAdapter: Adapter = {
	source: SOURCE,
	async collect({ homeDir, scope }: AdapterOptions): Promise<AdapterResult> {
		const result: AdapterResult = {
			mcpCandidates: [],
			skillCandidates: [],
			instructionCandidates: [],
			diagnostics: [],
		};

		const configPath = path.join(homeDir, ".codex", "config.toml");
		const read = await readSourceText(configPath, SOURCE, "mcp");
		if ("diagnostic" in read) {
			result.diagnostics.push(read.diagnostic);
		} else {
			const parsed = parseToml(read.text, configPath);
			if ("diagnostic" in parsed) {
				result.diagnostics.push(parsed.diagnostic);
			} else {
				const servers = parsed.data.mcp_servers;
				if (servers && typeof servers === "object" && !Array.isArray(servers)) {
					for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
						result.mcpCandidates.push({ source: SOURCE, name, raw } satisfies McpCandidate);
					}
				}
			}
		}

		const prompts = await collectMarkdownPrompts(path.join(homeDir, ".codex", "prompts"), SOURCE);
		result.skillCandidates.push(...prompts.candidates);
		result.diagnostics.push(...prompts.diagnostics);

		if (scope === "user") {
			const instructions = await collectInstructionFile(path.join(homeDir, ".codex", "AGENTS.md"), SOURCE);
			result.instructionCandidates.push(...instructions.candidates);
			result.diagnostics.push(...instructions.diagnostics);
		}

		return result;
	},
};
