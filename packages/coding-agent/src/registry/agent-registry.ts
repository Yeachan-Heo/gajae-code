/**
 * AgentRegistry - Process-global registry of live AgentSession instances.
 *
 * Tracks every alive agent (the main session plus every subagent) so the
 * `irc` tool can address peers by id. Sessions are registered explicitly at
 * creation and removed when the owner releases them.
 */

import type { AgentSession } from "../session/agent-session";

export const MAIN_AGENT_ID = "0-Main";

/** Thrown when `register` would replace a live agent id. */
export class AgentIdOccupiedError extends Error {
	readonly id: string;
	constructor(id: string) {
		super(`Agent id is already registered: ${id}`);
		this.name = "AgentIdOccupiedError";
		this.id = id;
	}
}

/**
 * What to do when the id a new root wants is already live.
 * Explicit ids fail closed. A default root that did not pass a registry
 * gets a private one. A caller-supplied registry keeps both roots and
 * remints only the newcomer.
 */
export type OccupiedAgentIdPlan = "reject" | "private-registry" | "remint";

export function planOccupiedAgentId(input: {
	explicitAgentId: boolean;
	explicitRegistry: boolean;
}): OccupiedAgentIdPlan {
	if (input.explicitAgentId) return "reject";
	if (!input.explicitRegistry) return "private-registry";
	return "remint";
}

export type AgentStatus = "running" | "idle" | "completed" | "aborted";
export type AgentKind = "main" | "sub";

export interface AgentRef {
	id: string;
	displayName: string;
	rosterLabel?: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	rosterLabel?: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	register(input: RegisterInput): AgentRef {
		if (this.#refs.has(input.id)) {
			throw new AgentIdOccupiedError(input.id);
		}
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			rosterLabel: input.rosterLabel,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: now,
			lastActivity: now,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	setStatus(id: string, status: AgentStatus): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.status === status) return;
		ref.status = status;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
	}

	attachSession(id: string, session: AgentSession, sessionFile?: string | null): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		// A second session must not retarget an id that already has an owner.
		if (ref.session && ref.session !== session) return;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
	}

	detachSession(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = null;
	}

	unregister(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
	}

	/**
	 * Remove `id` only when the bound session is `owner`.
	 * `owner === null` matches a placeholder that has not been attached yet,
	 * and leaves a different live session in place.
	 */
	releaseClaim(id: string, owner: AgentSession | null): boolean {
		const ref = this.#refs.get(id);
		if (!ref || ref.session !== owner) return false;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
		return true;
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Returns every alive agent (running | idle) except the caller.
	 * Flat namespace: every agent can see every other agent.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(ref => ref.id !== id && (ref.status === "running" || ref.status === "idle"));
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
