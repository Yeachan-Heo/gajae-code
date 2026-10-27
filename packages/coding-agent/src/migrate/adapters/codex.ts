/**
 * Codex adapter: reads `~/.codex/config.toml` ([mcp_servers]), user prompts,
 * and user-level `~/.codex/AGENTS.md` instructions. Project AGENTS.md is native GJC input.
 */

import * as path from "node:path";
import { TOML } from "bun";
import type { AdapterResult, ManualAction, McpCandidate, SourceDiagnostic } from "../types";
import {
	type Adapter,
	type AdapterOptions,
	collectInstructionFile,
	collectMarkdownCommands,
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

/**
 * Describe `config.toml` settings gjc cannot import. Approvals and sandbox mode
 * change what the agent may do, so they are reported for the user to re-express
 * rather than translated. Environment variable names are listed; values are not.
 */
function describeCodexSettings(data: Record<string, unknown>): ManualAction[] {
	const actions: ManualAction[] = [];
	const model = data.model;
	if (typeof model === "string" && model.trim()) {
		actions.push({
			source: SOURCE,
			area: "config.toml: model",
			detail: `model "${model}" is provider-specific and was not imported; select it with gjc config or --model.`,
		});
	}
	for (const key of ["approval_policy", "sandbox_mode"] as const) {
		const value = data[key];
		if (typeof value !== "string" || !value.trim()) continue;
		actions.push({
			source: SOURCE,
			area: `config.toml: ${key}`,
			detail: `"${value}" has no gjc equivalent and was not imported; review gjc's tool approval and sandbox settings.`,
		});
	}
	const policy = data.shell_environment_policy;
	if (policy && typeof policy === "object" && !Array.isArray(policy)) {
		const record = policy as Record<string, unknown>;
		const setKeys = record.set && typeof record.set === "object" ? Object.keys(record.set as object).sort() : [];
		const unsetKeys = Array.isArray(record.unset)
			? record.unset.filter((key): key is string => typeof key === "string").sort()
			: [];
		if (setKeys.length > 0 || unsetKeys.length > 0) {
			const parts: string[] = [];
			if (setKeys.length > 0) parts.push(`sets ${setKeys.join(", ")}`);
			if (unsetKeys.length > 0) parts.push(`unsets ${unsetKeys.join(", ")}`);
			actions.push({
				source: SOURCE,
				area: "config.toml: shell_environment_policy",
				detail: `shell_environment_policy ${parts.join(" and ")}; variable names were reported without values and nothing was imported.`,
			});
		}
	}
	return actions;
}

export const codexAdapter: Adapter = {
	source: SOURCE,
	async collect({ homeDir, scope }: AdapterOptions): Promise<AdapterResult> {
		const result: AdapterResult = {
			mcpCandidates: [],
			skillCandidates: [],
			slashCommandCandidates: [],
			agentCandidates: [],
			instructionCandidates: [],
			hookCandidates: [],
			diagnostics: [],
			manualActions: [],
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
				result.manualActions.push(...describeCodexSettings(parsed.data));
			}
		}

		const prompts = await collectMarkdownCommands(path.join(homeDir, ".codex", "prompts"), SOURCE);
		result.slashCommandCandidates.push(
			...prompts.candidates.map(candidate => ({ ...candidate, name: `prompts:${candidate.name}` })),
		);
		result.diagnostics.push(...prompts.diagnostics);

		if (scope === "user") {
			const instructions = await collectInstructionFile(path.join(homeDir, ".codex", "AGENTS.md"), SOURCE);
			result.instructionCandidates.push(...instructions.candidates);
			result.diagnostics.push(...instructions.diagnostics);
		}

		return result;
	},
};
