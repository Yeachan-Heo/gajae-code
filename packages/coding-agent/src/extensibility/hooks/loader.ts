/**
 * Hook loader - loads TypeScript hook modules using native Bun import.
 */
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import * as zod from "zod/v4";
import { hookCapability } from "../../capability/hook";
import type { Hook } from "../../discovery";
import { loadCapability } from "../../discovery";
import { HookSourceConvention } from "../../hooks/events";
import { type NormalizedHook, normalizeDirectoryHook } from "../../hooks/normalize";
import type { HookMessage } from "../../session/messages";
import type { SessionManager } from "../../session/session-manager";
import {
	type FunctionHook,
	type FunctionHookEventType,
	type FunctionHookPayloadFor,
	type FunctionHookRegistration,
	type FunctionHookRegistrationOptions,
	getFunctionHookRegistration,
	normalizeFunctionHookGrant,
	tagFunctionHookHandler,
	validateFunctionHookTarget,
} from "../extensions/function-hooks";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	MessageRenderer,
} from "../extensions/types";
import * as typebox from "../typebox";
import { resolvePath } from "../utils";
import { execCommand } from "./runner";
import type {
	ExecOptions,
	HookAPI,
	HookCommandContext,
	HookContext,
	HookFactory,
	HookMessageRenderer,
	RegisteredCommand,
} from "./types";

/**
 * Generic handler function type.
 */
type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Send message handler type for pi.sendMessage().
 */
export type SendMessageHandler = <T = unknown>(
	message: Pick<HookMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
) => void;

/**
 * Append entry handler type for pi.appendEntry().
 */
export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

/**
 * New session handler type for ctx.newSession() in HookCommandContext.
 */
export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

/**
 * Branch handler type for ctx.branch() in HookCommandContext.
 */
export type BranchHandler = (entryId: string) => Promise<{ cancelled: boolean }>;

/**
 * Navigate tree handler type for ctx.navigateTree() in HookCommandContext.
 */
export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean },
) => Promise<{ cancelled: boolean }>;

/**
 * Registered handlers for a loaded hook.
 */
export interface LoadedHook {
	/** Original path from config */
	path: string;
	/** Resolved absolute path */
	resolvedPath: string;
	/** Map of event type to handler functions */
	handlers: Map<string, HandlerFn[]>;
	/** Map of customType to hook message renderer */
	messageRenderers: Map<string, HookMessageRenderer>;
	/** Map of command name to registered command */
	commands: Map<string, RegisteredCommand>;
	/** Set the send message handler for this hook's pi.sendMessage() */
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	/** Set the append entry handler for this hook's pi.appendEntry() */
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
	/** Canonical discovery descriptor when loaded from a known hook convention. */
	normalization?: NormalizedHook;
}

/**
 * Result of loading hooks.
 */
export interface LoadHooksResult {
	/** Successfully loaded hooks */
	hooks: LoadedHook[];
	/** Errors encountered during loading */
	errors: Array<{ path: string; error: string }>;
}

export interface LoadHookExtensionsResult {
	factories: Array<{ factory: ExtensionFactory; name: string }>;
	errors: Array<{ path: string; error: string }>;
}

/**
 * Create a HookAPI instance that collects handlers, renderers, and commands.
 * Returns the API, maps, and functions to set handlers later.
 */
async function createHookAPI(
	handlers: Map<string, HandlerFn[]>,
	cwd: string,
	sourcePath: string,
): Promise<{
	api: HookAPI;
	messageRenderers: Map<string, HookMessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
}> {
	let sendMessageHandler: SendMessageHandler | null = null;
	let appendEntryHandler: AppendEntryHandler | null = null;
	const messageRenderers = new Map<string, HookMessageRenderer>();
	const commands = new Map<string, RegisteredCommand>();
	let functionHookRegistrationOrder = 0;

	// Cast to HookAPI - the implementation is more general (string event names)
	// but the interface has specific overloads for type safety in hooks
	const api = {
		on(event: string, handler: HandlerFn): void {
			if (!handlers.has(event)) {
				handlers.set(event, []);
			}
			handlers.get(event)!.push(handler);
		},
		sendMessage<T = unknown>(
			message: HookMessage<T>,
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
		): void {
			if (!sendMessageHandler) {
				throw new Error("sendMessage handler not initialized");
			}
			sendMessageHandler(message, options);
		},
		appendEntry<T = unknown>(customType: string, data?: T): void {
			if (!appendEntryHandler) {
				throw new Error("appendEntry handler not initialized");
			}
			appendEntryHandler(customType, data);
		},
		registerMessageRenderer<T = unknown>(customType: string, renderer: HookMessageRenderer<T>): void {
			messageRenderers.set(customType, renderer as HookMessageRenderer);
		},
		registerCommand(name: string, options: { description?: string; handler: RegisteredCommand["handler"] }): void {
			commands.set(name, { name, ...options });
		},
		registerFunctionHook<T extends FunctionHookEventType>(
			event: T,
			handler: FunctionHook<FunctionHookPayloadFor<T>>,
			options: FunctionHookRegistrationOptions = {},
		): void {
			if (options.target !== undefined && options.target !== "*") validateFunctionHookTarget(options.target);
			const registration: FunctionHookRegistration = {
				event,
				...(options.target === undefined ? {} : { target: options.target }),
				...(options.registrationId === undefined ? {} : { registrationId: options.registrationId }),
				registrationOrder: functionHookRegistrationOrder++,
				handler: handler as unknown as FunctionHook,
				grant: normalizeFunctionHookGrant(options),
				provenance: { source: "extension", path: sourcePath, extensionId: sourcePath },
			};
			const list = handlers.get(event) ?? [];
			list.push(tagFunctionHookHandler(registration) as unknown as HandlerFn);
			handlers.set(event, list);
		},
		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},
		logger,
		typebox,
		zod,
		pi: await import("@gajae-code/coding-agent"),
	} as HookAPI;

	return {
		api,
		messageRenderers,
		commands,
		setSendMessageHandler: (handler: SendMessageHandler) => {
			sendMessageHandler = handler;
		},
		setAppendEntryHandler: (handler: AppendEntryHandler) => {
			appendEntryHandler = handler;
		},
	};
}

/**
 * Load a single hook module using native Bun import.
 */
async function loadHook(hookPath: string, cwd: string): Promise<{ hook: LoadedHook | null; error: string | null }> {
	const resolvedPath = resolvePath(hookPath, cwd);

	try {
		// Import the module using native Bun import
		const module = await import(resolvedPath);
		const factory = module.default as HookFactory;

		if (typeof factory !== "function") {
			return { hook: null, error: "Hook must export a default function" };
		}

		// Create handlers map and API
		const handlers = new Map<string, HandlerFn[]>();
		const { api, messageRenderers, commands, setSendMessageHandler, setAppendEntryHandler } = await createHookAPI(
			handlers,
			cwd,
			resolvedPath,
		);

		// Call factory to register handlers
		factory(api);

		return {
			hook: {
				path: hookPath,
				resolvedPath,
				handlers,
				messageRenderers,
				commands,
				setSendMessageHandler,
				setAppendEntryHandler,
			},
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { hook: null, error: `Failed to load hook: ${message}` };
	}
}

/**
 * Load all hooks from configuration.
 * @param paths - Array of hook file paths
 * @param cwd - Current working directory for resolving relative paths
 */
export async function loadHooks(paths: string[], cwd: string): Promise<LoadHooksResult> {
	const hooks: LoadedHook[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	for (const hookPath of paths) {
		const { hook, error } = await loadHook(hookPath, cwd);

		if (error) {
			errors.push({ path: hookPath, error });
			continue;
		}

		if (hook) {
			hooks.push(hook);
		}
	}

	return { hooks, errors };
}

/**
 * Discover and load hooks from canonical native GJC configuration.
 * Claude Code and Codex hook layouts remain registered capability providers for
 * explicit import and diagnostics, but are not competing runtime authorities.
 *
 * Plus any explicitly configured paths from settings.
 */
export async function discoverAndLoadHooks(configuredPaths: string[], cwd: string): Promise<LoadHooksResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const normalizationErrors: Array<{ path: string; error: string }> = [];
	const normalizationByPath = new Map<string, NormalizedHook>();
	const normalizeExplicitPath = (inputPath: string): NormalizedHook | undefined => {
		const resolved = resolvePath(inputPath, cwd);
		const phase = path.basename(path.dirname(resolved));
		if (phase !== "pre" && phase !== "post") return undefined;
		const fileName = path.basename(resolved);
		const toolName = fileName.includes(".") ? fileName.slice(0, fileName.lastIndexOf(".")) : fileName;
		const normalized = normalizeDirectoryHook({
			convention: HookSourceConvention.NativeGjc,
			phase,
			toolName: toolName === "*" ? "*" : toolName,
			source: resolved,
			externalName: fileName,
		});
		if (!normalized.hook) {
			normalizationErrors.push({
				path: resolved,
				error: normalized.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join("; "),
			});
		}
		return normalized.hook ?? undefined;
	};

	// Helper to add paths without duplicates
	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Discover hooks via capability API and validate the provider descriptor
	// against the canonical model before importing project-controlled code.
	const discovered = await loadCapability<Hook>(hookCapability.id, { cwd, providers: ["native"] });
	for (const hook of discovered.items) {
		const convention =
			hook._source.provider === "native"
				? HookSourceConvention.NativeGjc
				: hook._source.provider === "claude"
					? HookSourceConvention.ClaudeCode
					: hook._source.provider === "codex"
						? HookSourceConvention.Codex
						: null;
		if (convention) {
			const normalized = normalizeDirectoryHook({
				convention,
				phase: hook.type,
				toolName: hook.tool,
				source: hook.path,
				externalName: hook.name,
			});
			if (!normalized.hook) {
				normalizationErrors.push({
					path: hook.path,
					error: normalized.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join("; "),
				});
				continue;
			}
			normalizationByPath.set(resolvePath(hook.path, cwd), normalized.hook);
		}
		addPaths([hook.path]);
	}

	// 2. Explicitly configured paths (can override/add)
	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);
		const normalized = normalizeExplicitPath(resolved);
		if (normalized) normalizationByPath.set(resolved, normalized);
		addPaths([resolved]);
	}

	const loaded = await loadHooks(allPaths, cwd);
	for (const hook of loaded.hooks) {
		hook.normalization = normalizationByPath.get(path.resolve(hook.path));
	}
	return { hooks: loaded.hooks, errors: [...normalizationErrors, ...loaded.errors] };
}

function toHookContext(context: ExtensionContext): HookContext {
	return {
		ui: {
			select: (title, options) => context.ui.select(title, options),
			confirm: (title, message) => context.ui.confirm(title, message),
			input: (title, placeholder) => context.ui.input(title, placeholder),
			notify: (message, type) => context.ui.notify(message, type),
			setStatus: (key, text) => context.ui.setStatus(key, text),
			custom: factory => context.ui.custom((tui, theme, _keybindings, done) => factory(tui, theme, done)),
			setEditorText: text => context.ui.setEditorText(text),
			getEditorText: () => context.ui.getEditorText(),
			editor: (title, prefill, options) => context.ui.editor(title, prefill, options),
			theme: context.ui.theme,
		},
		hasUI: context.hasUI,
		cwd: context.cwd,
		sessionManager: context.sessionManager,
		modelRegistry: context.modelRegistry,
		model: context.model,
		isIdle: () => context.isIdle(),
		abort: () => context.abort(),
		hasQueuedMessages: () => context.hasQueuedMessages(),
	};
}

function toHookCommandContext(context: ExtensionCommandContext): HookCommandContext {
	return {
		...toHookContext(context),
		waitForIdle: () => context.waitForIdle(),
		newSession: options => context.newSession(options),
		branch: entryId => context.branch(entryId),
		navigateTree: (targetId, options) => context.navigateTree(targetId, options),
	};
}

function createHookExtensionFactory(hook: LoadedHook): ExtensionFactory {
	return (api: ExtensionAPI) => {
		hook.setSendMessageHandler((message, options) => api.sendMessage(message, options));
		hook.setAppendEntryHandler((customType, data) => api.appendEntry(customType, data));

		for (const [event, handlers] of hook.handlers) {
			for (const handler of handlers) {
				const functionRegistration = getFunctionHookRegistration(handler);
				if (functionRegistration) {
					api.registerFunctionHook(functionRegistration.event, functionRegistration.handler, {
						...(functionRegistration.target === undefined ? {} : { target: functionRegistration.target }),
						...(functionRegistration.registrationId === undefined
							? {}
							: { registrationId: functionRegistration.registrationId }),
						...functionRegistration.grant,
						provenance: functionRegistration.provenance,
					});
					continue;
				}
				const normalized = hook.normalization;
				const adapted: HandlerFn = async (...args: unknown[]) => {
					const payload = args[0] as { toolName?: string };
					if (
						normalized &&
						event === normalized.runtimeEvent &&
						normalized.toolName !== "*" &&
						payload.toolName !== normalized.toolName
					) {
						return undefined;
					}
					return await handler(payload, toHookContext(args[1] as ExtensionContext));
				};
				(api.on as (event: string, handler: HandlerFn) => void)(event, adapted);
			}
		}

		for (const [customType, renderer] of hook.messageRenderers) {
			const adaptedRenderer: MessageRenderer = (message, options, theme) =>
				renderer({ ...message, role: "hookMessage" }, options, theme);
			api.registerMessageRenderer(customType, adaptedRenderer);
		}
		for (const command of hook.commands.values()) {
			api.registerCommand(command.name, {
				description: command.description,
				handler: (args, context) => command.handler(args, toHookCommandContext(context)),
			});
		}
	};
}

/** Load normalized directory hooks and adapt them into the authoritative ExtensionRunner path. */
export async function discoverAndLoadHookExtensions(
	configuredPaths: string[],
	cwd: string,
): Promise<LoadHookExtensionsResult> {
	const loaded = await discoverAndLoadHooks(configuredPaths, cwd);
	return {
		factories: loaded.hooks.map(hook => ({
			factory: createHookExtensionFactory(hook),
			name: `hook:${hook.resolvedPath}`,
		})),
		errors: loaded.errors,
	};
}
