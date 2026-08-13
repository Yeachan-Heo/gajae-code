/** Canonical todo_write raw-argument contract.
 *
 * Kept dependency-light so both the eager TodoWriteTool and the cold descriptor
 * registry reject and accept exactly the same payloads. Two independent copies
 * of these rules previously drifted: the deferred copy dropped the `content`
 * synonym, the `complete`/`completed` operation aliases, and every rejection
 * code, so a payload that the loaded tool accepted was rejected before the
 * tool ever loaded, with no correction hint to recover from.
 */
import { INTENT_FIELD } from "@gajae-code/agent-core";
import type { RawArgumentRejectionDetail, RawArgumentValidationResult } from "@gajae-code/ai/types";

/**
 * Models reliably reach for `complete`/`completed` because the status an op
 * sets is spelled `completed` (see TodoStatus). Accepting them as exact
 * aliases of `done` removes a repeated hard tool failure without widening the
 * operation vocabulary.
 */
export const TODO_DONE_ALIASES = ["complete", "completed"] as const;

export function isDoneAlias(value: string): boolean {
	return (TODO_DONE_ALIASES as readonly string[]).includes(value);
}

/**
 * Legal `op` values. Exported so the todo_write schema and this contract read
 * from one list: a rejection that names a vocabulary the schema no longer
 * accepts is exactly the drift this file exists to prevent.
 */
export const TODO_OPS = ["init", "start", "done", "rm", "drop", "append", "note"] as const;

function isKnownOp(value: string): boolean {
	return (TODO_OPS as readonly string[]).includes(value);
}

/**
 * The whole vocabulary, not a guess at which entry the caller meant. Static
 * text, so clamping a rejection detail can never truncate it away.
 */
const TODO_OP_VOCABULARY_HINT = `op must be one of: ${TODO_OPS.join(", ")}`;

/**
 * `_i` is the intent field injected into tool schemas by the agent loop. The
 * loop strips it before validation, but replayed, bridged, and directly
 * validated calls can still carry it, and rejecting it here would fail a call
 * whose only fault is the harness's own field.
 */
const TODO_WRITE_KEYS = new Set(["ops", INTENT_FIELD]);
const TODO_OP_KEYS = new Set(["op", "list", "task", "phase", "items", "text"]);
const TODO_INIT_ENTRY_KEYS = new Set(["phase", "items"]);
/** `content` is accepted only as a synonym the schema rewrites to `task`. */
const TODO_OP_KEYS_WITH_ALIASES = new Set([...TODO_OP_KEYS, "content"]);
const MAX_REJECTED_KEYS = 8;
const POSITIONAL_HANDLE_KEYS = new Set(["id", "ids", "index", "taskId", "task_id"]);

/**
 * Exact key corrections. `note` is the one repeatable confusion: it is an `op`
 * value, and the body of a note op goes in `text`, so a caller who wrote
 * `note: "..."` on an entry can be told exactly which fields a note op takes.
 * The correction names both required fields rather than a literal rewrite,
 * because a rewrite that omits `task` is rejected again on the retry. Only add
 * an entry here when the replacement is unambiguous — never from fuzzy or
 * edit-distance matching, because a wrong suggestion costs more turns than no
 * suggestion.
 *
 * The positional-handle family (`id`, `index`, and spellings of them) is the
 * other repeatable confusion: the tool result renders tasks as a list, so a
 * caller assumes the list is addressable by ordinal. No op has ever taken a
 * handle - a task is addressed by its verbatim content - and the executor
 * already says so, but on the validated model-facing path this validator
 * rejects the key first, so that message never gets its turn. One shared
 * correction keeps both layers telling the same story.
 */
const POSITIONAL_HANDLE_CORRECTION =
	'tasks have no id or index; target a task with "task" set to its exact content, or a whole phase with "phase"';

const TODO_KEY_CORRECTIONS = new Map<string, string>([
	["note", 'note is an op, not a key; note operations require both "task" and "text"'],
	["newTask", "there is no rename op; re-run init with the corrected list to rename a task"],
	["tasks", 'tasks is not a key; append operations take "items"'],
	["id", POSITIONAL_HANDLE_CORRECTION],
	["ids", POSITIONAL_HANDLE_CORRECTION],
	["index", POSITIONAL_HANDLE_CORRECTION],
	["taskId", POSITIONAL_HANDLE_CORRECTION],
	["task_id", POSITIONAL_HANDLE_CORRECTION],
]);

function unknownKeys(value: object, allowed: Set<string>): string[] {
	return Object.keys(value).filter(key => !allowed.has(key));
}

function keyRejectionDetail(keys: readonly string[], location?: string): RawArgumentRejectionDetail {
	const rejectedKeys = keys.slice(0, MAX_REJECTED_KEYS);
	// Distinct corrections only. A family that shares one correction (every
	// positional handle) would otherwise repeat it once per rejected key and blow
	// past the caller's hint clamp, which truncates the advice mid-sentence.
	const hints = [
		...new Set(
			keys
				.map(key => TODO_KEY_CORRECTIONS.get(key) ?? TODO_KEY_CORRECTIONS.get(key.split(".").at(-1) ?? ""))
				.filter((hint): hint is string => hint !== undefined),
		),
	];
	const omitted = keys.length - rejectedKeys.length;
	const parts = [
		...(location === undefined ? [] : [location]),
		...hints,
		...(omitted > 0 ? [`${omitted} additional rejected keys omitted`] : []),
	];
	return parts.length > 0 ? { rejectedKeys, hint: parts.join("; ") } : { rejectedKeys };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedPositionalHandleKeys(entry: Record<string, unknown>): string[] {
	const keys: string[] = [];
	for (const alias of ["task", "content"] as const) {
		const value = entry[alias];
		if (!isPlainRecord(value)) continue;
		for (const key of Object.keys(value)) {
			if (POSITIONAL_HANDLE_KEYS.has(key)) keys.push(`${alias}.${key}`);
		}
	}
	return keys;
}

/**
 * Single source of truth for todo_write pre-coercion validation. Every
 * rejection carries a code so the caller can surface an actionable correction
 * instead of a bare "raw arguments rejected" message, and every entry-level
 * rejection names the failing `ops` index. Rejection stays batch-atomic, but a
 * caller told which entry failed can resubmit the rest instead of rebuilding
 * the payload from memory — or, as observed, silently abandoning the list.
 */
export function validateRawTodoArguments(arguments_: Record<string, unknown>): RawArgumentValidationResult {
	const unknownRootKeys = unknownKeys(arguments_, TODO_WRITE_KEYS);
	if (unknownRootKeys.length > 0)
		return { outcome: "reject", code: "todo-write-unknown-root-key", detail: keyRejectionDetail(unknownRootKeys) };
	if (!Array.isArray(arguments_.ops)) return { outcome: "passthrough" };
	const ops: readonly unknown[] = arguments_.ops;
	for (const [index, entry] of ops.entries()) {
		if (!isPlainRecord(entry)) continue;
		const location = `ops[${index}]`;
		// The op value is checked before the entry keys. An entry that invents
		// both an op and a key is an unknown-op problem, and reporting the key
		// first tells the caller which keys are legal while leaving it to guess
		// that the operation it reached for does not exist at all.
		const rawOp = entry.op;
		const op = typeof rawOp === "string" && isDoneAlias(rawOp) ? "done" : rawOp;
		if (typeof op === "string" && !isKnownOp(op))
			return {
				outcome: "reject",
				code: "todo-write-unknown-op-value",
				detail: { rejectedKeys: [op], hint: `${location}; ${TODO_OP_VOCABULARY_HINT}` },
			};
		// `content` is normalized to `task` by the schema preprocessor, so it must
		// not be rejected here as an unknown key first.
		const unknownEntryKeys = unknownKeys(entry, TODO_OP_KEYS_WITH_ALIASES);
		if (unknownEntryKeys.length > 0)
			return {
				outcome: "reject",
				code: "todo-write-unknown-op-entry-key",
				detail: keyRejectionDetail(unknownEntryKeys, location),
			};
		const nestedHandles = nestedPositionalHandleKeys(entry);
		if (nestedHandles.length > 0)
			return {
				outcome: "reject",
				code: "todo-write-unknown-op-entry-key",
				detail: keyRejectionDetail(nestedHandles, location),
			};
		const target = entry.task ?? entry.content;
		if ((op === "done" || op === "drop") && !target && !entry.phase) {
			return { outcome: "reject", code: "todo-write-done-drop-requires-target", detail: { hint: location } };
		}
		const list = entry.list;
		if (!Array.isArray(list)) continue;
		const items: readonly unknown[] = list;
		for (const [itemIndex, item] of items.entries()) {
			if (!isPlainRecord(item)) continue;
			const unknownItemKeys = unknownKeys(item, TODO_INIT_ENTRY_KEYS);
			if (unknownItemKeys.length > 0)
				return {
					outcome: "reject",
					code: "todo-write-unknown-init-entry-key",
					detail: keyRejectionDetail(unknownItemKeys, `${location}.list[${itemIndex}]`),
				};
		}
	}
	return { outcome: "passthrough" };
}
