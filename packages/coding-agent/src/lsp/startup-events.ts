import type { LspStartupServerInfo } from "./index";

export const LSP_STARTUP_EVENT_CHANNEL = "lsp:startup";

export type LspStartupEvent =
	| {
			type: "completed";
			servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
	  }
	| {
			type: "failed";
			error: string;
	  };
const OPTIONAL_STARTUP_FAILURE_SERVERS = new Set(["rust-analyzer"]);

function isOptionalStartupFailure(server: LspStartupServerInfo): boolean {
	return server.status === "error" && OPTIONAL_STARTUP_FAILURE_SERVERS.has(server.name);
}

export function getLspStartupWarningMessage(event: LspStartupEvent): string | null {
	if (event.type === "failed") {
		return "LSP startup failed. It will retry lazily on write.";
	}

	const failedServers = event.servers.filter(server => server.status === "error" && !isOptionalStartupFailure(server));

	if (failedServers.length === 1) {
		return `LSP startup failed for ${failedServers[0].name}. It will retry lazily on write.`;
	}

	if (failedServers.length > 1) {
		const failedNames = failedServers.map(server => server.name).join(", ");
		return `LSP startup failed for ${failedNames}. It will retry lazily on write.`;
	}

	return null;
}
