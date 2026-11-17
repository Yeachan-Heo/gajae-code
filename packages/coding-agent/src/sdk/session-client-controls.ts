import type { AgentSession } from "../session/agent-session";
import { ActivityControls, type ActivityMcpSnapshot } from "./activity-controls";
import { AUTHORIZATION_CONTROL_OPERATIONS, AuthorizationControls } from "./authorization-controls";
import { createSdkComposerObservation, type SdkComposerObservation } from "./composer-observation";
import { createSdkDiffObservation, type SdkDiffObservation } from "./diff-observation";
import { assertNativeRuntimeInvocation } from "./native-lifecycle";
import { createSdkOperatorControls, type SdkOperatorControls } from "./operator-controls";
import {
	createSdkPreferenceControls,
	SDK_PREFERENCE_OPERATIONS,
	type SdkPreferenceControls,
} from "./preference-controls";
import type { CreateAgentSessionResult } from "./session";
import { getSessionControlLifetime } from "./session-control-lifetime";
import { SIDE_CONVERSATION_MUTATIONS, SIDE_CONVERSATION_QUERIES, SideConversationControls } from "./side-conversation";

interface SessionControls {
	composer: SdkComposerObservation;

	preferences: SdkPreferenceControls;
	authorization: AuthorizationControls;
	operator: SdkOperatorControls;
	activity?: ActivityControls;
	getMcpSnapshot?: () => ActivityMcpSnapshot;
	side: SideConversationControls;
	diff: SdkDiffObservation;
	generation: number;
	sameIdentity: () => boolean;
	retire: (preserveAuthorization?: boolean) => void;
	retired: boolean;
	identityRejected: boolean;
	authorizationPreserved: boolean;
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
	getSessionControlLifetime(result.session, preserve => controls.get(result.session)?.retire(preserve));
}
/** Internal TERM hook: stop existing exact-session producers, never construct borrowed controls. */
export function stopSessionClientControlProducers(session: AgentSession): void {
	const bound = controls.get(session);
	bound?.operator.dispose();
	bound?.side.dispose();
}

export function getSdkClientControlOperations(session: AgentSession): readonly string[] {
	const bound = resources.get(session);
	return [
		...SDK_PREFERENCE_OPERATIONS,
		...AUTHORIZATION_CONTROL_OPERATIONS,
		"auth.login",
		"operator.execute",
		"operator.read",
		"operator.cancel",
		...SIDE_CONVERSATION_MUTATIONS,
		...SIDE_CONVERSATION_QUERIES,
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

/** Check each dispatch, not just retrieval: retained service methods never retain native authority. */
function nativeDispatchGuard<T extends object>(session: AgentSession, service: T, methods: readonly (keyof T)[]): T {
	return new Proxy(service, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (methods.some(method => method === property)) assertNativeRuntimeInvocation(session);
				return Reflect.apply(value, target, args);
			};
		},
	});
}

/** Read the exact cached MCP controls without borrowing mutation authority. */
export function getSessionClientMcpSnapshot(session: AgentSession): ActivityMcpSnapshot {
	const entry = session.sessionLifecycle.transitioning ? controls.get(session) : getSessionClientControls(session);
	const assertCurrent = (): void => {
		if (
			!entry ||
			session.sessionLifecycle.disposed ||
			entry.retired ||
			entry.identityRejected ||
			entry.generation !== session.sessionLifecycle.generation ||
			!entry.sameIdentity()
		)
			throw Object.assign(new Error("Session control identity has retired."), { code: "resource_gone" });
		getSessionControlLifetime(session, preserve => controls.get(session)?.retire(preserve)).assertAvailable();
	};
	assertCurrent();
	if (!entry?.getMcpSnapshot)
		throw Object.assign(new Error("Native activity controls unavailable"), { code: "unavailable" });
	const snapshot = entry.getMcpSnapshot();
	assertCurrent();
	return snapshot;
}

/** Internal SDK binding shared by interactive and nonvisual hosts. No caller-supplied session handles. */
export function getSessionClientControls(session: AgentSession): SessionControls {
	if (session.sessionLifecycle.disposed || session.sessionLifecycle.transitioning)
		throw Object.assign(new Error("Session controls are unavailable during lifecycle transition."), {
			code: "resource_gone",
		});
	getSessionControlLifetime(session, preserve => controls.get(session)?.retire(preserve)).assertAvailable();
	const existing = controls.get(session);
	let authorization = existing?.authorizationPreserved ? existing.authorization : undefined;
	if (existing?.identityRejected)
		throw Object.assign(new Error("Session control identity has retired."), { code: "resource_gone" });
	if (existing && !existing.retired) {
		if (!existing.sameIdentity()) {
			existing.identityRejected = true;
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
	const owner = session.getAgentId();
	const settings = session.settings;
	const registry = session.modelRegistry;
	const boundResources = resources.get(session);
	const activity = boundResources ? new ActivityControls(boundResources) : undefined;
	const entry: SessionControls = {
		preferences: nativeDispatchGuard(session, createSdkPreferenceControls(session), [
			"handle",
			"setRole",
			"selectModel",
			"selectProfile",
			"patchConfig",
		]),
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
		retire: preserveAuthorization => retire(preserveAuthorization),
		authorization: authorization ?? nativeDispatchGuard(session, new AuthorizationControls(session), ["execute"]),
		operator: nativeDispatchGuard(session, createSdkOperatorControls(session), ["execute", "read", "cancel"]),
		...(activity
			? {
					getMcpSnapshot: () => activity.getMcpSnapshot(),
					activity: nativeDispatchGuard(session, activity, [
						"control",
						"getActivitySnapshot",
						"getDetail",
						"operateActivity",
						"acknowledge",
						"getMcpSnapshot",
						"operateMcp",
					]),
				}
			: {}),
		side: nativeDispatchGuard(session, new SideConversationControls(session), ["control"]),
		composer: nativeDispatchGuard(session, createSdkComposerObservation(session, resources.get(session)), [
			"dispatch",
		]),
		diff: nativeDispatchGuard(session, createSdkDiffObservation(session), ["dispatch"]),
		retired: false,
		identityRejected: false,
		authorizationPreserved: false,
	};
	controls.set(session, entry);
	const retire = (preserveAuthorization = false): void => {
		if (!preserveAuthorization) {
			entry.authorizationPreserved = false;
			void entry.authorization.close().catch(() => {});
		}
		if (entry.retired) return;
		entry.authorizationPreserved = preserveAuthorization;
		entry.retired = true;
		entry.preferences.dispose();
		entry.operator.dispose();
		entry.activity?.dispose();
		entry.side.dispose();
		entry.composer.dispose();
		entry.diff.dispose();
		removeTransition();
		removeCleanup();
	};
	const removeTransition = session.registerToolSessionTransitionCleanup(() => retire());
	const removeCleanup = session.registerToolSessionCleanup(() => retire());
	return entry;
}
