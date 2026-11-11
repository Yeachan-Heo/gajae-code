import type { AgentSession } from "../session/agent-session";
import { AUTHORIZATION_CONTROL_OPERATIONS, AuthorizationControls } from "./authorization-controls";

interface SessionControls {
	authorization: AuthorizationControls;
	retired: boolean;
}
const controls = new WeakMap<AgentSession, SessionControls>();

export function getSdkClientControlOperations(_session: AgentSession): readonly string[] {
	return [...AUTHORIZATION_CONTROL_OPERATIONS, "auth.login"];
}
export function getSessionClientControls(session: AgentSession): SessionControls {
	const existing = controls.get(session);
	if (existing && !existing.retired) return existing;
	if (session.sessionLifecycle.disposed || session.sessionLifecycle.transitioning)
		throw Object.assign(new Error("Session controls are unavailable during lifecycle transition."), {
			code: "resource_gone",
		});
	const entry: SessionControls = { authorization: new AuthorizationControls(session), retired: false };
	controls.set(session, entry);
	const retire = (): void => {
		entry.retired = true;
		void entry.authorization.close().catch(() => {});
		removeTransition();
		removeCleanup();
	};
	const removeTransition = session.registerToolSessionTransitionCleanup(retire);
	const removeCleanup = session.registerToolSessionCleanup(retire);
	return entry;
}
