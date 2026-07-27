// app-server listen mode: parse and validate --listen URLs.
//
// Supported modes (exact mirror of codex CLI):
//   stdio:// (default)  — newline-delimited JSON over stdin/stdout
//   ws://IP:PORT        — WebSocket TCP listener (serves /readyz + /healthz probes)
//   unix://PATH         — WebSocket over a Unix domain socket (HTTP Upgrade handshake)
//   unix://             — default socket path ($CODEX_HOME/app-server-control/app-server-control.sock)
//   off                 — do not expose a local transport (valid standalone mode)

export type ListenMode =
	| { kind: "stdio" }
	| { kind: "ws"; host: string; port: number }
	| { kind: "unix"; path: string | null }
	| { kind: "off" };

/**
 * Parse a --listen URL into a structured mode. Throws on invalid input.
 * `undefined` defaults to stdio.
 */
export function parseListenUrl(raw: string | undefined): ListenMode {
	if (raw === undefined || raw === "stdio" || raw === "stdio://") return { kind: "stdio" };
	if (raw === "off") return { kind: "off" };
	if (raw.startsWith("ws://")) {
		const rest = raw.slice(5);
		const colon = rest.lastIndexOf(":");
		if (colon === -1) throw new Error(`ws:// listen URL must include a port: ${raw}`);
		const host = rest.slice(0, colon);
		const portStr = rest.slice(colon + 1);
		const port = Number(portStr);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in ws:// URL: ${portStr}`);
		return { kind: "ws", host: host || "127.0.0.1", port };
	}
	if (raw.startsWith("unix://")) {
		const path = raw.slice(7);
		return { kind: "unix", path: path || null };
	}
	throw new Error(`unsupported --listen URL: ${raw}`);
}

/** Whether a listen mode needs the HTTP health probes (ws and unix only). */
export function needsHealthProbes(mode: ListenMode): boolean {
	return mode.kind === "ws" || mode.kind === "unix";
}

/** Whether a listen mode exposes any transport at all (off does not). */
export function exposesTransport(mode: ListenMode): boolean {
	return mode.kind !== "off";
}

/** Whether a ws:// bind is loopback (no auth required). */
export function isLoopback(mode: ListenMode): boolean {
	if (mode.kind !== "ws") return true;
	return mode.host === "127.0.0.1" || mode.host === "localhost" || mode.host === "::1" || mode.host === "[::1]";
}
