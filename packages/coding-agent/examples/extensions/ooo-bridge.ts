interface OooBridgeExtensionAPI {
	pi: unknown;
	on(event: "input", handler: (event: unknown, context: unknown) => unknown): void;
}

interface OooBridgeHost {
	createOuroborosOooBridge(): (event: unknown, context: unknown) => unknown;
}

export default function (pi: OooBridgeExtensionAPI) {
	const host = pi.pi as OooBridgeHost;
	pi.on("input", host.createOuroborosOooBridge());
}
