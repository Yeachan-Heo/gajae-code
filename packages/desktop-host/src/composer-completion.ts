import { DEFAULT_GJC_DEFINITION_NAMES } from "@gajae-code/coding-agent/defaults/gjc-defaults";
import { resolveSkillSlashCommands } from "@gajae-code/coding-agent/extensibility/skills";
import {
	BUILTIN_SLASH_COMMANDS,
	type FileSlashCommand,
	loadSlashCommands,
} from "@gajae-code/coding-agent/extensibility/slash-commands";
import { PromptActionAutocompleteProvider } from "@gajae-code/coding-agent/modes/prompt-action-autocomplete";
import { shouldShowExtensionCommand } from "@gajae-code/coding-agent/modes/slash-command-visibility";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { extractSlashCommandTokenPrefix, type SlashCommand } from "@gajae-code/tui";
import { sanitizeDisplayLine } from "@gajae-code/utils";
import { type DesktopCompletionResult, MAX_FRAME_BYTES } from "./protocol";

type CompletionSession = Pick<
	AgentSession,
	"skills" | "settings" | "model" | "extensionRunner" | "customCommands" | "setSlashCommands"
>;

const TEXT_LIMIT = 32_000;
const STALE = "Session changed while completing the draft. Select the conversation again.";
export const MANAGED_COMMANDS_UNAVAILABLE =
	"Slash completion is unavailable: the SDK owner does not expose its command catalog. Use its original control surface.";

export interface DesktopCompletionInput {
	text: string;
	cursor: number;
	sessionGeneration: number;
}

export function readDesktopCompletionInput(params: Record<string, unknown>): DesktopCompletionInput {
	if (Object.keys(params).some(key => !["sessionId", "sessionGeneration", "text", "cursor"].includes(key)))
		throw new Error("Invalid completion parameters");
	const { text, cursor, sessionGeneration } = params;
	if (typeof text !== "string" || text.length > TEXT_LIMIT || text.includes("\0"))
		throw new Error("Invalid completion text");
	if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length)
		throw new Error("Invalid completion cursor");
	if (
		cursor > 0 &&
		cursor < text.length &&
		/[\uD800-\uDBFF]/.test(text[cursor - 1]!) &&
		/[\uDC00-\uDFFF]/.test(text[cursor]!)
	)
		throw new Error("Invalid completion cursor");
	if (typeof sessionGeneration !== "number" || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0)
		throw new Error("Invalid completion session generation");
	return { text, cursor, sessionGeneration };
}

/** This is only an admission filter; token extraction and every replacement belong to the TUI provider. */
export function desktopCompletionTrigger(text: string, cursor: number): "file" | "slash" | undefined {
	const before = text.slice(0, cursor);
	const line = before.slice(before.lastIndexOf("\n") + 1);
	if (/(?:^|[\s"'=])@(?:[^\s"]*|"[^"]*)$/.test(line)) return "file";
	if (extractSlashCommandTokenPrefix(line) || /^\s*\/[^\s/]+[ \t][^\n]*$/.test(before)) return "slash";
	return undefined;
}

function assertCurrent(isCurrent: () => boolean): void {
	if (!isCurrent()) throw new Error(STALE);
}

/** A single owned identity/cwd/generation. Failed discovery can retry; retired discoveries never register. */
export class DesktopComposerCompletion {
	#files?: Promise<FileSlashCommand[]>;

	constructor(
		readonly session: CompletionSession,
		readonly cwd: string,
		readonly builtins: readonly SlashCommand[],
		readonly isCurrent: () => boolean,
	) {}

	async initialize(): Promise<FileSlashCommand[]> {
		assertCurrent(this.isCurrent);
		if (!this.#files) {
			const pending = loadSlashCommands({ cwd: this.cwd }).then(commands => {
				assertCurrent(this.isCurrent);
				this.session.setSlashCommands(commands);
				return commands;
			});
			this.#files = pending;
			void pending.catch(() => {
				if (this.#files === pending) this.#files = undefined;
			});
		}
		const commands = await this.#files;
		assertCurrent(this.isCurrent);
		return commands;
	}

	async complete(text: string, cursor: number): Promise<DesktopCompletionResult> {
		assertCurrent(this.isCurrent);
		const trigger = desktopCompletionTrigger(text, cursor);
		if (!trigger) return { items: [] };
		// File mentions do not require slash discovery or mutate the command registry.
		const commands = trigger === "slash" ? this.#catalog(await this.initialize()) : [];
		return completeDesktopDraft(text, cursor, this.cwd, commands, this.isCurrent);
	}

	#catalog(files: FileSlashCommand[]): SlashCommand[] {
		const reserved = new Set(BUILTIN_SLASH_COMMANDS.map(command => command.name));
		reserved.add("btw");
		const hooks = (this.session.extensionRunner?.getRegisteredCommands(reserved) ?? [])
			.filter(command => shouldShowExtensionCommand(command.name, this.session.model?.provider))
			.map(command => ({
				name: command.name,
				description: command.description ?? "(hook command)",
				getArgumentCompletions: command.getArgumentCompletions,
			}));
		const custom = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
		}));
		const direct: SlashCommand[] = [...this.builtins];
		const claimed = new Set(direct.map(command => command.name));
		for (const command of [...hooks, ...custom, ...files]) {
			// Builtins dispatch before SDK prompt expansion. Never advertise a shadow that cannot execute.
			if (reserved.has(command.name) || claimed.has(command.name)) continue;
			claimed.add(command.name);
			direct.push(command);
		}
		const defaults = new Set<string>(DEFAULT_GJC_DEFINITION_NAMES);
		const skills = this.session.settings.get("skills.enableSkillCommands")
			? resolveSkillSlashCommands(this.session.skills, new Set([...reserved, ...claimed])).map(command => ({
					name: command.name,
					description: command.description,
					...(defaults.has(command.skill.name) ? { priority: 100 } : {}),
				}))
			: [];
		return [...direct, ...skills];
	}
}

export async function completeDesktopDraft(
	text: string,
	cursor: number,
	cwd: string,
	commands: SlashCommand[],
	isCurrent: () => boolean,
): Promise<DesktopCompletionResult> {
	assertCurrent(isCurrent);
	if (!desktopCompletionTrigger(text, cursor)) return { items: [] };
	const lines = text.split("\n");
	const preceding = text.slice(0, cursor).split("\n");
	const cursorLine = preceding.length - 1;
	const cursorCol = preceding[cursorLine]!.length;
	const provider = new PromptActionAutocompleteProvider(commands, cwd, []);
	const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol);
	assertCurrent(isCurrent);
	const result: DesktopCompletionResult = { items: [] };
	let bytes = 1024; // Reserve the response envelope and JSON framing.
	for (const item of suggestions?.items ?? []) {
		if (result.items.length === 100) break;
		const applied = provider.applyCompletion(lines, cursorLine, cursorCol, item, suggestions!.prefix);
		const replacement = applied.lines.join("\n");
		const offset =
			applied.lines.slice(0, applied.cursorLine).reduce((sum, line) => sum + line.length + 1, 0) + applied.cursorCol;
		// Omit oversized insertions, never truncate an executable value or whole-draft replacement.
		if (replacement.length > TEXT_LIMIT || item.value.length > TEXT_LIMIT || applied.onApplied) continue;
		const completion = {
			value: item.value,
			label: sanitizeDisplayLine(item.label).slice(0, 256),
			...(item.description ? { description: sanitizeDisplayLine(item.description).slice(0, 1024) } : {}),
			text: replacement,
			cursor: offset,
		};
		const size = new TextEncoder().encode(JSON.stringify(completion)).byteLength + 1;
		if (bytes + size > MAX_FRAME_BYTES) break;
		bytes += size;
		result.items.push(completion);
	}
	assertCurrent(isCurrent);
	return result;
}
