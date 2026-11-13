import type { AgentSession } from "../session/agent-session";
import { ActivityControls } from "./activity-controls";
import { createSdkComposerObservation, type SdkComposerObservation } from "./composer-observation";
import { createSdkDiffObservation, type SdkDiffObservation } from "./diff-observation";
import {
	createSdkPreferenceControls,
	SDK_PREFERENCE_OPERATIONS,
	type SdkPreferenceControls,
} from "./preference-controls";
import type { CreateAgentSessionResult } from "./session";
import { getSessionControlLifetime } from "./session-control-lifetime";

interface SessionControls {
	composer: SdkComposerObservation;

	preferences: SdkPreferenceControls;
	activity?: ActivityControls;
	diff: SdkDiffObservation;
	generation: number;
	sameIdentity: () => boolean;
	retire: () => void;
	retired: boolean;
	identityRejected: boolean;
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
	getSessionControlLifetime(result.session, () => controls.get(result.session)?.retire());
}
export function getSdkClientControlOperations(session: AgentSession): readonly string[] {
	const bound = resources.get(session);
	return [
		...SDK_PREFERENCE_OPERATIONS,
		"composer.catalog",
		"composer.complete",
		"session.info",
		"diff.scopes",
		"diff.summary",
		"diff.file",
		...[
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
		),
	];
}
export function getSessionClientControls(session: AgentSession): SessionControls {
	if (session.sessionLifecycle.disposed || session.sessionLifecycle.transitioning)
		throw Object.assign(new Error("Session controls are unavailable during lifecycle transition."), {
			code: "resource_gone",
		});
	getSessionControlLifetime(session, () => controls.get(session)?.retire()).assertAvailable();
	const existing = controls.get(session);
	if (existing?.identityRejected)
		throw Object.assign(new Error("Session control identity has retired."), { code: "resource_gone" });
	if (existing && !existing.retired) {
		if (!existing.sameIdentity()) {
			existing.identityRejected = true;
			existing.retire();
			throw Object.assign(new Error("Session control identity has retired."), { code: "resource_gone" });
		}
		if (existing.generation === session.sessionLifecycle.generation) return existing;
		existing.retire();
	}
	const manager = session.sessionManager;
	const sessionId = session.sessionId;
	const managerId = manager.getSessionId();
	const identity = manager.getSessionIdentityGeneration();
	const cwd = manager.getCwd();
	const agent = session.agent;
	const owner = session.getAgentId();
	const settings = session.settings;
	const registry = session.modelRegistry;
	const entry: SessionControls = {
		preferences: createSdkPreferenceControls(session),
		generation: session.sessionLifecycle.generation,
		sameIdentity: () =>
			session.sessionManager === manager &&
			session.sessionId === sessionId &&
			manager.getSessionId() === managerId &&
			manager.getSessionIdentityGeneration() === identity &&
			manager.getCwd() === cwd &&
			session.agent === agent &&
			session.getAgentId() === owner &&
			session.settings === settings &&
			session.modelRegistry === registry,
		retire: () => retire(),
		...(resources.get(session) ? { activity: new ActivityControls(resources.get(session)!) } : {}),
		composer: createSdkComposerObservation(session, resources.get(session)),
		diff: createSdkDiffObservation(session),
		retired: false,
		identityRejected: false,
	};
	controls.set(session, entry);
	const retire = (): void => {
		if (entry.retired) return;
		entry.retired = true;
		entry.preferences.dispose();
		entry.activity?.dispose();
		entry.composer.dispose();
		entry.diff.dispose();
		removeTransition();
		removeCleanup();
	};
	const removeTransition = session.registerToolSessionTransitionCleanup(retire);
	const removeCleanup = session.registerToolSessionCleanup(retire);
	return entry;
}
