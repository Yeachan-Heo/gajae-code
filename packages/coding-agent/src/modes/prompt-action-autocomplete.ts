import {
	type AutocompleteItem,
	type AutocompleteProvider,
	autocompleteFuzzyMatch,
	autocompleteFuzzyScore,
	CombinedAutocompleteProvider,
	extractSlashCommandTokenPrefix,
	getSlashCommandMatchRank,
	hasInlineCodeDelimiter,
	isInsideInlineCodeSpan,
	normalizeFuzzyText,
	type SlashCommand,
} from "@gajae-code/tui";
import type { KeybindingsManager } from "../config/keybindings";
import { isSettingsInitialized, settings } from "../config/settings";
import { applyEmojiCompletion, getEmojiSuggestions, isEmojiPrefix, tryEmojiInlineReplace } from "./emoji-autocomplete";

interface PromptActionDefinition {
	id: string;
	label: string;
	description: string;
	keywords: string[];
	execute: (prefix: string) => void;
}

interface PromptActionAutocompleteItem extends AutocompleteItem {
	actionId: string;
	execute: (prefix: string) => void;
}

interface SkillCommandAutocompleteItem extends AutocompleteItem {
	normalizedSkillCommand: true;
}

interface PromptActionAutocompleteOptions {
	commands: SlashCommand[];
	basePath: string;
	keybindings: KeybindingsManager;
	copyCurrentLine: () => void;
	copyPrompt: () => void;
	pasteImage: () => void;
	pasteText: () => void;
	newSession: () => void;
	showHelp: () => void;
	scrollTmuxToPreviousUserInput: () => void;
	undo: (prefix: string) => void;
	moveCursorToMessageEnd: () => void;
	moveCursorToMessageStart: () => void;
	moveCursorToLineStart: () => void;
	moveCursorToLineEnd: () => void;
	/**
	 * Ghost-text next-prompt prediction shown in the empty composer as a dim
	 * inline hint (Tab accepts it via the editor's onTab handler).
	 */
	getPromptSuggestion?: () => string | null;
}

function isPromptActionItem(item: AutocompleteItem): item is PromptActionAutocompleteItem {
	return "actionId" in item && "execute" in item && typeof item.execute === "function";
}

function isSkillCommandAutocompleteItem(item: AutocompleteItem): item is SkillCommandAutocompleteItem {
	return "normalizedSkillCommand" in item && item.normalizedSkillCommand === true;
}

function mergeAutocompleteSuggestions(
	primary: { items: AutocompleteItem[]; prefix: string } | null,
	secondary: { items: AutocompleteItem[]; prefix: string } | null,
): { items: AutocompleteItem[]; prefix: string } | null {
	if (!primary) return secondary;
	if (!secondary) return primary;
	if (primary.prefix !== secondary.prefix) return primary;

	const seen = new Set<string>();
	const items: AutocompleteItem[] = [];
	for (const item of [...primary.items, ...secondary.items]) {
		const key = `${item.value}\0${item.label}`;
		if (seen.has(key)) continue;
		seen.add(key);
		items.push(item);
	}

	return { items, prefix: primary.prefix };
}
const ADVANCED_SLASH_COMMAND_PRIORITIES = new Map<string, number>([["grok-build-usage", -100]]);

function getSlashCommandPriority(command: SlashCommand | undefined, item: AutocompleteItem): number {
	if (command?.priority !== undefined) return command.priority;
	return ADVANCED_SLASH_COMMAND_PRIORITIES.get(item.value) ?? 0;
}

interface SlashCommandMetadata {
	command: SlashCommand;
	index: number;
	lowerName: string;
	normalizedName: string;
	normalizedDescription: string | undefined;
}

interface SkillCommandMetadata {
	command: SlashCommand;
	lowerSkillName: string;
	searchTargets: string[];
	collisionSearchTargets: string[];
}

function sortSlashCommandSuggestions(
	suggestions: { items: AutocompleteItem[]; prefix: string } | null,
	commandMetadata: ReadonlyMap<string, SlashCommandMetadata>,
): { items: AutocompleteItem[]; prefix: string } | null {
	if (!suggestions) return null;
	const query = suggestions.prefix.slice(1).toLowerCase();
	const normalizedQuery = normalizeFuzzyText(query);
	const items = suggestions.items
		.map((item, index) => {
			const metadata = commandMetadata.get(item.value);
			const command = metadata?.command;
			const commandIndex = metadata?.index ?? index;
			const lowerName = metadata?.lowerName ?? item.value.toLowerCase();
			const normalizedName = metadata?.normalizedName ?? normalizeFuzzyText(item.value);
			const normalizedDesc =
				metadata?.normalizedDescription ?? normalizeFuzzyText(item.description?.toLowerCase() ?? "");
			const nameScore = autocompleteFuzzyMatch(normalizedQuery, normalizedName)
				? autocompleteFuzzyScore(normalizedQuery, normalizedName)
				: 0;
			const descScore = autocompleteFuzzyMatch(normalizedQuery, normalizedDesc)
				? autocompleteFuzzyScore(normalizedQuery, normalizedDesc) * 0.5
				: 0;
			const isAscii = /^[\x00-\x7F]*$/.test(`${query}${item.value}`);
			return {
				item,
				index,
				commandIndex,
				matchRank: isAscii ? getSlashCommandMatchRank(query, lowerName) : 4,
				priority: getSlashCommandPriority(command, item),
				score: Math.max(nameScore, descScore),
			};
		})
		.sort(
			(a, b) =>
				a.matchRank - b.matchRank ||
				b.priority - a.priority ||
				b.score - a.score ||
				a.commandIndex - b.commandIndex ||
				a.index - b.index,
		)
		.map(({ item }) => item);
	return { ...suggestions, items };
}

function isRootPathSuggestionResult(suggestions: { items: AutocompleteItem[]; prefix: string } | null): boolean {
	return suggestions?.prefix.startsWith("/") === true && suggestions.items.some(item => item.value.startsWith("/"));
}

function withoutSkillCommandSuggestions(
	suggestions: { items: AutocompleteItem[]; prefix: string } | null,
): { items: AutocompleteItem[]; prefix: string } | null {
	if (!suggestions) return null;
	const items = suggestions.items.filter(item => !item.value.toLowerCase().startsWith("skill:"));
	return items.length > 0 ? { ...suggestions, items } : null;
}

function getPromptActionPrefix(textBeforeCursor: string): string | null {
	const hashIndex = textBeforeCursor.lastIndexOf("#");
	if (hashIndex === -1) return null;

	const query = textBeforeCursor.slice(hashIndex + 1);
	if (/[\s]/.test(query)) {
		return null;
	}

	return textBeforeCursor.slice(hashIndex);
}

function getSlashTokenPrefix(textBeforeCursor: string): string | null {
	return extractSlashCommandTokenPrefix(textBeforeCursor);
}

function getRawSlashTokenPrefix(textBeforeCursor: string): string | null {
	return textBeforeCursor.match(/(?:^|\s)(\/[^\s]*)$/)?.[1] ?? null;
}

function isSlashTokenInsideInlineCodeSpan(
	lines: string[],
	cursorLine: number,
	textBeforeCursor: string,
	prefix: string,
): boolean {
	const tokenStart = textBeforeCursor.length - prefix.length;
	const textBeforeToken = [...lines.slice(0, cursorLine), textBeforeCursor.slice(0, tokenStart)].join("\n");
	return isInsideInlineCodeSpan(textBeforeToken);
}

export class PromptActionAutocompleteProvider implements AutocompleteProvider {
	#baseProvider: CombinedAutocompleteProvider;
	#actions: PromptActionDefinition[];
	#commandMetadata = new Map<string, SlashCommandMetadata>();
	#skillCommandMetadata: SkillCommandMetadata[] = [];
	#getPromptSuggestion: (() => string | null) | undefined;

	constructor(
		commands: SlashCommand[],
		basePath: string,
		actions: PromptActionDefinition[],
		getPromptSuggestion?: () => string | null,
	) {
		this.#baseProvider = new CombinedAutocompleteProvider(commands, basePath);
		this.#actions = actions;
		for (const [index, command] of commands.entries()) {
			this.#commandMetadata.set(command.name, {
				command,
				index,
				lowerName: command.name.toLowerCase(),
				normalizedName: normalizeFuzzyText(command.name),
				normalizedDescription:
					command.description === undefined ? undefined : normalizeFuzzyText(command.description.toLowerCase()),
			});
			if (command.name.startsWith("skill:")) {
				const skillName = command.name.slice("skill:".length);
				const name = normalizeFuzzyText(command.name);
				const alias = normalizeFuzzyText(`skill-${skillName}`);
				const description = normalizeFuzzyText(command.description ?? "");
				this.#skillCommandMetadata.push({
					command,
					lowerSkillName: skillName.toLowerCase(),
					searchTargets: [name, alias, normalizeFuzzyText(skillName), description],
					collisionSearchTargets: [name, alias, description],
				});
			}
		}
		this.#getPromptSuggestion = getPromptSuggestion;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const promptActionPrefix = getPromptActionPrefix(textBeforeCursor);
		if (promptActionPrefix) {
			const query = promptActionPrefix.slice(1).toLowerCase();
			const items = this.#actions
				.map(action => {
					const searchable = [action.id, action.label, action.description, ...action.keywords]
						.join(" ")
						.toLowerCase();
					if (!autocompleteFuzzyMatch(query, searchable)) return null;
					return {
						value: action.label,
						label: action.label,
						description: action.description,
						actionId: action.id,
						execute: action.execute,
						score: autocompleteFuzzyScore(query, searchable),
					} satisfies PromptActionAutocompleteItem & { score: number };
				})
				.filter(item => item !== null)
				.sort((a, b) => b.score - a.score)
				.map(({ score: _score, ...item }) => item);
			if (items.length > 0) {
				return { items, prefix: promptActionPrefix };
			}
		}

		const rawSlashPrefix = getRawSlashTokenPrefix(textBeforeCursor);
		const slashPrefix = getSlashTokenPrefix(textBeforeCursor);
		const slashTokenInsideCode =
			rawSlashPrefix !== null &&
			(hasInlineCodeDelimiter(rawSlashPrefix) ||
				isSlashTokenInsideInlineCodeSpan(lines, cursorLine, textBeforeCursor, rawSlashPrefix));
		if (slashPrefix && !slashTokenInsideCode) {
			const baseSuggestions = withoutSkillCommandSuggestions(
				await this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol),
			);
			if (isRootPathSuggestionResult(baseSuggestions)) return baseSuggestions;
			const skillCommandSuggestions = this.#getSkillCommandSuggestions(textBeforeCursor, {
				includeEmpty: false,
			});
			return sortSlashCommandSuggestions(
				mergeAutocompleteSuggestions(baseSuggestions, skillCommandSuggestions),
				this.#commandMetadata,
			);
		}
		if (rawSlashPrefix && slashTokenInsideCode) {
			return withoutSkillCommandSuggestions(await this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol));
		}

		if (!isSettingsInitialized() || settings.get("emojiAutocomplete")) {
			const emojiSuggestions = getEmojiSuggestions(textBeforeCursor);
			if (emojiSuggestions) return emojiSuggestions;
		}

		return this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol);
	}
	getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		return this.#baseProvider.getForceFileSuggestions(lines, cursorLine, cursorCol);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	} {
		if (prefix.startsWith("#") && isPromptActionItem(item)) {
			if (item.actionId === "undo") {
				return {
					lines,
					cursorLine,
					cursorCol,
					onApplied: () => item.execute(prefix),
				};
			}
			const currentLine = lines[cursorLine] || "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = beforePrefix + afterCursor;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length,
				onApplied: () => item.execute(prefix),
			};
		}

		if (isEmojiPrefix(prefix)) {
			return applyEmojiCompletion(lines, cursorLine, cursorCol, item, prefix);
		}
		if (prefix.startsWith("/") && isSkillCommandAutocompleteItem(item)) {
			const currentLine = lines[cursorLine] || "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const separator = afterCursor.length === 0 ? " " : "";
			const newLines = [...lines];
			newLines[cursorLine] = `${beforePrefix}/${item.value}${separator}${afterCursor}`;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 1 + separator.length,
			};
		}
		return this.#baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		// An empty composer renders the pending prompt suggestion as ghost text.
		if (lines.every(line => line === "")) {
			const suggestion = this.#getPromptSuggestion?.();
			if (suggestion) return suggestion;
		}
		return this.#baseProvider.getInlineHint?.(lines, cursorLine, cursorCol) ?? null;
	}
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		const baseSuggestions = withoutSkillCommandSuggestions(
			this.#baseProvider.trySyncSlashCompletion?.(textBeforeCursor) ?? null,
		);
		const skillCommandSuggestions = this.#getSkillCommandSuggestions(textBeforeCursor, { includeEmpty: false });
		return sortSlashCommandSuggestions(
			mergeAutocompleteSuggestions(baseSuggestions, skillCommandSuggestions),
			this.#commandMetadata,
		);
	}
	trySyncInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
		if (isSettingsInitialized() && !settings.get("emojiAutocomplete")) return null;
		return tryEmojiInlineReplace(textBeforeCursor);
	}

	#getSkillCommandSuggestions(
		textBeforeCursor: string,
		options: { includeEmpty: boolean },
	): { items: AutocompleteItem[]; prefix: string } | null {
		const prefix = getSlashTokenPrefix(textBeforeCursor);
		if (!prefix) return null;
		const query = prefix.slice(1).toLowerCase();
		if (query.length === 0 && !options.includeEmpty) return null;
		const normalizedQuery = normalizeFuzzyText(
			query.startsWith("skill-") ? `skill:${query.slice("skill-".length)}` : query,
		);
		if (query.length > 0 && normalizedQuery.length === 0) return null;
		const exactNonSkillCommand = this.#commandMetadata.has(query) && !query.startsWith("skill:");
		const items = this.#skillCommandMetadata
			.map(({ command, lowerSkillName, searchTargets: allSearchTargets, collisionSearchTargets }) => {
				if (exactNonSkillCommand && query === lowerSkillName) return null;
				const searchTargets = exactNonSkillCommand ? collisionSearchTargets : allSearchTargets;
				if (
					!searchTargets.some(
						target => autocompleteFuzzyMatch(normalizedQuery, target) || target.includes(normalizedQuery),
					)
				) {
					return null;
				}
				const bestScore = Math.max(
					...searchTargets.map(target =>
						autocompleteFuzzyMatch(normalizedQuery, target)
							? autocompleteFuzzyScore(normalizedQuery, target)
							: target.includes(normalizedQuery)
								? 60
								: 0,
					),
				);
				return {
					value: command.name,
					label: command.name,
					description: command.description,
					normalizedSkillCommand: true,
					score: bestScore,
				} satisfies SkillCommandAutocompleteItem & { score: number };
			})
			.filter(item => item !== null)
			.sort((a, b) => b.score - a.score)
			.map(({ score: _score, ...item }) => item);
		if (items.length === 0) return null;
		return { items, prefix };
	}
}

export function createPromptActionAutocompleteProvider(
	options: PromptActionAutocompleteOptions,
): PromptActionAutocompleteProvider {
	const actions: PromptActionDefinition[] = [
		{
			id: "new-session",
			label: "Start new session",
			description: options.keybindings.getDisplayString("app.session.new"),
			keywords: ["new", "session", "fresh", "clear", "start", "conversation"],
			execute: options.newSession,
		},
		{
			id: "help",
			label: "Open command help",
			description: "/help",
			keywords: ["help", "commands", "command", "palette", "shortcuts", "beginner"],
			execute: options.showHelp,
		},
		{
			id: "copy-line",
			label: "Copy current line",
			description: options.keybindings.getDisplayString("app.clipboard.copyLine"),
			keywords: ["copy", "line", "clipboard", "current"],
			execute: options.copyCurrentLine,
		},
		{
			id: "copy-prompt",
			label: "Copy whole prompt",
			description: options.keybindings.getDisplayString("app.clipboard.copyPrompt"),
			keywords: ["copy", "prompt", "clipboard", "message"],
			execute: options.copyPrompt,
		},
		{
			id: "paste-image",
			label: "Paste image from clipboard",
			description: options.keybindings.getDisplayString("app.clipboard.pasteImage"),
			keywords: ["paste", "image", "clipboard", "screenshot", "attach", "vision"],
			execute: options.pasteImage,
		},
		{
			id: "paste-text",
			label: "Paste text from configured clipboard",
			description: "requires --clipboard-transport ssh",
			keywords: ["paste", "text", "clipboard", "ssh", "pbpaste", "mac"],
			execute: options.pasteText,
		},
		{
			id: "tmux-previous-user-input",
			label: "Scroll to previous user input",
			description: "tmux copy-mode",
			keywords: ["scroll", "tmux", "previous", "user", "input", "prompt", "history"],
			execute: options.scrollTmuxToPreviousUserInput,
		},
		{
			id: "undo",
			label: "Undo",
			description: options.keybindings.getDisplayString("tui.editor.undo"),
			keywords: ["undo", "revert", "edit", "history"],
			execute: options.undo,
		},
		{
			id: "cursor-message-end",
			label: "Move cursor to end of message",
			description: "Current message",
			keywords: ["move", "cursor", "message", "end", "prompt", "last", "bottom"],
			execute: options.moveCursorToMessageEnd,
		},
		{
			id: "cursor-message-start",
			label: "Move cursor to beginning of message",
			description: "Current message",
			keywords: ["move", "cursor", "message", "start", "beginning", "prompt", "first", "top"],
			execute: options.moveCursorToMessageStart,
		},
		{
			id: "cursor-line-start",
			label: "Move cursor to beginning of line",
			description: options.keybindings.getDisplayString("tui.editor.cursorLineStart"),
			keywords: ["move", "cursor", "line", "start", "beginning", "home"],
			execute: options.moveCursorToLineStart,
		},
		{
			id: "cursor-line-end",
			label: "Move cursor to end of line",
			description: options.keybindings.getDisplayString("tui.editor.cursorLineEnd"),
			keywords: ["move", "cursor", "line", "end"],
			execute: options.moveCursorToLineEnd,
		},
	];

	return new PromptActionAutocompleteProvider(
		options.commands,
		options.basePath,
		actions,
		options.getPromptSuggestion,
	);
}
