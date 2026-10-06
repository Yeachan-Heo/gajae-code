/**
 * Provider model trust registry for runtime safety stops and payload authenticity.
 * Public surface for model registration and clone propagation.
 */

export {
	copyProviderSafetyStopAdapterInvocation,
	isProviderSafetyStopAdapterInvocation,
	isProviderSafetyStopAuthenticated,
	isProviderSafetyStopModelTrusted,
	mintProviderSafetyStop,
	PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
	PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
	type ProviderSafetyStopAdapterCapability,
	type ProviderSafetyStopAdapterInvocation,
	registerProviderSafetyStopModel,
	registerTrustedModelClone,
	revokeProviderSafetyStop,
	withProviderSafetyStopAdapterInvocation,
} from "./adapter-internals/provider-safety-stop";
