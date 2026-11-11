export type SdkComposerObservationOperation = "composer.catalog" | "composer.complete" | "session.info";

export function isSdkComposerObservationOperation(value: unknown): value is SdkComposerObservationOperation {
	return value === "composer.catalog" || value === "composer.complete" || value === "session.info";
}

/** Installed by a trusted local application in SessionRouter, never accepted from a wire request. */
