import type { AgentSession } from "../session/agent-session";
import { type CreateAgentSessionOptions, createAgentSession } from "./session";
import {
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

/** Internal lifecycle-only session construction with an owner-bound SDK startup result. */
export async function createLifecycleAgentSession(
	options: CreateAgentSessionOptions = {},
): Promise<CreateLifecycleAgentSessionResult> {
	const rollback = new SdkStartupRollbackTracker();
	const capability = new SdkStartupCapability(rollback);
	try {
		const internalOptions = {
			...options,
			[lifecycleStartupCapabilityOption]: capability,
		} as CreateAgentSessionOptions & { [lifecycleStartupCapabilityOption]: SdkStartupCapability };
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
