import { AsyncJobManager } from "../async";
import type { Settings } from "../config/settings";
import type { ToolSession } from "../tools";

/** SDK-owned identity: generations advance only when a session move commits. */
export interface TaskScopeIdentity {
	readonly cwd: string;
	readonly generation: number;
}

/** A short admission lease, not a lease held by detached task execution. */
export interface TaskScopeAuthority {
	getTaskScopeIdentity?: () => TaskScopeIdentity;
	getTaskScopeSettings?: () => Settings;
	runWithTaskAdmission?<T>(admit: () => Promise<T>): Promise<T>;
	/** Resolve the live artifact owner under a short cwd lease without reloading task settings. */
	runWithTaskOwnerReadLease?<T>(resolve: () => Promise<T>): Promise<T>;
}

/** Retain execution inputs while leaving shared services and output allocation owned by the parent. */
export function snapshotTaskSession(
	session: ToolSession & TaskScopeAuthority,
	jobManager: AsyncJobManager | undefined,
): ToolSession {
	const sessionFile = session.getSessionFile();
	const sessionId = session.getSessionId?.() ?? null;
	const endpointId = session.getAsyncEndpointId?.() ?? sessionId;
	const credentialSessionId = session.getCredentialSessionId?.() ?? sessionId;
	const agentId = session.getAgentId?.() ?? null;
	const spawns = session.getSessionSpawns();
	const activeModel = session.getActiveModelString?.();
	const modelString = session.getModelString?.();
	const agentDir = session.getSessionAgentDir?.() ?? session.settings.getAgentDir();
	const mcpManager = session.getMcpManager?.();
	const managedDestination = session.isManagedSessionDestination?.() ?? false;
	const hindsight = session.getHindsightSessionState?.();
	const telemetry = session.getTelemetry?.();
	const planMode = structuredClone(session.getPlanModeState?.());
	const compactContext = session.getCompactContext?.();
	const ircTool = session.getToolByName?.("irc");
	const profileSession = session as ToolSession & { getActiveModelProfile?: () => string | undefined };
	const activeProfile = profileSession.getActiveModelProfile?.();
	const snapshot: ToolSession & TaskScopeAuthority & { getActiveModelProfile: () => string | undefined } = {
		...session,
		cwd: session.cwd,
		settings: (session.getTaskScopeSettings?.() ?? session.settings).snapshot(),
		contextFiles: session.contextFiles ? structuredClone(session.contextFiles) : undefined,
		workspaceTree: session.workspaceTree ? structuredClone(session.workspaceTree) : undefined,
		skills: session.skills?.map(skill => ({ ...skill, _source: skill._source ? { ...skill._source } : undefined })),
		promptTemplates: session.promptTemplates ? structuredClone(session.promptTemplates) : undefined,
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionId,
		getAsyncEndpointId: () => (jobManager ? AsyncJobManager.endpointIdOf(jobManager) : undefined) ?? endpointId,
		getCredentialSessionId: () => credentialSessionId,
		getAgentId: () => agentId,
		getSessionSpawns: () => spawns,
		getActiveModelString: () => activeModel,
		getActiveModelProfile: () => activeProfile,
		getModelString: () => modelString,
		getSessionAgentDir: () => agentDir,
		getMcpManager: () => mcpManager,
		isManagedSessionDestination: () => managedDestination,
		getHindsightSessionState: () => hindsight,
		getTelemetry: () => telemetry,
		getPlanModeState: () => (planMode ? structuredClone(planMode) : undefined),
		getCompactContext: session.getCompactContext ? () => compactContext ?? "" : undefined,
		getAsyncJobManager: () => jobManager,
		getToolByName: name => (name === "irc" ? ircTool : undefined),
		getTaskScopeIdentity: undefined,
		getTaskScopeSettings: undefined,
		runWithTaskAdmission: undefined,
		runWithTaskOwnerReadLease: undefined,
	};
	return snapshot;
}
