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
	registerProviderSafetyStopModel,
	registerTrustedModelClone,
	revokeProviderSafetyStop,
	withProviderSafetyStopAdapterInvocation,
	type ProviderSafetyStopAdapterCapability,
	type ProviderSafetyStopAdapterInvocation,
} from "./adapter-internals/provider-safety-stop";
