import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import type {
	DesktopMcpAction,
	DesktopMcpErrorCode,
	DesktopMcpOperationResult,
	DesktopMcpRef,
	DesktopMcpScope,
	DesktopMcpServer,
	DesktopMcpSnapshot,
} from "./mcp-protocol";

export const DESKTOP_MCP_LIMITS = { servers: 100, fieldChars: 128 } as const;

const REASONS: Record<DesktopMcpErrorCode, string> = {
	invalid_input: "Invalid MCP control input.",
	unavailable: "The captured factory result has no available MCP manager controls.",
	disposed: "MCP controls or their session have been disposed.",
	stale_session: "The session has changed; reopen MCP controls.",
	session_transitioning: "The session is transitioning; retry after it settles.",
	stale_connection: "The connection has changed; reopen MCP controls.",
	not_found: "This MCP reference is unknown or has expired.",
	stale_target: "The MCP server binding has changed; refresh its reference.",
	busy: "The SDK lifecycle is busy; retry after it settles.",
	unsupported: "The captured manager does not support this control.",
	unknown_effect: "MCP control completion was not proven. Refresh status before retrying.",
	backend_failure: "The SDK MCP operation failed. Completion was not proven.",
	redaction_failed: "MCP display redaction failed; content was withheld.",
};

export class DesktopMcpError extends Error {
	constructor(readonly code: DesktopMcpErrorCode) {
		super(REASONS[code]);
		this.name = "DesktopMcpError";
	}
}

export interface DesktopMcpOptions {
	connectionGeneration: string;
	/** Host policy, invoked before truncation. Throwing or returning a non-string fails closed. */
	redact(text: string): string;
}

type FactoryResult = Pick<CreateAgentSessionResult, "session" | "mcpManager">;
type Manager = NonNullable<CreateAgentSessionResult["mcpManager"]>;
interface Target {
	readonly name: string;
	readonly generation: number;
	readonly binding: string;
}
interface Reference {
	target: Target;
	ordinal: number;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesktopMcpError("invalid_input");
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new DesktopMcpError("invalid_input");
	const names = Reflect.ownKeys(value);
	if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)))
		throw new DesktopMcpError("invalid_input");
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new DesktopMcpError("invalid_input");
	}
	return value as Record<string, unknown>;
}

function reference(value: unknown): DesktopMcpRef {
	const parsed = object(value, ["key", "sessionGeneration", "connectionGeneration"]);
	if (
		typeof parsed.key !== "string" ||
		!parsed.key ||
		parsed.key.length > 128 ||
		typeof parsed.connectionGeneration !== "string" ||
		!parsed.connectionGeneration ||
		parsed.connectionGeneration.length > 128 ||
		typeof parsed.sessionGeneration !== "number" ||
		!Number.isSafeInteger(parsed.sessionGeneration) ||
		parsed.sessionGeneration < 0
	)
		throw new DesktopMcpError("invalid_input");
	return {
		key: parsed.key,
		connectionGeneration: parsed.connectionGeneration,
		sessionGeneration: parsed.sessionGeneration,
	};
}

function action(value: unknown): DesktopMcpAction {
	if (value !== "suspend" && value !== "resume" && value !== "reconnect") throw new DesktopMcpError("invalid_input");
	return value;
}

/** Only an explicit allowlist of backend codes may cross the host boundary. */
function failure(error: unknown): DesktopMcpError {
	if (error instanceof DesktopMcpError) return error;
	const descriptor = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
	const code: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
	switch (code) {
		case "invalid_target":
			return new DesktopMcpError("invalid_input");
		case "stale_target":
			return new DesktopMcpError("stale_target");
		case "resource_gone":
			return new DesktopMcpError("stale_session");
		case "busy":
		case "MCP_MANAGER_LIFECYCLE_CLOSED":
			return new DesktopMcpError("busy");
		case "unsupported":
			return new DesktopMcpError("unsupported");
		case "unavailable":
			return new DesktopMcpError("unavailable");
		case "unknown_effect":
			return new DesktopMcpError("unknown_effect");
		default:
			return new DesktopMcpError("backend_failure");
	}
}

/**
 * Captures the actual factory manager and session owner, never a process singleton.
 * View refs are not authority: the SDK validates target generations at its own fence.
 * Disposal detaches observation only; it never disposes the potentially shared manager.
 */
export class DesktopMcpController {
	readonly #session: FactoryResult["session"];
	readonly #manager: Manager | undefined;
	readonly #sessionManager: FactoryResult["session"]["sessionManager"];
	readonly #sessionId: string;
	readonly #managerSessionId: string;
	readonly #owner: string | undefined;
	readonly #scope: DesktopMcpScope;
	readonly #redact: (text: string) => string;
	readonly #references = new Map<string, Reference>();
	readonly #subscriptions = new Set<() => void>();
	readonly #abort = new AbortController();
	#ordinal = 0;
	#disposed = false;
	#stale = false;

	constructor(result: FactoryResult, options: DesktopMcpOptions) {
		if (
			!options ||
			typeof options.connectionGeneration !== "string" ||
			!options.connectionGeneration ||
			options.connectionGeneration.length > 128 ||
			typeof options.redact !== "function"
		)
			throw new DesktopMcpError("invalid_input");
		this.#session = result.session;
		this.#manager = result.mcpManager;
		this.#sessionManager = result.session.sessionManager;
		this.#sessionId = result.session.sessionId;
		this.#managerSessionId = this.#sessionManager.getSessionId();
		this.#owner = result.session.getAgentId();
		this.#scope = {
			connectionGeneration: options.connectionGeneration,
			sessionGeneration: result.session.sessionLifecycle.generation,
		};
		this.#redact = options.redact;
		this.#assertCurrent();
	}

	#assertCurrent(allowTransition = false): void {
		const lifecycle = this.#session.sessionLifecycle;
		// A committed generation is authoritative even while successor cleanup is
		// still transitioning. Notifications and staged identities are not.
		if (lifecycle.generation !== this.#scope.sessionGeneration) this.#stale = true;
		if (this.#stale) {
			this.#references.clear();
			throw new DesktopMcpError("stale_session");
		}
		if (this.#disposed || lifecycle.disposed) throw new DesktopMcpError("disposed");
		if (lifecycle.transitioning) {
			if (!allowTransition) throw new DesktopMcpError("session_transitioning");
			return;
		}
		// Only settled same-generation identity drift is permanent ABA evidence.
		// Preparation may stage these getters and then restore the predecessor.
		if (
			this.#session.sessionId !== this.#sessionId ||
			this.#session.sessionManager !== this.#sessionManager ||
			this.#sessionManager.getSessionId() !== this.#managerSessionId ||
			this.#session.getAgentId() !== this.#owner
		) {
			this.#stale = true;
			this.#references.clear();
			throw new DesktopMcpError("stale_session");
		}
	}

	#text(text: string): string {
		try {
			const redacted: unknown = this.#redact(text);
			if (typeof redacted !== "string") throw new DesktopMcpError("redaction_failed");
			return redacted.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, DESKTOP_MCP_LIMITS.fieldChars);
		} catch {
			throw new DesktopMcpError("redaction_failed");
		}
	}

	getSnapshot(): DesktopMcpSnapshot {
		const base: DesktopMcpSnapshot = {
			...this.#scope,
			scope: "factory_manager_may_be_shared",
			available: false,
			servers: [],
			truncated: false,
		};
		try {
			// Reading status never enters prompt/mutation admission.
			this.#assertCurrent(true);
			if (!this.#manager) throw new DesktopMcpError("unavailable");
			const snapshot = this.#manager.getServerControlSnapshot();
			const current = snapshot.slice(0, DESKTOP_MCP_LIMITS.servers);
			const retained = new Set<string>();
			const servers: DesktopMcpServer[] = current.map(server => {
				let entry = [...this.#references].find(
					([, ref]) =>
						ref.target.binding === server.target.binding &&
						ref.target.name === server.target.name &&
						ref.target.generation === server.target.generation,
				);
				if (!entry) {
					const key = crypto.randomUUID();
					const ref = { target: { ...server.target }, ordinal: ++this.#ordinal };
					this.#references.set(key, ref);
					entry = [key, ref];
				}
				const [key, ref] = entry;
				retained.add(key);
				return {
					ref: { ...this.#scope, key },
					// Configured names can themselves contain URLs or credentials. Keep them private.
					label: this.#text(`MCP server ${ref.ordinal}`),
					state: server.state,
					transport: server.transport,
					sharing: server.sharing,
					toolCount: Math.max(0, Math.min(1_000_000, server.toolCount)),
					controls: this.#session.sessionLifecycle.transitioning ? [] : [...server.controls],
				};
			});
			for (const key of this.#references.keys()) if (!retained.has(key)) this.#references.delete(key);
			this.#assertCurrent(true);
			if (this.#session.sessionLifecycle.transitioning) for (const server of servers) server.controls = [];
			return { ...base, available: true, servers, truncated: snapshot.length > current.length };
		} catch (error) {
			this.#references.clear();
			const sanitized = failure(error);
			return { ...base, error: { code: sanitized.code, message: sanitized.message } };
		}
	}

	async operate(value: unknown, requestedAction: unknown): Promise<DesktopMcpOperationResult> {
		try {
			const ref = reference(value);
			const operation = action(requestedAction);
			this.#assertCurrent();
			if (ref.connectionGeneration !== this.#scope.connectionGeneration)
				throw new DesktopMcpError("stale_connection");
			if (ref.sessionGeneration !== this.#scope.sessionGeneration) throw new DesktopMcpError("stale_session");
			const target = this.#references.get(ref.key)?.target;
			if (!target) throw new DesktopMcpError("not_found");
			const manager = this.#manager;
			if (!manager) throw new DesktopMcpError("unavailable");
			const result = await this.#session.withMcpControlAdmission(this.#scope.sessionGeneration, async signal => {
				this.#assertCurrent(true);
				// No listener, redactor, or await before the manager's atomic CAS admission.
				return manager.controlServer(target, operation, { signal: AbortSignal.any([signal, this.#abort.signal]) });
			});
			this.#assertCurrent();
			return { status: result.status, cleanup: result.cleanup, snapshot: this.getSnapshot() };
		} catch (error) {
			throw failure(error);
		}
	}

	/** Notifications wake only. They never authorize a fresh session/target binding. */
	onChange(listener: () => void): () => void {
		this.#assertCurrent(true);
		const wake = (): void => {
			if (!this.#disposed) {
				try {
					listener();
				} catch {
					/* Isolated host subscriber. */
				}
			}
		};
		const unsubscribers = [this.#session.subscribe(wake)];
		if (this.#manager) {
			unsubscribers.push(this.#manager.subscribeToServerControlsChanged(wake));
			unsubscribers.push(this.#manager.subscribeToToolsChanged(wake));
		}
		const unsubscribe = (): void => {
			this.#subscriptions.delete(unsubscribe);
			for (const dispose of unsubscribers.splice(0)) dispose();
		};
		this.#subscriptions.add(unsubscribe);
		if (this.#disposed) unsubscribe();
		return unsubscribe;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abort.abort();
		this.#references.clear();
		for (const unsubscribe of this.#subscriptions) unsubscribe();
	}
}

export function createDesktopMcpController(result: FactoryResult, options: DesktopMcpOptions): DesktopMcpController {
	return new DesktopMcpController(result, options);
}
