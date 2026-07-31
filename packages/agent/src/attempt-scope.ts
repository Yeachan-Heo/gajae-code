/**
 * Per-attempt scope identity for request-scoped execution attribution.
 *
 * An AttemptScope is an immutable, frozen value allocated before every
 * observable lifecycle emission for a single provider/agent attempt.
 * It carries a stable `attemptId`, a monotonic `generation` (per-lineage),
 * and a `lineage` discriminator that distinguishes the main attempt from
 * concurrent side attempts (IRC background, ephemeral/btw turns).
 *
 * The `attemptId` + `generation` + `lineage` form the comparable identity.
 * AttemptScope is structurally assignable to AttemptScopeRef in
 * `packages/ai` so it can be carried through `SimpleStreamOptions` and
 * provider hook signatures without a reverse dependency.
 */
export type AttemptLineage = "main" | `side:${string}`;

export interface AttemptScope {
	readonly attemptId: string;
	readonly generation: number;
	readonly lineage: AttemptLineage;
}

export function attemptScopesEqual(a: AttemptScope, b: AttemptScope): boolean {
	return a.attemptId === b.attemptId && a.generation === b.generation && a.lineage === b.lineage;
}

/**
 * Per-lineage currentness authority. Main and side attempts have separate
 * instances so a side attempt never invalidates the main scope, and
 * `forceAbort` advances only the main lineage.
 */
export interface LineageCurrentness {
	readonly lineage: AttemptLineage;
	/** True iff no successor scope with a greater generation was allocated in this lineage. */
	isCurrent(scope: AttemptScope): boolean;
	/** Allocate the next generation for the given attempt identity in this lineage. */
	advance(attemptId: string): number;
	/** Allocate the next generation in this lineage. */
	/** Current generation value for this lineage. */
	readonly current: number;
}

export function createLineageCurrentness(lineage: AttemptLineage): LineageCurrentness {
	let current = 0;
	let currentAttemptId: string | undefined;
	return {
		lineage,
		get current() {
			return current;
		},
		isCurrent(scope: AttemptScope): boolean {
			return scope.lineage === lineage && scope.generation === current && scope.attemptId === currentAttemptId;
		},
		advance(attemptId: string): number {
			currentAttemptId = attemptId;
			return ++current;
		},
	};
}

/**
 * Agent-owned authority over all attempt lineages. Owns the main lineage;
 * side lineages are registered/removed with bounded lifecycle.
 *
 * This is the SINGLE source of currentness truth injected into
 * AttemptRecordStore (packages/coding-agent). Every store operation
 * calls `authority.isCurrent(scope)` and fails closed when the authority
 * is missing or the scope is superseded.
 */
export interface AttemptScopeAuthority {
	/** Register a side-lineage authority. Returns an unregister function. */
	registerSide(lineage: AttemptLineage, auth: LineageCurrentness): () => void;
	/** True iff the scope's lineage is known and its generation is current. */
	isCurrent(scope: AttemptScope): boolean;
	/** Advance the main lineage (called by forceAbort). Returns the new generation. */
	advanceMain(): number;
	/** Mint the next main-lineage scope. */
	mintMain(): AttemptScope;
	/**
	 * Atomically register a fresh side lineage, mint a side scope, and return
	 * both the scope and a dispose function. The authority knows the lineage
	 * BEFORE the scope is returned, so `isCurrent` succeeds immediately.
	 */
	mintSide(): { scope: AttemptScope; dispose: () => void };
}

export interface AttemptMinter {
	mint(lineage: AttemptLineage): AttemptScope;
}

export function createAttemptMinter(): AttemptMinter {
	const generations = new Map<AttemptLineage, number>();
	return {
		mint(lineage: AttemptLineage): AttemptScope {
			const gen = (generations.get(lineage) ?? 0) + 1;
			generations.set(lineage, gen);
			return Object.freeze({
				attemptId: crypto.randomUUID(),
				generation: gen,
				lineage,
			});
		},
	};
}

const SIDE_LRU_CAP = 1024;

/**
 * Create the Agent-owned authority. Owns the main lineage and a bounded
 * (LRU-capped) map of side lineages. Only RETIRED side authorities are
 * eligible for LRU eviction; a live side attempt is never silently
 * invalidated by a newer side registration.
 */
export function createAttemptScopeAuthority(): AttemptScopeAuthority {
	const mainAuth = createLineageCurrentness("main");
	const sideAuths = new Map<AttemptLineage, LineageCurrentness>();
	const sideOrder: AttemptLineage[] = [];
	const retiredSet = new Set<AttemptLineage>();

	function evictRetiredIfNeeded(): void {
		// Only evict RETIRED side authorities. A live side attempt is never
		// evicted by a newer registration.
		while (sideOrder.length > SIDE_LRU_CAP) {
			const retiredIdx = sideOrder.findIndex(l => retiredSet.has(l));
			if (retiredIdx < 0) break;
			const [removed] = sideOrder.splice(retiredIdx, 1);
			if (removed) {
				sideAuths.delete(removed);
				retiredSet.delete(removed);
			}
		}
	}

	function mintFor(lineage: AttemptLineage, auth: LineageCurrentness): AttemptScope {
		const attemptId = crypto.randomUUID();
		return Object.freeze({
			attemptId,
			generation: auth.advance(attemptId),
			lineage,
		});
	}

	return {
		registerSide(lineage: AttemptLineage, auth: LineageCurrentness): () => void {
			if (sideAuths.has(lineage)) {
				const idx = sideOrder.indexOf(lineage);
				if (idx >= 0) sideOrder.splice(idx, 1);
			}
			sideAuths.set(lineage, auth);
			sideOrder.push(lineage);
			evictRetiredIfNeeded();
			return () => {
				if (sideAuths.get(lineage) === auth) {
					// Mark as retired but keep in maps until eviction.
					// isCurrent returns false for retired lineages because
					// the auth is still present but the scope is superseded
					// by disposal (generation stays at its last value).
					retiredSet.add(lineage);
					evictRetiredIfNeeded();
				}
			};
		},
		isCurrent(scope: AttemptScope): boolean {
			if (scope.lineage === "main") return mainAuth.isCurrent(scope);
			if (retiredSet.has(scope.lineage)) return false;
			const auth = sideAuths.get(scope.lineage);
			return auth ? auth.isCurrent(scope) : false;
		},
		advanceMain(): number {
			// Advance main lineage to a fresh attemptId so any previously-minted
			// main scope becomes non-current. The next mintMain() will set the
			// real attemptId for the new attempt.
			return mainAuth.advance(crypto.randomUUID());
		},
		mintMain(): AttemptScope {
			return mintFor("main", mainAuth);
		},
		mintSide(): { scope: AttemptScope; dispose: () => void } {
			const lineage = `side:${crypto.randomUUID()}` as AttemptLineage;
			const auth = createLineageCurrentness(lineage);
			const unregister = this.registerSide(lineage, auth);
			const scope = mintFor(lineage, auth);
			return { scope, dispose: unregister };
		},
	};
}

/**
 * Immutable per-run attempt handle, carried through terminal/finalizer paths.
 * Keyed by logicalRunId in the Agent's `#runHandles` map.
 */
export interface AttemptRunHandle {
	readonly logicalRunId: number | import("./types.js").ManagedLogicalRunId;
	readonly scope: AttemptScope;
}
