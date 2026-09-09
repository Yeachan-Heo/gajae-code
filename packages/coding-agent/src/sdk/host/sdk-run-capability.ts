import type { ExtensionAPI } from "../../extensibility/extensions/types";
import type { SdkRunCapability } from "../../session/sdk-run-capability-internal";

export { createSdkRunCapability } from "../../session/sdk-run-capability-internal";

/** Private SDK submission shape. Never expose run authority on ExtensionAPI. */
export type InternalSdkSendOptions = NonNullable<Parameters<ExtensionAPI["sendUserMessage"]>[1]> & {
	sdkRunCapability?: SdkRunCapability;
};

export type InternalSdkSubmissionApi = Omit<ExtensionAPI, "sendUserMessage"> & {
	sendUserMessage: (
		content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
		options?: InternalSdkSendOptions,
	) => Promise<void>;
};
