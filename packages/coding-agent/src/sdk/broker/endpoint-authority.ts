import { createHash } from "node:crypto";

export type EndpointIncarnationRecord = {
	endpointGeneration: number;
	endpointMtimeMs?: number;
	pid: number;
};

/** Derives endpoint authority only when immutable endpoint mtime evidence is present. */
export function deriveEndpointIncarnation(record: EndpointIncarnationRecord, sessionId: string): string | undefined {
	if (
		!Number.isSafeInteger(record.endpointGeneration) ||
		record.endpointGeneration <= 0 ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.endpointMtimeMs !== "number" ||
		!Number.isFinite(record.endpointMtimeMs) ||
		record.endpointMtimeMs <= 0
	)
		return undefined;
	return createHash("sha256")
		.update(
			JSON.stringify({
				endpointGeneration: record.endpointGeneration,
				endpointMtimeMs: record.endpointMtimeMs,
				pid: record.pid,
				sessionId,
			}),
		)
		.digest("hex");
}
