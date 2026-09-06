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
import type { Skill } from "./extensibility/skills";
import customSystemPromptTemplate from "./prompts/system/custom-system-prompt.md" with { type: "text" };
import projectPromptTemplate from "./prompts/system/project-prompt.md" with { type: "text" };
import systemPromptTemplate from "./prompts/system/system-prompt.md" with { type: "text" };
import volatileProjectContextTemplate from "./prompts/system/volatile-project-context.md" with { type: "text" };
import { escapePromptMetadata } from "./session/messages";
import { DEFAULT_ESSENTIAL_TOOL_NAMES } from "./tools";
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

/** Neutralize tag-like sequences in embedded project context so file bodies cannot escape framing. */
function sanitizeEmbeddedPromptContent(content: string): string {
	return escapePromptMetadata(content, { preserveNewlines: true });
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
	/** Agent directory backing native user-scope context and system prompt files. */
	agentDir?: string;
	/** Resolver-owned classification for `agentDir`; preserve it across HOME/config refreshes. */
	profileAuthority?: "default" | "custom";
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

export interface ProjectContextFilesResult {
	contextFiles: Array<{ path: string; content: string; depth?: number }>;
	warnings: string[];
}

/**
 * Load all context files using the capability API.
 * Returns {path, content, depth} entries for all discovered context files.
 * Native user-global files (`~/.gjc/agent/AGENTS.md`) come first, then project
 * files sorted by depth (descending) so files closer to cwd appear last/more
 * prominent. User-home files from foreign providers (`~/.claude/CLAUDE.md`,
 * `~/.codex/AGENTS.md`, …) stay excluded — only gjc's own user config applies.
 */
export async function loadProjectContextFilesResult(
	options: LoadContextFilesOptions = {},
): Promise<ProjectContextFilesResult> {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const result = await loadCapability(contextFileCapability.id, {
		cwd: resolvedCwd,
		agentDir: options.agentDir,
		profileAuthority: options.profileAuthority,
	});
	const items = result.items as ContextFile[];

	// Native user-global context applies everywhere and is least specific, so it
	// renders first — project files rendered later take precedence over it.
	const userFiles = items
		.filter(item => item.level === "user" && item._source.provider === "native")
		.map(item => ({ path: item.path, content: item.content }));

	// Convert project-level ContextFile items and preserve depth info
	const projectFiles = items
		.filter(item => item.level === "project")
		.map(item => ({
			path: item.path,
			content: item.content,
			depth: item.depth,
		}));

	// Sort by depth (descending): higher depth (farther from cwd) comes first,
	// so files closer to cwd appear later and are more prominent
	projectFiles.sort((a, b) => {
		const depthA = a.depth ?? -1;
		const depthB = b.depth ?? -1;
		return depthB - depthA;
	});

	return {
		contextFiles: dedupeExactContextFiles([...userFiles, ...projectFiles]),
		warnings: result.warnings,
	};
}

/** Load project context files without exposing discovery diagnostics. */
export async function loadProjectContextFiles(
	options: LoadContextFilesOptions = {},
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return (await loadProjectContextFilesResult(options)).contextFiles;
}

/**
 * Load the effective system prompt customization from SYSTEM.md.
 * Project-level SYSTEM.md overrides user-level SYSTEM.md.
 */
export async function loadSystemPromptFiles(options: LoadContextFilesOptions = {}): Promise<string | null> {
	const resolvedCwd = options.cwd ?? getProjectDir();

	const result = await loadCapability<SystemPromptFile>(systemPromptCapability.id, {
		cwd: resolvedCwd,
		agentDir: options.agentDir,
		profileAuthority: options.profileAuthority,
	});

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
	/** Language guidance for internal technical reasoning. Default: off. */
	reasoningLanguage?: "off" | "english";
	/** Skills settings for discovery. */
	skillsSettings?: SkillsSettings;
	/** Working directory. Default: getProjectDir() */
	cwd?: string;
	/** Agent directory backing native user-scope prompt discovery. */
	agentDir?: string;
	/** Resolver-owned classification for `agentDir`; preserve it across HOME/config refreshes. */
	profileAuthority?: "default" | "custom";
	/** Pre-loaded context files (skips discovery if provided). */
	contextFiles?: Array<{ path: string; content: string; depth?: number }>;
	/** Skills provided directly to system prompt construction. */
	skills?: Skill[];
	/** Pre-loaded rulebook rules (descriptions, excluding TTSR and always-apply). */
	rules?: Array<{ name: string; description?: string; path: string; globs?: string[] }>;
	/** Intent field name injected into every tool schema. If set, explains the field in the prompt. */
	intentField?: string;
	/** Whether built-in tool discovery is active; enables the tool-discovery prompt block. */
	toolDiscoveryActive?: boolean;
	/** Encourage the agent to delegate via tasks unless changes are trivial. */
	eagerTasks?: boolean;
	/** Rules with alwaysApply=true — their full content is injected into the prompt. */
	alwaysApplyRules?: AlwaysApplyRule[];
	/** Whether secret obfuscation is active. When true, explains the redaction format in the prompt. */
	secretsEnabled?: boolean;
	/** Pre-loaded workspace tree (skips discovery if provided). May be a Promise to allow early kick-off. */
	workspaceTree?: WorkspaceTree | Promise<WorkspaceTree>;
	/**
	 * Render a trimmed role-agent base prompt for subagent sessions: omits the
	 * workflow-surface/routing/self-awareness (`<gjc-runtime>`) and `<soul>` blocks
	 * that only apply to the top-level interactive/print agent. Tool safety, repo
	 * safety, and the completion contract are retained. Default: false.
	 */
	subagent?: boolean;
}

export interface BuildSystemPromptResult {
	/** Ordered system prompt blocks. Providers should preserve entries as distinct messages/blocks. */
	systemPrompt: string[];
	/** Context-file discovery warnings visible to SDK and session callers. */
	warnings: string[];
}
/** Host wall-clock facts injected with every turn. */
export interface LocalTimeContext {
	/** Local calendar date with weekday, e.g. `2026-08-19 (Wed)`. */
	date: string;
	/** Local clock time with UTC offset and IANA zone, e.g. `21:04 UTC+09:00 (Asia/Seoul)`. */
	time: string;
}

/**
 * Render the host's local date and clock time for the volatile turn context.
 *
 * Every field is derived from a single `Intl.DateTimeFormat` pass over one
 * resolved zone, so the date, clock, offset, and zone name can never disagree
 * with each other the way `Date`'s local getters can. Falls back to UTC only
 * when the runtime has no usable ICU zone.
 *
 * @param timeZone IANA zone override. Default: the host zone.
 */
export function getLocalTimeContext(now: Date = new Date(), timeZone?: string): LocalTimeContext {
	try {
		const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZoneName: "longOffset",
		}).formatToParts(now);
		const part = (type: Intl.DateTimeFormatPartTypes): string =>
			parts.find(candidate => candidate.type === type)?.value ?? "";
		const year = part("year");
		const month = part("month");
		const day = part("day");
		const hour = part("hour");
		const minute = part("minute");
		if (!year || !month || !day || !hour || !minute) throw new Error("incomplete date parts");
		// `longOffset` renders "GMT+09:00", or a bare "GMT" at zero offset.
		const offset = part("timeZoneName").replace(/^GMT$/, "UTC+00:00").replace(/^GMT/, "UTC");
		const weekday = part("weekday");
		return {
			date: weekday ? `${year}-${month}-${day} (${weekday})` : `${year}-${month}-${day}`,
			time: `${hour}:${minute} ${offset}${zone ? ` (${zone})` : ""}`.trim(),
		};
	} catch (error) {
		logger.warn("Could not resolve host timezone for volatile project context; falling back to UTC", {
			error: String(error),
		});
		const fallbackNow = Number.isFinite(now.getTime()) ? now : new Date(0);
		const iso = fallbackNow.toISOString();
		return { date: iso.slice(0, 10), time: `${iso.slice(11, 16)} UTC+00:00 (UTC)` };
	}
}

export interface BuildVolatileProjectContextOptions {
	cwd?: string;
	/** Clock source for the rendered local date/time. Default: `new Date()`. */
	now?: Date;
	/** Trusted/test-only override in the derived `YYYY-MM-DD (Www)` or `YYYY-MM-DD` format. */
	date?: string;
	/** Trusted/test-only override in the derived `HH:MM UTC±HH:MM (IANA/Zone)` format. */
	localTime?: string;
	workspaceTree?: WorkspaceTree;
}

const LOCAL_DATE_OVERRIDE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?: \(([A-Z][a-z]{2})\))?$/u;
const LOCAL_TIME_OVERRIDE_PATTERN =
	/^(\d{2}):(\d{2}) UTC([+-])(\d{2}):(\d{2}) \(([A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*)\)$/u;

function isValidLocalDateOverride(value: string): boolean {
	const match = LOCAL_DATE_OVERRIDE_PATTERN.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const instant = new Date(Date.UTC(2000, month - 1, day));
	instant.setUTCFullYear(year);
	if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day)
		return false;
	const weekday = match[4];
	if (!weekday) return true;
	return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][instant.getUTCDay()] === weekday;
}

function isValidLocalTimeOverride(value: string): boolean {
	const match = LOCAL_TIME_OVERRIDE_PATTERN.exec(value);
	if (!match) return false;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	const offsetHour = Number(match[4]);
	const offsetMinute = Number(match[5]);
	return hour < 24 && minute < 60 && offsetHour < 24 && offsetMinute < 60;
}

export function buildVolatileProjectContext(options: BuildVolatileProjectContextOptions = {}): string {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const local = getLocalTimeContext(options.now ?? new Date());
	const date = escapePromptMetadata(
		options.date && isValidLocalDateOverride(options.date) ? options.date : local.date,
	);
	const localTime = escapePromptMetadata(
		options.localTime && isValidLocalTimeOverride(options.localTime) ? options.localTime : local.time,
	);
	return prompt
		.render(volatileProjectContextTemplate, {
			date,
			localTime,
			cwd: escapePromptMetadata(shortenPath(resolvedCwd.replace(/\\/g, "/"))),
			workspaceTree: {
				...(options.workspaceTree ?? {
					rootPath: resolvedCwd,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				}),
				rendered: escapePromptMetadata(options.workspaceTree?.rendered ?? "", { preserveNewlines: true }),
			},
		})
		.trim();
}

/** Build the system prompt with tools, guidelines, and context */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	if ($env.NULL_PROMPT === "true") {
		return { systemPrompt: [], warnings: [] };
	}

	const {
		customPrompt,
		tools,
		appendSystemPrompt,
		pluginAppendices,
		repeatToolDescriptions = false,
		reasoningLanguage = "off",
		toolNames: providedToolNames,
		cwd,
		contextFiles: providedContextFiles,
		rules,
		alwaysApplyRules,
		intentField,
		toolDiscoveryActive = false,
		eagerTasks = false,
		secretsEnabled = false,
		workspaceTree: providedWorkspaceTree,
		subagent = false,
	} = options;
	const resolvedCwd = cwd ?? getProjectDir();

	const prepDefaults = {
		resolvedCustomPrompt: undefined as string | undefined,
		resolvedAppendPrompt: undefined as string | undefined,
		systemPromptCustomization: null as string | null,
		contextFiles: { contextFiles: [] as Array<{ path: string; content: string; depth?: number }>, warnings: [] },
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
		agentDir: options.agentDir,
		profileAuthority: options.profileAuthority,
	});
	const contextFilesPromise = providedContextFiles
		? Promise.resolve({ contextFiles: providedContextFiles, warnings: [] })
		: logger.time("loadProjectContextFiles", loadProjectContextFilesResult, {
				cwd: resolvedCwd,
				agentDir: options.agentDir,
				profileAuthority: options.profileAuthority,
			});
	const workspaceTreePromise =
		providedWorkspaceTree !== undefined
			? Promise.resolve(providedWorkspaceTree)
			: logger.time("buildWorkspaceTree", () =>
					buildWorkspaceTree(resolvedCwd, { timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS }),
				);

	const [resolvedCustomPrompt, resolvedAppendPrompt, systemPromptCustomization, contextFileResult, workspaceTree] =
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
			withDeadline("loadProjectContextFiles", contextFilesPromise, prepDefaults.contextFiles),
			withDeadline("buildWorkspaceTree", workspaceTreePromise, prepDefaults.workspaceTree),
		]);
	const contextFiles = dedupeExactContextFiles(contextFileResult.contextFiles);
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

	// Date/time deliberately absent: volatile clock facts live in the per-turn
	// volatile project context (see buildVolatileProjectContext), never in this
	// cached stable prefix.
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
			// Use the same essential-tool baseline as a default session.
			toolNames = [...DEFAULT_ESSENTIAL_TOOL_NAMES];
		}
	}

	// Build tool descriptions for system prompt rendering.
	const toolPromptNames = new Map<string, string>(toolNames.map(name => [name, tools?.get(name)?.wireName ?? name]));
	const toolRefs = Object.fromEntries(toolPromptNames.entries());
	const hasHiddenToolDiscoveryTool = Object.hasOwn(toolRefs, "search_tool_bm25");
	const toolInfo = toolNames.map(name => ({
		name: toolPromptNames.get(name) ?? name,
		internalName: name,
		label: tools?.get(name)?.label ?? "",
		description: tools?.get(name)?.description ?? "",
	}));

	const effectiveSystemPromptCustomization = dedupePromptSource(systemPromptCustomization, [
		resolvedCustomPrompt,
		resolvedAppendPrompt,
	]);
	const promptSources = [effectiveSystemPromptCustomization, resolvedCustomPrompt, resolvedAppendPrompt];
	const injectedAlwaysApplyRules = dedupeAlwaysApplyRules(alwaysApplyRules, promptSources);

	const environment = await logger.time("getEnvironmentInfo", getEnvironmentInfo);
	const sanitizedContextFiles = contextFiles.map(file => ({
		...file,
		path: escapePromptMetadata(file.path),
		content: sanitizeEmbeddedPromptContent(file.content),
	}));
	const sanitizedAlwaysApplyRules = injectedAlwaysApplyRules.map(rule => ({
		...rule,
		name: escapePromptMetadata(rule.name),
		path: escapePromptMetadata(rule.path),
		content: sanitizeEmbeddedPromptContent(rule.content),
	}));
	const data = {
		systemPromptCustomization: effectiveSystemPromptCustomization,
		customPrompt: resolvedCustomPrompt,
		appendPrompt: resolvedAppendPrompt ?? "",
		tools: toolNames,
		toolInfo,
		repeatToolDescriptions,
		reasoningLanguageEnglish: reasoningLanguage === "english",
		toolRefs,
		environment,
		contextFiles: sanitizedContextFiles,
		agentsMdSearch: { files: agentsMdFiles.map(file => escapePromptMetadata(file)) },
		workspaceTree,
		rules: rules ?? [],
		alwaysApplyRules: sanitizedAlwaysApplyRules,
		cwd: promptCwd,
		intentTracing: !!intentField,
		intentField: intentField ?? "",
		toolDiscoveryActive: toolDiscoveryActive && hasHiddenToolDiscoveryTool,
		eagerTasks,
		secretsEnabled,
		subagent,
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

	return { systemPrompt, warnings: contextFileResult.warnings };
}
