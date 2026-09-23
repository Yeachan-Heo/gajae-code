import { AcpSdkAdapterError } from "../../sdk/acp";

type JsonObject = Record<string, unknown>;

export type PrimaryControlSurface = "cli" | "sdk";

/**
 * Startup-control provenance is the authority record ACP needs before it may take
 * permission, provider, and lifecycle ownership of a session. Hosts serving that
 * record report capabilities carrying `promptTerminalOutcomeVersion`
 * and `primaryControlSurface`; a host that predates the record reports neither, and a
 * host that cannot answer at all reports nothing. Those are three different operator
 * problems, so they get three different messages instead of one "restart the session".
 */
export function resolveStartupProvenance(input: {
	sessionId: string;
	capabilities: JsonObject | undefined;
	queryFailure: unknown;
}): PrimaryControlSurface {
	const { sessionId, capabilities, queryFailure } = input;
	if (!capabilities)
		throw new AcpSdkAdapterError(
			"unavailable",
			`ACP session ${sessionId} did not answer runtime.capabilities, so its startup control provenance is unknown${describeFailure(queryFailure)}.`,
		);
	const surface =
		capabilities.primaryControlSurface === "sdk"
			? "sdk"
			: capabilities.primaryControlSurface === "cli"
				? "cli"
				: undefined;
	if (capabilities.promptTerminalOutcomeVersion !== 1 || surface === undefined)
		throw new AcpSdkAdapterError(
			"unavailable",
			`ACP session ${sessionId} is served by a live GJC host that predates startup control provenance. Upgrading the client does not upgrade that already-running host: stop it, then reopen the session so the current build resumes it from its stored record.`,
		);
	return surface;
}

function describeFailure(failure: unknown): string {
	if (failure === undefined) return "";
	let code: unknown;
	try {
		if ((typeof failure !== "object" || failure === null) && typeof failure !== "function") return " (query failed)";
		code = (failure as { code?: unknown }).code;
	} catch {
		return " (query failed)";
	}
	switch (code) {
		case "connection_closed":
			return " (connection closed)";
		case "timeout":
			return " (query timed out)";
		case "uncertain_after_send":
			return " (query outcome uncertain)";
		default:
			return " (query failed)";
	}
}
