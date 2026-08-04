import type { AgentSession } from "../session/agent-session";
import { type CreateAgentSessionOptions, createAgentSession } from "./session";
import {
	lifecycleMcpStartupTimeoutOption,
	lifecycleStartupCapabilityOption,
	SdkStartupCapability,
	type SdkStartupFailure,
	SdkStartupRollbackTracker,
} from "./startup-capability";

export type CreateLifecycleAgentSessionResult =
	| {
			session: AgentSession;
			capability: SdkStartupCapability;
			rollback: SdkStartupRollbackTracker;
	  }
	| { capability: SdkStartupCapability; rollback: SdkStartupRollbackTracker; failure: SdkStartupFailure };

/** Options accepted by lifecycle-only session construction. */
export type CreateLifecycleAgentSessionOptions = CreateAgentSessionOptions & {
	/**
	 * Startup budget for ACP lifecycle MCP launches, in milliseconds. Set only
	 * when the lifecycle request supplies `mcpServers`; ordinary consumers keep
	 * the manager's short default ceiling.
	 */
	mcpStartupTimeoutMs?: number;
	/**
	 * The broker-issued readiness intent from this session's launch request.
	 * `deferred` prepares the session: it holds endpoint authority and publishes
	 * a prepared signal instead of readiness until it is explicitly activated.
	 */
	readiness?: "immediate" | "deferred";
};

/** Internal lifecycle-only session construction with an owner-bound SDK startup result. */
export async function createLifecycleAgentSession(
	options: CreateLifecycleAgentSessionOptions = {},
): Promise<CreateLifecycleAgentSessionResult> {
	const rollback = new SdkStartupRollbackTracker();
	const capability = new SdkStartupCapability(rollback, options.readiness ?? "immediate");
	try {
		const { mcpStartupTimeoutMs, readiness: _readiness, ...sessionOptions } = options;
		const internalOptions = {
			...sessionOptions,
			[lifecycleStartupCapabilityOption]: capability,
			...(mcpStartupTimeoutMs !== undefined ? { [lifecycleMcpStartupTimeoutOption]: mcpStartupTimeoutMs } : {}),
		} as CreateAgentSessionOptions & {
			[lifecycleStartupCapabilityOption]: SdkStartupCapability;
			[lifecycleMcpStartupTimeoutOption]?: number;
		};
		const result = await createAgentSession(internalOptions);
		if (!result.session.extensionRunner)
			capability.settleFailure(capability.normalizeFailure("registration", "runner_absent"));
		return { session: result.session, capability, rollback };
	} catch (error) {
		const settled = capability.settleFailure(capability.normalizeFailure("registration", "failed", error));
		const failure =
			settled.status === "failed" ? settled.failure : capability.normalizeFailure("registration", "failed", error);
		return { capability, rollback, failure };
	}
}
