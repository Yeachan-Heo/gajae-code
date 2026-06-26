/**
 * System prompt construction and project context loading
 */

import * as os from "node:os";
import type { AgentTool } from "@gajae-code/agent-core";
import { $env, getGpuCachePath, getProjectDir, hasFsCode, isEnoent, logger, prompt } from "@gajae-code/utils";
import { $ } from "bun";
import { contextFileCapability } from "./capability/context-file";
import { systemPromptCapability } from "./capability/system-prompt";
import type { SkillsSettings } from "./config/settings";
import { type ContextFile, loadCapability, type SystemPrompt as SystemPromptFile } from "./discovery";
import { loadSkills, type Skill } from "./extensibility/skills";
import customSystemPromptTemplate from "./prompts/system/custom-system-prompt.md" with { type: "text" };
import projectPromptTemplate from "./prompts/system/project-prompt.md" with { type: "text" };
import systemPromptTemplate from "./prompts/system/system-prompt.md" with { type: "text" };
import { shortenPath } from "./tools/render-utils";
import { AGENTS_MD_LIMIT, buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

interface AlwaysApplyRule {
	name: string;
	content: string;
	path: string;
}

function normalizePromptBlock(content: string): string {
	return prompt.format(content, { renderPhase: "post-render" }).trim();
}

function splitComparablePromptBlocks(content: string | null | undefined): string[] {
	const normalized = firstNonEmpty(content);
	if (!normalized) return [];

	return normalizePromptBlock(normalized)
		.split(/\n{2,}/)
		.map(block => block.trim())
		.filter(block => block.length > 0);
}

function promptSourceContainsRule(source: string | null | undefined, ruleContent: string): boolean {
	const sourceBlocks = splitComparablePromptBlocks(source);
	const ruleBlocks = splitComparablePromptBlocks(ruleContent);
	if (sourceBlocks.length === 0 || ruleBlocks.length === 0 || ruleBlocks.length > sourceBlocks.length) return false;

	for (let start = 0; start <= sourceBlocks.length - ruleBlocks.length; start += 1) {
		if (ruleBlocks.every((block, offset) => sourceBlocks[start + offset] === block)) return true;
	}

	return false;
}

function dedupeAlwaysApplyRules(
	alwaysApplyRules: AlwaysApplyRule[] | undefined,
	promptSources: Array<string | null | undefined>,
): AlwaysApplyRule[] {
	if (!alwaysApplyRules || alwaysApplyRules.length === 0) return [];

	return alwaysApplyRules.filter(
		rule => !promptSources.some(source => promptSourceContainsRule(source, rule.content)),
	);
}

function dedupePromptSource(source: string | null | undefined, otherSources: Array<string | null | undefined>): string {
	const resolvedSource = firstNonEmpty(source);
	if (!resolvedSource) return "";

	return otherSources.some(otherSource => promptSourceContainsRule(otherSource, resolvedSource)) ? "" : resolvedSource;
}

function firstNonEmpty(...values: (string | undefined | null)[]): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function parseWmicTable(output: string, header: string): string | null {
	const lines = output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	const filtered = lines.filter(line => line.toLowerCase() !== header.toLowerCase());
	return filtered[0] ?? null;
}

const SYSTEM_PROMPT_PREP_TIMEOUT_MS = 5000;

async function getGpuModel(): Promise<string | null> {
	switch (process.platform) {
		case "win32": {
			const output = await $`wmic path win32_VideoController get name`
				.quiet()
				.text()
				.catch(() => null);
			return output ? parseWmicTable(output, "Name") : null;
		}
		case "linux": {
			const output = await $`lspci`
				.quiet()
				.text()
				.catch(() => null);
			if (!output) return null;
			const gpus: Array<{ name: string; priority: number }> = [];
			for (const line of output.split("\n")) {
				if (!/(VGA|3D|Display)/i.test(line)) continue;
				const parts = line.split(":");
				const name = parts.length > 1 ? parts.slice(1).join(":").trim() : line.trim();
				const nameLower = name.toLowerCase();
				// Skip BMC/server management adapters
				if (/aspeed|matrox g200|mgag200/i.test(name)) continue;
				// Prioritize discrete GPUs
				let priority = 0;
				if (
					nameLower.includes("nvidia") ||
					nameLower.includes("geforce") ||
					nameLower.includes("quadro") ||
					nameLower.includes("rtx")
				) {
					priority = 3;
				} else if (nameLower.includes("amd") || nameLower.includes("radeon") || nameLower.includes("rx ")) {
					priority = 3;
				} else if (nameLower.includes("intel")) {
					priority = 1;
				} else {
					priority = 2;
				}
				gpus.push({ name, priority });
			}
			if (gpus.length === 0) return null;
			gpus.sort((a, b) => b.priority - a.priority);
			return gpus[0].name;
		}
		default:
			return null;
	}
}

function getTerminalName(): string | undefined {
	const termProgram = Bun.env.TERM_PROGRAM;
	const termProgramVersion = Bun.env.TERM_PROGRAM_VERSION;
	if (termProgram) {
		return termProgramVersion ? `${termProgram} ${termProgramVersion}` : termProgram;
	}

	if (Bun.env.WT_SESSION) return "Windows Terminal";

	const term = firstNonEmpty(Bun.env.TERM, Bun.env.COLORTERM, Bun.env.TERMINAL_EMULATOR);
	return term ?? undefined;
}

/** Cached system info structure */
interface GpuCache {
	gpu: string;
}

function getSystemInfoCachePath(): string {
	return getGpuCachePath();
}

async function loadGpuCache(): Promise<GpuCache | null> {
	try {
		const cachePath = getSystemInfoCachePath();
		const content = await Bun.file(cachePath).json();
		return content as GpuCache;
	} catch {
		return null;
	}
}

async function saveGpuCache(info: GpuCache): Promise<void> {
	try {
		const cachePath = getSystemInfoCachePath();
		await Bun.write(cachePath, JSON.stringify(info, null, "\t"));
	} catch {
		// Silently ignore cache write failures
	}
}

async function getCachedGpu(): Promise<string | undefined> {
	const cached = await logger.time("getCachedGpu:loadGpuCache", loadGpuCache);
	if (cached) return cached.gpu;
	const gpu = await logger.time("getCachedGpu:getGpuModel", getGpuModel);
	if (gpu) {
		await logger.time("getCachedGpu:saveGpuCache", saveGpuCache, { gpu });
	}
	return gpu ?? undefined;
}
async function getEnvironmentInfo(): Promise<Array<{ label: string; value: string }>> {
	const gpu = await getCachedGpu();
	let cpuModel: string | undefined;
	try {
		cpuModel = os.cpus()[0]?.model;
	} catch {
		cpuModel = undefined;
	}
	const entries: Array<{ label: string; value: string | undefined }> = [
		{ label: "OS", value: `${os.platform()} ${os.release()}` },
		{ label: "Distro", value: os.type() },
		{ label: "Kernel", value: os.version() },
		{ label: "Arch", value: os.arch() },
		{ label: "CPU", value: cpuModel },
		{ label: "GPU", value: gpu },
		{ label: "Terminal", value: getTerminalName() },
	];
	return entries.filter((e): e is { label: string; value: string } => !!e.value);
}

/** Resolve input as file path or literal string */
export async function resolvePromptInput(input: string | undefined, description: string): Promise<string | undefined> {
	if (!input) {
		return undefined;
	} else if (input.includes("\n")) {
		return input;
	}

	try {
		return await Bun.file(input).text();
	} catch (error) {
		if (!hasFsCode(error, "ENAMETOOLONG") && !isEnoent(error)) {
			logger.warn(`Could not read ${description} file`, { path: input, error: String(error) });
		}
		return input;
	}
}

export interface LoadContextFilesOptions {
	/** Working directory to start walking up from. Default: getProjectDir() */
	cwd?: string;
}

function dedupeExactContextFiles(
	contextFiles: Array<{ path: string; content: string; depth?: number }>,
): Array<{ path: string; content: string; depth?: number }> {
	const lastIndexByContent = new Map<string, number>();
	for (const [index, file] of contextFiles.entries()) {
		// Keep the closest matching context entry when content is byte-for-byte identical.
		lastIndexByContent.set(file.content, index);
	}

	return contextFiles.filter((file, index) => lastIndexByContent.get(file.content) === index);
}

/**
 * Load all project context files using the capability API.
 * Returns {path, content, depth} entries for all discovered context files.
 * Files are sorted by depth (descending) so files closer to cwd appear last/more prominent.
 */
export async function loadProjectContextFiles(
	options: LoadContextFilesOptions = {},
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	const resolvedCwd = options.cwd ?? getProjectDir();

	const result = await loadCapability(contextFileCapability.id, { cwd: resolvedCwd });

	// Convert project-level ContextFile items and preserve depth info
	const files = result.items
		.filter(item => (item as ContextFile).level === "project")
		.map(item => {
			const contextFile = item as ContextFile;
			return {
				path: contextFile.path,
				content: contextFile.content,
				depth: contextFile.depth,
			};
		});

	// Sort by depth (descending): higher depth (farther from cwd) comes first,
	// so files closer to cwd appear later and are more prominent
	files.sort((a, b) => {
		const depthA = a.depth ?? -1;
		const depthB = b.depth ?? -1;
		return depthB - depthA;
	});

	return dedupeExactContextFiles(files);
}

/**
 * Load the effective system prompt customization from SYSTEM.md.
 * Project-level SYSTEM.md overrides user-level SYSTEM.md.
 */
export async function loadSystemPromptFiles(options: LoadContextFilesOptions = {}): Promise<string | null> {
	const resolvedCwd = options.cwd ?? getProjectDir();

	const result = await loadCapability<SystemPromptFile>(systemPromptCapability.id, { cwd: resolvedCwd });

	if (result.items.length === 0) return null;

	const projectLevel = result.items.find(item => item.level === "project");
	if (projectLevel) {
		return projectLevel.content;
	}

	const userLevel = result.items.find(item => item.level === "user");
	return userLevel?.content ?? null;
}

export interface SystemPromptToolMetadata {
	label: string;
	description: string;
	/** Tool name the model sees on the provider wire. Defaults to the internal tool name. */
	wireName?: string;
}

export function buildSystemPromptToolMetadata(
	tools: Map<string, AgentTool>,
	overrides: Partial<Record<string, Partial<SystemPromptToolMetadata>>> = {},
): Map<string, SystemPromptToolMetadata> {
	return new Map(
		Array.from(tools.entries(), ([name, tool]) => {
			const toolRecord = tool as AgentTool & { label?: string; description?: string };
			const override = overrides[name];
			const wireName =
				override?.wireName ??
				(typeof toolRecord.customWireName === "string" ? toolRecord.customWireName : undefined);
			return [
				name,
				{
					label: override?.label ?? (typeof toolRecord.label === "string" ? toolRecord.label : ""),
					description:
						override?.description ?? (typeof toolRecord.description === "string" ? toolRecord.description : ""),
					wireName,
				},
			] as const;
		}),
	);
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. */
	tools?: Map<string, SystemPromptToolMetadata>;
	/** Tool names to include in prompt. */
	toolNames?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Rendered GJC plugin system-appendix blocks (lower-authority, appended last). */
	pluginAppendices?: string;
	/** Repeat full tool descriptions in system prompt. Default: false */
	repeatToolDescriptions?: boolean;
	/** Skills settings for discovery. */
	skillsSettings?: SkillsSettings;
	/** Working directory. Default: getProjectDir() */
	cwd?: string;
	/** Pre-loaded context files (skips discovery if provided). */
	contextFiles?: Array<{ path: string; content: string; depth?: number }>;
	/** Skills provided directly to system prompt construction. */
	skills?: Skill[];
	/** Pre-loaded rulebook rules (descriptions, excluding TTSR and always-apply). */
	rules?: Array<{ name: string; description?: string; path: string; globs?: string[] }>;
	/** Intent field name injected into every tool schema. If set, explains the field in the prompt. */
	intentField?: string;
	/** Whether MCP tool discovery is active for this prompt build. */
	mcpDiscoveryMode?: boolean;
	/** Discoverable MCP server summaries to advertise when discovery mode is active. */
	mcpDiscoveryServerSummaries?: string[];
	/** Encourage the agent to delegate via tasks unless changes are trivial. */
	eagerTasks?: boolean;
	/** Rules with alwaysApply=true — their full content is injected into the prompt. */
	alwaysApplyRules?: AlwaysApplyRule[];
	/** Whether secret obfuscation is active. When true, explains the redaction format in the prompt. */
	secretsEnabled?: boolean;
	/** Pre-loaded workspace tree (skips discovery if provided). May be a Promise to allow early kick-off. */
	workspaceTree?: WorkspaceTree | Promise<WorkspaceTree>;
}

/** Result of building provider-facing system prompt messages. */
export interface BuildSystemPromptResult {
	/** Ordered system prompt blocks. Providers should preserve entries as distinct messages/blocks. */
	systemPrompt: string[];
}

/** Build the system prompt with tools, guidelines, and context */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	if ($env.NULL_PROMPT === "true") {
		return { systemPrompt: [] };
	}

	const {
		customPrompt,
		tools,
		appendSystemPrompt,
		pluginAppendices,
		repeatToolDescriptions = false,
		skillsSettings,
		toolNames: providedToolNames,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		rules,
		alwaysApplyRules,
		intentField,
		mcpDiscoveryMode = false,
		mcpDiscoveryServerSummaries = [],
		eagerTasks = false,
		secretsEnabled = false,
		workspaceTree: providedWorkspaceTree,
	} = options;
	const resolvedCwd = cwd ?? getProjectDir();

	const prepDefaults = {
		resolvedCustomPrompt: undefined as string | undefined,
		resolvedAppendPrompt: undefined as string | undefined,
		systemPromptCustomization: null as string | null,
		contextFiles: dedupeExactContextFiles(providedContextFiles ?? []),
		skills: providedSkills ?? ([] as Skill[]),
		workspaceTree: {
			rootPath: resolvedCwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		} satisfies WorkspaceTree,
	};

	const deadline = Bun.sleep(SYSTEM_PROMPT_PREP_TIMEOUT_MS).then(() => "__timeout__" as const);
	const timedOut: string[] = [];
	const failed: Array<{ name: string; error: unknown }> = [];

	async function withDeadline<T>(name: string, work: Promise<T>, fallback: T): Promise<T> {
		const tagged = work
			.then(value => ({ kind: "ok" as const, value }))
			.catch(error => ({ kind: "err" as const, error }));
		const result = await Promise.race([tagged, deadline]);
		if (result === "__timeout__") {
			timedOut.push(name);
			// Let the work continue in the background so its caches still warm; just log on completion.
			void tagged.then(r => {
				if (r.kind === "err") {
					logger.warn("Background system prompt preparation step failed", { name, error: String(r.error) });
				} else {
					logger.debug("Background system prompt preparation step completed after timeout", { name });
				}
			});
			return fallback;
		}
		if (result.kind === "err") {
			failed.push({ name, error: result.error });
			return fallback;
		}
		return result.value;
	}

	const systemPromptCustomizationPromise = logger.time("loadSystemPromptFiles", loadSystemPromptFiles, {
		cwd: resolvedCwd,
	});
	const contextFilesPromise = providedContextFiles
		? Promise.resolve(providedContextFiles)
		: logger.time("loadProjectContextFiles", loadProjectContextFiles, { cwd: resolvedCwd });
	const workspaceTreePromise =
		providedWorkspaceTree !== undefined
			? Promise.resolve(providedWorkspaceTree)
			: logger.time("buildWorkspaceTree", () =>
					buildWorkspaceTree(resolvedCwd, { timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS }),
				);
	const skillsPromise: Promise<Skill[]> =
		providedSkills !== undefined
			? Promise.resolve(providedSkills)
			: skillsSettings?.enabled !== false
				? loadSkills({ ...skillsSettings, cwd: resolvedCwd }).then(result => result.skills)
				: Promise.resolve([]);

	const [resolvedCustomPrompt, resolvedAppendPrompt, systemPromptCustomization, contextFiles, skills, workspaceTree] =
		await Promise.all([
			withDeadline(
				"customPrompt",
				resolvePromptInput(customPrompt, "system prompt"),
				prepDefaults.resolvedCustomPrompt,
			),
			withDeadline(
				"appendSystemPrompt",
				resolvePromptInput(appendSystemPrompt, "append system prompt"),
				prepDefaults.resolvedAppendPrompt,
			),
			withDeadline(
				"loadSystemPromptFiles",
				systemPromptCustomizationPromise,
				prepDefaults.systemPromptCustomization,
			),
			withDeadline("loadProjectContextFiles", contextFilesPromise, prepDefaults.contextFiles).then(
				dedupeExactContextFiles,
			),
			withDeadline("loadSkills", skillsPromise, prepDefaults.skills),
			withDeadline("buildWorkspaceTree", workspaceTreePromise, prepDefaults.workspaceTree),
		]);
	const agentsMdFiles = Array.from(new Set(workspaceTree.agentsMdFiles)).sort().slice(0, AGENTS_MD_LIMIT);

	if (timedOut.length > 0) {
		logger.warn("System prompt preparation steps timed out; using minimal fallback for those steps", {
			cwd: resolvedCwd,
			timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS,
			steps: timedOut,
		});
		process.stderr.write(
			`Warning: system prompt preparation steps timed out after ${SYSTEM_PROMPT_PREP_TIMEOUT_MS}ms (${timedOut.join(", ")}); using minimal fallback for those steps.\n`,
		);
	}
	if (failed.length > 0) {
		for (const { name, error } of failed) {
			logger.warn("System prompt preparation step failed; using minimal fallback", {
				cwd: resolvedCwd,
				step: name,
				error: String(error),
			});
		}
	}

	const date = new Date().toISOString().slice(0, 10);
	const dateTime = date;
	const promptCwd = shortenPath(resolvedCwd.replace(/\\/g, "/"));

	// Build tool metadata for system prompt rendering
	// Priority: explicit list > tools map > defaults
	// Default includes both bash and python; actual availability determined by settings in createTools
	let toolNames = providedToolNames;
	if (!toolNames) {
		if (tools) {
			// Tools map provided
			toolNames = Array.from(tools.keys());
		} else {
			// Use defaults
			toolNames = ["read", "bash", "eval", "edit", "write"]; // TODO: Why?
		}
	}

	// Build tool descriptions for system prompt rendering.
	const toolPromptNames = new Map<string, string>(toolNames.map(name => [name, tools?.get(name)?.wireName ?? name]));
	const toolRefs = Object.fromEntries(toolPromptNames.entries());
	const toolInfo = toolNames.map(name => ({
		name: toolPromptNames.get(name) ?? name,
		internalName: name,
		label: tools?.get(name)?.label ?? "",
		description: tools?.get(name)?.description ?? "",
	}));

	// Filter skills for the rendered system prompt:
	// - require the `read` tool so the model can actually fetch skill content;
	// - drop skills with frontmatter `hide: true` (still loadable via skill:// and /skill:<name>).
	const hasRead = tools?.has("read");
	const filteredSkills = hasRead ? skills.filter(skill => skill.hide !== true) : [];

	const effectiveSystemPromptCustomization = dedupePromptSource(systemPromptCustomization, [
		resolvedCustomPrompt,
		resolvedAppendPrompt,
	]);
	const promptSources = [effectiveSystemPromptCustomization, resolvedCustomPrompt, resolvedAppendPrompt];
	const injectedAlwaysApplyRules = dedupeAlwaysApplyRules(alwaysApplyRules, promptSources);

	const environment = await logger.time("getEnvironmentInfo", getEnvironmentInfo);
	const data = {
		systemPromptCustomization: effectiveSystemPromptCustomization,
		customPrompt: resolvedCustomPrompt,
		appendPrompt: resolvedAppendPrompt ?? "",
		tools: toolNames,
		toolInfo,
		repeatToolDescriptions,
		toolRefs,
		environment,
		contextFiles,
		agentsMdSearch: { files: agentsMdFiles },
		workspaceTree,
		skills: filteredSkills,
		rules: rules ?? [],
		alwaysApplyRules: injectedAlwaysApplyRules,
		date,
		dateTime,
		cwd: promptCwd,
		intentTracing: !!intentField,
		intentField: intentField ?? "",
		mcpDiscoveryMode,
		hasMCPDiscoveryServers: mcpDiscoveryServerSummaries.length > 0,
		mcpDiscoveryServerSummaries,
		eagerTasks,
		secretsEnabled,
	};
	const rendered = prompt.render(resolvedCustomPrompt ? customSystemPromptTemplate : systemPromptTemplate, data);
	const systemPrompt = [rendered];
	const projectPrompt = resolvedCustomPrompt ? "" : prompt.render(projectPromptTemplate, data).trim();
	if (projectPrompt) {
		systemPrompt.push(projectPrompt);
	}

	// Plugin system appendices are appended last as a lower-authority block; they
	// can never override base/project/developer instructions above them.
	if (pluginAppendices?.trim()) {
		systemPrompt.push(pluginAppendices.trim());
	}

	return { systemPrompt };
}
