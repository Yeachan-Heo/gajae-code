export type SdkDiffObservationOperation = "diff.scopes" | "diff.summary" | "diff.file";
export function isSdkDiffObservationOperation(value: unknown): value is SdkDiffObservationOperation {
	return value === "diff.scopes" || value === "diff.summary" || value === "diff.file";
}

/** Installed by a trusted local application in SessionRouter, never accepted from a wire request. */
