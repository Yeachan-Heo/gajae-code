import type { AgentSession } from "../session/agent-session";

interface Move {
	previousCwd: string;
	newCwd: string;
	previousSessionFile: string | undefined;
	newSessionFile: string | undefined;
}
interface PendingMove {
	move: Move;
	completed: boolean;
}
interface SessionControlLifetime {
	assertAvailable(): void;
}
const lifetimes = new WeakMap<AgentSession, SessionControlLifetime>();

/** Internal lifetime binding: only native move callbacks authorize cwd/file changes. */
export function getSessionControlLifetime(
	session: AgentSession,
	retire: (preserveAuthorization: boolean) => void,
): SessionControlLifetime {
	const existing = lifetimes.get(session);
	if (existing) return existing;
	const manager = session.sessionManager;
	// A late binding cannot observe the before snapshot of an admitted move.
	// Reject without caching anything; a settled lookup captures the real endpoint.
	if (manager.hasPendingCwdMove())
		throw Object.assign(new Error("Session controls are unavailable until the cwd transition settles; retry."), {
			code: "resource_gone",
		});
	const sessionId = session.sessionId;
	const managerId = manager.getSessionId();
	const identity = manager.getSessionIdentityGeneration();
	const agent = session.agent;
	const owner = session.getAgentId();
	const settings = session.settings;
	const registry = session.modelRegistry;
	let cwd = manager.getCwd();
	let sessionFile = manager.getSessionFile();
	let rejected = false;
	let disposed = false;
	let renewing = false;
	let successor = manager;
	let successorId = managerId;
	let successorIdentity = identity;
	let current: PendingMove | undefined;
	const pending = new Set<PendingMove>();
	const sameNonManagerOwner = (): boolean =>
		session.agent === agent &&
		session.getAgentId() === owner &&
		session.settings === settings &&
		session.modelRegistry === registry;
	const sameOwner = (): boolean =>
		sameNonManagerOwner() &&
		session.sessionManager === manager &&
		session.sessionId === sessionId &&
		manager.getSessionId() === managerId &&
		manager.getSessionIdentityGeneration() === identity;
	const sameSuccessorOwner = (): boolean =>
		sameNonManagerOwner() &&
		session.sessionManager === successor &&
		session.sessionId === successorId &&
		successor.getSessionId() === successorId &&
		successor.getSessionIdentityGeneration() === successorIdentity;
	const unavailable = (message: string): never => {
		throw Object.assign(new Error(message), { code: "resource_gone" });
	};
	// Observers invalidate SDK ownership; only SDK availability checks throw.
	const reject = (): void => {
		rejected = true;
		retire(false);
	};
	const checkOwner = (): boolean => {
		if (rejected || !sameOwner()) {
			reject();
			return false;
		}
		return true;
	};
	const matches = (expectedCwd: string, expectedFile: string | undefined): boolean =>
		manager.getCwd() === expectedCwd && manager.getSessionFile() === expectedFile;
	const matchesMove = (
		move: Pick<Move, "previousCwd" | "newCwd" | "previousSessionFile">,
	): PendingMove | undefined => {
		if (!checkOwner()) return;
		const ticket = current;
		if (
			!ticket ||
			ticket.completed ||
			ticket.move.previousCwd !== move.previousCwd ||
			ticket.move.newCwd !== move.newCwd ||
			ticket.move.previousSessionFile !== move.previousSessionFile
		) {
			reject();
			return;
		}
		return ticket;
	};
	const removeBefore = manager.registerBeforeMoveListener(
		move => {
			if (!checkOwner()) return;
			if (
				!matches(cwd, sessionFile) ||
				move.previousCwd !== cwd ||
				move.previousSessionFile !== sessionFile ||
				(current && !current.completed)
			)
				return reject();
			const ticket: PendingMove = { move, completed: false };
			current = ticket;
			pending.add(ticket);
			// Retire raw, already-returned views before even the old-cwd callback window.
			// Native executors keep their own actual settlement/admission ownership.
			retire(true);
			// Do NOT return/await this from a writer callback. The native tail includes
			// the remaining after/abort listeners and any already-queued move writers.
			void manager.joinCwdTransition().then(
				() => {
					if (disposed || renewing) return;
					if (!sameOwner() || !ticket.completed) reject();
					pending.delete(ticket);
				},
				() => {
					if (disposed || renewing) return;
					reject();
					pending.delete(ticket);
				},
			);
		},
		{ prepend: true },
	);
	const removeAfter = manager.registerAfterMoveListener(
		move => {
			const ticket = matchesMove(move);
			if (!ticket) return;
			if (!matches(ticket.move.newCwd, ticket.move.newSessionFile)) return reject();
			cwd = ticket.move.newCwd;
			sessionFile = ticket.move.newSessionFile;
			ticket.completed = true;
		},
		{ prepend: true },
	);
	const removeAbort = manager.registerMoveAbortListener(
		move => {
			if (!checkOwner()) return;
			// An earlier before-listener may reject before this binding was invoked.
			if (!current || current.completed) {
				if (!matches(cwd, sessionFile)) reject();
				return;
			}
			const ticket = matchesMove(move);
			if (!ticket) return;
			// Abort is authority only for an actually restored predecessor. A retained
			// destination requires the native after-move commit evidence instead.
			if (!matches(ticket.move.previousCwd, ticket.move.previousSessionFile)) return reject();
			ticket.completed = true;
		},
		{ prepend: true },
	);
	const lifetime: SessionControlLifetime = {
		assertAvailable() {
			if (disposed) unavailable("Session controls are disposed.");
			if (rejected || !sameNonManagerOwner()) {
				reject();
				unavailable("Session control identity has retired.");
			}
			if (renewing) {
				if (!sameSuccessorOwner()) {
					reject();
					unavailable("Session control identity has retired.");
				}
				unavailable("Session controls are unavailable until native transition cleanup settles; retry.");
			}
			if (!checkOwner()) unavailable("Session control identity has retired.");
			if (pending.size) unavailable("Session controls are unavailable until the cwd transition settles; retry.");
			if (!matches(cwd, sessionFile)) {
				reject();
				unavailable("Session control identity has retired.");
			}
		},
	};
	lifetimes.set(session, lifetime);
	const removeMoves = (): void => {
		removeBefore();
		removeAfter();
		removeAbort();
	};
	const removeCleanup = session.registerToolSessionCleanup(() => {
		disposed = true;
		removeMoves();
		removeTransition();
		retire(false);
	});
	const transitionCleanup = (): void => {
		retire(false);
		if (disposed || rejected || session.sessionLifecycle.disposed) return;
		if (!sameNonManagerOwner()) return reject();
		if (!session.sessionLifecycle.transitioning) {
			// Ordinary view cleanup cannot authorize a changed logical identity.
			if (!checkOwner()) return;
			if (!matches(cwd, sessionFile)) return reject();
			removeTransition = session.registerToolSessionTransitionCleanup(() => transitionCleanup());
			return;
		}
		// Only this registered native cleanup signal authorizes a new logical
		// identity, including the manager replacement performed by a cold fork.
		// Generation changes alone (including clearContext) never do.
		successor = session.sessionManager;
		successorId = successor.getSessionId();
		successorIdentity = successor.getSessionIdentityGeneration();
		if (session.sessionId !== successorId) return reject();
		renewing = true;
		removeMoves();
		removeTransition();
		// As with move callbacks, do not join the writer from inside its callback.
		// Keep the old binding unavailable until predecessor and successor native
		// writers (including owned work) settle. Moves may change cwd/file while
		// settling; the next binding captures that final endpoint, not this snapshot.
		const settled =
			successor === manager
				? manager.joinCwdTransition()
				: Promise.all([manager.joinCwdTransition(), successor.joinCwdTransition()]);
		void settled.then(
			() => {
				if (disposed || rejected) return;
				if (!sameSuccessorOwner()) return reject();
				disposed = true;
				removeCleanup();
				if (lifetimes.get(session) === lifetime) lifetimes.delete(session);
			},
			() => reject(),
		);
	};
	let removeTransition = session.registerToolSessionTransitionCleanup(() => transitionCleanup());
	return lifetime;
}
