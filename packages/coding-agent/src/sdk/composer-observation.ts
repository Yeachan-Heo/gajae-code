import { extractSlashCommandTokenPrefix, type SlashCommand } from "@gajae-code/tui";
import { sanitizeDisplayLine } from "@gajae-code/utils";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import type { ContextUsage } from "../extensibility/extensions/types";
import { getBuiltinSlashCommandsForSession, isDisplaySafeCommandName } from "../extensibility/slash-commands";
import { PromptActionAutocompleteProvider } from "../modes/prompt-action-autocomplete";
import type { AgentSession } from "../session/agent-session";
import { ACP_BUILTIN_SLASH_COMMANDS } from "../slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";

export const SDK_COMPOSER_LIMITS = {
	textChars: 32_000,
	commands: 256,
	completions: 100,
	responseBytes: 262_144,
	labelChars: 256,
	descriptionChars: 1024,
} as const;

import type { SdkComposerObservationOperation } from "./protocol/client-control-contracts";

export {
	isSdkComposerObservationOperation,
	type SdkComposerObservationOperation,
} from "./protocol/client-control-contracts";
export type SdkComposerObservationErrorCode =
	| "invalid_input"
	| "disposed"
	| "stale_session"
	| "session_transitioning"
	| "backend_failure";

const reasons: Record<SdkComposerObservationErrorCode, string> = {
	invalid_input: "Invalid composer observation parameters.",
	disposed: "The composer observation service or session has been disposed.",
	stale_session: "The composer observation belongs to an earlier session identity or working directory.",
	session_transitioning: "The session is transitioning; retry after it settles.",
	backend_failure: "The session completion provider failed.",
};

export class SdkComposerObservationError extends Error {
	constructor(readonly code: SdkComposerObservationErrorCode) {
		super(reasons[code]);
		this.name = "SdkComposerObservationError";
	}
}

export interface SdkComposerCommand {
	/** Exact executable name; only display-safe command names are advertised. */
	name: string;
	label: string;
	description?: string;
	source: "builtin" | "extension" | "prompt" | "skill";
}

export interface SdkComposerCatalog {
	sessionGeneration: number;
	commands: SdkComposerCommand[];
	truncated: boolean;
}

export interface SdkComposerCompletionInput {
	text: string;
	/** UTF-16 offset; a cursor inside a surrogate pair is rejected. */
	cursor: number;
}

export interface SdkComposerCompletion {
	value: string;
	label: string;
	description?: string;
	/** Exact whole-draft replacement produced by the shared provider. */
	text: string;
	cursor: number;
}

export interface SdkComposerCompletionResult {
	sessionGeneration: number;
	items: SdkComposerCompletion[];
	truncated: boolean;
}

export interface SdkSessionInfo {
	sessionId: string;
	sessionGeneration: number;
	name?: string;
	cwd: string;
	model?: { provider: string; id: string; name: string; contextWindow: number };
	modelProfile?: string;
	/** Null when the session has no explicit thinking selection. */
	thinkingLevel: string | null;
	streaming: boolean;
	bashRunning: boolean;
	pythonRunning: boolean;
	queuedMessages: number;
	context?: { tokens: number | null; contextWindow: number; percent: number | null; source: ContextUsage["source"] };
	stats: {
		userMessages: number;
		assistantMessages: number;
		toolCalls: number;
		toolResults: number;
		totalMessages: number;
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		premiumRequests: number;
		cost: number;
	};
}

export type SdkComposerObservationResult = SdkComposerCatalog | SdkComposerCompletionResult | SdkSessionInfo;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new SdkComposerObservationError("invalid_input");
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new SdkComposerObservationError("invalid_input");
	const names = Reflect.ownKeys(value);
	if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)))
		throw new SdkComposerObservationError("invalid_input");
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) throw new SdkComposerObservationError("invalid_input");
		result[key] = descriptor.value;
	}
	return result;
}

function validCursor(text: string, cursor: number): boolean {
	if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length) return false;
	return !(
		cursor > 0 &&
		cursor < text.length &&
		/[\uD800-\uDBFF]/.test(text[cursor - 1]!) &&
		/[\uDC00-\uDFFF]/.test(text[cursor]!)
	);
}

function display(text: string, limit: number): string {
	const sanitized = sanitizeDisplayLine(text).replaceAll("\t", " ");
	const cutoff = Math.min(limit, sanitized.length);
	return sanitized.slice(0, validCursor(sanitized, cutoff) ? cutoff : cutoff - 1);
}

/** Admission only: all token interpretation and replacements remain owned by the shared provider. */
function trigger(text: string, cursor: number): boolean {
	const before = text.slice(0, cursor);
	const line = before.slice(before.lastIndexOf("\n") + 1);
	return (
		/(?:^|[\s"'=])@(?:[^\s"]*|"[^"]*)$/.test(line) ||
		extractSlashCommandTokenPrefix(line) !== null ||
		/^\s*\/[^\s/]+[ \t][^\n]*$/.test(before)
	);
}

function bytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

interface CatalogCommand {
	command: SlashCommand;
	source: SdkComposerCommand["source"];
}

/** Read-only session catalog, shared-engine draft completion, and HUD observations. */
export class SdkComposerObservation {
	readonly #session: AgentSession;
	readonly #manager: AgentSession["sessionManager"];
	readonly #agent: AgentSession["agent"];
	readonly #sessionId: string;
	readonly #managerId: string;
	readonly #managerGeneration: number;
	readonly #generation: number;
	readonly #cwd: string;
	#retired: "disposed" | "stale_session" | undefined;
	#unregisterDispose: (() => void) | undefined;
	#unregisterTransition: (() => void) | undefined;

	constructor(session: AgentSession) {
		this.#session = session;
		this.#manager = session.sessionManager;
		this.#agent = session.agent;
		this.#sessionId = session.sessionId;
		this.#managerId = this.#manager.getSessionId();
		this.#managerGeneration = this.#manager.getSessionIdentityGeneration();
		this.#generation = session.sessionLifecycle.generation;
		this.#cwd = this.#manager.getCwd();
		this.#guard();
		this.#unregisterDispose = session.registerToolSessionCleanup(() => this.dispose());
		this.#unregisterTransition = session.registerToolSessionTransitionCleanup(() =>
			this.#retire(session.sessionLifecycle.disposed ? "disposed" : "stale_session"),
		);
	}

	get disposed(): boolean {
		return this.#retired !== undefined;
	}

	#guard(): void {
		const lifecycle = this.#session.sessionLifecycle;
		if (lifecycle.disposed) {
			this.#retire("disposed");
			throw new SdkComposerObservationError("disposed");
		}
		if (this.#retired) throw new SdkComposerObservationError(this.#retired);
		if (
			lifecycle.generation !== this.#generation ||
			this.#session.sessionId !== this.#sessionId ||
			this.#session.agent !== this.#agent ||
			this.#session.sessionManager !== this.#manager ||
			this.#manager.getSessionId() !== this.#managerId ||
			this.#manager.getSessionIdentityGeneration() !== this.#managerGeneration ||
			this.#manager.getCwd() !== this.#cwd
		) {
			this.#retire("stale_session");
			throw new SdkComposerObservationError("stale_session");
		}
		if (lifecycle.transitioning) throw new SdkComposerObservationError("session_transitioning");
	}

	#commands(): CatalogCommand[] {
		this.#guard();
		const executable = new Map(ACP_BUILTIN_SLASH_COMMANDS.map(command => [command.name, command]));
		const seen = new Set<string>();
		const commands: CatalogCommand[] = [];
		for (const builtin of getBuiltinSlashCommandsForSession(this.#session.hasExactMcpControls, this.#session)) {
			const available = executable.get(builtin.name);
			if (!available) continue;
			seen.add(builtin.name);
			commands.push({ command: { ...builtin, description: available.description }, source: "builtin" });
		}
		const extensions = new Map(
			(this.#session.extensionRunner?.getRegisteredCommands() ?? []).map(command => [command.name, command]),
		);
		for (const dynamic of getSessionSlashCommands(this.#session)) {
			if (
				lookupBuiltinSlashCommand(dynamic.name) !== undefined ||
				seen.has(dynamic.name) ||
				!isDisplaySafeCommandName(dynamic.name) ||
				/\s/.test(dynamic.name) ||
				dynamic.name.length > SDK_COMPOSER_LIMITS.labelChars
			)
				continue;
			seen.add(dynamic.name);
			const extension = dynamic.source === "extension" ? extensions.get(dynamic.name) : undefined;
			commands.push({
				command: {
					name: dynamic.name,
					description: dynamic.description,
					...(extension?.getArgumentCompletions
						? { getArgumentCompletions: extension.getArgumentCompletions }
						: {}),
				},
				source: dynamic.source,
			});
		}
		this.#guard();
		return commands;
	}

	catalog(value: unknown): SdkComposerCatalog {
		this.#guard();
		object(value, []);
		const result: SdkComposerCatalog = { sessionGeneration: this.#generation, commands: [], truncated: false };
		let size = 1024;
		for (const { command, source } of this.#commands()) {
			const item: SdkComposerCommand = {
				name: command.name,
				label: display(command.name, SDK_COMPOSER_LIMITS.labelChars),
				...(command.description
					? { description: display(command.description, SDK_COMPOSER_LIMITS.descriptionChars) }
					: {}),
				source,
			};
			const itemBytes = bytes(item) + 1;
			if (
				result.commands.length >= SDK_COMPOSER_LIMITS.commands ||
				size + itemBytes > SDK_COMPOSER_LIMITS.responseBytes
			) {
				result.truncated = true;
				break;
			}
			size += itemBytes;
			result.commands.push(item);
		}
		this.#guard();
		return result;
	}

	async complete(value: unknown): Promise<SdkComposerCompletionResult> {
		this.#guard();
		const { text, cursor } = object(value, ["text", "cursor"]);
		this.#guard();
		if (
			typeof text !== "string" ||
			text.length > SDK_COMPOSER_LIMITS.textChars ||
			text.includes("\0") ||
			typeof cursor !== "number" ||
			!validCursor(text, cursor)
		)
			throw new SdkComposerObservationError("invalid_input");
		const result: SdkComposerCompletionResult = { sessionGeneration: this.#generation, items: [], truncated: false };
		if (!trigger(text, cursor)) return result;
		const lines = text.split("\n");
		const preceding = text.slice(0, cursor).split("\n");
		const cursorLine = preceding.length - 1;
		const cursorCol = preceding[cursorLine]!.length;
		const provider = new PromptActionAutocompleteProvider(
			this.#commands().map(entry => entry.command),
			this.#cwd,
			[],
		);
		try {
			const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol);
			this.#guard();
			let size = 1024;
			for (const item of suggestions?.items ?? []) {
				const applied = provider.applyCompletion(lines, cursorLine, cursorCol, item, suggestions!.prefix);
				const replacement = applied.lines.join("\n");
				const offset =
					applied.lines.slice(0, applied.cursorLine).reduce((sum, line) => sum + line.length + 1, 0) +
					applied.cursorCol;
				if (
					applied.onApplied ||
					replacement.length > SDK_COMPOSER_LIMITS.textChars ||
					item.value.length > SDK_COMPOSER_LIMITS.textChars ||
					!validCursor(replacement, offset)
				) {
					result.truncated = true;
					continue;
				}
				const completion: SdkComposerCompletion = {
					value: item.value,
					label: display(item.label, SDK_COMPOSER_LIMITS.labelChars),
					...(item.description
						? { description: display(item.description, SDK_COMPOSER_LIMITS.descriptionChars) }
						: {}),
					text: replacement,
					cursor: offset,
				};
				const itemBytes = bytes(completion) + 1;
				if (
					result.items.length >= SDK_COMPOSER_LIMITS.completions ||
					size + itemBytes > SDK_COMPOSER_LIMITS.responseBytes
				) {
					result.truncated = true;
					break;
				}
				size += itemBytes;
				result.items.push(completion);
			}
			this.#guard();
			return result;
		} catch (error) {
			// Recheck ownership before translating an asynchronous backend failure.
			this.#guard();
			if (error instanceof SdkComposerObservationError) throw error;
			throw new SdkComposerObservationError("backend_failure");
		}
	}

	info(value: unknown): SdkSessionInfo {
		this.#guard();
		object(value, []);
		this.#guard();
		const stats = this.#session.getSessionStats();
		const context = this.#session.getContextUsage();
		const model = this.#session.model;
		const profile = this.#session.getActiveModelProfile();
		const name = this.#session.sessionName;
		const result: SdkSessionInfo = {
			sessionId: this.#sessionId,
			sessionGeneration: this.#generation,
			...(name ? { name: display(name, SDK_COMPOSER_LIMITS.labelChars) } : {}),
			cwd: display(this.#cwd, 4096),
			...(model
				? {
						model: {
							provider: display(model.provider, 256),
							id: display(model.id, 512),
							name: display(model.name, 256),
							contextWindow: model.contextWindow,
						},
					}
				: {}),
			...(profile ? { modelProfile: display(profile, SDK_COMPOSER_LIMITS.labelChars) } : {}),
			thinkingLevel: this.#session.thinkingLevel ?? null,
			streaming: this.#session.isStreaming,
			bashRunning: this.#session.isBashRunning,
			pythonRunning: this.#session.isEvalRunning,
			queuedMessages: this.#session.queuedMessageCount,
			...(context
				? {
						context: {
							tokens: context.tokens,
							contextWindow: context.contextWindow,
							percent: context.percent,
							source: context.source,
						},
					}
				: {}),
			stats: {
				userMessages: stats.userMessages,
				assistantMessages: stats.assistantMessages,
				toolCalls: stats.toolCalls,
				toolResults: stats.toolResults,
				totalMessages: stats.totalMessages,
				tokens: {
					input: stats.tokens.input,
					output: stats.tokens.output,
					cacheRead: stats.tokens.cacheRead,
					cacheWrite: stats.tokens.cacheWrite,
					total: stats.tokens.total,
				},
				premiumRequests: stats.premiumRequests,
				cost: stats.cost,
			},
		};
		this.#guard();
		return result;
	}

	async dispatch(operation: SdkComposerObservationOperation, input: unknown): Promise<SdkComposerObservationResult> {
		switch (operation) {
			case "composer.catalog":
				return this.catalog(input);
			case "composer.complete":
				return this.complete(input);
			case "session.info":
				return this.info(input);
			default:
				throw new SdkComposerObservationError("invalid_input");
		}
	}

	#retire(reason: "disposed" | "stale_session"): void {
		if (this.#retired) return;
		this.#retired = reason;
		this.#unregisterDispose?.();
		this.#unregisterTransition?.();
		this.#unregisterDispose = undefined;
		this.#unregisterTransition = undefined;
	}

	dispose(): void {
		this.#retire("disposed");
	}
}

export function createSdkComposerObservation(session: AgentSession): SdkComposerObservation {
	return new SdkComposerObservation(session);
}
