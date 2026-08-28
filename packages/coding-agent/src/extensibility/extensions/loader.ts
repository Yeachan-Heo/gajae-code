/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { ImageContent, Model, TextContent, Tool, UsageReport } from "@gajae-code/ai/core";
import type { KeyId } from "@gajae-code/tui";
import { hasFsCode, isEacces, isEnoent, logger } from "@gajae-code/utils";
import * as Zod from "zod/v4";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import type { Settings } from "../../config/settings";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
import type { CustomMessage } from "../../session/messages";
import { EventBus } from "../../utils/event-bus";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";
import * as TypeBox from "../typebox";

import { resolvePath } from "../utils";
import type {
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	RegisteredCommand,
	ToolDefinition,
} from "./types";

installLegacyPiSpecifierShim();

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type LoadedExtensionModule = ExtensionFactory | { default?: ExtensionFactory };

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		super("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	}
}

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	pendingProviderRegistrations: Array<{ name: string; config: import("./types").ProviderConfig; sourceId: string }> =
		[];

	sendMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	sendUserMessage(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	appendEntry(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setLabel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getActiveTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAllTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	resolveTool(): Pick<Tool, "safeSummary" | "safeSummaryFields"> | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setActiveTools(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getCommands(): never {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModel(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingLevel(): ThinkingLevel {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingVisibility(): "visible" | "hidden" {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingVisibility(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevelForControl(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingVisibilityForControl(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModelTemporaryForControl(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	fetchUsageReportsForControl(): Promise<UsageReport[] | null> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingScopeForControl(): "session" | "global config" {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getSessionName(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

/**
 * Per-extension activation transaction over the shared runtime state.
 *
 * Registration writes from a factory are staged here (stage); the factory
 * completing without throwing is the validation step; commit copies the
 * staged mutations into the shared runtime; rollback discards them, so a
 * factory that fails midway leaves no registration behind (issue #4718).
 */
export class ExtensionActivationScope {
	readonly #runtime: IExtensionRuntime;
	readonly #stagedFlagDefaults = new Map<string, boolean | string>();
	readonly #stagedProviderRegistrations: Array<{
		name: string;
		config: import("./types").ProviderConfig;
		sourceId: string;
	}> = [];
	#closed = false;

	/** True while staged writes may still be added or committed. */
	get open(): boolean {
		return !this.#closed;
	}

	constructor(runtime: IExtensionRuntime) {
		this.#runtime = runtime;
	}

	get flagValues(): Map<string, boolean | string> {
		return this.#stagedFlagDefaults;
	}

	get pendingProviderRegistrations(): Array<{
		name: string;
		config: import("./types").ProviderConfig;
		sourceId: string;
	}> {
		return this.#stagedProviderRegistrations;
	}

	/**
	 * Publish the staged mutations into the shared runtime as one transaction.
	 *
	 * Prior state is journaled before any live mutation so a throw partway
	 * through publication is undone before it escapes: flag entries that did
	 * not exist are removed, overwritten entries are restored, and the
	 * provider queue is truncated to its prior length. The scope only becomes
	 * terminal once publication has fully succeeded, so a failed commit
	 * leaves the shared runtime exactly as it was (issue #4718).
	 */
	commit(): void {
		if (this.#closed) return;
		const priorFlagEntries = new Map<string, { existed: true; value: boolean | string } | { existed: false }>();
		for (const name of this.#stagedFlagDefaults.keys()) {
			// Flag values are `boolean | string`, so `undefined` means absent.
			const current = this.#runtime.flagValues.get(name);
			priorFlagEntries.set(name, current === undefined ? { existed: false } : { existed: true, value: current });
		}
		const priorProviderCount = this.#runtime.pendingProviderRegistrations.length;

		try {
			for (const [name, value] of this.#stagedFlagDefaults) {
				this.#runtime.flagValues.set(name, value);
			}
			for (const registration of this.#stagedProviderRegistrations) {
				this.#runtime.pendingProviderRegistrations.push(registration);
			}
		} catch (err) {
			for (const [name, prior] of priorFlagEntries) {
				if (prior.existed) {
					this.#runtime.flagValues.set(name, prior.value);
				} else {
					this.#runtime.flagValues.delete(name);
				}
			}
			this.#runtime.pendingProviderRegistrations.length = priorProviderCount;
			this.#close();
			throw err;
		}

		this.#closed = true;
	}

	rollback(): void {
		if (this.#closed) return;
		this.#close();
	}

	/** Mark the scope terminal and drop the staged copies. */
	#close(): void {
		this.#closed = true;
		this.#stagedFlagDefaults.clear();
		this.#stagedProviderRegistrations.length = 0;
	}
}

/**
 * ExtensionAPI implementation for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
class ConcreteExtensionAPI implements ExtensionAPI {
	readonly logger = logger;
	readonly typebox = TypeBox;
	readonly zod = Zod;

	constructor(
		public readonly pi: typeof import("@gajae-code/coding-agent"),
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		private readonly activation: ExtensionActivationScope,
		private readonly cwd: string,
		public readonly events: EventBus,
	) {}

	on<F extends HandlerFn>(event: string, handler: F): void {
		const list = this.extension.handlers.get(event) ?? [];
		list.push(handler);
		this.extension.handlers.set(event, list);
	}

	registerTool<
		TParams extends import("@gajae-code/ai/core").TSchema = import("@gajae-code/ai/core").TSchema,
		TDetails = unknown,
	>(tool: ToolDefinition<TParams, TDetails>): void {
		this.extension.tools.set(tool.name, {
			definition: tool,
			extensionPath: this.extension.path,
		});
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		this.extension.commands.set(name, { name, ...options });
	}

	setLabel(label: string): void {
		this.extension.label = label;
	}

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void {
		this.extension.shortcuts.set(shortcut, { shortcut, extensionPath: this.extension.path, ...options });
	}

	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void {
		this.extension.flags.set(name, { name, extensionPath: this.extension.path, ...options });
		if (options.default !== undefined) {
			this.activation.flagValues.set(name, options.default);
		}
	}

	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
		this.extension.messageRenderers.set(customType, renderer as MessageRenderer);
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		if (!this.activation.open) {
			// Post-commit: the shared runtime is authoritative, so runtime-side
			// writes (CLI flag overrides, later extensions) stay observable.
			return this.runtime.flagValues.get(name);
		}
		// Activation in flight: prefer this factory's staged default so the
		// extension reads back what it just registered.
		return this.activation.flagValues.get(name) ?? this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: {
			deliverAs?: "steer" | "followUp";
			queuedAtDispatch?: boolean;
			onPreflightAccepted?: () => void;
			onPreflightAcceptCommit?: () => void | Promise<void>;
			onQueuedPromoted?: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => void;
			onDispatchDisposition?: (promotion: { startsOwnRun: boolean }) => void;
			preflightSignal?: AbortSignal;
		},
	): Promise<void> {
		return Promise.resolve(this.runtime.sendUserMessage(content, options));
	}

	appendEntry(customType: string, data?: unknown): void {
		this.runtime.appendEntry(customType, data);
	}

	exec(command: string, args: string[], options?: ExecOptions) {
		return execCommand(command, args, options?.cwd ?? this.cwd, options);
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	getAllTools(): string[] {
		return this.runtime.getAllTools();
	}

	resolveTool(name: string): Pick<Tool, "safeSummary" | "safeSummaryFields"> | undefined {
		return this.runtime.resolveTool(name);
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.runtime.setActiveTools(toolNames);
	}

	getCommands() {
		return this.runtime.getCommands();
	}

	setModel(model: Model): Promise<boolean> {
		return this.runtime.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void {
		this.runtime.setThinkingLevel(level, persist);
	}

	getThinkingVisibility(): "visible" | "hidden" {
		return this.runtime.getThinkingVisibility();
	}

	setThinkingVisibility(visibility: "visible" | "hidden", persist?: boolean): void {
		this.runtime.setThinkingVisibility(visibility, persist);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.cycleThinkingLevel();
	}

	setThinkingLevelForControl(level: ThinkingLevel, persist: boolean): Promise<void> {
		return this.runtime.setThinkingLevelForControl(level, persist);
	}

	setThinkingVisibilityForControl(visibility: "visible" | "hidden", persist: boolean): Promise<void> {
		return this.runtime.setThinkingVisibilityForControl(visibility, persist);
	}

	setModelTemporaryForControl(
		model: Model,
		expectedSessionId?: string,
		thinkingLevel?: ThinkingLevel,
	): Promise<boolean> {
		return this.runtime.setModelTemporaryForControl(model, expectedSessionId, thinkingLevel);
	}

	fetchUsageReportsForControl(): Promise<UsageReport[] | null> {
		return this.runtime.fetchUsageReportsForControl();
	}

	getThinkingScopeForControl(): "session" | "global config" {
		return this.runtime.getThinkingScopeForControl();
	}

	getSessionName(): string | undefined {
		return this.runtime.getSessionName();
	}

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: import("./types").ProviderConfig): void {
		this.activation.pendingProviderRegistrations.push({ name, config, sourceId: this.extension.path });
	}
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	let activation: ExtensionActivationScope | undefined;
	try {
		const module = (await loadLegacyPiModule(resolvedPath)) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				extension: null,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		const extension = createExtension(extensionPath, resolvedPath);
		activation = new ExtensionActivationScope(runtime);
		const api = new ConcreteExtensionAPI(
			await import("@gajae-code/coding-agent"),
			extension,
			runtime,
			activation,
			cwd,
			eventBus,
		);
		await factory(api);
		activation.commit();

		return { extension, error: null };
	} catch (err) {
		activation?.rollback();
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	name = "<inline>",
): Promise<Extension> {
	const extension = createExtension(name, name);
	const activation = new ExtensionActivationScope(runtime);
	const api = new ConcreteExtensionAPI(
		await import("@gajae-code/coding-agent"),
		extension,
		runtime,
		activation,
		cwd,
		eventBus,
	);
	try {
		await factory(api);
	} catch (err) {
		activation.rollback();
		throw err;
	}
	activation.commit();
	return extension;
}

/**
 * Load extensions from paths.
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const runtime = new ExtensionRuntime();

	for (const extPath of paths) {
		const { extension, error } = await loadExtension(extPath, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

interface ExtensionManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
}

async function readExtensionManifest(packageJsonPath: string): Promise<ExtensionManifest | null> {
	try {
		const pkg = (await Bun.file(packageJsonPath).json()) as { gjc?: ExtensionManifest; pi?: ExtensionManifest };
		const manifest = pkg.gjc ?? pkg.pi;
		if (manifest && typeof manifest === "object") {
			return manifest;
		}
		return null;
	} catch (error) {
		if (isEnoent(error) || isEacces(error) || hasFsCode(error, "EPERM")) {
			return null;
		}
		logger.warn("Failed to read extension manifest", { path: packageJsonPath, error: String(error) });
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 */
async function resolveExtensionEntries(dir: string): Promise<string[] | null> {
	const packageJsonPath = path.join(dir, "package.json");
	const manifest = await readExtensionManifest(packageJsonPath);
	if (manifest?.extensions?.length) {
		const entries: string[] = [];
		for (const extPath of manifest.extensions) {
			const resolvedExtPath = path.resolve(dir, extPath);
			try {
				await fs.stat(resolvedExtPath);
				entries.push(resolvedExtPath);
			} catch (err) {
				if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) continue;
				throw err;
			}
		}
		if (entries.length > 0) {
			return entries;
		}
	}

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	try {
		await fs.stat(indexTs);
		return [indexTs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}
	try {
		await fs.stat(indexJs);
		return [indexJs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "gjc"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
async function discoverExtensionsInDir(dir: string): Promise<string[]> {
	const discovered: string[] = [];

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = await resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	let entries: fs1.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to discover extensions in directory", { path: dir, error: String(err) });
		return [];
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);

		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			discovered.push(entryPath);
			continue;
		}

		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const resolved = await resolveExtensionEntries(entryPath);
			if (resolved) {
				discovered.push(...resolved);
			}
		}
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 *
 * @param configuredPaths - Explicit paths from settings.json and CLI extension flags
 * @param cwd - Current working directory
 * @param eventBus - Event bus shared by loaded extensions
 * @param disabledExtensionIds - Extension IDs disabled by settings
 * @param agentDir - Effective user profile directory for capability and plugin discovery
 * @param settings - Effective session settings for capability provider policy
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds: string[] = [],
	agentDir?: string,
	settings?: Settings,
): Promise<LoadExtensionsResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds);
	const selectedAgentDir = agentDir ?? settings?.getAgentDir();

	const isDisabledName = (name: string): boolean => disabled.has(`extension-module:${name}`);

	const addPath = (extPath: string): void => {
		const resolved = path.resolve(extPath);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPaths.push(extPath);
		}
	};

	const addPaths = (paths: string[]) => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			addPath(extPath);
		}
	};

	// 1. Discover extension modules via capability API (native .gjc/.pi only)
	const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
		cwd,
		agentDir: selectedAgentDir,
		settings,
	});
	for (const ext of discovered.items) {
		if (ext._source.provider !== "native") continue;
		if (isDisabledName(ext.name)) continue;
		addPath(ext.path);
	}

	// 2. Discover extension entry points from installed plugins
	addPaths(await getAllPluginExtensionPaths(cwd, selectedAgentDir));

	// 3. Explicitly configured paths
	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);

		let stat: fs1.Stats | null = null;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		if (stat?.isDirectory()) {
			const entries = await resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}

			const discovered = await discoverExtensionsInDir(resolved);
			if (discovered.length > 0) {
				addPaths(discovered);
			}
			continue;
		}

		addPath(resolved);
	}

	return loadExtensions(allPaths, cwd, eventBus);
}
