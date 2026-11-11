import type { AgentSession } from "../session/agent-session";
import { createSdkOperatorControls, type SdkOperatorControls } from "./operator-controls";
import { AuthorizationControls, AUTHORIZATION_CONTROL_OPERATIONS } from "./authorization-controls";
import { createSdkPreferenceControls, SDK_PREFERENCE_OPERATIONS, type SdkPreferenceControls } from "./preference-controls";

interface SessionControls {
	preferences: SdkPreferenceControls;
	authorization: AuthorizationControls;
	operator: SdkOperatorControls;
	retired: boolean;
}
const controls = new WeakMap<AgentSession, SessionControls>();
export function getSdkClientControlOperations(_session: AgentSession): readonly string[] {
	return [...SDK_PREFERENCE_OPERATIONS, ...AUTHORIZATION_CONTROL_OPERATIONS, "auth.login", "operator.execute", "operator.read", "operator.cancel", "operator.background"];
}

/** Internal SDK binding shared by interactive and nonvisual hosts. No caller-supplied session handles. */
export function getSessionClientControls(session: AgentSession): SessionControls {
	const existing = controls.get(session);
	if (existing && !existing.retired) return existing;
	if (session.sessionLifecycle.disposed || session.sessionLifecycle.transitioning)
		throw Object.assign(new Error("Session controls are unavailable during lifecycle transition."), { code: "resource_gone" });
	const entry: SessionControls = { preferences: createSdkPreferenceControls(session), authorization: new AuthorizationControls(session), operator: createSdkOperatorControls(session), retired: false };
	controls.set(session, entry);
	const retire = (): void => {
		entry.retired = true;
		entry.preferences.dispose();
		entry.operator.dispose();
		void entry.authorization.close().catch(() => {});
		removeTransition();
		removeCleanup();
	};
	const removeTransition = session.registerToolSessionTransitionCleanup(retire);
	const removeCleanup = session.registerToolSessionCleanup(retire);
	return entry;
}
