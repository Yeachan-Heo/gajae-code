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
			/**
			 * Starts the memory backend that construction deliberately skipped. The
			 * caller MUST run it only after readiness is published.
			 */
			startDeferredMemoryBackend: () => Promise<void>;
	  }
	| { capability: SdkStartupCapability; rollback: SdkStartupRollbackTracker; failure: SdkStartupFailure };

/**
 * Options accepted by lifecycle-only session construction.
 *
 * `deferMemoryBackendStartup` is not accepted: lifecycle sessions are launched
 * by the broker under a fixed readiness deadline, and memory startup runs
 * unbounded LLM work, so deferral is an invariant rather than a caller choice.
 */
export type CreateLifecycleAgentSessionOptions = Omit<CreateAgentSessionOptions, "deferMemoryBackendStartup"> & {
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
			// Memory startup (rollout summarisation) issues one LLM request per
			// claimed rollout, so its duration scales with the backlog. Keeping it
			// inside the broker's readiness window is what kills the child at the
			// cutoff; the host resumes it once readiness is published.
			deferMemoryBackendStartup: true,
			[lifecycleStartupCapabilityOption]: capability,
			...(mcpStartupTimeoutMs !== undefined ? { [lifecycleMcpStartupTimeoutOption]: mcpStartupTimeoutMs } : {}),
		} as CreateAgentSessionOptions & {
			[lifecycleStartupCapabilityOption]: SdkStartupCapability;
			[lifecycleMcpStartupTimeoutOption]?: number;
		};
		const result = await createAgentSession(internalOptions);
		if (!result.session.extensionRunner)
			capability.settleFailure(capability.normalizeFailure("registration", "runner_absent"));
		if (!result.startDeferredMemoryBackend)
			throw new Error("Lifecycle session construction did not return a deferred memory backend starter.");
		return {
			session: result.session,
			capability,
			rollback,
			startDeferredMemoryBackend: result.startDeferredMemoryBackend,
		};
	} catch (error) {
		const settled = capability.settleFailure(capability.normalizeFailure("registration", "failed", error));
		const failure =
			settled.status === "failed" ? settled.failure : capability.normalizeFailure("registration", "failed", error);
		return { capability, rollback, failure };
	}
}
