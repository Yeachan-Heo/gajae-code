/**
 * Helper for wiring the `compact` action of an {@link ExtensionContext}.
 *
 * Extension-facing APIs accept `string | CompactOptions`, but `AgentSession.compact`
 * takes two positional arguments `(instructions, options)`. This helper splits the
 * union so the same adapter can be reused by print, SDK, ACP, and executor callers.
 */
import type { Model } from "@gajae-code/ai/core";
import {
	type DurableModelProfileOwnership,
	type ModelProfileOwnershipSettings,
	readDurableModelProfileOwnership,
} from "../../config/model-profile-ownership";
import type { CompactOptions } from "./types";

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
	settings: ModelProfileOwnershipSettings;
	setModel(
		model: Model,
		role?: string,
		options?: {
			cause?: string;
			observedOwnership?: DurableModelProfileOwnership;
			onMutationStarted?: () => void;
			onMutationCompleted?: () => void;
		},
	): Promise<unknown>;
}

/** Internal host hooks run inside the selection admission around the durable mutation. */
export interface SetModelMutationHooks {
	onBeforeMutation?: () => void;
	onAfterMutation?: () => void;
}

/**
 * Helper for wiring the `setModel` action of an {@link ExtensionContext}.
 *
 * Returns false when no API key is available for the requested model.
 */
export async function runExtensionSetModel(
	session: SetModelCapableSession,
	model: Model,
	hooks?: SetModelMutationHooks,
): Promise<boolean> {
	const observedOwnership = readDurableModelProfileOwnership(session.settings);
	const key = await session.modelRegistry.getApiKey(model, session.credentialSessionId);
	if (!key) return false;
	await session.setModel(model, "default", {
		cause: "user-selection",
		observedOwnership,
		onMutationStarted: hooks?.onBeforeMutation,
		onMutationCompleted: hooks?.onAfterMutation,
	});
	return true;
}
