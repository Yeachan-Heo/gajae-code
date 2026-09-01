/**
 * Helper for wiring the `compact` action of an {@link ExtensionContext}.
 *
 * Extension-facing APIs accept `string | CompactOptions`, but `AgentSession.compact`
 * takes two positional arguments `(instructions, options)`. This helper splits the
 * union so the same adapter can be reused by print, SDK, ACP, and executor callers.
 */
import type { Model } from "@gajae-code/ai/core";
import type { CompactOptions, SdkControlMutationOptions } from "./types";

interface CompactableSession {
	compact(instructions?: string, options?: CompactOptions): Promise<unknown>;
}

export async function runExtensionCompact(
	session: CompactableSession,
	instructionsOrOptions: string | CompactOptions | undefined,
): Promise<void> {
	const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
	const options =
		instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
	await session.compact(instructions, options);
}

interface SetModelCapableSession {
	credentialSessionId?: string;
	modelRegistry: { getApiKey(model: Model, sessionId?: string): Promise<string | undefined> };
	setModel(model: Model, role?: string, options?: { cause?: string }): Promise<unknown>;
	/** Serialize the complete extension model mutation with session controls. */
	withSdkControlMutation?<T>(body: () => Promise<T>, options?: SdkControlMutationOptions): Promise<T>;
	/** Capture the session identity before an asynchronous extension mutation. */
	captureSessionIdentityForMode?(): unknown;
	/** Reject materialization when the extension mutation crossed a session transition. */
	isSessionIdentityCurrentForMode?(admission: unknown): boolean;
	/** Legacy fallback for adapters that expose only the transition flag. */
	isSessionTransitioning?: boolean;
	/** Persist effective profile roles and clear its marker for a concrete default selection. */
	materializeActiveDefaultModelProfileAssignment?(model: Model): boolean;
	/** Drop a session-only profile marker and its runtime role overrides. */
	clearSessionOnlyModelProfileState?(): void;
	/** Fallback marker clear for legacy session adapters. */
	setActiveModelProfile?(name: string | undefined): void;
}

/**
 * Helper for wiring the `setModel` action of an {@link ExtensionContext}.
 *
 * Returns false when no API key is available for the requested model.
 */
export async function runExtensionSetModel(session: SetModelCapableSession, model: Model): Promise<boolean> {
	const identityAdmission = session.captureSessionIdentityForMode?.();
	const assertCurrentIdentity = (): void => {
		if (
			identityAdmission !== undefined &&
			session.isSessionIdentityCurrentForMode &&
			!session.isSessionIdentityCurrentForMode(identityAdmission)
		) {
			throw new Error("Session changed while selecting model");
		}
		if (identityAdmission === undefined && session.isSessionTransitioning === true) {
			throw new Error("Session changed while selecting model");
		}
	};
	const runMutation = async (): Promise<boolean> => {
		assertCurrentIdentity();
		const key = await session.modelRegistry.getApiKey(model, session.credentialSessionId);
		assertCurrentIdentity();
		if (!key) return false;
		await session.setModel(model, "default", { cause: "user-selection" });
		// setModel performs its own admission checks, but an extension adapter may
		// implement only the structural contract above. Revalidate before the
		// synchronous profile materialization so a transition cannot leak the
		// predecessor's effective assignment into its successor.
		assertCurrentIdentity();
		// A durable profile is replaced by materializing its effective assignments
		// (otherwise a restart reapplies modelProfile.default and restores the
		// profile the caller just replaced); a session-only marker is dropped
		// together with its runtime role overrides.
		if (!session.materializeActiveDefaultModelProfileAssignment?.(model)) {
			if (session.clearSessionOnlyModelProfileState) session.clearSessionOnlyModelProfileState();
			else session.setActiveModelProfile?.(undefined);
		}
		return true;
	};
	return session.withSdkControlMutation
		? session.withSdkControlMutation(runMutation, { allowSdkControlMutationReentry: true })
		: runMutation();
}
