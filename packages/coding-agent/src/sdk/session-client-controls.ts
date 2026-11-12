import type { AgentSession } from "../session/agent-session";
import { AUTHORIZATION_CONTROL_OPERATIONS, AuthorizationControls } from "./authorization-controls";
import { createSdkDiffObservation, type SdkDiffObservation } from "./diff-observation";
import {
	createSdkPreferenceControls,
	SDK_PREFERENCE_OPERATIONS,
	type SdkPreferenceControls,
} from "./preference-controls";

import { getSessionControlLifetime } from "./session-control-lifetime";

interface SessionControls {
	preferences: SdkPreferenceControls;
	authorization: AuthorizationControls;
	diff: SdkDiffObservation;
	generation: number;
	sameIdentity: () => boolean;
	retire: (preserveAuthorization?: boolean) => void;
	retired: boolean;
	identityRejected: boolean;
	authorizationPreserved: boolean;
}
const controls = new WeakMap<AgentSession, SessionControls>();

export function getSdkClientControlOperations(_session: AgentSession): readonly string[] {
	return [
		...SDK_PREFERENCE_OPERATIONS,
		...AUTHORIZATION_CONTROL_OPERATIONS,
		"auth.login",
		"diff.scopes",
		"diff.summary",
		"diff.file",
	];
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
		retire: preserveAuthorization => retire(preserveAuthorization),
		authorization: authorization ?? new AuthorizationControls(session),
		diff: createSdkDiffObservation(session),
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
		entry.diff.dispose();
		removeTransition();
		removeCleanup();
	};
	const removeTransition = session.registerToolSessionTransitionCleanup(() => retire());
	const removeCleanup = session.registerToolSessionCleanup(() => retire());
	return entry;
}
