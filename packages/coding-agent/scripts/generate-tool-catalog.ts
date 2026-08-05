import * as path from "node:path";
import { TOOL_CATALOG } from "../src/tools/tool-catalog.generated";
import { toolWireSchema } from "@gajae-code/ai/utils/schema";

export interface GeneratedToolCatalogEntry {
	name: string;
	label?: string;
	description?: string;
	parameters?: Record<string, unknown>;
	strict?: boolean;
	hidden?: boolean;
	deferrable?: boolean;
	loadMode?: "essential" | "discoverable";
	summary?: string;
	nonAbortable?: boolean;
	concurrency?: "shared" | "exclusive";
	lenientArgValidation?: boolean;
	customWireName?: string;
	customFormat?: { syntax: "lark" | "regex"; definition: string };
	mergeCallAndResult?: boolean;
	inline?: boolean;
	intent?: "omit" | "optional" | "require";
	platformExclusions?: readonly { platform: string; arch?: string }[];
};

export interface ToolCatalogGenerationOptions {
	platform?: NodeJS.Platform;
	arch?: NodeJS.Architecture;
}

type AuditedFallback = {
	name: string;
	parameters: unknown;
	label: string;
	description: string;
	strict: boolean;
	hidden?: boolean;
	deferrable?: boolean;
	loadMode: "essential" | "discoverable";
	summary: string;
	nonAbortable?: boolean;
	concurrency?: "shared" | "exclusive";
	lenientArgValidation?: boolean;
	mergeCallAndResult?: boolean;
	inline?: boolean;
	customWireName?: string;
	customFormat?: { syntax: "lark" | "regex"; definition: string };
	intent?: "omit" | "optional" | "require";
};

function makeSettings() {
	const values: Record<string, unknown> = {
		"tools.discoveryMode": "all",
		"mcp.discoveryMode": true,
		"eval.py": false,
		"eval.js": true,
		"goal.enabled": true,
		"lsp.enabled": true,
		"debug.enabled": true,
		"todo.enabled": true,
		"find.enabled": true,
		"search.enabled": true,
		"github.enabled": true,
		"astGrep.enabled": true,
		"astEdit.enabled": true,
		"renderMermaid.enabled": true,
		"web_search.enabled": true,
		"calc.enabled": true,
		"skill.enabled": true,
		"browser.enabled": true,
		"computer.enabled": true,
		"checkpoint.enabled": true,
		"irc.enabled": true,
		"recipe.enabled": true,
		"task.maxRecursionDepth": 2,
		"task.disabledAgents": [],
		"task.maxConcurrency": 4,
		"task.isolation.mode": "none",
		"task.simpleMode": "off",
		"task.simple": "default",
		"task.parentSpawns": "*",
		"disabledExtensions": [],
		"memory.backend": "off",
		"edit.fuzzyMatch": true,
		"edit.fuzzyThreshold": 0.8,
		"lsp.diagnosticsOnEdit": false,
		"lsp.formatOnWrite": false,
	};
	return {
		get: (key: string) => values[key],
		has: (key: string) => Object.hasOwn(values, key),
		getGroup: (group: string) => {
			if (group === "skills") return { enabled: true, enablePiUser: true, enablePiProject: true, customDirectories: [] };
			if (group === "task") return { disabledAgents: [] };
			return {};
		},
		getNotificationSettingsSnapshot: () => ({ enabled: false, telegram: {}, discord: {}, slack: {} }),
	};
}

function makeSession(): any {
	const settings = makeSettings();
	return {
		cwd: path.resolve(import.meta.dir, "../.."),
		hasUI: false,
		workflowGateEligible: true,
		settings,
		requireYieldTool: false,
		enableLsp: true,
		hasEditTool: true,
		taskDepth: 0,
		currentAgentType: "executor",
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "catalog",
		getAgentId: () => "catalog",
		getToolByName: () => undefined,
		getToolForExecution: () => undefined,
		getWorkflowGateEmitter: () => undefined,
		getAskAnswerSource: () => undefined,
		getPlanModeState: () => undefined,
		getGoalModeState: () => undefined,
		getActiveSkillState: () => undefined,
		getActiveSkillPhase: () => undefined,
		getDeepInterviewAskStage: () => undefined,
		getTodoPhases: () => [],
		setTodoPhases: () => undefined,
		getCheckpointState: () => undefined,
		setCheckpointState: () => undefined,
		sendCustomMessage: async () => undefined,
		skills: [{ name: "catalog", path: "embedded:catalog", filePath: "embedded:catalog", baseDir: "embedded:", description: "catalog", source: "bundled:default", content: "" }],
		agentRegistry: {},
		getArtifactsDir: () => null,
		getAuthorizedArtifactsDirs: () => [],
		getArtifactManager: () => null,
		registerSessionCleanup: () => () => undefined,
		isToolDiscoveryEnabled: () => true,
		getDiscoverableTools: () => [],
		getDiscoverableToolSearchIndex: () => ({ entries: [], search: () => [] }),
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async () => [],
	};
}

export class ToolCatalogGenerationError extends Error {
	readonly code = "TOOL_CATALOG_GENERATION_FAILED";
	constructor(
		message: string,
		readonly toolName: string,
		readonly key: string | undefined,
		readonly cause: unknown,
	) {
		super(message, { cause });
		this.name = "ToolCatalogGenerationError";
	}
}

function formatCause(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readToolProperty(toolName: string, tool: unknown, key: string): unknown {
	try {
		return (tool as Record<string, unknown> | undefined)?.[key];
	} catch (cause) {
		throw new ToolCatalogGenerationError(
			`Failed to read tool "${toolName}" property "${key}": ${formatCause(cause)}`,
			toolName,
			key,
			cause,
		);
	}
}

function assertCatalogJsonValue(value: unknown, seen = new Set<object>()): void {
	if (value === undefined) throw new Error("value contains undefined");
	if (typeof value === "function" || typeof value === "symbol") throw new Error(`value has unsupported ${typeof value}`);
	if (value === null || typeof value !== "object") return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const entry of value) assertCatalogJsonValue(entry, seen);
		return;
	}
	for (const entry of Object.values(value)) {
		assertCatalogJsonValue(entry, seen);
	}
}

function serializeCatalogValue(toolName: string, key: string, value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		assertCatalogJsonValue(value);
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new Error("JSON.stringify returned undefined");
		return JSON.parse(encoded);
	} catch (cause) {
		throw new ToolCatalogGenerationError(
			`Failed to serialize tool "${toolName}" property "${key}": ${formatCause(cause)}`,
			toolName,
			key,
			cause,
		);
	}
}

function excludedOnPlatform(
	exclusions: readonly { platform: string; arch?: string }[] | undefined,
	platform: NodeJS.Platform,
	arch: NodeJS.Architecture,
): boolean {
	return exclusions?.some(exclusion => exclusion.platform === platform && (!exclusion.arch || exclusion.arch === arch)) ?? false;
}

function fallbackMetadata(tool: Record<string, unknown>, parameters: unknown): AuditedFallback {
	const read = <T>(key: string, fallback?: T): T | undefined => {
		const value = tool[key] as T | undefined;
		return value === undefined ? fallback : value;
	};
	const metadata = {
		name: read<string>("name"),
		parameters,
		label: read<string>("label"),
		description: read<string>("description"),
		strict: read<boolean>("strict"),
		hidden: read<boolean>("hidden"),
		deferrable: read<boolean>("deferrable"),
		loadMode: read<"essential" | "discoverable">("loadMode"),
		summary: read<string>("summary"),
		nonAbortable: read<boolean>("nonAbortable"),
		concurrency: read<"shared" | "exclusive">("concurrency"),
		lenientArgValidation: read<boolean>("lenientArgValidation"),
		mergeCallAndResult: read<boolean>("mergeCallAndResult"),
		inline: read<boolean>("inline"),
		customWireName: read<string | undefined>("customWireName"),
		customFormat: read<AuditedFallback["customFormat"]>("customFormat"),
		intent: read<AuditedFallback["intent"]>("intent"),
	};
	for (const key of ["name", "label", "description", "strict", "loadMode", "summary"] as const) {
		if (metadata[key] === undefined) throw new Error(`Fallback metadata is missing required field "${key}"`);
	}
	return metadata as AuditedFallback;
}

async function fallbackForPlatformExcludedTool(name: string): Promise<AuditedFallback> {
	if (name === "computer") {
		const { computerSchema, ComputerTool } = await import("../src/tools/computer");
		const fallback = fallbackMetadata(new ComputerTool({} as any) as unknown as Record<string, unknown>, computerSchema);
		fallback.deferrable = true;
		return fallback;
	}
	throw new Error(`No independently derived catalog fallback is defined for platform-excluded tool "${name}"`);
}

async function fallbackForUnavailableTool(name: string): Promise<AuditedFallback> {
	if (name === "ssh") {
		const { sshSchema, SshTool, SSH_DESCRIPTION } = await import("../src/tools/ssh");
		const fallback = fallbackMetadata(new SshTool({} as any, [], new Map(), SSH_DESCRIPTION) as unknown as Record<string, unknown>, sshSchema);
		fallback.deferrable = true;
		return fallback;
	}
	if (name === "telegram_send") {
		const { telegramSendSchema, TelegramSendTool } = await import("../src/tools/telegram-send");
		const fallback = fallbackMetadata(new TelegramSendTool({} as any) as unknown as Record<string, unknown>, telegramSendSchema);
		fallback.deferrable = true;
		return fallback;
	}
	if (name === "recipe") {
		const { recipeSchema, RECIPE_DESCRIPTION } = await import("../src/tools/recipe");
		return fallbackMetadata(
			{
				name: "recipe",
				label: "Run",
				deferrable: true,
				description: RECIPE_DESCRIPTION,
				strict: true,
				concurrency: "exclusive",
				loadMode: "discoverable",
				summary: "Execute a saved bash recipe (multi-step shell command preset)",
				mergeCallAndResult: true,
				inline: true,
			},
			recipeSchema,
		);
	}
	throw new Error(`No independently derived catalog fallback is defined for unavailable tool "${name}"`);
}

export async function generateToolCatalogData(options: ToolCatalogGenerationOptions = {}): Promise<Record<string, GeneratedToolCatalogEntry>> {
	const previousEditVariant = process.env.GJC_EDIT_VARIANT;
	process.env.GJC_EDIT_VARIANT = "replace";
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	try {
		const { BUILTIN_TOOL_DESCRIPTORS, HIDDEN_TOOL_DESCRIPTORS, PLATFORM_EXCLUDED_TOOL_DESCRIPTORS } = await import("../src/tools/descriptors");
		const all = { ...BUILTIN_TOOL_DESCRIPTORS, ...HIDDEN_TOOL_DESCRIPTORS, ...PLATFORM_EXCLUDED_TOOL_DESCRIPTORS } as Record<string, any>;
		const session = makeSession();
		const output: Record<string, GeneratedToolCatalogEntry> = {};
		for (const [name, descriptor] of Object.entries(all)) {
			let fallback: AuditedFallback | undefined;
			let tool: any;
			const platformExcluded = excludedOnPlatform(descriptor.metadata.platformExclusions, platform, arch);
			if (!platformExcluded) {
				try {
					tool = await descriptor.load(session);
				} catch (cause) {
					throw new ToolCatalogGenerationError(
						`Failed to load descriptor "${name}": ${formatCause(cause)}`,
						name,
						"load",
						cause,
					);
				}
			}
			if (!tool && platformExcluded) {
				try {
					fallback = await fallbackForPlatformExcludedTool(name);
					tool = fallback;
				} catch (cause) {
					throw new ToolCatalogGenerationError(
						`Failed to materialize platform-excluded descriptor "${name}": ${formatCause(cause)}`,
						name,
						"parameters",
						cause,
					);
				}
			}
			if (!tool) {
				try {
					fallback = await fallbackForUnavailableTool(name);
					tool = fallback;
				} catch (cause) {
					throw new ToolCatalogGenerationError(
						`Failed to materialize unavailable descriptor "${name}": ${formatCause(cause)}`,
						name,
						"parameters",
						cause,
					);
				}
			}
			if (!tool) {
				throw new ToolCatalogGenerationError(
					`Descriptor "${name}" returned no tool and has no explicit exclusion or fallback`,
					name,
					"load",
					undefined,
				);
			}

			let parameters: unknown;
			try {
				parameters = toolWireSchema(tool);
			} catch (cause) {
				throw new ToolCatalogGenerationError(
					`Failed to derive wire schema for tool "${name}": ${formatCause(cause)}`,
					name,
					"parameters",
					cause,
				);
			}
			if (fallback) {
				const fallbackFields: Array<keyof AuditedFallback> = [
					"parameters",
					"label",
					"description",
					"strict",
					"hidden",
					"deferrable",
					"loadMode",
					"summary",
					"nonAbortable",
					"concurrency",
					"lenientArgValidation",
					"mergeCallAndResult",
					"inline",
					"customWireName",
					"customFormat",
					"intent",
				];
				for (const key of fallbackFields) {
					const committed = TOOL_CATALOG[name]?.[key];
					if (committed === undefined) continue;
					const derived = key === "parameters" ? parameters : fallback[key];
					const committedValue = serializeCatalogValue(name, `catalog.${String(key)}`, committed);
					const derivedValue = serializeCatalogValue(name, String(key), derived);
					if (JSON.stringify(committedValue) !== JSON.stringify(derivedValue)) {
						throw new ToolCatalogGenerationError(
							`Committed catalog ${String(key)} for unavailable tool "${name}" differs from its independently derived value`,
							name,
							String(key),
							{ committedValue, derivedValue },
						);
					}
				}
			}
			const read = (key: string): unknown => (fallback ? fallback[key as keyof AuditedFallback] : readToolProperty(name, tool, key));
			const choose = <T>(key: string, descriptorValue: T | undefined): T | undefined =>
				fallback ? (read(key) as T | undefined) : ((read(key) as T | undefined) ?? descriptorValue);
			const intent = choose("intent", descriptor.metadata.intent);
			const entry: GeneratedToolCatalogEntry = {
				name,
				label: choose("label", descriptor.presentation.label),
				description: choose("description", descriptor.metadata.description),
				parameters: serializeCatalogValue(name, "parameters", parameters) as Record<string, unknown>,
				strict: choose("strict", descriptor.metadata.strict),
				hidden: choose("hidden", descriptor.metadata.hidden),
				deferrable: choose("deferrable", descriptor.metadata.deferrable),
				loadMode: choose("loadMode", descriptor.metadata.loadMode),
				summary: choose("summary", descriptor.metadata.summary),
				nonAbortable: choose("nonAbortable", descriptor.metadata.nonAbortable),
				concurrency: choose("concurrency", descriptor.metadata.concurrency),
				lenientArgValidation: choose("lenientArgValidation", descriptor.metadata.lenientArgValidation),
				customWireName: choose("customWireName", descriptor.metadata.customWireName),
				customFormat: serializeCatalogValue(name, "customFormat", choose("customFormat", descriptor.metadata.customFormat)) as GeneratedToolCatalogEntry["customFormat"],
				mergeCallAndResult: choose("mergeCallAndResult", descriptor.metadata.mergeCallAndResult),
				inline: choose("inline", descriptor.metadata.inline),
				intent: typeof intent === "string" ? (intent as GeneratedToolCatalogEntry["intent"]) : undefined,
				platformExclusions: descriptor.metadata.platformExclusions,
			};
			for (const key of Object.keys(entry) as Array<keyof GeneratedToolCatalogEntry>) {
				if (entry[key] === undefined) delete entry[key];
			}
			output[name] = entry;
		}
		return output;
	} finally {
		if (previousEditVariant === undefined) delete process.env.GJC_EDIT_VARIANT;
		else process.env.GJC_EDIT_VARIANT = previousEditVariant;
	}
}

export function renderToolCatalogModule(catalog: Record<string, GeneratedToolCatalogEntry>): string {
	return `/**
 * Generated by scripts/generate-tool-catalog.ts. Do not edit by hand.
 */
export interface ToolCatalogEntry {
	readonly name: string;
	readonly label?: string;
	readonly description?: string;
	readonly parameters?: Record<string, unknown>;
	readonly strict?: boolean;
	readonly hidden?: boolean;
	readonly deferrable?: boolean;
	readonly loadMode?: "essential" | "discoverable";
	readonly summary?: string;
	readonly nonAbortable?: boolean;
	readonly concurrency?: "shared" | "exclusive";
	readonly lenientArgValidation?: boolean;
	readonly customWireName?: string;
	readonly customFormat?: { syntax: "lark" | "regex"; definition: string };
	readonly mergeCallAndResult?: boolean;
	readonly inline?: boolean;
	readonly intent?: "omit" | "optional" | "require";
	readonly platformExclusions?: readonly { platform: string; arch?: string }[];
}

export const TOOL_CATALOG: Readonly<Record<string, ToolCatalogEntry>> = ${JSON.stringify(catalog, null, "\t")};
`;
}

if (import.meta.main) {
	const catalog = await generateToolCatalogData();
	const outputPath = path.resolve(import.meta.dir, "../src/tools/tool-catalog.generated.ts");
	await Bun.write(outputPath, renderToolCatalogModule(catalog));
	console.error(`generated ${Object.keys(catalog).length} tool catalog entries at ${outputPath}`);
}
