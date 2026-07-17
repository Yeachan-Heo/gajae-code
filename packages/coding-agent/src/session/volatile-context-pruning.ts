import type { CustomMessageEntry, SessionEntry } from "./session-manager";

const SUPERSEDED_VOLATILE_CONTEXT_NOTICE = "[superseded volatile context pruned]";

/**
 * Custom messages whose producer maintains one current singleton state:
 * - todo-write-error-reminder: a later todo-write failure replaces the prior warning.
 * - resolve-reminder: only the currently pending resolve preview can be applied.
 * - eager-todo-prelude: the newest todo prelude reflects the current task state.
 */
const SUPERSEDED_SINGLETON_REMINDER_TYPES = new Set([
	"todo-write-error-reminder",
	"resolve-reminder",
	"eager-todo-prelude",
]);

/**
 * Volatile context is refreshed for every prompt. Only its newest copy is useful;
 * replacing older copies at a maintenance boundary preserves the audit trail
 * without repeatedly charging the model for stale workspace snapshots.
 */
export function pruneSupersededVolatileProjectContext(entries: readonly SessionEntry[]): {
	changed: CustomMessageEntry[];
	bytesSaved: number;
} {
	let latest = -1;
	entries.forEach((entry, index) => {
		if (entry.type === "custom_message" && entry.customType === "volatile-project-context") latest = index;
	});
	if (latest < 0) return { changed: [], bytesSaved: 0 };

	const changed: CustomMessageEntry[] = [];
	let bytesSaved = 0;
	entries.forEach((entry, index) => {
		if (index >= latest || entry.type !== "custom_message" || entry.customType !== "volatile-project-context") return;
		const content =
			typeof entry.content === "string"
				? entry.content
				: entry.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		if (!content) return;
		entry.content = SUPERSEDED_VOLATILE_CONTEXT_NOTICE;
		bytesSaved += Buffer.byteLength(content, "utf-8");
		changed.push(entry as CustomMessageEntry);
	});
	return { changed, bytesSaved };
}

/** Retire superseded known singleton maintenance reminders without touching ordinary user context. */
export function pruneSupersededMaintenanceReminders(entries: readonly SessionEntry[]): {
	changed: CustomMessageEntry[];
	bytesSaved: number;
} {
	const latest = new Map<string, number>();
	entries.forEach((entry, index) => {
		if (entry.type === "custom_message" && SUPERSEDED_SINGLETON_REMINDER_TYPES.has(entry.customType)) {
			latest.set(entry.customType, index);
		}
	});
	const changed: CustomMessageEntry[] = [];
	let bytesSaved = 0;
	entries.forEach((entry, index) => {
		if (
			entry.type !== "custom_message" ||
			latest.get(entry.customType) === undefined ||
			latest.get(entry.customType) === index
		)
			return;
		const text =
			typeof entry.content === "string"
				? entry.content
				: entry.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		if (!text) return;
		entry.content = SUPERSEDED_VOLATILE_CONTEXT_NOTICE;
		bytesSaved += Buffer.byteLength(text, "utf-8");
		changed.push(entry);
	});
	return { changed, bytesSaved };
}
