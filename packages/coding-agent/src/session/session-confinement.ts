/**
 * Session filesystem scope (`gjc --confine`).
 *
 * A confined session records `filesystemScope: "cwd"` in its transcript
 * header. Every reader of that field goes through these helpers, so the
 * persisted spelling is decided in one place.
 */

/** The only persisted scope value; an ordinary session omits the field. */
export type FilesystemScope = "cwd";

/** Anything that may carry the persisted field: a header, a listing entry, or parsed JSON. */
interface ScopeCarrier {
	filesystemScope?: unknown;
}

/** True when a header or session listing records a `--confine` session. */
export function isConfinedScope(carrier: ScopeCarrier | undefined): boolean {
	return carrier?.filesystemScope === "cwd";
}

/** Normalize an untrusted header field to the persisted scope, dropping anything else. */
export function parseFilesystemScope(value: unknown): FilesystemScope | undefined {
	return value === "cwd" ? "cwd" : undefined;
}

/** Keep only sessions whose confinement matches the launch that is resuming. */
export function sessionMatchesConfinement(session: ScopeCarrier, confined: boolean): boolean {
	return isConfinedScope(session) === confined;
}
