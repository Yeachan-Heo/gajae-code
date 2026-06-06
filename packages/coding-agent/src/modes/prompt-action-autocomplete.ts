import type { AutocompleteItem, AutocompleteProvider, SlashCommand } from "@gajae-code/tui";
import { CombinedAutocompleteProvider, getKeybindings, getSlashCommandMatchRank } from "@gajae-code/tui";
import type { KeybindingsManager } from "../config/keybindings";
import { formatKeyHints } from "../config/keybindings";
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
	undo: (prefix: string) => void;
	moveCursorToMessageEnd: () => void;
	moveCursorToMessageStart: () => void;
	moveCursorToLineStart: () => void;
	moveCursorToLineEnd: () => void;
}

function fuzzyMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	if (query.length > target.length) return false;

	let queryIndex = 0;
	for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
		if (query[queryIndex] === target[targetIndex]) {
			queryIndex += 1;
		}
	}

	return queryIndex === query.length;
}

function fuzzyScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (target === query) return 100;
	if (target.startsWith(query)) return 80;
	if (target.includes(query)) return 60;

	let queryIndex = 0;
	let gaps = 0;
	let lastMatchIndex = -1;
	for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
		if (query[queryIndex] === target[targetIndex]) {
			if (lastMatchIndex >= 0 && targetIndex - lastMatchIndex > 1) {
				gaps += 1;
			}
			lastMatchIndex = targetIndex;
			queryIndex += 1;
		}
	}

	if (queryIndex !== query.length) return 0;
	return Math.max(1, 40 - gaps * 5);
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

function sortSlashCommandSuggestions(
	suggestions: { items: AutocompleteItem[]; prefix: string } | null,
	commands: SlashCommand[],
): { items: AutocompleteItem[]; prefix: string } | null {
	if (!suggestions) return null;
	const query = suggestions.prefix.slice(1).toLowerCase();
	const commandIndexes = new Map(commands.map((command, index) => [command.name, index]));
	const commandByName = new Map(commands.map(command => [command.name, command]));
	const items = suggestions.items
		.map((item, index) => {
			const command = commandByName.get(item.value);
			const commandIndex = commandIndexes.get(item.value) ?? index;
			const lowerName = item.value.toLowerCase();
			const lowerDesc = command?.description?.toLowerCase() ?? item.description?.toLowerCase() ?? "";
			const nameScore = fuzzyMatch(query, lowerName) ? fuzzyScore(query, lowerName) : 0;
			const descScore = fuzzyMatch(query, lowerDesc) ? fuzzyScore(query, lowerDesc) * 0.5 : 0;
			return {
				item,
				index,
				commandIndex,
				matchRank: getSlashCommandMatchRank(query, lowerName),
				priority: command?.priority ?? 0,
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

function withoutSkillCommandSuggestions(
	suggestions: { items: AutocompleteItem[]; prefix: string } | null,
): { items: AutocompleteItem[]; prefix: string } | null {
	if (!suggestions) return null;
	const items = suggestions.items.filter(item => !item.value.startsWith("skill:"));
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
	const slashIndex = textBeforeCursor.lastIndexOf("/");
	if (slashIndex === -1) return null;
	const beforeSlash = textBeforeCursor.slice(0, slashIndex);
	if (beforeSlash && !/\s$/.test(beforeSlash)) return null;
	const token = textBeforeCursor.slice(slashIndex);
	if (/[\s]/.test(token)) return null;
	return token;
}

export class PromptActionAutocompleteProvider implements AutocompleteProvider {
	#baseProvider: CombinedAutocompleteProvider;
	#actions: PromptActionDefinition[];
	#commands: SlashCommand[];

	constructor(commands: SlashCommand[], basePath: string, actions: PromptActionDefinition[]) {
		this.#baseProvider = new CombinedAutocompleteProvider(commands, basePath);
		this.#actions = actions;
		this.#commands = commands;
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
					const searchable = [action.label, action.description, ...action.keywords].join(" ").toLowerCase();
					if (!fuzzyMatch(query, searchable)) return null;
					return {
						value: action.label,
						label: action.label,
						description: action.description,
						actionId: action.id,
						execute: action.execute,
						score: fuzzyScore(query, searchable),
					} satisfies PromptActionAutocompleteItem & { score: number };
				})
				.filter(item => item !== null)
				.sort((a, b) => b.score - a.score)
				.map(({ score: _score, ...item }) => item);
			if (items.length > 0) {
				return { items, prefix: promptActionPrefix };
			}
		}

		const slashPrefix = getSlashTokenPrefix(textBeforeCursor);
		if (slashPrefix) {
			const baseSuggestions = withoutSkillCommandSuggestions(
				await this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol),
			);
			const skillCommandSuggestions = this.#getSkillCommandSuggestions(textBeforeCursor);
			return sortSlashCommandSuggestions(
				mergeAutocompleteSuggestions(baseSuggestions, skillCommandSuggestions),
				this.#commands,
			);
		}

		if (!isSettingsInitialized() || settings.get("emojiAutocomplete")) {
			const emojiSuggestions = getEmojiSuggestions(textBeforeCursor);
			if (emojiSuggestions) return emojiSuggestions;
		}

		return this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol);
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
			const newLines = [...lines];
			newLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2,
			};
		}
		return this.#baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		return this.#baseProvider.getInlineHint?.(lines, cursorLine, cursorCol) ?? null;
	}
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		const baseSuggestions = withoutSkillCommandSuggestions(
			this.#baseProvider.trySyncSlashCompletion?.(textBeforeCursor) ?? null,
		);
		const skillCommandSuggestions = this.#getSkillCommandSuggestions(textBeforeCursor);
		return sortSlashCommandSuggestions(
			mergeAutocompleteSuggestions(baseSuggestions, skillCommandSuggestions),
			this.#commands,
		);
	}
	trySyncInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
		if (isSettingsInitialized() && !settings.get("emojiAutocomplete")) return null;
		return tryEmojiInlineReplace(textBeforeCursor);
	}

	#getSkillCommandSuggestions(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		const prefix = getSlashTokenPrefix(textBeforeCursor);
		if (!prefix) return null;
		const query = prefix.slice(1).toLowerCase();
		if (query.length === 0) return null;
		const normalizedQuery = query.startsWith("skill-") ? `skill:${query.slice("skill-".length)}` : query;
		const exactNonSkillCommand = this.#commands.some(
			command => command.name === query && !command.name.startsWith("skill:"),
		);
		const items = this.#commands
			.filter(command => command.name.startsWith("skill:"))
			.map(command => {
				const skillName = command.name.slice("skill:".length);
				if (exactNonSkillCommand && query === skillName.toLowerCase()) return null;
				const searchTargets = [
					command.name,
					`skill-${skillName}`,
					...(exactNonSkillCommand ? [] : [skillName]),
					command.description ?? "",
				].map(target => target.toLowerCase());
				if (
					!searchTargets.some(target => fuzzyMatch(normalizedQuery, target) || target.includes(normalizedQuery))
				) {
					return null;
				}
				const bestScore = Math.max(
					...searchTargets.map(target =>
						fuzzyMatch(normalizedQuery, target)
							? fuzzyScore(normalizedQuery, target)
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
	const editorKeybindings = getKeybindings();
	const actions: PromptActionDefinition[] = [
		{
			id: "copy-line",
			label: "Copy current line",
			description: formatKeyHints(options.keybindings.getKeys("app.clipboard.copyLine")),
			keywords: ["copy", "line", "clipboard", "current"],
			execute: options.copyCurrentLine,
		},
		{
			id: "copy-prompt",
			label: "Copy whole prompt",
			description: formatKeyHints(options.keybindings.getKeys("app.clipboard.copyPrompt")),
			keywords: ["copy", "prompt", "clipboard", "message"],
			execute: options.copyPrompt,
		},
		{
			id: "undo",
			label: "Undo",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.undo")),
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
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.cursorLineStart")),
			keywords: ["move", "cursor", "line", "start", "beginning", "home"],
			execute: options.moveCursorToLineStart,
		},
		{
			id: "cursor-line-end",
			label: "Move cursor to end of line",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.cursorLineEnd")),
			keywords: ["move", "cursor", "line", "end"],
			execute: options.moveCursorToLineEnd,
		},
	];

	return new PromptActionAutocompleteProvider(options.commands, options.basePath, actions);
}
