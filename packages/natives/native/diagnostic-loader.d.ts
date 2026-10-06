/** Bytes copied out of one read-only broker publication observation. */
export interface DiagnosticSnapshotRead {
	ok: boolean;
	reason: string | null;
	bytes: Uint8Array | null;
}

/** Outcome of one read-only publication revalidation. */
export interface DiagnosticSnapshotStatus {
	ok: boolean;
	reason: string | null;
}

/**
 * Exclusive read-only lease over one already published broker document. It
 * exposes no descriptor, path, token or write method; `close` is idempotent and
 * every use after close reports `unsafe_discovery`.
 */
export interface DiagnosticSnapshotLease {
	readonly ok: boolean;
	readonly reason: string | null;
	read(): DiagnosticSnapshotRead;
	revalidate(): DiagnosticSnapshotStatus;
	close(): void;
}

export interface DiagnosticNativeEntry {
	openDiagnosticSnapshot(agentDir: string, budgetMs: number): DiagnosticSnapshotLease;
}

export type DiagnosticNativeLoad =
	| { ok: true; value: DiagnosticNativeEntry }
	| { ok: false; reason: "unsupported" };

/**
 * Load the read-only diagnostic entry point from the fixed package-owned
 * artifact. Never extracts, repairs, scans candidates or initializes the
 * ordinary native loader; any unsupported runtime, missing or mismatched
 * artifact resolves to `unsupported`.
 */
export interface DiagnosticRuntimeTuple {
	platform?: string;
	arch?: string;
	bunVersion?: string;
}

/** True only for the single admitted tuple: darwin/arm64 on Bun 1.4.0. */
export declare function supportedRuntime(runtime: DiagnosticRuntimeTuple): boolean;

/**
 * An opaque, single-use verification authority. It carries no descriptor and no
 * path: either `activateVerifiedArtifact` or `closeVerifiedArtifact` consumes it,
 * after which the token holds no authority at all.
 */
export interface VerifiedDiagnosticArtifact {
	ok: true;
	readonly token: string;
}

export type DiagnosticArtifactVerification = VerifiedDiagnosticArtifact | { ok: false; reason: "unsupported" };

/**
 * Classify one ACL probe. Pure and platform-independent: absence requires a null
 * handle with the platform's "no such ACL" errno, a first entry means an ACE exists,
 * and everything else -- including `acl_get_entry` returning -1 -- is unproven.
 */
export declare function classifyAclProbe(probe: {
	handle: number;
	errno: number | null;
	firstEntry: number | null;
}): "absent" | "present" | "unproven";

/**
 * Classify the extended ACL of an open descriptor through the platform's read-only
 * ACL API, bound from the absolute system library path. Refuses before `dlopen` when
 * a dyld override is in effect, and reports `unproven` whenever the platform cannot
 * answer.
 */
export declare function inspectAclOnDescriptor(descriptor: number): "absent" | "present" | "unproven";

/** One parsed entry of the bounded external ACL representation. */
export interface ParsedAclEntry {
	guid: Uint8Array;
	flags: number;
	rights: number;
}

export type ParsedAclRepresentation =
	| { ok: true; count: number; headerFlags: number; entries: ParsedAclEntry[] }
	| { ok: false };

/** Parse and structurally validate the bounded external ACL representation. */
export declare function parseAclRepresentation(bytes: Uint8Array): ParsedAclRepresentation;

/**
 * Decide a parsed representation by full-field equality: exactly one entry, ACL header
 * flags entirely zero, entry flags exactly the deny tag, rights exactly DELETE, and the
 * everyone GUID.
 */
export declare function classifyAclRepresentation(
	parsed: unknown,
): "approved-single-deny-delete" | "not-allowlisted" | "unproven";

/**
 * Classify a trusted ancestor's ACL above the artifact namespace anchor: absent, the
 * approved single non-inheriting everyone DENY DELETE entry, understood-but-refused, or
 * unproven.
 */
export declare function inspectAncestorAclOnDescriptor(
	descriptor: number,
): "absent" | "approved-single-deny-delete" | "not-allowlisted" | "unproven";

/** Admission for one component of the artifact path: owner, mode, shape. */
export declare function namespaceComponentAdmitted(
	component: { uid: number; gid: number; mode: number; isSymbolicLink: boolean; isDirectory: boolean },
	euid: number,
): boolean;

/** The single applicable package-owned artifact path, or null when none applies. */
export declare function selectArtifactLayout(require: NodeRequire): string | null;

/**
 * Prove the namespace and the bytes of one artifact and retain the descriptor they
 * were read from. The handle owns an open descriptor: pass it to
 * `activateVerifiedArtifact` or release it with `closeVerifiedArtifact`.
 */
export declare function verifyDiagnosticArtifact(file: string): DiagnosticArtifactVerification;

/**
 * Release a verified handle without activating it. A fabricated, mutated or already
 * consumed handle is ignored rather than closing an unrelated descriptor.
 */
export declare function closeVerifiedArtifact(handle: unknown): void;

/**
 * Activate the verified bytes through their retained descriptor, so a pathname
 * replaced after verification cannot redirect the load. Always closes the handle.
 */
export declare function activateVerifiedArtifact(handle: unknown): DiagnosticNativeLoad;

export declare function validateDiagnosticBinding(binding: unknown, expectedVersion: string): boolean;

export declare function loadDiagnosticNativeReadOnly(runtimeOverride?: DiagnosticRuntimeTuple): DiagnosticNativeLoad;
