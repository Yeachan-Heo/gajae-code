/**
 * OpenCode adapter: reads `~/.config/opencode/opencode.json` (mcp), plus
 * `~/.config/opencode/skills` and `~/.config/opencode/commands`.
 */
import * as path from "node:path";
import type { AdapterResult, McpCandidate } from "../types";
import {
	type Adapter,
	type AdapterOptions,
	collectMarkdownPrompts,
	collectSkillTree,
	parseSourceJson,
	readSourceText,
} from "./index";

const SOURCE = "opencode" as const;

export const opencodeAdapter: Adapter = {
	source: SOURCE,
	async collect({ homeDir }: AdapterOptions): Promise<AdapterResult> {
		const result: AdapterResult = {
			mcpCandidates: [],
			skillCandidates: [],
			instructionCandidates: [],
			diagnostics: [],
		};
		const baseDir = path.join(homeDir, ".config", "opencode");

		const configPath = path.join(baseDir, "opencode.json");
		const read = await readSourceText(configPath, SOURCE, "mcp");
		if ("diagnostic" in read) {
			result.diagnostics.push(read.diagnostic);
		} else {
			const parsed = parseSourceJson(read.text, configPath, SOURCE, "mcp");
			if ("diagnostic" in parsed) {
				result.diagnostics.push(parsed.diagnostic);
			} else {
				const servers = parsed.data.mcp;
				if (servers && typeof servers === "object" && !Array.isArray(servers)) {
					for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
						result.mcpCandidates.push({ source: SOURCE, name, raw } satisfies McpCandidate);
					}
				}
			}
		}

		const skills = await collectSkillTree(path.join(baseDir, "skills"), SOURCE);
		result.skillCandidates.push(...skills.candidates);
		result.diagnostics.push(...skills.diagnostics);

		const commands = await collectMarkdownPrompts(path.join(baseDir, "commands"), SOURCE);
		result.skillCandidates.push(...commands.candidates);
		result.diagnostics.push(...commands.diagnostics);

		return result;
	},
};
