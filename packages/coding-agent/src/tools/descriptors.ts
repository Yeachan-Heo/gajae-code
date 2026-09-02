import type { AgentTool } from "@gajae-code/agent-core";
import type { RawArgumentValidationResult, TSchema } from "@gajae-code/ai/types";
import { $which } from "@gajae-code/utils";
import { resolveBrowserBackend } from "../browser-backend";
import type { ToolFactory, ToolSession } from ".";
import { selectAskParameters } from "./ask-contract";
import { isComputerCallable, isComputerLoadablePlatform } from "./computer-policy";
import {
	deferredAskParameters,
	deferredIntentPolicies,
	validateDeferredAskArguments,
	validateDeferredTodoArguments,
} from "./descriptor-validation";
import { TOOL_CATALOG, type ToolCatalogEntry } from "./tool-catalog.generated";
import { ToolError } from "./tool-errors";

export interface ToolDescriptorMetadata {
	readonly name: string;
	readonly summary?: string;
	readonly loadMode?: "essential" | "discoverable";
	readonly hidden?: boolean;
	readonly deferrable?: boolean;
	readonly nonAbortable?: boolean;
	readonly concurrency?: "shared" | "exclusive";
	readonly strict?: boolean;
	readonly lenientArgValidation?: boolean;
	readonly mergeCallAndResult?: boolean;
	readonly inline?: boolean;
	readonly rawArgumentValidation?: (
		arguments_: Record<string, unknown>,
		session?: ToolSession,
	) => RawArgumentValidationResult;
	readonly intent?: AgentTool<any, any, any>["intent"];
	readonly parametersForSession?: (session?: ToolSession) => TSchema;
	readonly parameters?: TSchema;
	readonly description?: string;
	readonly label?: string;
	readonly customWireName?: string;
	readonly customFormat?: AgentTool<any, any, any>["customFormat"];
	readonly platformExclusions?: readonly {
		readonly platform: NodeJS.Platform;
		readonly arch?: NodeJS.Architecture;
	}[];
}

export interface ToolAvailabilityContext {
	readonly includeYield?: boolean;
	readonly enableLsp?: boolean;
	readonly goalEnabled?: boolean;
	readonly goalStateToolNames?: readonly string[];
	readonly allowEval?: boolean;
	readonly discoveryActive?: boolean;
}

export type ToolDescriptorLoadResult = AgentTool<any, any, any> | null | Promise<AgentTool<any, any, any> | null>;
type Loader = (session: ToolSession) => ToolDescriptorLoadResult;

export interface ToolDescriptor {
	readonly metadata: ToolDescriptorMetadata;
	readonly presentation: ToolDescriptorPresentation;
	readonly isAvailable: (session: ToolSession, context?: ToolAvailabilityContext) => boolean;
	readonly load: Loader;
}

export interface ToolDescriptorPresentation {
	readonly label: string;
	readonly summary?: string;
}

export class LazyAgentTool implements AgentTool<any, any, any> {
	readonly descriptor: ToolDescriptor;
	#tool?: AgentTool<any, any, any>;
	#loader?: () => ToolDescriptorLoadResult;
	#session?: ToolSession;
	#loadPromise?: Promise<AgentTool<any, any, any>>;

	constructor(
		descriptor: ToolDescriptor,
		materialized?: AgentTool<any, any, any>,
		loader?: () => ToolDescriptorLoadResult,
		session?: ToolSession,
	) {
		this.descriptor = descriptor;
		this.#tool = materialized;
		this.#loader = loader;
		this.#session = session;
	}

	async #get(): Promise<AgentTool<any, any, any>> {
		if (this.#tool) return this.#tool;
		if (!this.#loadPromise) {
			const load = this.#loader;
			this.#loadPromise = Promise.resolve()
				.then(() => {
					if (!load) throw new ToolError(`Tool "${this.descriptor.metadata.name}" has no deferred loader`);
					return load();
				})
				.then(tool => {
					if (!tool) throw new ToolError(`Tool "${this.descriptor.metadata.name}" failed to load`);
					this.#tool = tool;
					return tool;
				})
				.catch(error => {
					this.#loadPromise = undefined;
					if (error instanceof ToolError) throw error;
					throw new ToolError(
						`Tool "${this.descriptor.metadata.name}" failed to load implementation: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
				});
		}
		return this.#loadPromise;
	}

	/** Materialize this facade for contract tests without exposing it in production dispatch. */
	async materializeForTests(): Promise<AgentTool<any, any, any>> {
		return await this.#get();
	}

	get name(): string {
		return this.#tool?.name ?? this.descriptor.metadata.name;
	}
	get description(): string {
		return (
			this.#tool?.description ??
			this.descriptor.metadata.description ??
			this.descriptor.presentation.summary ??
			this.descriptor.metadata.summary ??
			this.descriptor.presentation.label
		);
	}
	get parameters(): TSchema {
		const parameters =
			this.#tool?.parameters ??
			this.descriptor.metadata.parametersForSession?.(this.#session) ??
			this.descriptor.metadata.parameters;
		if (!parameters) throw new ToolError(`Tool "${this.descriptor.metadata.name}" has no advertised parameters`);
		return parameters;
	}
	get rawArgumentValidation() {
		const validate = this.#tool?.rawArgumentValidation;
		if (validate) return validate.bind(this.#tool);
		const descriptorValidate = this.descriptor.metadata.rawArgumentValidation;
		return descriptorValidate
			? (arguments_: Record<string, unknown>) => descriptorValidate(arguments_, this.#session)
			: undefined;
	}
	get strict(): boolean | undefined {
		return this.#tool?.strict ?? this.descriptor.metadata.strict;
	}
	get customFormat() {
		return this.#tool?.customFormat ?? this.descriptor.metadata.customFormat;
	}
	get customWireName() {
		return this.#tool?.customWireName ?? this.descriptor.metadata.customWireName;
	}
	get safeSummary() {
		const summarize = this.#tool?.safeSummary;
		return summarize ? summarize.bind(this.#tool) : undefined;
	}
	get safeSummaryFields() {
		return this.#tool?.safeSummaryFields;
	}
	get label(): string {
		return this.#tool?.label ?? this.descriptor.metadata.label ?? this.descriptor.presentation.label;
	}
	get hidden(): boolean | undefined {
		return this.#tool?.hidden ?? this.descriptor.metadata.hidden;
	}
	get deferrable(): boolean | undefined {
		return this.#tool?.deferrable ?? this.descriptor.metadata.deferrable;
	}
	get loadMode(): "essential" | "discoverable" | undefined {
		return this.#tool?.loadMode ?? this.descriptor.metadata.loadMode;
	}
	get summary(): string | undefined {
		return this.#tool?.summary ?? this.descriptor.metadata.summary;
	}
	get nonAbortable(): boolean | undefined {
		return this.#tool?.nonAbortable ?? this.descriptor.metadata.nonAbortable;
	}
	get concurrency(): "shared" | "exclusive" | undefined {
		return this.#tool?.concurrency ?? this.descriptor.metadata.concurrency;
	}
	get lenientArgValidation(): boolean | undefined {
		return this.#tool?.lenientArgValidation ?? this.descriptor.metadata.lenientArgValidation;
	}
	get intent() {
		const intent = this.#tool?.intent ?? this.descriptor.metadata.intent;
		return typeof intent === "function" ? intent.bind(this.#tool) : intent;
	}
	get renderCall() {
		const render = this.#tool?.renderCall;
		return render ? render.bind(this.#tool) : undefined;
	}
	get renderResult() {
		const render = this.#tool?.renderResult;
		return render ? render.bind(this.#tool) : undefined;
	}
	get mergeCallAndResult(): boolean | undefined {
		return (this.#tool as any)?.mergeCallAndResult ?? this.descriptor.metadata.mergeCallAndResult;
	}
	get inline(): boolean | undefined {
		return (this.#tool as any)?.inline ?? this.descriptor.metadata.inline;
	}
	get mode() {
		return (this.#tool as any)?.mode;
	}

	readonly execute: AgentTool<any, any, any>["execute"] = async (...args) => {
		const tool = await this.#get();
		return tool.execute.call(tool, ...args);
	};
}

export type EffectiveToolDiscoveryMode = "off" | "mcp-only" | "all";

export interface ToolDiscoverySettingsSource {
	get(key: string): unknown;
}

export function resolveEffectiveDiscoveryMode(
	settings: ToolDiscoverySettingsSource,
	explicitMcpConfigPath?: string,
): EffectiveToolDiscoveryMode {
	const configured = settings.get("tools.discoveryMode");
	if (configured !== "off") return configured === "mcp-only" ? "mcp-only" : "all";
	return settings.get("mcp.discoveryMode") || explicitMcpConfigPath !== undefined ? "mcp-only" : "off";
}

function resolveDiscoveryActive(session: ToolSession): boolean {
	return resolveEffectiveDiscoveryMode(session.settings, session.mcpConfigPath) !== "off";
}

function defaultAvailabilityContext(session: ToolSession): ToolAvailabilityContext {
	return {
		includeYield: session.requireYieldTool === true,
		enableLsp: session.enableLsp ?? true,
		goalEnabled: session.settings.get("goal.enabled"),
		goalStateToolNames: [],
		allowEval: (session.settings.get("eval.py") ?? true) || (session.settings.get("eval.js") ?? true),
		discoveryActive: resolveDiscoveryActive(session),
	};
}

function availableFor(name: string, session: ToolSession, context = defaultAvailabilityContext(session)): boolean {
	if (name === "goal") return context.goalEnabled === true;
	if (name === "move_session") return typeof session.rescopeSessionCwd === "function";
	if (context.goalStateToolNames?.includes(name)) return context.goalEnabled === true;
	if (name === "lsp") return (context.enableLsp ?? true) && Boolean(session.settings.get("lsp.enabled"));
	if (name === "eval") return context.allowEval ?? true;
	if (name === "debug") return Boolean(session.settings.get("debug.enabled"));
	if (name === "todo_write") return !context.includeYield && Boolean(session.settings.get("todo.enabled"));
	if (name === "find") return Boolean(session.settings.get("find.enabled"));
	if (name === "search") return Boolean(session.settings.get("search.enabled"));
	if (name === "github") return Boolean(session.settings.get("github.enabled")) && Boolean($which("gh"));
	if (name === "ast_grep") return Boolean(session.settings.get("astGrep.enabled"));
	if (name === "ast_edit") return Boolean(session.settings.get("astEdit.enabled"));
	if (name === "render_mermaid") return Boolean(session.settings.get("renderMermaid.enabled"));
	if (name === "web_search") return Boolean(session.settings.get("web_search.enabled"));
	if (name === "search_tool_bm25") return context.discoveryActive ?? resolveDiscoveryActive(session);
	if (name === "calc") return Boolean(session.settings.get("calc.enabled"));
	if (name === "skill" || name === "skill_discovery") return Boolean(session.settings.get("skill.enabled"));
	if (name === "browser")
		return (
			Boolean(session.settings.get("browser.enabled")) && resolveBrowserBackend(session.settings).exposesBuiltinTool
		);
	if (name === "computer") return isComputerCallable(session);
	if (name === "checkpoint" || name === "rewind")
		return Boolean(session.settings.get("checkpoint.enabled")) && (session.taskDepth ?? 0) === 0;
	if (name === "irc")
		return (
			Boolean(session.settings.get("irc.enabled")) && Boolean(session.agentRegistry) && Boolean(session.getAgentId)
		);
	if (name === "ask")
		return Boolean(session.hasUI || session.workflowGateEligible || session.getWorkflowGateEmitter?.());
	if (name === "cron") return process.env.CLAUDE_CODE_DISABLE_CRON !== "1";
	if (name === "recipe") return Boolean(session.settings.get("recipe.enabled"));
	if (name === "task") {
		const maxDepth = session.settings.get("task.maxRecursionDepth") ?? 2;
		return maxDepth < 0 || (session.taskDepth ?? 0) < maxDepth;
	}
	return true;
}

function catalogEntry(name: string): ToolCatalogEntry | undefined {
	return TOOL_CATALOG[name];
}

type DescriptorSpec = Omit<ToolDescriptorMetadata, "name"> & {
	name: string;
	loader: Loader;
};

const moduleCache = new Map<string, Promise<any>>();
function cached(key: string, load: () => Promise<any>): Promise<any> {
	let promise = moduleCache.get(key);
	if (!promise) {
		promise = load();
		moduleCache.set(key, promise);
	}
	return promise;
}
export function evictCachedTool(key: string): void {
	moduleCache.delete(key);
}

const loaders: Record<string, Loader> = {
	read: session => cached("read", () => import("./read")).then(module => new module.ReadTool(session)),
	bash: session => cached("bash", () => import("./bash")).then(module => new module.BashTool(session)),
	edit: session => cached("edit", () => import("../edit")).then(module => new module.EditTool(session)),
	ast_grep: session => cached("ast_grep", () => import("./ast-grep")).then(module => new module.AstGrepTool(session)),
	ast_edit: session => cached("ast_edit", () => import("./ast-edit")).then(module => new module.AstEditTool(session)),
	render_mermaid: session =>
		cached("render_mermaid", () => import("./render-mermaid")).then(module => new module.RenderMermaidTool(session)),
	ask: session => cached("ask", () => import("./ask")).then(module => module.AskTool.createIf(session)),
	debug: session => cached("debug", () => import("./debug")).then(module => module.DebugTool.createIf(session)),
	bisect: session => cached("bisect", () => import("./bisect")).then(module => new module.BisectTool(session)),
	eval: session => cached("eval", () => import("./eval")).then(module => new module.EvalTool(session)),
	calc: session => cached("calc", () => import("./calculator")).then(module => new module.CalculatorTool(session)),
	ssh: session => cached("ssh", () => import("./ssh")).then(module => module.loadSshTool(session)),
	github: session => cached("github", () => import("./gh")).then(module => module.GithubTool.createIf(session)),
	find: session => cached("find", () => import("./find")).then(module => new module.FindTool(session)),
	search: session => cached("search", () => import("./search")).then(module => new module.SearchTool(session)),
	lsp: session => cached("lsp", () => import("../lsp")).then(module => module.LspTool.createIf(session)),
	browser: session => cached("browser", () => import("./browser")).then(module => new module.BrowserTool(session)),
	computer: session =>
		cached("computer", () => import("./computer")).then(module => module.ComputerTool.createIf(session)),
	checkpoint: session =>
		cached("checkpoint", () => import("./checkpoint")).then(module => module.CheckpointTool.createIf(session)),
	rewind: session =>
		cached("checkpoint", () => import("./checkpoint")).then(module => module.RewindTool.createIf(session)),
	task: session => cached("task", () => import("../task")).then(module => module.TaskTool.create(session)),
	subagent: session => cached("subagent", () => import("./subagent")).then(module => new module.SubagentTool(session)),
	python: session =>
		cached("python", () => import("./python")).then(module =>
			module.createSessionPythonTool({
				cwd: session.cwd,
				settings: session.settings,
				getCwd: () => session.cwd,
				getSessionId: () => session.getSessionId?.() ?? null,
				registerSessionCleanup: (cleanup: () => Promise<void> | void) => {
					session.registerSessionCleanup?.(cleanup);
				},
			}),
		),
	job: session => cached("job", () => import("./job")).then(module => module.JobTool.createIf(session)),
	monitor: session =>
		cached("monitor", () => import("./monitor")).then(module => module.MonitorTool.createIf(session)),
	cron: session => cached("cron", () => import("./cron")).then(module => module.CronTool.createIf(session)),
	recipe: session => cached("recipe", () => import("./recipe")).then(module => module.RecipeTool.createIf(session)),
	irc: session => cached("irc", () => import("./irc")).then(module => module.IrcTool.createIf(session)),
	todo_write: session =>
		cached("todo_write", () => import("./todo-write")).then(module => new module.TodoWriteTool(session)),
	web_search: session =>
		cached("web_search", () => import("../web/search")).then(module => new module.WebSearchTool(session)),
	search_tool_bm25: session =>
		cached("search_tool_bm25", () => import("./search-tool-bm25")).then(module =>
			module.SearchToolBm25Tool.createIf(session),
		),
	skill_discovery: session =>
		cached("skill_discovery", () => import("./skill-discovery")).then(module =>
			module.SkillDiscoveryTool.createIf(session),
		),
	telegram_send: session =>
		cached("telegram_send", () => import("./telegram-send")).then(module =>
			module.TelegramSendTool.createIf(session),
		),
	write: session => cached("write", () => import("./write")).then(module => new module.WriteTool(session)),
	skill: session => cached("skill", () => import("./skill")).then(module => module.SkillTool.createIf(session)),
	goal: session =>
		cached("goal", () => import("../goals/tools/goal-tool")).then(module => new module.GoalTool(session)),
	move_session: session =>
		cached("move_session", () => import("./move-session")).then(module => new module.MoveSessionTool(session)),
	yield: session => cached("yield", () => import("./yield")).then(module => new module.YieldTool(session)),
	report_finding: _session => cached("review", () => import("./review")).then(module => module.reportFindingTool),
	resolve: session => cached("resolve", () => import("./resolve")).then(module => new module.ResolveTool(session)),
};

function descriptor(spec: DescriptorSpec): ToolDescriptor {
	const catalog = catalogEntry(spec.name);
	const metadata = Object.freeze({
		name: spec.name,
		summary: catalog?.summary ?? spec.summary,
		loadMode: catalog?.loadMode ?? spec.loadMode,
		hidden: catalog?.hidden ?? spec.hidden,
		deferrable: catalog?.deferrable ?? spec.deferrable,
		nonAbortable: catalog?.nonAbortable ?? spec.nonAbortable,
		concurrency: catalog?.concurrency ?? spec.concurrency,
		strict: catalog?.strict ?? spec.strict,
		lenientArgValidation: catalog?.lenientArgValidation ?? spec.lenientArgValidation,
		mergeCallAndResult: catalog?.mergeCallAndResult ?? spec.mergeCallAndResult,
		inline: catalog?.inline ?? spec.inline,
		rawArgumentValidation: spec.rawArgumentValidation,
		parametersForSession: spec.parametersForSession,
		intent: catalog?.intent ?? spec.intent,
		description: catalog?.description ?? spec.description,
		parameters: spec.parameters ?? (catalog?.parameters as TSchema | undefined),
		label: catalog?.label ?? spec.label,
		customWireName: catalog?.customWireName ?? spec.customWireName,
		customFormat: catalog?.customFormat ?? spec.customFormat,
		platformExclusions: spec.platformExclusions,
	});
	const presentation = Object.freeze({
		label: catalog?.label ?? spec.label ?? spec.name,
		summary: catalog?.summary ?? spec.summary,
	});
	return Object.freeze({
		metadata,
		presentation,
		isAvailable: (session: ToolSession, context?: ToolAvailabilityContext) =>
			availableFor(spec.name, session, context),
		load: spec.loader,
	});
}

const names: Array<[name: string, label: string, summary: string | undefined, loadMode: "essential" | "discoverable"]> =
	[
		["read", "Read", undefined, "essential"],
		["bash", "Bash", undefined, "essential"],
		["edit", "Edit", undefined, "essential"],
		["ast_grep", "AST Grep", "Search code with AST patterns (structural grep)", "discoverable"],
		["ast_edit", "AST Edit", "Perform AST-aware code edits (structural refactoring)", "discoverable"],
		["render_mermaid", "RenderMermaid", "Render a Mermaid diagram to an image", "discoverable"],
		["ask", "Ask", "Ask the user a clarifying question", "discoverable"],
		["debug", "Debug", "Debug a running process with DAP (debugger adapter protocol)", "discoverable"],
		["bisect", "Bisect", "Find the commit that introduced a regression", "discoverable"],
		["eval", "Eval", "Execute Python or JavaScript code in an in-process eval backend", "discoverable"],
		[
			"python",
			"Python",
			"Execute Python in a persistent per-session REPL kernel (every call is appended to the session transcript)",
			"discoverable",
		],
		["calc", "Calc", "Evaluate a mathematical expression", "discoverable"],
		["ssh", "SSH", "Execute a command on a remote host over SSH", "discoverable"],
		["github", "GitHub", "Interact with GitHub issues, pull requests, and repositories", "discoverable"],
		["find", "Find", "Find files and directories matching a glob pattern", "discoverable"],
		["search", "Search", "Search file contents using ripgrep (fast text search)", "discoverable"],
		["lsp", "LSP", "Query LSP (language server) for diagnostics, hover info, and references", "discoverable"],
		["browser", "Browser", "Control a headless browser to navigate and interact with web pages", "discoverable"],
		["computer", "Computer", undefined, "discoverable"],
		["checkpoint", "Checkpoint", "Create a git-based checkpoint to save and restore session state", "discoverable"],
		["rewind", "Rewind", "Rewind to a previously created checkpoint", "discoverable"],
		["task", "Task", "Spawn a subagent to complete a parallel task", "discoverable"],
		["subagent", "Subagent", "Manage detached task subagents", "discoverable"],
		["job", "Job", "Manage long-running background jobs", "discoverable"],
		["monitor", "Monitor", "Start a background monitor", "discoverable"],
		["cron", "Cron", "Schedule, list, and cancel cron-style prompts", "discoverable"],
		["recipe", "Run", "Execute a saved bash recipe", "discoverable"],
		["irc", "IRC", "Send and receive messages between agents", "discoverable"],
		["todo_write", "Todo Write", "Write a structured todo list", "discoverable"],
		["web_search", "Web Search", "Search the web for up-to-date information", "discoverable"],
		["search_tool_bm25", "SearchTools", undefined, "essential"],
		["skill_discovery", "SkillDiscovery", "Discover project and user runtime skills by thin metadata", "essential"],
		["telegram_send", "TelegramSend", "Send a workspace file to Telegram", "discoverable"],
		["write", "Write", "Write content to a file", "discoverable"],
		["skill", "Skill", "Chain into another available skill", "essential"],
		["goal", "Goal", undefined, "essential"],
		["move_session", "Move Session", undefined, "essential"],
	];

const descriptorRawArgumentValidations: Readonly<Record<string, ToolDescriptorMetadata["rawArgumentValidation"]>> = {
	ask: validateDeferredAskArguments,
	todo_write: validateDeferredTodoArguments,
};

const builtins = names
	.filter(([name]) => name !== "computer" || isComputerLoadablePlatform())
	.map(([name, label, summary, loadMode]) =>
		descriptor({
			name,
			label,
			summary,
			loadMode,
			deferrable: loadMode !== "essential",
			strict: true,
			description: name === "write" ? undefined : summary,
			platformExclusions:
				name === "computer"
					? [{ platform: "linux" }, { platform: "win32" }, { platform: "darwin", arch: "x64" }]
					: undefined,
			parameters: name === "ask" ? deferredAskParameters : undefined,
			parametersForSession:
				name === "ask" ? session => selectAskParameters(session?.getDeepInterviewAskStage?.()) : undefined,
			rawArgumentValidation: descriptorRawArgumentValidations[name],
			intent: deferredIntentPolicies[name],
			loader: loaders[name],
		}),
	);

export const PLATFORM_EXCLUDED_TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
	computer: descriptor({
		name: "computer",
		label: "Computer",
		summary:
			"Control the macOS desktop (Apple Silicon) with screenshot, pointer, keyboard, scroll, and wait actions; available by default on supported hosts and supervisor-gated",
		loadMode: "discoverable",
		deferrable: true,
		strict: true,
		description:
			"Control the macOS desktop (Apple Silicon) with screenshot, pointer, keyboard, scroll, and wait actions.",
		platformExclusions: [{ platform: "linux" }, { platform: "win32" }, { platform: "darwin", arch: "x64" }],
		loader: loaders.computer,
	}),
};
export const BUILTIN_TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = Object.fromEntries(
	builtins.map(descriptorValue => [descriptorValue.metadata.name, descriptorValue]),
);

const hidden = ["yield", "report_finding", "resolve"].map(name =>
	descriptor({ name, label: name, hidden: true, strict: true, loader: loaders[name] }),
);

export const HIDDEN_TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = Object.fromEntries(
	hidden.map(descriptorValue => [descriptorValue.metadata.name, descriptorValue]),
);
export const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
	...BUILTIN_TOOL_DESCRIPTORS,
	...HIDDEN_TOOL_DESCRIPTORS,
};
export const TOOL_DESCRIPTOR_REGISTRY = TOOL_DESCRIPTORS;
export const BUILTIN_TOOL_DESCRIPTOR_REGISTRY = BUILTIN_TOOL_DESCRIPTORS;
export const HIDDEN_TOOL_DESCRIPTOR_REGISTRY = HIDDEN_TOOL_DESCRIPTORS;

export const BUILTIN_TOOLS: Record<string, ToolFactory> = Object.fromEntries(
	Object.entries(BUILTIN_TOOL_DESCRIPTORS).map(([name, descriptorValue]) => [name, descriptorValue.load]),
);
export const HIDDEN_TOOLS: Record<string, ToolFactory> = Object.fromEntries(
	Object.entries(HIDDEN_TOOL_DESCRIPTORS).map(([name, descriptorValue]) => [name, descriptorValue.load]),
);
