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
	sendFrame: (connectionId: string, frame: SdkFrame) => void | Promise<void>;
	onFrame: (handler: (connectionId: string, frame: SdkFrame) => void) => undefined | (() => void);
}

export interface BrokerIndexWriter {
	register(input: { sessionId: string; stateRoot: string; endpointGeneration: number }): void | Promise<void>;
	unregister?(input: { sessionId: string; stateRoot: string; endpointGeneration: number }): void | Promise<void>;
}
