import type { SdkSessionEndpoint } from "./discovery";

export type SdkEndpointLiveness = "live" | "stale" | "dead" | "unknown";

export interface SdkEndpointSelectionError {
	code:
		| "endpoint_stale"
		| "endpoint_dead"
		| "endpoint_unknown"
		| "no_live_endpoint"
		| "multiple_live_endpoints"
		| "not_found";
}

export function classifyEndpoint(endpoint: SdkSessionEndpoint): SdkEndpointLiveness {
	if (endpoint.stale === true) return "stale";
	if (!Number.isInteger(endpoint.pid) || endpoint.pid === undefined || endpoint.pid <= 0) return "unknown";
	try {
		process.kill(endpoint.pid, 0);
		return "live";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		return code === "EPERM" ? "live" : "unknown";
	}
}

export function selectLiveEndpoint(
	records: readonly SdkSessionEndpoint[],
	explicitSessionId?: string,
): SdkSessionEndpoint | SdkEndpointSelectionError {
	if (explicitSessionId !== undefined) {
		const endpoint = records.find(record => record.sessionId === explicitSessionId);
		if (!endpoint) return { code: "not_found" };
		switch (classifyEndpoint(endpoint)) {
			case "live":
				return endpoint;
			case "stale":
				return { code: "endpoint_stale" };
			case "dead":
				return { code: "endpoint_dead" };
			case "unknown":
				return { code: "endpoint_unknown" };
		}
	}
	const live = records.filter(record => classifyEndpoint(record) === "live");
	if (live.length === 1) return live[0]!;
	return { code: live.length === 0 ? "no_live_endpoint" : "multiple_live_endpoints" };
}
