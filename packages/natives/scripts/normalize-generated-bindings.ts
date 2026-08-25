const APPEARANCE_DOC = "Long-lived macOS appearance observer.";
const escapedAppearanceDoc = APPEARANCE_DOC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const APPEARANCE_BOUNDARY = new RegExp(`(?:\\r?\\n)+/\\*\\*\\r?\\n \\* ${escapedAppearanceDoc}`);

/** Normalize the one napi-rs declaration boundary that must remain byte-stable. */
export function normalizeGeneratedBindings(bindings: string): string {
	if (!APPEARANCE_BOUNDARY.test(bindings)) {
		throw new Error(`Generated declarations are missing the ${APPEARANCE_DOC} boundary.`);
	}
	return bindings.replace(APPEARANCE_BOUNDARY, `\n\n/**\n * ${APPEARANCE_DOC}`);
}
