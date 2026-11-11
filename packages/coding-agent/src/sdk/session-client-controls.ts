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
	generation: number;
	sameIdentity: () => boolean;
	retire: (preserveAuthorization?: boolean) => void;
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
	if (session.sessionLifecycle.disposed || session.sessionLifecycle.transitioning)
		throw Object.assign(new Error("Session controls are unavailable during lifecycle transition."), {
			code: "resource_gone",
		});
	const existing = controls.get(session);
	let authorization: AuthorizationControls | undefined;
	if (existing && !existing.retired) {
		if (!existing.sameIdentity()) {
			existing.retire();
			throw Object.assign(new Error("Session control identity has retired."), { code: "resource_gone" });
		}
		if (existing.generation === session.sessionLifecycle.generation) return existing;
		// Context clear advances the view generation without retiring the live
		// session or its factory resources. Authorization is identity-bound, not
		// context-bound: keep its provider ownership and nonce fences intact.
		authorization = existing.authorization;
		existing.retire(true);
	}
	const manager = session.sessionManager;
	const sessionId = session.sessionId;
	const managerId = manager.getSessionId();
	const identity = manager.getSessionIdentityGeneration();
	const cwd = manager.getCwd();
	const agent = session.agent;
	const entry: SessionControls = {
		generation: session.sessionLifecycle.generation,
		sameIdentity: () =>
			session.sessionManager === manager &&
			session.sessionId === sessionId &&
			manager.getSessionId() === managerId &&
			manager.getSessionIdentityGeneration() === identity &&
			manager.getCwd() === cwd &&
			session.agent === agent,
		retire: preserveAuthorization => retire(preserveAuthorization),
		diff: createSdkDiffObservation(session),
		side: new SideConversationControls(session),
		preferences: createSdkPreferenceControls(session),
		authorization: authorization ?? new AuthorizationControls(session),
		operator: createSdkOperatorControls(session),
		composer: createSdkComposerObservation(session, resources.get(session)),
		...(resources.get(session) ? { activity: new ActivityControls(resources.get(session)!) } : {}),
		retired: false,
	};
	controls.set(session, entry);
	const retire = (preserveAuthorization = false): void => {
		if (entry.retired) return;
		entry.retired = true;
		entry.preferences.dispose();
		entry.side.dispose();
		entry.diff.dispose();
		entry.operator.dispose();
		entry.composer.dispose();
		entry.activity?.dispose();
		if (!preserveAuthorization) void entry.authorization.close().catch(() => {});
		removeTransition();
		removeCleanup();
	};
	const removeTransition = session.registerToolSessionTransitionCleanup(() => retire());
	const removeCleanup = session.registerToolSessionCleanup(() => retire());
	return entry;
}
