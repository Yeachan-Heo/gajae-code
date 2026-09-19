/**
 * In-memory generation lease for asynchronous session-title regeneration.
 *
 * The lease is keyed by the session manager instance so TUI and ACP command
 * dispatchers share the same ordering state without adding protocol fields to
 * the persisted session format.
 */
const generations = new WeakMap<object, number>();

function currentGeneration(owner: object): number {
	return generations.get(owner) ?? 0;
}

/** Start a new regeneration and invalidate every older completion. */
export function beginSessionTitleGeneration(owner: object): number {
	const generation = currentGeneration(owner) + 1;
	generations.set(owner, generation);
	return generation;
}

/** Invalidate pending regeneration after a newer session mutation is accepted. */
export function invalidateSessionTitleGeneration(owner: object): void {
	generations.set(owner, currentGeneration(owner) + 1);
}

/** Return whether a regeneration still owns the latest generation lease. */
export function isSessionTitleGenerationCurrent(owner: object, generation: number): boolean {
	return currentGeneration(owner) === generation;
}
