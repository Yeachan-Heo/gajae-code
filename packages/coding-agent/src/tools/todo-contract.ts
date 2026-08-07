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
import type { RawArgumentValidationResult } from "@gajae-code/ai/types";

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

function hasUnknownKeys(value: object, allowed: Set<string>): boolean {
	return Object.keys(value).some(key => !allowed.has(key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Single source of truth for todo_write pre-coercion validation. Every
 * rejection carries a code so the caller can surface an actionable correction
 * instead of a bare "raw arguments rejected" message.
 */
export function validateRawTodoArguments(arguments_: Record<string, unknown>): RawArgumentValidationResult {
	if (hasUnknownKeys(arguments_, TODO_WRITE_KEYS)) return { outcome: "reject", code: "todo-write-unknown-root-key" };
	if (!Array.isArray(arguments_.ops)) return { outcome: "passthrough" };
	for (const entry of arguments_.ops) {
		if (!isPlainRecord(entry)) continue;
		// `content` is normalized to `task` by the schema preprocessor, so it must
		// not be rejected here as an unknown key first.
		if (hasUnknownKeys(entry, TODO_OP_KEYS_WITH_ALIASES))
			return { outcome: "reject", code: "todo-write-unknown-op-entry-key" };
		const op = typeof entry.op === "string" && isDoneAlias(entry.op) ? "done" : entry.op;
		const target = entry.task ?? entry.content;
		if ((op === "done" || op === "drop") && !target && !entry.phase) {
			return { outcome: "reject", code: "todo-write-done-drop-requires-target" };
		}
		const list = entry.list;
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (isPlainRecord(item) && hasUnknownKeys(item, TODO_INIT_ENTRY_KEYS))
				return { outcome: "reject", code: "todo-write-unknown-init-entry-key" };
		}
	}
	return { outcome: "passthrough" };
}
