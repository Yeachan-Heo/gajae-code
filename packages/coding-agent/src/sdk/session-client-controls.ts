import type { AgentSession } from "../session/agent-session";
import { ActivityControls } from "./activity-controls";
import type { CreateAgentSessionResult } from "./session";

interface SessionControls {
	activity?: ActivityControls;
	retired: boolean;
}
const controls = new WeakMap<AgentSession, SessionControls>();
const resources = new WeakMap<
	AgentSession,
	Pick<CreateAgentSessionResult, "session" | "jobObservation" | "mcpManager">
>();
/** Trusted factory-only binding; attachment callers cannot supply resource handles. */
export function bindSessionClientControlResources(
	result: Pick<CreateAgentSessionResult, "session" | "jobObservation" | "mcpManager">,
): void {
	resources.set(result.session, result);
}
export function getSdkClientControlOperations(session: AgentSession): readonly string[] {
	const bound = resources.get(session);
	return [
		"activity.snapshot",
		"activity.detail",
		"activity.cancel",
		"activity.pause",
		"activity.resume",
		"activity.delete",
		"activity.acknowledge",
		"mcp.snapshot",
		"mcp.suspend",
		"mcp.resume",
		"mcp.reconnect",
	].filter(operation =>
		operation.startsWith("mcp.") ? bound?.mcpManager !== undefined : bound?.jobObservation !== undefined,
	);
}
export function getSessionClientControls(session: AgentSession): SessionControls {
	const existing = controls.get(session);
	if (existing && !existing.retired) return existing;
	if (session.sessionLifecycle.disposed || session.sessionLifecycle.transitioning)
		throw Object.assign(new Error("Session controls are unavailable during lifecycle transition."), {
			code: "resource_gone",
		});
	const entry: SessionControls = {
		...(resources.get(session) ? { activity: new ActivityControls(resources.get(session)!) } : {}),
		retired: false,
	};
	controls.set(session, entry);
	const retire = (): void => {
		entry.retired = true;
		entry.activity?.dispose();
		removeTransition();
		removeCleanup();
	};
	const removeTransition = session.registerToolSessionTransitionCleanup(retire);
	const removeCleanup = session.registerToolSessionCleanup(retire);
	return entry;
}
