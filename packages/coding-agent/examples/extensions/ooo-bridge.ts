interface OooBridgeExtensionAPI {
	pi: unknown;
	on(event: "input" | "session_switch", handler: (event: unknown, context: unknown) => unknown): void;
}

interface OooBridgeHost {
	createOuroborosOooBridge(): ((event: unknown, context: unknown) => unknown) & { reset(): Promise<void> };
}

export default function (pi: OooBridgeExtensionAPI) {
	const host = pi.pi as OooBridgeHost;
	const bridge = host.createOuroborosOooBridge();
	pi.on("input", bridge);
	pi.on("session_switch", () => bridge.reset());
}
