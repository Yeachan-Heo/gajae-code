import * as path from "node:path";

export const SESSION_STAGING_DIRNAME = ".staging" as const;

/** True when a path contains the reserved session staging directory segment. */
export function isStagedSessionPath(filePath: string): boolean {
	return path
		.resolve(filePath)
		.split(path.sep)
		.some(segment => segment === SESSION_STAGING_DIRNAME);
}
