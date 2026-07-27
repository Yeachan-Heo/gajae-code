// app-server connection state: per-connection lifecycle for the codex-compatible wire.
//
// Per the pinned protocol: a single `initialize` request must precede every other method
// on a connection; the server then expects an `initialized` notification. Any request
// before the handshake completes is rejected with "Not initialized" (-32600); a repeat
// `initialize` after success is rejected with "Already initialized" (-32600). Per-connection
// `capabilities` carry the `optOutNotificationMethods` allowlist (EXACT method-name match,
// no wildcards/prefixes; unknown names accepted and ignored) and the `experimentalApi`
// capability flag, both set from the `initialize` params.

export interface ConnectionCapabilities {
	/** Exact method names whose notifications this connection opts out of. */
	readonly optOutNotificationMethods: ReadonlySet<string>;
	/** Client declared support for experimental (beta) methods. */
	readonly experimentalApi: boolean;
	/** ClientInfo from initialize (name/title/version), if provided. */
	readonly clientInfo?: { name?: string; title?: string; version?: string };
}

export type ConnectionStateStage = "uninitialized" | "initializing" | "initialized";

export interface InitializeParams {
	clientInfo?: { name?: string; title?: string; version?: string };
	capabilities?: {
		experimentalApi?: boolean;
		optOutNotificationMethods?: string[];
	};
}

/**
 * Mutable per-connection state. One instance lives for the lifetime of a transport
 * connection; it is NOT shared across connections.
 */
export class ConnectionState {
	#stage: ConnectionStateStage = "uninitialized";
	#capabilities: ConnectionCapabilities | undefined;

	get stage(): ConnectionStateStage {
		return this.#stage;
	}
	get capabilities(): ConnectionCapabilities | undefined {
		return this.#capabilities;
	}
	get initialized(): boolean {
		return this.#stage === "initialized";
	}

	/**
	 * Begin the handshake. Returns true if this is the first initialize on the connection;
	 * false (with the caller expected to emit "Already initialized") if one already landed.
	 * Does NOT advance to `initialized` — that happens on the `initialized` notification, per
	 * the protocol's two-step handshake (initialize request -> initialized notification).
	 */
	beginInitialize(params: InitializeParams | undefined): boolean {
		if (this.#stage !== "uninitialized") return false;
		this.#stage = "initializing";
		const caps = params?.capabilities ?? {};
		// Exact-match set; unknown names are accepted and ignored (no validation error).
		const optOut = Array.isArray(caps.optOutNotificationMethods)
			? new Set(caps.optOutNotificationMethods.filter((m): m is string => typeof m === "string" && m.length > 0))
			: new Set<string>();
		this.#capabilities = {
			optOutNotificationMethods: optOut,
			experimentalApi: caps.experimentalApi === true,
			clientInfo: params?.clientInfo,
		};
		return true;
	}

	/** Complete the handshake on receipt of the `initialized` notification. */
	completeInitialize(): boolean {
		if (this.#stage !== "initializing") return false;
		this.#stage = "initialized";
		return true;
	}

	/**
	 * Decide whether a method is allowed on this connection. Returns:
	 *   - { ok: true } when the connection is initialized (or the method is `initialize`);
	 *   - { ok: false, key: "notInitialized" } when the handshake has not begun;
	 *   - { ok: false, key: "alreadyInitialized" } on a duplicate initialize.
	 */
	authorize(method: string): { ok: true } | { ok: false; key: "notInitialized" | "alreadyInitialized" } {
		if (method === "initialize") {
			if (this.#stage === "uninitialized") return { ok: true };
			return { ok: false, key: "alreadyInitialized" };
		}
		if (this.#stage !== "initialized") return { ok: false, key: "notInitialized" };
		return { ok: true };
	}

	/** Does this connection opt out of a given notification method? Exact match only. */
	optsOutOf(method: string): boolean {
		return this.#capabilities?.optOutNotificationMethods.has(method) ?? false;
	}
}
