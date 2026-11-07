import type { SessionEntry, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { DesktopMessageRevision } from "./protocol";

const isUserPrompt = (entry: SessionEntry | undefined): boolean =>
	entry?.type === "message" && entry.message.role === "user";

/**
 * Entries that are part of the conversation itself. Everything else (state diffs, model or
 * mode changes, labels, ...) is bookkeeping the SDK may append before a prompt, so it must
 * not separate an edited prompt from the prompt it replaces.
 */
const isConversation = (entry: SessionEntry): boolean =>
	entry.type === "message" ||
	entry.type === "custom_message" ||
	entry.type === "compaction" ||
	entry.type === "branch_summary";

/** Oldest first by timestamp, keeping the given order for ties or unreadable timestamps. */
function oldestFirst(entries: SessionEntry[]): SessionEntry[] {
	return entries
		.map((entry, order) => ({ entry, order, time: Date.parse(entry.timestamp) }))
		.sort((left, right) => {
			const elapsed = left.time - right.time;
			return (Number.isNaN(elapsed) ? 0 : elapsed) || left.order - right.order;
		})
		.map(item => item.entry);
}

/** Direct children oldest first; the cold child index does not promise append order. */
function childrenOf(manager: SessionManager, parentId: string | null): SessionEntry[] {
	return oldestFirst(parentId === null ? manager.getTree().map(node => node.entry) : manager.getChildren(parentId));
}

/**
 * Sibling prompt revisions of the TUI `/tree` model: editing a prompt rewinds to its
 * parent and appends a new user entry there (after any SDK bookkeeping entries), so the
 * revisions of a prompt are the answered prompts that follow the same conversation entry.
 * The tree is append-only and every append moves the leaf, so cached revisions stay
 * exact until a leaf change adds a prompt or a prompt's first answer.
 */
export class PromptRevisions {
	#manager: SessionManager | undefined;
	#leafId: string | null | undefined;
	#revisions = new Map<string, DesktopMessageRevision | null>();
	/** Last leaf shown under each prompt, so returning to a revision restores where it was left. */
	#leaves = new Map<string, string>();

	revision(manager: SessionManager, entryId: string): DesktopMessageRevision | undefined {
		this.#sync(manager);
		const leafId = manager.getLeafId();
		if (leafId !== this.#leafId) {
			if (!this.#appendedAnswersOnly(manager, this.#leafId, leafId)) this.#revisions.clear();
			this.#leafId = leafId;
		}
		const cached = this.#revisions.get(entryId);
		if (cached !== undefined) return cached ?? undefined;
		const revision = this.#compute(manager, entryId);
		this.#revisions.set(entryId, revision ?? null);
		return revision;
	}

	/** Records the current leaf for every prompt on the active branch before leaving it. */
	remember(manager: SessionManager, promptEntryIds: readonly string[]): void {
		this.#sync(manager);
		const leafId = manager.getLeafId();
		if (!leafId) return;
		for (const entryId of promptEntryIds) this.#leaves.set(entryId, leafId);
	}

	/** The leaf to show for a prompt revision: where it was left, else its newest continuation. */
	target(manager: SessionManager, entryId: string): string {
		this.#sync(manager);
		const remembered = this.#leaves.get(entryId);
		if (remembered && manager.getEntry(remembered)) return remembered;
		const visited = new Set<string>();
		let current = entryId;
		while (!visited.has(current)) {
			visited.add(current);
			const next = childrenOf(manager, current).at(-1);
			if (!next) break;
			current = next.id;
		}
		return current;
	}

	#sync(manager: SessionManager): void {
		if (manager === this.#manager) return;
		this.#manager = manager;
		this.#leafId = undefined;
		this.#revisions.clear();
		this.#leaves.clear();
	}

	/**
	 * True when the leaf only advanced by appending non-prompt entries below a non-prompt,
	 * which cannot change any prompt's revisions or answered state. A leaf that was a prompt
	 * and gained its first answer changes that prompt's answered state, so it is checked
	 * before reaching `from`. Anything else, such as a tree navigation, is structural.
	 */
	#appendedAnswersOnly(manager: SessionManager, from: string | null | undefined, to: string | null): boolean {
		if (!from || !to) return false;
		let current: string | null = to;
		for (let steps = 0; current && steps < 64; steps++) {
			const entry = manager.getEntry(current);
			if (!entry || isUserPrompt(entry)) return false;
			if (current === from) return true;
			current = entry.parentId;
		}
		return false;
	}

	#compute(manager: SessionManager, entryId: string): DesktopMessageRevision | undefined {
		const entry = manager.getEntry(entryId);
		if (!entry || !isUserPrompt(entry)) return undefined;
		const revisions = this.#promptsAfter(manager, this.#anchor(manager, entry)).filter(
			// An unanswered prompt has nothing to show: navigating to it would land on its parent.
			prompt => prompt.id === entryId || manager.getChildren(prompt.id).length > 0,
		);
		const index = revisions.findIndex(prompt => prompt.id === entryId);
		if (index < 0 || revisions.length < 2) return undefined;
		return {
			index,
			count: revisions.length,
			...(index > 0 ? { previous: revisions[index - 1]!.id } : {}),
			...(index < revisions.length - 1 ? { next: revisions[index + 1]!.id } : {}),
		};
	}

	/** The nearest conversation entry above a prompt, skipping bookkeeping; null at the root. */
	#anchor(manager: SessionManager, entry: SessionEntry): string | null {
		let parentId = entry.parentId;
		while (parentId) {
			const parent = manager.getEntry(parentId);
			if (!parent || isConversation(parent)) return parentId;
			parentId = parent.parentId;
		}
		return null;
	}

	/** Prompts reached from an anchor through bookkeeping entries only, oldest first. */
	#promptsAfter(manager: SessionManager, anchorId: string | null): SessionEntry[] {
		const prompts: SessionEntry[] = [];
		const pending = childrenOf(manager, anchorId);
		for (let i = 0; i < pending.length; i++) {
			const entry = pending[i]!;
			if (isUserPrompt(entry)) prompts.push(entry);
			else if (!isConversation(entry)) pending.push(...childrenOf(manager, entry.id));
		}
		return oldestFirst(prompts);
	}
}
