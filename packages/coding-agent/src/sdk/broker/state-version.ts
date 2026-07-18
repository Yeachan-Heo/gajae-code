export const SDK_STATE_VERSION = 1;

// The session-index snapshot carries its own format version, independent of the shared
// SDK_STATE_VERSION used by discovery, the lifecycle ledger, and per-event records. Version 2
// snapshots relax the on-disk schema to allow gaps in indexSeq (compaction drops terminal+dead
// sessions and superseded heartbeats), so an older broker must hard-fail rather than silently
// fall back to a truncated log. Bumping only this constant keeps the broker protocol untouched.
export const SESSION_INDEX_SNAPSHOT_VERSION = 2;

export class UnsupportedStateVersionError extends Error {
	readonly code = "unsupported_state_version";

	constructor(
		readonly file: string,
		readonly version: number,
	) {
		super(`Unsupported SDK state version ${version} in ${file}; maximum supported version is ${SDK_STATE_VERSION}.`);
		this.name = "UnsupportedStateVersionError";
	}
}

export function assertSupportedStateVersion(file: string, value: unknown): void {
	if (!value || typeof value !== "object") return;
	const record = value as { version?: unknown; stateVersion?: unknown };
	for (const version of [record.version, record.stateVersion]) {
		if (typeof version === "number" && Number.isFinite(version) && version > SDK_STATE_VERSION) {
			throw new UnsupportedStateVersionError(file, version);
		}
	}
}

// Fences the session-index snapshot format independently of SDK_STATE_VERSION. An older broker
// (whose SESSION_INDEX_SNAPSHOT_VERSION is 1) trips assertSupportedStateVersion on a version-2
// snapshot and refuses to start; a current broker accepts both the legacy contiguous format
// (version 1 or absent) and the gapped version-2 format.
export function assertSupportedSnapshotVersion(file: string, value: unknown): void {
	if (!value || typeof value !== "object") return;
	const record = value as { version?: unknown; stateVersion?: unknown };
	for (const version of [record.version, record.stateVersion]) {
		if (typeof version === "number" && Number.isFinite(version) && version > SESSION_INDEX_SNAPSHOT_VERSION) {
			throw new UnsupportedStateVersionError(file, version);
		}
	}
}
