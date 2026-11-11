import type { AgentSession } from "../session/agent-session";
import { createSdkComposerObservation, type SdkComposerObservation } from "./composer-observation";
import type { CreateAgentSessionResult } from "./session";

interface SessionControls {
	composer: SdkComposerObservation;
	retired: boolean;
}
const controls = new WeakMap<AgentSession, SessionControls>();
const resources = new WeakMap<AgentSession, Pick<CreateAgentSessionResult, "session" | "jobObservation">>();
/** Trusted factory-only binding; attachment callers cannot supply resource handles. */
export function bindSessionClientControlResources(
	result: Pick<CreateAgentSessionResult, "session" | "jobObservation">,
): void {
	resources.set(result.session, result);
}
export function getSdkClientControlOperations(_session: AgentSession): readonly string[] {
	return ["composer.catalog", "composer.complete", "session.info"];
}
export function getSessionClientControls(session: AgentSession): SessionControls {
	const existing = controls.get(session);
	if (existing && !existing.retired) return existing;
	if (session.sessionLifecycle.disposed || session.sessionLifecycle.transitioning)
		throw Object.assign(new Error("Session controls are unavailable during lifecycle transition."), {
			code: "resource_gone",
		});
	const entry: SessionControls = {
		composer: createSdkComposerObservation(session, resources.get(session)),
		retired: false,
	};
	controls.set(session, entry);
	const retire = (): void => {
		entry.retired = true;
		entry.composer.dispose();
		removeTransition();
		removeCleanup();
	};
	const removeTransition = session.registerToolSessionTransitionCleanup(retire);
	const removeCleanup = session.registerToolSessionCleanup(retire);
	return entry;
}
