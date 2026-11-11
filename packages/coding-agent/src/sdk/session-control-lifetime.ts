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
	let current: PendingMove | undefined;
	const pending = new Set<PendingMove>();
	const sameOwner = (): boolean =>
		session.sessionManager === manager &&
		session.sessionId === sessionId &&
		manager.getSessionId() === managerId &&
		manager.getSessionIdentityGeneration() === identity &&
		session.agent === agent &&
		session.getAgentId() === owner &&
		session.settings === settings &&
		session.modelRegistry === registry;
	const unavailable = (message: string): never => {
		throw Object.assign(new Error(message), { code: "resource_gone" });
	};
	const reject = (): never => {
		rejected = true;
		retire(false);
		return unavailable("Session control identity has retired.");
	};
	const assertOwner = (): void => {
		if (rejected || !sameOwner()) reject();
	};
	const matches = (expectedCwd: string, expectedFile: string | undefined): boolean =>
		manager.getCwd() === expectedCwd && manager.getSessionFile() === expectedFile;
	const matchesMove = (move: Pick<Move, "previousCwd" | "newCwd" | "previousSessionFile">): PendingMove => {
		assertOwner();
		const ticket = current;
		if (
			!ticket ||
			ticket.completed ||
			ticket.move.previousCwd !== move.previousCwd ||
			ticket.move.newCwd !== move.newCwd ||
			ticket.move.previousSessionFile !== move.previousSessionFile
		)
			return reject();
		return ticket;
	};
	const removeBefore = manager.registerBeforeMoveListener(
		move => {
			assertOwner();
			if (
				!matches(cwd, sessionFile) ||
				move.previousCwd !== cwd ||
				move.previousSessionFile !== sessionFile ||
				(current && !current.completed)
			)
				reject();
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
					if (disposed) return;
					if (!sameOwner() || !ticket.completed) {
						rejected = true;
						retire(false);
					}
					pending.delete(ticket);
				},
				() => {
					if (disposed) return;
					rejected = true;
					retire(false);
					pending.delete(ticket);
				},
			);
		},
		{ prepend: true },
	);
	const removeAfter = manager.registerAfterMoveListener(
		move => {
			const ticket = matchesMove(move);
			if (!matches(ticket.move.newCwd, ticket.move.newSessionFile)) reject();
			cwd = ticket.move.newCwd;
			sessionFile = ticket.move.newSessionFile;
			ticket.completed = true;
		},
		{ prepend: true },
	);
	const removeAbort = manager.registerMoveAbortListener(
		move => {
			assertOwner();
			// An earlier before-listener may reject before this binding was invoked.
			if (!current || current.completed) {
				if (!matches(cwd, sessionFile)) reject();
				return;
			}
			const ticket = matchesMove(move);
			// Abort is authority only for an actually restored predecessor. A retained
			// destination requires the native after-move commit evidence instead.
			if (!matches(ticket.move.previousCwd, ticket.move.previousSessionFile)) reject();
			ticket.completed = true;
		},
		{ prepend: true },
	);
	const lifetime: SessionControlLifetime = {
		assertAvailable() {
			if (disposed) unavailable("Session controls are disposed.");
			assertOwner();
			if (pending.size) unavailable("Session controls are unavailable until the cwd transition settles; retry.");
			if (!matches(cwd, sessionFile)) reject();
		},
	};
	lifetimes.set(session, lifetime);
	session.registerToolSessionCleanup(() => {
		disposed = true;
		removeBefore();
		removeAfter();
		removeAbort();
		retire(false);
	});
	return lifetime;
}
