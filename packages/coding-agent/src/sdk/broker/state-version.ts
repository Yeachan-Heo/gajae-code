export const SDK_STATE_VERSION = 1;

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
