import { dlopen, FFIType } from "bun:ffi";
import type { NativeProcessObservation } from "@gajae-code/natives";

/**
 * A POSIX session that a normally completed command created with `setsid()`.
 *
 * Detaching into a new session is how a command daemonizes on purpose (for
 * example `git gc --auto` with `gc.autoDetach`). Once the command that created
 * the session has completed normally, the shell no longer owns its members and
 * shell cleanup must not kill them.
 *
 * `id` is the session id, which is the pid of the process that called `setsid()`.
 * `leaderIncarnation` pins that leader: `null` when it had already exited when the
 * session was released.
 */
export type ReleasedSession = { id: number; leaderIncarnation: string | null };

/**
 * Whether `sessionId` still names a released session.
 *
 * The kernel does not reuse a pid while a session with that id has members, so a
 * session whose leader is gone can only be the released one. A present leader must
 * be the exact released incarnation; any other incarnation means the old session
 * died and an unrelated process reused the pid for a new session. An inconclusive
 * leader lookup fails closed, so the session is treated as owned.
 */
export function isReleasedSession(
	sessionId: number,
	released: ReadonlyMap<number, ReleasedSession>,
	observeLeader: (pid: number) => Pick<NativeProcessObservation, "status" | "incarnation">,
): boolean {
	const session = released.get(sessionId);
	if (!session) return false;
	const leader = observeLeader(sessionId);
	if (leader.status === "absent") return true;
	return leader.status === "present" && leader.incarnation === session.leaderIncarnation;
}

/** `getsid(2)` reader: the session id of `pid`, or -1 when it cannot be read. */
export type SessionIdReader = { sessionIdOf(pid: number): number; close(): void };

export function openSessionIdReader(): SessionIdReader | undefined {
	const library =
		process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : process.platform === "linux" ? "libc.so.6" : "";
	if (!library) return undefined;
	try {
		const libc = dlopen(library, { getsid: { args: [FFIType.i32], returns: FFIType.i32 } });
		return {
			sessionIdOf: pid => libc.symbols.getsid(pid),
			close: () => libc.close(),
		};
	} catch {
		return undefined;
	}
}
