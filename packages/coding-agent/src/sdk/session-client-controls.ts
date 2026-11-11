import type { AgentSession } from "../session/agent-session";
import { createSdkDiffObservation, type SdkDiffObservation } from "./diff-observation";

interface SessionControls {
	diff: SdkDiffObservation;
	retired: boolean;
}
const controls = new WeakMap<AgentSession, SessionControls>();

export function getSdkClientControlOperations(_session: AgentSession): readonly string[] {
	return ["diff.scopes", "diff.summary", "diff.file"];
}
export function getSessionClientControls(session: AgentSession): SessionControls {
	const existing = controls.get(session);
	if (existing && !existing.retired) return existing;
	if (session.sessionLifecycle.disposed || session.sessionLifecycle.transitioning)
		throw Object.assign(new Error("Session controls are unavailable during lifecycle transition."), {
			code: "resource_gone",
		});
	const entry: SessionControls = { diff: createSdkDiffObservation(session), retired: false };
	controls.set(session, entry);
	const retire = (): void => {
		entry.retired = true;
		entry.diff.dispose();
		removeTransition();
		removeCleanup();
	};
	const removeTransition = session.registerToolSessionTransitionCleanup(retire);
	const removeCleanup = session.registerToolSessionCleanup(retire);
	return entry;
}
