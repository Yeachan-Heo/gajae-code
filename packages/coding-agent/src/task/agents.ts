/**
 * Bundled agent definitions.
 *
 * Agents are embedded at build time via Bun's import with { type: "text" }.
 */
import { parseFrontmatter, prompt } from "@gajae-code/utils";
import { parseAgentFields } from "../discovery/helpers";
import ralplanPersistenceTemplate from "../prompts/agent-fragments/ralplan-persistence.md" with { type: "text" };
import restrictedBashTemplate from "../prompts/agent-fragments/restricted-bash.md" with { type: "text" };
// Embed agent markdown files at build time
import architectMd from "../prompts/agents/architect.md" with { type: "text" };
import criticMd from "../prompts/agents/critic.md" with { type: "text" };
import executorMd from "../prompts/agents/executor.md" with { type: "text" };
import agentFrontmatterTemplate from "../prompts/agents/frontmatter.md" with { type: "text" };
import plannerMd from "../prompts/agents/planner.md" with { type: "text" };

import type { AgentDefinition, AgentSource } from "./types";

interface AgentFrontmatter {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string;
	model?: string | string[];
	thinkingLevel?: string;
	blocking?: boolean;
	hide?: boolean;
	forkContext?: "forbidden" | "allowed";
	bashAllowedPrefixes?: string[];
}

interface EmbeddedAgentDef {
	fileName: string;
	frontmatter?: AgentFrontmatter;
	template: string;
}

const ULTRAGOAL_RED_TEAM_OPEN = "__GJC_ULTRAGOAL_RED_TEAM_OPEN__";
const ULTRAGOAL_RED_TEAM_CLOSE = "__GJC_ULTRAGOAL_RED_TEAM_CLOSE__";

function buildAgentContent(def: EmbeddedAgentDef): string {
	const restrictedBash = prompt.render(restrictedBashTemplate);
	const ralplanPersistence = prompt.render(ralplanPersistenceTemplate, {
		stage: def.frontmatter?.name ?? def.fileName.replace(/\.md$/, ""),
	});
	const template =
		def.fileName === "executor.md"
			? def.template
					.replace("{{#if ultragoalRedTeam}}", ULTRAGOAL_RED_TEAM_OPEN)
					.replace("{{/if}}", ULTRAGOAL_RED_TEAM_CLOSE)
			: def.template;
	const body = prompt
		.render(template, { restrictedBash, ralplanPersistence })
		.replace(ULTRAGOAL_RED_TEAM_OPEN, "{{#if ultragoalRedTeam}}")
		.replace(ULTRAGOAL_RED_TEAM_CLOSE, "{{/if}}");
	if (!def.frontmatter) return body;
	return prompt.render(agentFrontmatterTemplate, { ...def.frontmatter, body });
}

const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef[] = [
	{ fileName: "executor.md", template: executorMd },
	{ fileName: "architect.md", template: architectMd },
	{ fileName: "planner.md", template: plannerMd },
	{ fileName: "critic.md", template: criticMd },
];

// Computed lazily on first loadBundledAgents() call to avoid eager prompt.render at module load.

export class AgentParsingError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse agent: ${error.message}`, { cause: error });
		this.name = "AgentParsingError";
	}

	toString(): string {
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

/**
 * Parse an agent from embedded content.
 */
export function parseAgent(
	filePath: string,
	content: string,
	source: AgentSource,
	level: "fatal" | "warn" | "off" = "fatal",
): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter(content, {
		location: filePath,
		level,
	});
	const fields = parseAgentFields(frontmatter);
	if (!fields) {
		throw new AgentParsingError(new Error(`Invalid agent field: ${filePath}\n${content}`), filePath);
	}
	return {
		...fields,
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Cache for bundled agents */
let bundledAgentsCache: AgentDefinition[] | null = null;

/**
 * Load all bundled agents from embedded content.
 * Results are cached after first load.
 */
export function loadBundledAgents(): AgentDefinition[] {
	if (bundledAgentsCache !== null) {
		return bundledAgentsCache;
	}
	const utilityAgents = EMBEDDED_AGENT_DEFS.map(def =>
		parseAgent(`embedded:${def.fileName}`, buildAgentContent(def), "bundled"),
	);
	bundledAgentsCache = utilityAgents;
	return bundledAgentsCache;
}

/**
 * Get a bundled agent by name.
 */
export function getBundledAgent(name: string): AgentDefinition | undefined {
	return loadBundledAgents().find(a => a.name === name);
}

/**
 * Get all bundled agents as a map keyed by name.
 */
export function getBundledAgentsMap(): Map<string, AgentDefinition> {
	const map = new Map<string, AgentDefinition>();
	for (const agent of loadBundledAgents()) {
		map.set(agent.name, agent);
	}
	return map;
}

/**
 * Clear the bundled agents cache (for testing).
 */
export function clearBundledAgentsCache(): void {
	bundledAgentsCache = null;
}

// Re-export for backward compatibility
export const BUNDLED_AGENTS = loadBundledAgents;
