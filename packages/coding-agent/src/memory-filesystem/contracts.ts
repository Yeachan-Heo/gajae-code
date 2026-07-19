export const FILESYSTEM_MEMORY_PROTOCOL_VERSION = 1 as const;
export const FILESYSTEM_MEMORY_MAX_URI_LENGTH = 2_048;
export const FILESYSTEM_MEMORY_MAX_PATH_COMPONENTS = 64;
export const FILESYSTEM_MEMORY_MAX_COMPONENT_LENGTH = 255;
export const FILESYSTEM_MEMORY_MAX_READ_BYTES = 1_048_576;
export const FILESYSTEM_MEMORY_MAX_VISITED_DIRECTORIES = 256;
export const FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES = 4_096;
export const FILESYSTEM_MEMORY_MAX_DIRECTORY_DEPTH = 16;

export type FilesystemMemoryScope = "global" | "project" | "project-local" | "session";

export type FilesystemMemoryOutcomeCode =
	| "ok"
	| "invalid_uri"
	| "invalid_path"
	| "not_found"
	| "not_regular_file"
	| "symlink_denied"
	| "outside_root"
	| "topology_changed"
	| "unsupported"
	| "too_large"
	| "permission_denied"
	| "identity_unavailable"
	| "identity_drift"
	| "policy_denied"
	| "unknown_version";

export interface FilesystemMemorySuccess<T> {
	readonly code: "ok";
	readonly value: T;
}

export interface FilesystemMemoryFailure {
	readonly code: Exclude<FilesystemMemoryOutcomeCode, "ok">;
	readonly message: string;
}

export type FilesystemMemoryOutcome<T> = FilesystemMemorySuccess<T> | FilesystemMemoryFailure;

export interface FilesystemMemoryUri {
	readonly scope: FilesystemMemoryScope;
	/** Decoded path components. They never contain separators, controls, or dot segments. */
	readonly components: readonly string[];
	readonly canonical: string;
}

export interface FilesystemMemoryInitializationMarkerV1 {
	readonly version: 1;
	readonly initializedAt: string;
	readonly scopes: readonly FilesystemMemoryScope[];
}

export interface FilesystemMemoryIdentityRegistryV1 {
	readonly version: 1;
	readonly repositories: Record<string, FilesystemMemoryRepositoryIdentityV1>;
}

export interface FilesystemMemoryRepositoryIdentityV1 {
	readonly projectId: string;
	readonly commonDir: string;
	readonly remoteDisplay: string | null;
	readonly enrolledAt: string;
}

export interface FilesystemMemoryUserPolicyV1 {
	readonly version: 1;
	readonly allowedScopes: readonly FilesystemMemoryScope[];
}

export interface FilesystemMemoryRepositoryPolicyV1 {
	readonly version: 1;
	readonly allowedScopes?: readonly FilesystemMemoryScope[];
}

export interface FilesystemMemoryMapV1 {
	readonly version: 1;
	readonly routes: Record<string, readonly string[]>;
}

export interface FilesystemMemoryCheckpointV1 {
	readonly version: 1;
	readonly taskId: string;
	readonly createdAt: string;
	readonly content: string;
	readonly expectedDigest: string | null;
}

export interface FilesystemMemoryMarkdownMetadataV1 {
	readonly version: 1;
	readonly title?: string;
	readonly tags?: readonly string[];
	readonly volatility?: "stable" | "volatile";
	readonly status?: "active" | "archived" | "superseded" | "unverified";
}

export interface FilesystemMemoryScopeAvailability {
	readonly scope: FilesystemMemoryScope;
	readonly available: boolean;
	readonly reason: FilesystemMemoryOutcomeCode | null;
}

export const FILESYSTEM_MEMORY_PRIVATE_DIRECTORY_MODE = 0o700;
export const FILESYSTEM_MEMORY_PRIVATE_FILE_MODE = 0o600;
