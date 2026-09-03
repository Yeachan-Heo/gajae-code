import { parseModelString } from "../config/model-resolver";
import { type AgentSession, isSessionDisposalIncompleteError } from "../session/agent-session";
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
	 * Explicit model pin (#4707): the coordinator-resolved `provider/model`
	 * selector, forwarded as {@link CreateAgentSessionOptions.modelPattern} so
	 * the session resolves it through the same staged selector resolver the CLI
	 * `--model` flag uses (after extension providers register).
	 *
	 * Resolution is strict: if this child's registry cannot resolve the pin to
	 * exactly this model, construction fails and the partial session is
	 * disposed instead of continuing into startup profile application, which
	 * would otherwise activate `modelProfile.default`/`mpreset` while the
	 * coordinator reports the requested pin.
	 */
	modelId?: string;
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
	/** Broker-issued lifecycle request identity published with host registration. */
	lifecycleRequestId?: string;
};

/** Internal lifecycle-only session construction with an owner-bound SDK startup result. */
export async function createLifecycleAgentSession(
	options: CreateLifecycleAgentSessionOptions = {},
): Promise<CreateLifecycleAgentSessionResult> {
	const rollback = new SdkStartupRollbackTracker();
	const capability = new SdkStartupCapability(rollback, options.readiness ?? "immediate", options.lifecycleRequestId);
	try {
		const {
			modelId,
			mcpStartupTimeoutMs,
			readiness: _readiness,
			lifecycleRequestId: _lifecycleRequestId,
			...sessionOptions
		} = options;
		const internalOptions = {
			...sessionOptions,
			// Explicit model pin (#4707): resolve through the staged selector
			// resolver after extension providers register (modelPattern), so the
			// pin matches CLI `--model` semantics instead of bypassing them.
			...(modelId !== undefined ? { modelPattern: modelId } : {}),
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
		// Explicit model pin (#4707) is a guarantee, not a preference. The
		// coordinator validated the selector against its own registry; this child
		// owns the registry that actually serves requests, and the two can drift
		// (a model removed, a provider disabled, an extension that failed to
		// register). On drift `createAgentSession` returns a session with no model
		// plus a fallback warning, and the startup profile pass that runs next
		// would activate `modelProfile.default`/`mpreset` instead — publishing
		// success on a model the caller never asked for. Fail before readiness and
		// before any profile application, and dispose the partial session.
		if (modelId !== undefined) {
			const active = result.session.model;
			const activeSelector = active ? `${active.provider}/${active.id}` : undefined;
			const expected = parseModelString(modelId);
			const expectedSelector = expected ? `${expected.provider}/${expected.id}` : modelId;
			if (!activeSelector || activeSelector.toLowerCase() !== expectedSelector.toLowerCase()) {
				try {
					await result.session.dispose();
				} catch (error) {
					if (!isSessionDisposalIncompleteError(error)) throw error;
					await result.session.awaitDisposeCompletion();
				}
				throw new Error(
					`Model "${modelId}" not found. Use --list-models to see available models.${
						activeSelector ? ` Session resolved ${activeSelector} instead.` : ""
					}`,
				);
			}
		}
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
