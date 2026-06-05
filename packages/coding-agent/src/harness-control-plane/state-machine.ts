/**
 * Lifecycle state machine + the universal `{state, evidence, nextAllowedActions}` contract.
 *
 * `nextAllowedActions` is the forcing function: it tells the caller exactly which
 * primitives are currently permitted and, when not, why. Owner-routed verbs
 * (`submit`) report `owner-not-live` when no `RuntimeOwner` holds the session lease.
 */
import type { HarnessLifecycle, NextAllowedAction, PrimitiveResponse, SessionState, SessionStateView } from "./types";

const TERMINAL_LIFECYCLES: ReadonlySet<HarnessLifecycle> = new Set(["completed", "retired"]);

const TRANSITIONS: Record<HarnessLifecycle, readonly HarnessLifecycle[]> = {
	new: ["started", "blocked", "retired"],
	started: ["submitted", "observing", "recovering", "blocked", "retired"],
	submitted: ["observing", "recovering", "validating", "blocked", "retired"],
	observing: ["submitted", "recovering", "validating", "finalizing", "blocked", "retired"],
	recovering: ["started", "submitted", "observing", "blocked", "retired"],
	validating: ["finalizing", "observing", "blocked", "retired"],
	finalizing: ["completed", "blocked", "retired"],
	completed: ["retired"],
	blocked: ["started", "submitted", "observing", "recovering", "validating", "retired"],
	retired: [],
};

export function isTerminal(lifecycle: HarnessLifecycle): boolean {
	return TERMINAL_LIFECYCLES.has(lifecycle);
}

export function canTransition(from: HarnessLifecycle, to: HarnessLifecycle): boolean {
	return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: HarnessLifecycle, to: HarnessLifecycle): void {
	if (from === to) return;
	if (!canTransition(from, to)) {
		throw new Error(`invalid_transition:${from}->${to}`);
	}
}

/**
 * Derive the permitted next actions for a session given its lifecycle and whether
 * a live owner currently holds the lease.
 */
export function nextAllowedActions(lifecycle: HarnessLifecycle, ownerLive: boolean): NextAllowedAction[] {
	const terminal = isTerminal(lifecycle);
	const actions: NextAllowedAction[] = [];
	const add = (verb: NextAllowedAction["verb"], available: boolean, reason?: string): void => {
		actions.push(available ? { verb, available } : { verb, available, reason: reason ?? "unavailable" });
	};

	// Pure / read-only verbs are always available.
	add("observe", true);
	add("classify", true);
	add("events", true);
	add("monitor", true);

	// `start` creates a new session; never re-applicable to an existing record.
	add("start", false, "session-already-exists");

	// `submit` is owner-routed: it requires a live owner and a non-blocked, non-terminal lifecycle.
	if (terminal) add("submit", false, `lifecycle-terminal:${lifecycle}`);
	else if (lifecycle === "blocked") add("submit", false, "lifecycle-blocked");
	else if (!ownerLive) add("submit", false, "owner-not-live");
	else add("submit", true);

	// `recover` handles a dead/failed owner, so it is available without a live owner.
	add("recover", !terminal, terminal ? `lifecycle-terminal:${lifecycle}` : undefined);
	add("validate", !terminal, terminal ? `lifecycle-terminal:${lifecycle}` : undefined);
	add("finalize", !terminal, terminal ? `lifecycle-terminal:${lifecycle}` : undefined);
	add("retire", lifecycle !== "retired", lifecycle === "retired" ? "already-retired" : undefined);

	return actions;
}

export function buildStateView(state: SessionState, ownerLive: boolean): SessionStateView {
	return {
		sessionId: state.sessionId,
		lifecycle: state.lifecycle,
		harness: state.harness,
		ownerLive,
		blockers: state.blockers,
	};
}

/** Build the universal contract response carried by every primitive. */
export function buildResponse<E extends Record<string, unknown>>(
	state: SessionState,
	ownerLive: boolean,
	evidence: E,
	ok = true,
): PrimitiveResponse<E> {
	return {
		ok,
		state: buildStateView(state, ownerLive),
		evidence,
		nextAllowedActions: nextAllowedActions(state.lifecycle, ownerLive),
	};
}
