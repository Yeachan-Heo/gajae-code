/** Exact endpoint authority captured from a verified SDK session binding. */
export interface SessionEndpointAuthority {
	readonly endpointGeneration: number;
	readonly endpointIncarnation: string;
}

/** Session identity plus the endpoint authority bound to that exact session. */
export interface SessionBindingAuthority extends SessionEndpointAuthority {
	readonly sessionId: string;
}
