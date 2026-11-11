import type { AgentSession } from "../session/agent-session";
import { ActivityControls } from "./activity-controls";
import { AUTHORIZATION_CONTROL_OPERATIONS, AuthorizationControls } from "./authorization-controls";
import { createSdkComposerObservation, type SdkComposerObservation } from "./composer-observation";
import { createSdkDiffObservation, type SdkDiffObservation } from "./diff-observation";
import { createSdkOperatorControls, type SdkOperatorControls } from "./operator-controls";
import {
	createSdkPreferenceControls,
	SDK_PREFERENCE_OPERATIONS,
	type SdkPreferenceControls,
} from "./preference-controls";
import type { CreateAgentSessionResult } from "./session";
import { SIDE_CONVERSATION_MUTATIONS, SIDE_CONVERSATION_QUERIES, SideConversationControls } from "./side-conversation";

interface SessionControls {
	preferences: SdkPreferenceControls;
	authorization: AuthorizationControls;
	operator: SdkOperatorControls;
	activity?: ActivityControls;
	composer: SdkComposerObservation;
	side: SideConversationControls;
	diff: SdkDiffObservation;
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
const ACTIVITY_OPERATIONS = [
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
] as const;
export function getSdkClientControlOperations(session: AgentSession): readonly string[] {
	const bound = resources.get(session);
	return [
		"diff.scopes",
		"diff.summary",
		"diff.file",
		...SIDE_CONVERSATION_MUTATIONS,
		...SIDE_CONVERSATION_QUERIES,
		...SDK_PREFERENCE_OPERATIONS,
		...AUTHORIZATION_CONTROL_OPERATIONS,
		"auth.login",
		"operator.execute",
		"operator.read",
		"operator.cancel",
		"composer.catalog",
		"composer.complete",
		"session.info",
		...ACTIVITY_OPERATIONS.filter(operation =>
			operation.startsWith("mcp.") ? bound?.mcpManager !== undefined : bound?.jobObservation !== undefined,
		),
	];
}

/** Internal SDK binding shared by interactive and nonvisual hosts. No caller-supplied session handles. */
export function getSessionClientControls(session: AgentSession): SessionControls {
	const existing = controls.get(session);
	if (existing && !existing.retired) return existing;
	if (session.sessionLifecycle.disposed || session.sessionLifecycle.transitioning)
		throw Object.assign(new Error("Session controls are unavailable during lifecycle transition."), {
			code: "resource_gone",
		});
	const entry: SessionControls = {
		diff: createSdkDiffObservation(session),
		side: new SideConversationControls(session),
		preferences: createSdkPreferenceControls(session),
		authorization: new AuthorizationControls(session),
		operator: createSdkOperatorControls(session),
		composer: createSdkComposerObservation(session, resources.get(session)),
		...(resources.get(session) ? { activity: new ActivityControls(resources.get(session)!) } : {}),
		retired: false,
	};
	controls.set(session, entry);
	const retire = (): void => {
		entry.retired = true;
		entry.preferences.dispose();
		entry.side.dispose();
		entry.diff.dispose();
		entry.operator.dispose();
		entry.composer.dispose();
		entry.activity?.dispose();
		void entry.authorization.close().catch(() => {});
		removeTransition();
		removeCleanup();
	};
	const removeTransition = session.registerToolSessionTransitionCleanup(retire);
	const removeCleanup = session.registerToolSessionCleanup(retire);
	return entry;
}
