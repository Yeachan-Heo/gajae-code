export type SdkFrame = Record<string, unknown>;

/** Narrow common surface shared by control and query adapters. */
export interface SessionSurface {
	sessionId: string;
}

export interface SessionOperationSurface extends SessionSurface {
	/** Query rows backed by this session's installed binding map. */
	installedQueries?: ReadonlySet<string>;
}

/** Operations the neutral control dispatcher may require from a session. */
export interface ControlSurface extends SessionSurface {
	[key: string]: unknown;
}

export interface HostEndpointAdapters {
	sessionId: string;
	stateRoot: string;
	token: string;
	sendFrame: (connectionId: string, frame: SdkFrame) => "written" | "dropped" | Promise<"written" | "dropped">;
	onFrame: (handler: (connectionId: string, frame: SdkFrame) => void) => undefined | (() => void);
	/**
	 * Largest directed frame, in UTF-8 bytes, that `sendFrame` delivers on its
	 * directed write path. Omitted means the native notification server's
	 * `RESPONSE_CEILING_BYTES`; `null` declares a transport without a ceiling,
	 * whose replies are sent intact.
	 */
	directedFrameCeilingBytes?: number | null;
}

export interface BrokerIndexWriter {
	register(input: { sessionId: string; stateRoot: string; endpointGeneration: number }): void | Promise<void>;
	heartbeat?(input: {
		sessionId: string;
		stateRoot: string;
		endpointGeneration: number;
		activity: { state: "active" | "idle"; at: number };
	}): void | Promise<void>;
	unregister?(input: {
		sessionId: string;
		stateRoot: string;
		endpointGeneration: number;
		reason?: "detached_idle";
	}): void | Promise<void>;
}
