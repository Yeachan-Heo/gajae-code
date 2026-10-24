import type { SessionInfo } from "./session-manager";

/** Keep only sessions whose confinement matches the launch that is resuming. */
export function sessionMatchesConfinement(session: Pick<SessionInfo, "filesystemScope">, confined: boolean): boolean {
	return confined ? session.filesystemScope === "cwd" : session.filesystemScope !== "cwd";
}
